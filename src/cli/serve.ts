import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { buildIndexDetailed } from "../core/build-index.js";
import { buildSegmentDetail } from "../core/serve.js";
import type { IndexResult, NodeIndex, NodeBody } from "../core/types.js";

/** Spec "Interface" — 지정 포트가 사용 중이어도 다른 포트를 고르지 않는다. */
export const DEFAULT_PORT = 7377;

/** 정적 자산은 `dist/web/`에 놓인다 (`npm run build`가 `src/web/`에서 복사). */
const WEB_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "web",
);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/** 기동 시점 파일 상태 지문. 상주 인덱스가 그 지문 기준으로 여전히 유효한지 판단하는 데 쓴다. */
export type FileSnapshot = {
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
};

/**
 * 상주 인덱스가 지금 파일 상태와 여전히 맞는지 검사한다.
 *
 * `size`나 `mtime`(초 단위) 단독으로는 놓치는 변경이 실측으로 확인됐다 —
 * 같은 길이 문자열로 치환하는 `reattach`(uuid→uuid)는 size가 그대로고,
 * `reattach`/`revert`는 temp+rename이라 매번 새 inode를 받지만 제3의
 * 도구가 in-place로 고치면 ino는 유지된 채 mtime만 바뀔 수 있다.
 * `{ino, size, mtimeMs}` 세 값을 모두 비교해야 두 경로 다 잡힌다.
 */
function isStale(filePath: string, baseline: FileSnapshot): boolean {
  let current: ReturnType<typeof statSync>;
  try {
    current = statSync(filePath);
  } catch {
    return true; // 파일이 사라졌다면 당연히 stale이다
  }
  return (
    current.ino !== baseline.ino ||
    current.size !== baseline.size ||
    current.mtimeMs !== baseline.mtimeMs
  );
}

/**
 * 상주 인덱스 위에서 동작하는 읽기 전용 요청 핸들러를 만든다.
 *
 * 인덱스는 프로세스 수명 동안 한 번만 만든다 — 요청마다 다시 인덱싱하면
 * 실측 2.14초를 매번 치르게 된다 (Design "고려한 대안" 대안2).
 * 본문은 상주시키지 않고 `byteOffset`으로 그때 seek해서 읽는다.
 *
 * 기동 후 원본이 외부에서 바뀌면(reattach/revert 등) 상주 인덱스가 낡는다.
 * `/api/body`는 uuid 불일치로 자체 감지하지만, `/api/index`·`/api/segment/*`는
 * 파일을 다시 보지 않아 감지할 지점이 없었다 — 세그먼트 경계가 이미 바뀐
 * 뒤에도 낡은 구조를 200으로 계속 내보내는 채로 실측됐다
 * (docs/design/20260902-0420-serve-command.tdd.md 53번 줄이 이미 이 감지를
 * 약속했지만 이 두 엔드포인트에는 구현되지 않았었다). `snapshot`과 비교해
 * 요청 시점에 어긋났으면 두 엔드포인트도 같은 409로 답한다.
 */
export function createRequestHandler(
  filePath: string,
  index: IndexResult,
  nodes: ReadonlyMap<string, NodeIndex>,
  snapshot: FileSnapshot,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    // ADR-0003: 쓰기 API를 갖지 않는다. 경로 존재 여부와 무관하게 405다 —
    // 어떤 경로가 쓰기를 받는지 탐색당하지 않기 위해서다.
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, {
        error: "이 서버는 읽기 전용입니다. 파일 수정은 sessgraph CLI가 합니다",
      });
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (
      url.pathname === "/api/index" ||
      url.pathname.startsWith("/api/segment/")
    ) {
      if (isStale(filePath, snapshot)) {
        sendJson(res, 409, {
          error: "파일이 변경되었습니다. 서버를 재시작하세요",
        });
        return;
      }
    }

    if (url.pathname === "/api/index") {
      sendJson(res, 200, index);
      return;
    }

    if (url.pathname.startsWith("/api/segment/")) {
      const rootUuid = decodeURIComponent(
        url.pathname.slice("/api/segment/".length),
      );
      const detail = buildSegmentDetail(index, nodes, filePath, rootUuid);
      if (!detail) {
        sendJson(res, 404, {
          error: `세그먼트를 찾을 수 없습니다: ${rootUuid}`,
        });
        return;
      }
      sendJson(res, 200, detail);
      return;
    }

    if (url.pathname === "/api/body") {
      const uuid = url.searchParams.get("uuid");
      const node = uuid ? nodes.get(uuid) : undefined;
      if (!uuid || !node) {
        sendJson(res, 404, { error: `노드를 찾을 수 없습니다: ${uuid ?? ""}` });
        return;
      }
      let raw: string;
      try {
        raw = readLineAt(filePath, node.byteOffset, node.byteLength);
      } catch (err) {
        sendJson(res, 409, {
          error: `본문을 읽지 못했습니다: ${(err as Error).message}`,
        });
        return;
      }
      // 기동 후 원본이 외부에서 바뀌면 offset이 어긋난다. 엉뚱한 본문을
      // 조용히 렌더하지 않는다 (Spec "엣지 케이스").
      if (!rawMatchesUuid(raw, uuid)) {
        sendJson(res, 409, {
          error: "파일이 변경되었습니다. 서버를 재시작하세요",
        });
        return;
      }
      const body: NodeBody = { uuid, raw };
      sendJson(res, 200, body);
      return;
    }

    void serveStatic(url.pathname, res);
  };
}

async function serveStatic(pathname: string, res: ServerResponse) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  // 경로 탈출 차단 — 정적 루트 밖의 파일을 읽지 않는다.
  const resolved = path.resolve(WEB_ROOT, relative);
  if (resolved !== WEB_ROOT && !resolved.startsWith(WEB_ROOT + path.sep)) {
    sendJson(res, 404, { error: "찾을 수 없습니다" });
    return;
  }
  try {
    const content = await readFile(resolved);
    res.writeHead(200, {
      "content-type":
        MIME[path.extname(resolved)] ?? "application/octet-stream",
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "찾을 수 없습니다" });
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** 인덱스가 기록한 바이트 범위만 읽는다 — 파일 전체를 올리지 않는다. */
function readLineAt(
  filePath: string,
  byteOffset: number,
  byteLength: number,
): string {
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(byteLength);
    const read = readSync(fd, buf, 0, byteLength, byteOffset);
    return buf.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function rawMatchesUuid(raw: string, uuid: string): boolean {
  try {
    return (JSON.parse(raw) as { uuid?: unknown }).uuid === uuid;
  } catch {
    return false;
  }
}

/**
 * `sessgraph serve <file> [--port n]` — 127.0.0.1에만 바인딩하는 읽기 전용
 * 뷰어 서버를 기동하고 포그라운드에 머무른다
 * (docs/spec/20260902-0420-serve-command.spec.md).
 *
 * 반환하는 Promise는 서버가 닫힐 때(SIGINT) 종료 코드로 resolve한다.
 */
export function runServe(
  argv: readonly string[],
  log: (line: string) => void = (line) => console.log(line),
  logError: (line: string) => void = (line) => console.error(line),
): Promise<number> {
  let values: { port?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { port: { type: "string" } },
    }));
  } catch (err) {
    logError(`인자 파싱 실패: ${(err as Error).message}`);
    return Promise.resolve(2);
  }

  const file = positionals[0];
  if (!file) {
    logError("세션 파일 경로가 필요합니다");
    return Promise.resolve(2);
  }
  if (!existsSync(file)) {
    logError(`파일을 찾을 수 없습니다: ${file}`);
    return Promise.resolve(2);
  }

  let port = DEFAULT_PORT;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      logError(`포트 값이 올바르지 않습니다: ${values.port}`);
      return Promise.resolve(2);
    }
  }

  let index: IndexResult;
  let nodes: ReadonlyMap<string, NodeIndex>;
  try {
    ({ index, nodes } = buildIndexDetailed(file));
  } catch (err) {
    // 깨진 인덱스로 화면을 그리지 않는다 (ADR-0004).
    logError((err as Error).message);
    return Promise.resolve(2);
  }
  const stat = statSync(file);
  const snapshot: FileSnapshot = {
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };

  const server = createServer(
    createRequestHandler(file, index, nodes, snapshot),
  );

  return new Promise<number>((resolve) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        logError(
          `포트 ${port}이 사용 중입니다. \`--port\`로 다른 포트를 지정하세요`,
        );
      } else {
        logError(err.message);
      }
      resolve(2);
    });

    server.listen(port, "127.0.0.1", () => {
      const actual = server.address();
      const boundPort =
        typeof actual === "object" && actual ? actual.port : port;
      log(`http://127.0.0.1:${boundPort}`);
      log(
        `조각 ${index.segments.length}개 · 노드 ${index.nodeCount}개 · Ctrl-C로 종료`,
      );
    });

    const shutdown = () => {
      server.close(() => resolve(0));
      // 열린 keep-alive 연결이 남아 close 콜백이 지연되는 것을 막는다.
      server.closeAllConnections();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
