/**
 * 검색 워커의 메인 스레드 쪽 Promise 래퍼
 * (docs/design/20261015-1821-search-index.tdd.md "아키텍처").
 */
import { Worker } from "node:worker_threads";

import type { SearchFilters } from "../../core/types.js";
import { NO_FILTERS } from "../../core/search-filters.js";
import type {
  SearchReply,
  SearchRequest,
  SearchResult,
  WorkerInit,
} from "./protocol.js";

export class SearchIndexError extends Error {
  readonly code: "unavailable" | "failed";

  constructor(code: "unavailable" | "failed", message: string) {
    super(message);
    this.code = code;
  }
}

type Pending = {
  readonly resolve: (r: SearchResult) => void;
  readonly reject: (e: SearchIndexError) => void;
};

export class SearchIndexClient {
  readonly #worker: Worker;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  /** 워커가 죽었으면 그 사유. 이후 요청은 모두 unavailable */
  #dead: string | null = null;

  constructor(init: WorkerInit) {
    this.#worker = new Worker(new URL("./worker.js", import.meta.url), {
      workerData: init,
    });
    this.#worker.on("message", (reply: SearchReply) => {
      const pending = this.#pending.get(reply.id);
      if (!pending) return;
      this.#pending.delete(reply.id);
      if ("result" in reply) pending.resolve(reply.result);
      else
        pending.reject(
          new SearchIndexError(reply.error.code, reply.error.message),
        );
    });
    this.#worker.on("error", (err) => this.#fail(err.message));
    this.#worker.on("exit", (code) =>
      this.#fail(`검색 워커가 종료되었습니다 (코드 ${code})`),
    );
  }

  searchAll(
    query: string,
    filters: SearchFilters = NO_FILTERS,
  ): Promise<SearchResult & { kind: "all" }> {
    return this.#send({
      id: this.#nextId++,
      kind: "all",
      query,
      filters,
    }) as Promise<SearchResult & { kind: "all" }>;
  }

  searchOne(
    query: string,
    path: string,
    filters: SearchFilters = NO_FILTERS,
  ): Promise<SearchResult & { kind: "one" }> {
    return this.#send({
      id: this.#nextId++,
      kind: "one",
      query,
      path,
      filters,
    }) as Promise<SearchResult & { kind: "one" }>;
  }

  async close(): Promise<void> {
    await this.#worker.terminate();
  }

  #send(req: SearchRequest): Promise<SearchResult> {
    if (this.#dead !== null) {
      return Promise.reject(new SearchIndexError("unavailable", this.#dead));
    }
    return new Promise((resolve, reject) => {
      this.#pending.set(req.id, { resolve, reject });
      this.#worker.postMessage(req);
    });
  }

  #fail(reason: string): void {
    if (this.#dead !== null) return;
    this.#dead = reason;
    for (const p of this.#pending.values()) {
      p.reject(new SearchIndexError("unavailable", reason));
    }
    this.#pending.clear();
  }
}
