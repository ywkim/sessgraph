/**
 * 메인 스레드와 검색 워커 사이의 메시지. `node:sqlite`를 불러오지 않는다 —
 * 메인 스레드는 이 파일과 client.ts만 본다.
 */
import type { SearchTier } from "../../core/search-text.js";
import type { SearchFilters } from "../../core/types.js";

export interface WorkerInit {
  readonly cacheDir: string;
  /** 이번 `serve`에 등록된 세션 파일 경로 */
  readonly paths: readonly string[];
}

export type SearchRequest =
  | {
      readonly id: number;
      readonly kind: "all";
      readonly query: string;
      readonly filters: SearchFilters;
    }
  | {
      readonly id: number;
      readonly kind: "one";
      readonly query: string;
      readonly path: string;
      readonly filters: SearchFilters;
    };

export interface IndexProgress {
  /** 등록 경로가 모두 이번 기동에서 한 번 이상 동기화를 마쳤는가 */
  readonly ready: boolean;
  readonly indexedSessions: number;
  readonly totalSessions: number;
  readonly failed: readonly {
    readonly path: string;
    readonly reason: string;
  }[];
  readonly suspect: readonly string[];
}

export interface WorkerMatch {
  readonly tier: SearchTier;
  readonly timestamp: string | null;
  readonly uuid: string | null;
  readonly excerpt: string;
}

export interface WorkerSessionHits {
  readonly path: string;
  readonly bestTier: SearchTier;
  readonly latestAt: string | null;
  readonly matchCount: number;
  readonly matches: readonly WorkerMatch[];
}

export type SearchResult =
  | {
      readonly kind: "all";
      readonly index: IndexProgress;
      readonly sessions: readonly WorkerSessionHits[];
      readonly truncatedSessions: boolean;
      /** 종류 조건 때문에 빠진 매치의 수 */
      readonly excludedMatchCount: number;
      readonly durationMs: number;
    }
  | {
      readonly kind: "one";
      readonly index: IndexProgress;
      readonly matchCount: number;
      readonly matches: readonly WorkerMatch[];
      /** 종류 조건 때문에 빠진 매치의 수 */
      readonly excludedMatchCount: number;
      readonly durationMs: number;
    };

export type SearchReply =
  | { readonly id: number; readonly result: SearchResult }
  | {
      readonly id: number;
      readonly error: {
        /** unavailable: 색인을 열 수 없음 (Spec "캐시 디렉터리를 만들 수 없음") */
        readonly code: "unavailable" | "failed";
        readonly message: string;
      };
    };
