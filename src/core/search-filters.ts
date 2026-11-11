import type { SearchTier } from "./search-text.js";
import type { SearchFilters } from "./types.js";

/** 조건 없음 */
export const NO_FILTERS: SearchFilters = {
  since: null,
  until: null,
  tiers: null,
};

const ALL_TIERS: readonly SearchTier[] = ["conversation", "tool", "meta"];

export type ParsedFilters =
  | { readonly ok: true; readonly filters: SearchFilters }
  | { readonly ok: false; readonly error: string };

/**
 * 쿼리 문자열의 `since`·`until`·`tiers`를 검색 조건으로 해석한다. 순수 함수
 * (docs/spec/20261015-1821-search-index.spec.md "검색 조건").
 */
export function parseSearchFilters(params: {
  readonly since: string | null;
  readonly until: string | null;
  readonly tiers: string | null;
}): ParsedFilters {
  const since = normalizeTime(params.since);
  if (since === undefined) {
    return { ok: false, error: "시작 시각 형식이 올바르지 않습니다" };
  }
  const until = normalizeTime(params.until);
  if (until === undefined) {
    return { ok: false, error: "끝 시각 형식이 올바르지 않습니다" };
  }
  if (since !== null && until !== null && since >= until) {
    return { ok: false, error: "기간이 비어 있습니다" };
  }

  let tiers: readonly SearchTier[] | null = null;
  if (params.tiers !== null) {
    const picked = new Set<SearchTier>();
    for (const part of params.tiers.split(",")) {
      const tier = ALL_TIERS.find((t) => t === part);
      if (tier === undefined) {
        return { ok: false, error: "종류가 올바르지 않습니다" };
      }
      picked.add(tier);
    }
    // 셋을 모두 적으면 조건이 없는 것과 같다
    tiers =
      picked.size === ALL_TIERS.length
        ? null
        : ALL_TIERS.filter((t) => picked.has(t));
  }
  return { ok: true, filters: { since, until, tiers } };
}

/** 값이 없으면 null, 해석하지 못하면 undefined. */
function normalizeTime(value: string | null): string | null | undefined {
  if (value === null) return null;
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}
