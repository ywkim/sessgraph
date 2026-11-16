/**
 * 검색 입력줄(검색어·종류·기간)의 상태와 그 전이. DOM과 컴포넌트에서 떨어진
 * 순수 함수라 노드 테스트로 확인한다 (docs/spec/20261015-1821-search-index.spec.md
 * "검색 조건 입력").
 */
import {
  DEFAULT_TIERS,
  type FilterInput,
  type Period,
  type Tier,
} from "./search-filters.js";

export interface SearchFormState {
  /** 입력칸에 적힌 그대로. 찾을 때는 앞뒤 공백을 뗀다. */
  readonly query: string;
  readonly filters: FilterInput;
}

export function initialSearchForm(): SearchFormState {
  return {
    query: "",
    filters: { tiers: new Set(DEFAULT_TIERS), period: "all" },
  };
}

export function withQuery(
  state: SearchFormState,
  query: string,
): SearchFormState {
  return { ...state, query };
}

export function withTier(
  state: SearchFormState,
  tier: Tier,
  on: boolean,
): SearchFormState {
  const tiers = new Set(state.filters.tiers);
  if (on) tiers.add(tier);
  else tiers.delete(tier);
  return { ...state, filters: { ...state.filters, tiers } };
}

export function withTiers(
  state: SearchFormState,
  add: readonly Tier[],
): SearchFormState {
  const tiers = new Set(state.filters.tiers);
  for (const tier of add) tiers.add(tier);
  return { ...state, filters: { ...state.filters, tiers } };
}

export function withPeriod(
  state: SearchFormState,
  period: Period,
): SearchFormState {
  return { ...state, filters: { ...state.filters, period } };
}

/** 조건을 바꿨을 때 다시 찾을 검색어. 검색어가 비어 있으면 찾지 않는다 (Spec "검색 조건 입력"). */
export function queryToRerun(state: SearchFormState): string | null {
  const query = state.query.trim();
  return query === "" ? null : query;
}
