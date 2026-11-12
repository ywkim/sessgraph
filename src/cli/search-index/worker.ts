/**
 * 검색 색인 워커. DB 연결을 단독 소유하고 동기화와 질의를 직렬로 처리한다
 * (docs/design/20261015-1821-search-index.tdd.md "워커 하나가 DB를 소유한다").
 */
import { statSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

import type {
  IndexProgress,
  SearchReply,
  SearchRequest,
  SearchResult,
  WorkerInit,
} from "./protocol.js";
import { SearchStore } from "./store.js";

const init = workerData as WorkerInit;
const port = parentPort!;

/** 이번 기동에서 동기화를 마친 경로와, 그때의 지문 */
const synced = new Map<string, { ino: number; size: number } | null>();

let store: SearchStore | null = null;
let unavailable: string | null = null;
try {
  store = SearchStore.open(init.cacheDir);
} catch (err) {
  unavailable = (err as Error).message;
}

function fingerprint(p: string): { ino: number; size: number } | null {
  try {
    const s = statSync(p);
    return { ino: s.ino, size: s.size };
  } catch {
    return null;
  }
}

function syncPath(s: SearchStore, p: string): void {
  const before = fingerprint(p);
  s.sync(p);
  synced.set(p, before);
}

/** 지문이 바뀐 경로만 다시 동기화한다. 첫 동기화 전인 경로는 백그라운드에 맡긴다. */
function refresh(s: SearchStore, paths: readonly string[]): void {
  for (const p of paths) {
    if (!synced.has(p)) continue;
    const prev = synced.get(p);
    const now = fingerprint(p);
    if (
      prev === null ||
      now === null ||
      prev === undefined ||
      prev.ino !== now.ino ||
      prev.size !== now.size
    ) {
      syncPath(s, p);
    }
  }
}

function progress(s: SearchStore): {
  readonly index: IndexProgress;
  readonly eligible: Set<string>;
} {
  const failed: { path: string; reason: string }[] = [];
  const suspect: string[] = [];
  const eligible = new Set<string>();
  for (const state of s.states(init.paths)) {
    if (state.failure === null) eligible.add(state.path);
    if (!synced.has(state.path)) continue;
    if (state.failure !== null) {
      failed.push({ path: state.path, reason: state.failure });
    }
    if (state.suspect) suspect.push(state.path);
  }
  return {
    index: {
      ready: synced.size === init.paths.length,
      indexedSessions: synced.size,
      totalSessions: init.paths.length,
      failed,
      suspect,
    },
    eligible,
  };
}

function handle(req: SearchRequest): SearchReply {
  if (store === null) {
    return {
      id: req.id,
      error: { code: "unavailable", message: unavailable ?? "알 수 없음" },
    };
  }
  const start = performance.now();
  try {
    refresh(store, req.kind === "all" ? init.paths : [req.path]);
    const { index, eligible } = progress(store);
    let result: SearchResult;
    if (req.kind === "all") {
      const r = store.searchAll(req.query, eligible, req.filters);
      result = {
        kind: "all",
        index,
        sessions: r.sessions,
        truncatedSessions: r.truncatedSessions,
        excludedMatchCount: r.excludedMatchCount,
        durationMs: performance.now() - start,
      };
    } else {
      const r = eligible.has(req.path)
        ? store.searchOne(req.query, req.path, req.filters)
        : { matchCount: 0, matches: [], excludedMatchCount: 0 };
      result = {
        kind: "one",
        index,
        matchCount: r.matchCount,
        matches: r.matches,
        excludedMatchCount: r.excludedMatchCount,
        durationMs: performance.now() - start,
      };
    }
    return { id: req.id, result };
  } catch (err) {
    return {
      id: req.id,
      error: { code: "failed", message: (err as Error).message },
    };
  }
}

port.on("message", (req: SearchRequest) => {
  port.postMessage(handle(req));
});

/**
 * 최근에 바뀐 세션부터 한 파일씩 동기화한다. 파일 사이마다 이벤트 루프에
 * 양보해 그 사이에 들어온 검색 요청을 먼저 처리한다 (Spec "기동과 첫 생성").
 */
function background(): void {
  if (store === null) return;
  const s = store;
  const queue = [...init.paths]
    .map((p) => {
      try {
        return { p, mtime: statSync(p).mtimeMs };
      } catch {
        return { p, mtime: -Infinity };
      }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map(({ p }) => p);
  const step = () => {
    const next = queue.shift();
    if (next === undefined) return;
    if (!synced.has(next)) syncPath(s, next);
    setImmediate(step);
  };
  setImmediate(step);
}

background();
