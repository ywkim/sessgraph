import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import path from "node:path";

import type { SearchFilters } from "../core/types.js";

/**
 * 검색 기록 — 검색어와 결과에서 누른 세션을 남겨 검색 품질 평가에 쓴다
 * (docs/spec/20261015-1821-search-index.spec.md "검색 기록").
 *
 * 실제 세션 내용이 담기므로 캐시 디렉터리에 소유자만 읽는 파일로 둔다.
 */
export type SearchLogEvent =
  | {
      readonly kind: "search";
      readonly at: string;
      readonly query: string;
      /** 검색에 건 조건. 안 건 조건은 null. 이 필드가 없는 줄은 조건 없는 검색이다 */
      readonly filters: SearchFilters;
      /** 세션 하나 검색이면 그 세션 id, 전 세션 검색이면 null */
      readonly sessionId: string | null;
      /** 전 세션 검색 결과의 세션 id, 순위 순. 세션 하나 검색이면 빈 배열 */
      readonly results: readonly string[];
      readonly matchCount: number;
      readonly indexReady: boolean;
      readonly durationMs: number;
      /** 전 세션 검색에만 있다. 이어지는 open·answer·notfound가 이 값으로 검색에 이어진다 */
      readonly searchId?: string;
    }
  | {
      readonly kind: "open";
      readonly at: string;
      readonly query: string;
      /** 그 검색에 걸었던 조건. 순위는 이 조건을 적용한 결과의 순위다 */
      readonly filters: SearchFilters;
      readonly sessionId: string;
      /** 전 세션 결과에서 그 세션의 순위 (1부터) */
      readonly rank: number;
      readonly uuid: string;
      /** 화면이 실어 보낸 검색 id. 없으면 어느 검색에서 눌렀는지 잇지 못한다 */
      readonly searchId?: string;
    }
  | {
      /** 매치 하나를 "이게 답"으로 표시했다 */
      readonly kind: "answer";
      readonly at: string;
      readonly searchId: string;
      readonly query: string;
      readonly filters: SearchFilters;
      readonly sessionId: string;
      /** 전 세션 결과에서 그 세션의 순위 (1부터) */
      readonly rank: number;
      /** 그 세션이 보여 준 매치 중 이 매치의 위치 (1부터) */
      readonly snippetIndex: number;
      readonly uuid: string;
      /** 그 세션이 보여 준 매치의 uuid, 화면 순서. uuid가 없는 매치는 null */
      readonly shown: readonly (string | null)[];
    }
  | {
      /** 이 검색에서 원하는 것을 못 찾았다고 표시했다 */
      readonly kind: "notfound";
      readonly at: string;
      readonly searchId: string;
      readonly query: string;
      readonly filters: SearchFilters;
      readonly matchCount: number;
    };

type WithoutAt<T> = T extends unknown ? Omit<T, "at"> : never;

export interface SearchLog {
  record(event: WithoutAt<SearchLogEvent>): void;
}

export const SEARCH_LOG_FILE = "search-log.jsonl";

/** 한 줄 append. 쓰기에 실패해도 검색 응답에는 영향을 주지 않는다. */
export class FileSearchLog implements SearchLog {
  readonly filePath: string;

  constructor(
    cacheDir: string,
    private readonly onError: (message: string) => void = () => {},
  ) {
    this.filePath = path.join(cacheDir, SEARCH_LOG_FILE);
  }

  record(event: WithoutAt<SearchLogEvent>): void {
    const line = JSON.stringify({ at: new Date().toISOString(), ...event });
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      appendFileSync(this.filePath, line + "\n", { mode: 0o600 });
      chmodSync(this.filePath, 0o600);
    } catch (err) {
      this.onError(`검색 기록을 남기지 못했습니다: ${(err as Error).message}`);
    }
  }
}
