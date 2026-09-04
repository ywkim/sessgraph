import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { buildIndexDetailed } from "../core/build-index.js";
import { buildSegmentDetail } from "../core/serve.js";
import type {
  IndexResult,
  NodeIndex,
  NodeBody,
  SessionSummary,
} from "../core/types.js";

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

/** 파일을 stat해 지문을 뜬다. */
export function snapshotOf(filePath: string): FileSnapshot {
  const stat = statSync(filePath);
  return { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

/**
 * 두 지문을 비교해 baseline이 낡았는지 판정하는 순수 함수.
 *
 * `size`나 `mtime`(초 단위) 단독으로는 놓치는 변경이 실측으로 확인됐다 —
 * 같은 길이 문자열로 치환하는 `reattach`(uuid→uuid)는 size가 그대로고,
 * `reattach`/`revert`는 temp+rename이라 매번 새 inode를 받지만 제3의
 * 도구가 in-place로 고치면 ino는 유지된 채 mtime만 바뀔 수 있다.
 * `{ino, size, mtimeMs}` 세 값을 모두 비교해야 두 경로 다 잡힌다. 값
 * 비교만 하는 순수 함수로 둔 이유는, 실제 파일에서 이 세 축을 독립적으로
 * 재현하려 하면 파일시스템의 타임스탬프 정밀도 한계(예: `utimesSync`가
 * 밀리초 미만을 못 담는 것)에 부딪히기 때문이다 — 축별 회귀 테스트는
 * 이 함수를 직접 호출해 검증한다.
 */
export function isStale(
  current: FileSnapshot,
  baseline: FileSnapshot,
): boolean {
  return (
    current.ino !== baseline.ino ||
    current.size !== baseline.size ||
    current.mtimeMs !== baseline.mtimeMs
  );
}

function currentlyStale(filePath: string, baseline: FileSnapshot): boolean {
  let current: FileSnapshot;
  try {
    current = snapshotOf(filePath);
  } catch {
    return true; // 파일이 사라졌다면 당연히 stale이다
  }
  return isStale(current, baseline);
}

/** 한 시점의 파일에서 뽑아낸 인덱스와, 그 시점의 파일 지문. */
export type IndexState = {
  readonly snapshot: FileSnapshot;
  readonly index: IndexResult;
  readonly nodes: ReadonlyMap<string, NodeIndex>;
};

/**
 * 파일을 인덱싱해 상태 한 벌을 만든다.
 *
 * 스냅샷은 반드시 인덱싱 **전에** 찍는다. 인덱싱은 파일을 순차로 읽으므로
 * 즉시 끝나지 않고(실측 823MB 파일 기준 약 1초), 그 사이에 파일이 바뀌면
 * 인덱싱 결과는 이미 그 변경을 일부만 반영한 상태다. 스냅샷을 나중에 찍으면
 * 변경 이후 지문을 baseline으로 삼아 "최신"이라고 오판하고 그 어긋남을
 * 영구히 놓친다. 먼저 찍으면 다음 요청에서 불일치로 잡혀 다시 인덱싱된다.
 */
export function loadIndexState(filePath: string): IndexState {
  const snapshot = snapshotOf(filePath);
  const { index, nodes } = buildIndexDetailed(filePath);
  return { snapshot, index, nodes };
}

/**
 * 세션 id를 절대경로에서 파생한다 — 파일명(basename)이 아니라 경로
 * 전체를 해시한다. Claude Code 세션 저장 구조상 basename이 uuid처럼
 * 보이지만, 이 도구가 받는 파일은 그 구조에 한정되지 않는다 —
 * `reattach`가 만드는 `{file}.bak.{시각}` 백업이나 사용자가 복사해 둔
 * 사본은 서로 다른 디렉터리에서 같은 파일명을 가질 수 있다. id가
 * 충돌하면 서로 다른 세션이 조용히 섞인다
 * (docs/design/20260905-0641-multi-session-serve.tdd.md).
 */
export function sessionIdOf(filePath: string): string {
  return createHash("sha256")
    .update(path.resolve(filePath))
    .digest("hex")
    .slice(0, 12);
}

/** 화면에 보여줄 이름. 조회에는 쓰지 않으므로 중복되어도 안전하다. */
function labelOf(filePath: string): string {
  const resolved = path.resolve(filePath);
  const parent = path.basename(path.dirname(resolved));
  return path.join(parent, path.basename(resolved));
}

/** 세션 하나의 상태 — 등록되었지만 아직 안 읽었거나, 읽었거나, 실패했다. */
type SessionEntry = {
  readonly id: string;
  readonly label: string;
  readonly filePath: string;
  state: IndexState | null;
  failure: string | null;
};

/** 존재하는 경로만 등록한다. 등록 시점에 존재 여부를 확정하고, 내용은 읽지 않는다. */
export function registerSessions(
  filePaths: readonly string[],
): Map<string, SessionEntry> {
  const registry = new Map<string, SessionEntry>();
  for (const filePath of filePaths) {
    const id = sessionIdOf(filePath);
    const label = labelOf(filePath);
    const exists = existsSync(filePath);
    registry.set(id, {
      id,
      label,
      filePath,
      state: null,
      failure: exists ? null : `파일을 찾을 수 없습니다: ${filePath}`,
    });
  }
  return registry;
}

function summaryOf(entry: SessionEntry): SessionSummary {
  return {
    id: entry.id,
    label: entry.label,
    status:
      entry.failure !== null ? "failed" : entry.state ? "ready" : "unread",
    failure: entry.failure,
  };
}

/**
 * 요청 시점 세션 상태가 없거나 낡았으면 (다시) 인덱싱해 교체한다.
 *
 * `buildIndexDetailed`는 동기 함수라 Node의 단일 스레드 이벤트 루프 안에서
 * 한 요청의 (재)인덱싱이 끝나기 전까지 다른 요청이 끼어들 수 없다 — 별도의
 * in-flight 잠금 없이도 중복 인덱싱이 생기지 않는다. 세션이 여럿이면 이
 * 성질은 동시에 "한 세션의 인덱싱이 다른 세션 요청을 그 시간만큼 막는다"는
 * 결과로도 나타난다 — 혼자 쓰는 도구이고 실측 1초대~2.14초라 지금은
 * 감수한다 (docs/design/20260905-0641-multi-session-serve.tdd.md).
 *
 * 실패하면 `entry.failure`에 사유를 남기고 `state`는 갱신하지 않는다 —
 * 낡은 인덱스로 조용히 폴백하지 않는다는 원칙은 세션이 여럿이어도 그대로
 * 유지하되, 그 실패의 범위는 이 세션 하나로 국한한다.
 */
function ensureFresh(
  entry: SessionEntry,
): { readonly state: IndexState } | { readonly error: string } {
  if (entry.state && !currentlyStale(entry.filePath, entry.state.snapshot)) {
    return { state: entry.state };
  }
  try {
    entry.state = loadIndexState(entry.filePath);
    entry.failure = null;
    return { state: entry.state };
  } catch (err) {
    const message = (err as Error).message;
    entry.failure = message;
    return { error: message };
  }
}

/**
 * 여러 세션 위에서 동작하는 읽기 전용 요청 핸들러를 만든다.
 *
 * 세션 축은 경로 세그먼트(`/api/session/:id/...`)로 표현한다 — 조회
 * 문자열에 기본값을 두면 축을 빠뜨린 요청이 임의의 세션으로 조용히
 * 넘어갈 수 있다. 경로에 넣으면 누락은 문법적으로 무효(404)가 된다
 * (docs/design/20260905-0641-multi-session-serve.tdd.md 대안5).
 */
export function createRequestHandler(
  registry: Map<string, SessionEntry>,
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

    if (url.pathname === "/api/sessions") {
      sendJson(res, 200, [...registry.values()].map(summaryOf));
      return;
    }

    const sessionMatch = /^\/api\/session\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (!sessionMatch) {
      void serveStatic(url.pathname, res);
      return;
    }

    const [, id, rest] = sessionMatch;
    const entry = registry.get(id!);
    if (!entry) {
      sendJson(res, 404, { error: `세션을 찾을 수 없습니다: ${id}` });
      return;
    }

    const fresh = ensureFresh(entry);
    if ("error" in fresh) {
      sendJson(res, 500, {
        error: `파일이 바뀌어 다시 인덱싱했지만 실패했습니다: ${fresh.error}`,
      });
      return;
    }
    const { index, nodes } = fresh.state;

    if (rest === "/index") {
      sendJson(res, 200, index);
      return;
    }

    if (rest!.startsWith("/segment/")) {
      const rootUuid = decodeURIComponent(rest!.slice("/segment/".length));
      const detail = buildSegmentDetail(index, nodes, entry.filePath, rootUuid);
      if (!detail) {
        sendJson(res, 404, {
          error: `세그먼트를 찾을 수 없습니다: ${rootUuid}`,
        });
        return;
      }
      sendJson(res, 200, detail);
      return;
    }

    if (rest === "/body") {
      const uuid = url.searchParams.get("uuid");
      const node = uuid ? nodes.get(uuid) : undefined;
      if (!uuid || !node) {
        sendJson(res, 404, { error: `노드를 찾을 수 없습니다: ${uuid ?? ""}` });
        return;
      }
      let raw: string;
      try {
        raw = readLineAt(entry.filePath, node.byteOffset, node.byteLength);
      } catch (err) {
        sendJson(res, 409, {
          error: `본문을 읽지 못했습니다: ${(err as Error).message}`,
        });
        return;
      }
      // 위 ensureFresh가 대부분의 어긋남을 이미 재인덱싱으로 해소하지만,
      // 요청 처리 도중(재인덱싱 이후 seek 이전) 파일이 또 바뀌는 좁은 창은
      // 여전히 남는다. uuid 불일치는 그 마지막 방어선이다 (Spec "엣지 케이스").
      if (!rawMatchesUuid(raw, uuid)) {
        sendJson(res, 409, {
          error: "파일이 변경되었습니다. 잠시 후 다시 시도하세요",
        });
        return;
      }
      const body: NodeBody = { uuid, raw };
      sendJson(res, 200, body);
      return;
    }

    sendJson(res, 404, { error: "찾을 수 없습니다" });
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
 * `sessgraph serve <file...> [--port n]` — 127.0.0.1에만 바인딩하는
 * 읽기 전용 뷰어 서버를 기동하고 포그라운드에 머무른다
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

  const files = positionals;
  if (files.length === 0) {
    logError("세션 파일 경로가 필요합니다");
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

  const registry = registerSessions(files);
  const failed = [...registry.values()].filter((e) => e.failure);
  // 보여줄 수 있는 세션이 하나도 없으면 기동하지 않는다. 일부만 없으면
  // 기동하고 나머지는 그대로 보여준다 (Design "아키텍처").
  if (failed.length === registry.size) {
    logError(failed[0]!.failure!);
    return Promise.resolve(2);
  }

  const server = createServer(createRequestHandler(registry));

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
      log(`세션 ${registry.size}개 등록됨 · Ctrl-C로 종료`);
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
