import test from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runReattach } from "./reattach.js";
import { runRevert } from "./revert.js";
import type { CommandEnvelope, RevertResult } from "../core/types.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "fixtures",
);

/**
 * console.log/error를 캡처하고, `--json` 출력용 `write`는 `runReattach`/
 * `runRevert`의 두 번째 인자로 직접 주입한다 — 전역 `process.stdout.write`를
 * patch하지 않는다. 이 파일의 테스트들은 실제 파일 I/O로 `await`하는데,
 * 전역 patch가 그 경계를 넘어 살아있으면 Node v26 test runner 리포터가
 * 깨져 형제 테스트가 등록에서 사라진다(재현: 5개 중 2개만 등록됨).
 * `src/cli/envelope.ts`의 `printEnvelope` 코멘트 참고.
 */
function captureConsole(): {
  logs: string[];
  errors: string[];
  writes: string[];
  write: (chunk: string) => void;
  restore: () => void;
} {
  const logs: string[] = [];
  const errors: string[] = [];
  const writes: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  return {
    logs,
    errors,
    writes,
    write: (chunk) => writes.push(chunk),
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

async function withReattachedFixture(
  run: (dir: string, filePath: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "sessgraph-revert-"));
  const filePath = path.join(dir, "session.jsonl");
  copyFileSync(path.join(fixturesDir, "compact-split.anon.jsonl"), filePath);

  const cap = captureConsole();
  try {
    await runReattach(
      [
        filePath,
        "--uuid",
        "00000000-0000-4000-8000-000000000003",
        "--parent",
        "00000000-0000-4000-8000-000000000002",
        "--reason",
        "테스트: 끊긴 지점 연결",
        "--commit",
      ],
      cap.write,
    );
  } finally {
    cap.restore();
  }

  try {
    await run(dir, filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("runRevert: dry-run은 파일을 건드리지 않는다", async () => {
  await withReattachedFixture(async (_dir, filePath) => {
    const afterReattach = readFileSync(filePath, "utf8");

    const cap = captureConsole();
    let exitCode: number;
    try {
      exitCode = await runRevert([filePath, "--last"], cap.write);
    } finally {
      cap.restore();
    }

    assert.equal(exitCode, 0);
    assert.equal(readFileSync(filePath, "utf8"), afterReattach);
    assert.ok(cap.logs.some((l) => l.includes("dry-run")));
  });
});

test("runRevert --commit --last: reattach를 정확히 되돌려 원본과 같아진다", async () => {
  await withReattachedFixture(async (_dir, filePath) => {
    const original = readFileSync(
      path.join(fixturesDir, "compact-split.anon.jsonl"),
      "utf8",
    );

    const cap = captureConsole();
    let exitCode: number;
    try {
      exitCode = await runRevert([filePath, "--last", "--commit"], cap.write);
    } finally {
      cap.restore();
    }

    assert.equal(exitCode, 0);
    assert.equal(readFileSync(filePath, "utf8"), original);
    assert.ok(cap.logs.some((l) => l.includes("되돌렸습니다")));

    const surgeryLog = readFileSync(`${filePath}.surgery.log`, "utf8")
      .trimEnd()
      .split("\n");
    assert.equal(surgeryLog.length, 2);
    const lastEntry = JSON.parse(surgeryLog[1]!) as { kind: string };
    assert.equal(lastEntry.kind, "revert");
  });
});

test("runRevert --json --commit: 봉투에 RevertResult가 담긴다", async () => {
  await withReattachedFixture(async (_dir, filePath) => {
    const cap = captureConsole();
    let exitCode: number;
    try {
      exitCode = await runRevert(
        [filePath, "--last", "--commit", "--json"],
        cap.write,
      );
    } finally {
      cap.restore();
    }

    assert.equal(exitCode, 0);
    assert.equal(cap.writes.length, 1);
    const envelope = JSON.parse(
      cap.writes[0]!,
    ) as CommandEnvelope<RevertResult>;
    assert.equal(envelope.ok, true);
    assert.equal(envelope.command, "revert");
    assert.equal(envelope.result?.committed, true);
    assert.ok(envelope.result?.preRevertBackupPath);
    assert.ok(existsSync(envelope.result?.preRevertBackupPath ?? ""));
  });
});

test("runRevert: --last와 --to 동시 지정은 종료 코드 2", async () => {
  await withReattachedFixture(async (_dir, filePath) => {
    const cap = captureConsole();
    let exitCode: number;
    try {
      exitCode = await runRevert(
        [filePath, "--last", "--to", "2026-01-01T00:00:00.000Z"],
        cap.write,
      );
    } finally {
      cap.restore();
    }
    assert.equal(exitCode, 2);
  });
});

test("runRevert: 수술 이력이 없으면 종료 코드 2", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sessgraph-revert-none-"));
  const filePath = path.join(dir, "session.jsonl");
  copyFileSync(path.join(fixturesDir, "minimal-chain.anon.jsonl"), filePath);

  const cap = captureConsole();
  let exitCode: number;
  try {
    exitCode = await runRevert([filePath, "--last"], cap.write);
  } finally {
    cap.restore();
  }
  assert.equal(exitCode, 2);
  rmSync(dir, { recursive: true, force: true });
});
