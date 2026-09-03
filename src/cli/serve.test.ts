import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildIndexDetailed } from "../core/build-index.js";
import {
  createRequestHandler,
  isStale,
  runServe,
  snapshotOf,
} from "./serve.js";
import type { IndexResult, NodeBody, SegmentDetail } from "../core/types.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "fixtures",
);

const U = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/**
 * 픽스처를 임시 디렉터리로 복사한 뒤 그 파일 위에 서버를 띄운다.
 * 포트 0으로 바인딩해 테스트끼리 포트를 다투지 않게 한다 — `runServe`가
 * 강제하는 고정 포트 정책과는 별개로, 여기서 검증하는 것은 핸들러다.
 */
async function withServer(
  fixture: string,
  body: (base: string, file: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "sessgraph-serve-"));
  const file = path.join(dir, "session.jsonl");
  copyFileSync(path.join(fixturesDir, `${fixture}.anon.jsonl`), file);

  const snapshot = snapshotOf(file);
  const { index, nodes } = buildIndexDetailed(file);
  const server: Server = createServer(
    createRequestHandler(file, index, nodes, snapshot),
  );
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await body(`http://127.0.0.1:${port}`, file);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("serve: /api/index는 inspect와 같은 IndexResult를 돌려준다", async () => {
  await withServer("compact-split", async (base, file) => {
    const res = await fetch(`${base}/api/index`);
    assert.equal(res.status, 200);
    const served = (await res.json()) as IndexResult;
    const direct = buildIndexDetailed(file).index;
    assert.equal(served.nodeCount, direct.nodeCount);
    assert.deepEqual(
      served.segments.map((s) => s.rootUuid),
      direct.segments.map((s) => s.rootUuid),
    );
  });
});

test("serve: /api/segment/:root는 노드 목록과 재연결 명령어를 준다", async () => {
  await withServer("compact-split", async (base) => {
    const res = await fetch(`${base}/api/segment/${U(3)}`);
    assert.equal(res.status, 200);
    const detail = (await res.json()) as SegmentDetail;
    assert.deepEqual(
      detail.nodes.map((n) => n.uuid),
      [U(3), U(4), U(5)],
    );
    assert.equal(detail.suggestedParentSource, "inferred");
    assert.ok(detail.suggestedReattachCommand?.includes(`--parent ${U(2)}`));
  });
});

test("serve: 존재하지 않는 세그먼트 root는 404", async () => {
  await withServer("compact-split", async (base) => {
    const res = await fetch(`${base}/api/segment/${U(99)}`);
    assert.equal(res.status, 404);
  });
});

test("serve: /api/body는 원본 JSONL 한 줄을 그대로 돌려준다", async () => {
  await withServer("compact-split", async (base) => {
    const res = await fetch(`${base}/api/body?uuid=${U(4)}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as NodeBody;
    assert.equal(body.uuid, U(4));
    assert.equal((JSON.parse(body.raw) as { uuid: string }).uuid, U(4));
  });
});

test("serve: 인덱스에 없는 uuid는 404", async () => {
  await withServer("compact-split", async (base) => {
    const res = await fetch(`${base}/api/body?uuid=${U(99)}`);
    assert.equal(res.status, 404);
  });
});

test("serve: 기동 후 원본이 바뀌면 /api/body는 409로 알린다", async () => {
  await withServer("compact-split", async (base, file) => {
    // 첫 줄을 길이가 다른 내용으로 갈아엎어 byteOffset을 어긋나게 만든다.
    writeFileSync(file, `{"uuid":"x","parentUuid":null}\n`);
    const res = await fetch(`${base}/api/body?uuid=${U(4)}`);
    assert.equal(res.status, 409);
    const payload = (await res.json()) as { error: string };
    assert.match(payload.error, /파일이 변경되었습니다|본문을 읽지 못했습니다/);
  });
});

test("serve: 기동 후 원본이 바뀌면 /api/index는 낡은 구조를 200으로 내보내지 않는다", async () => {
  await withServer("compact-split", async (base, file) => {
    // uuid→uuid 치환(길이 불변)도 잡혀야 한다 — size만 보면 놓친다.
    writeFileSync(file, readFileSync(file, "utf8").replace(U(1), U(2)));
    const res = await fetch(`${base}/api/index`);
    assert.equal(res.status, 409);
  });
});

test("serve: 기동 후 원본이 바뀌면 /api/segment/:root도 409", async () => {
  await withServer("compact-split", async (base, file) => {
    writeFileSync(file, readFileSync(file, "utf8").replace(U(1), U(2)));
    const res = await fetch(`${base}/api/segment/${U(3)}`);
    assert.equal(res.status, 409);
  });
});

test("isStale: size·mtime이 같아도 inode가 다르면 stale이다", () => {
  // size/mtimeMs 축을 일부러 동일하게 둬 ino 비교가 실제로 결과를
  // 좌우하는지 검증한다 (2026-09-03 리뷰). 실제 파일에서 이 세 축을
  // 독립적으로 재현하려 하면 파일시스템의 타임스탬프 정밀도 한계(예:
  // `utimesSync`가 밀리초 미만을 못 담는 것)에 부딪히므로, 순수 함수를
  // 직접 값 비교로 검증한다.
  const baseline = { ino: 1, size: 100, mtimeMs: 1_000 };
  const current = { ino: 2, size: 100, mtimeMs: 1_000 };
  assert.equal(isStale(current, baseline), true);
});

test("isStale: 세 값이 모두 같으면 stale이 아니다", () => {
  const baseline = { ino: 1, size: 100, mtimeMs: 1_000 };
  const current = { ino: 1, size: 100, mtimeMs: 1_000 };
  assert.equal(isStale(current, baseline), false);
});

test("serve: 쓰기 메서드는 어떤 경로에서도 405 (ADR-0003)", async () => {
  await withServer("compact-split", async (base) => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await fetch(`${base}/api/index`, { method });
      assert.equal(res.status, 405, `${method}가 405가 아님`);
    }
  });
});

test("serve: /는 뷰어 HTML을 응답한다", async () => {
  await withServer("compact-split", async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await res.text(), /sessgraph/);
  });
});

test("serve: 정적 루트 밖으로 나가는 경로는 404", async () => {
  await withServer("compact-split", async (base) => {
    const res = await fetch(`${base}/..%2f..%2fpackage.json`);
    assert.equal(res.status, 404);
  });
});

test("serve: 정적 루트에 테스트 산출물이 섞여 노출되지 않는다", async () => {
  // src/web/CLAUDE.md "이 스코프가 하지 않는 것" — serveStatic은 파일명
  // allowlist 없이 정적 루트 안의 파일을 그대로 응답하므로, 빌드 산출물
  // 배치가 곧 노출 범위다. 2026-09-03 리뷰에서 dist/web/에 format.test.js가
  // 섞여 나온 회귀가 실제로 있었다 (scripts/copy-web-assets.js).
  await withServer("compact-split", async (base) => {
    const res = await fetch(`${base}/format.test.js`);
    assert.equal(res.status, 404);
  });
});

test("serve: 빈 파일도 정상 기동하고 세그먼트 0개를 응답한다", async () => {
  await withServer("empty", async (base) => {
    const res = await fetch(`${base}/api/index`);
    assert.equal(res.status, 200);
    const index = (await res.json()) as IndexResult;
    assert.equal(index.nodeCount, 0);
    assert.deepEqual(index.segments, []);
  });
});

test("runServe: 파일이 없으면 서버를 띄우지 않고 종료 코드 2", async () => {
  const errors: string[] = [];
  const code = await runServe(
    [path.join(tmpdir(), "sessgraph-does-not-exist.jsonl")],
    () => {},
    (line) => errors.push(line),
  );
  assert.equal(code, 2);
  assert.match(errors.join("\n"), /파일을 찾을 수 없습니다/);
});

test("runServe: 파일 경로가 없으면 종료 코드 2", async () => {
  const errors: string[] = [];
  const code = await runServe(
    [],
    () => {},
    (line) => errors.push(line),
  );
  assert.equal(code, 2);
  assert.match(errors.join("\n"), /세션 파일 경로가 필요합니다/);
});

test("runServe: 인덱싱 불변식 위반이면 서버를 띄우지 않는다 (ADR-0004)", async () => {
  const errors: string[] = [];
  const code = await runServe(
    [path.join(fixturesDir, "no-parent-field.anon.jsonl")],
    () => {},
    (line) => errors.push(line),
  );
  assert.equal(code, 2);
  assert.match(errors.join("\n"), /parentUuid 필드가 전혀 없습니다/);
});

test("runServe: 포트가 사용 중이면 다른 포트를 고르지 않고 종료 코드 2", async () => {
  const blocker = createServer(() => {});
  await new Promise<void>((resolve) =>
    blocker.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = blocker.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const errors: string[] = [];
  try {
    const code = await runServe(
      [
        path.join(fixturesDir, "compact-split.anon.jsonl"),
        "--port",
        String(port),
      ],
      () => {},
      (line) => errors.push(line),
    );
    assert.equal(code, 2);
    assert.match(errors.join("\n"), new RegExp(`포트 ${port}이 사용 중입니다`));
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});
