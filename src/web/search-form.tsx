/**
 * 검색 입력줄 컴포넌트. 상태는 `mountSearchForm`의 닫힌 변수에만 있고, 바깥(app.ts)은
 * `onSearch`로 찾을 때만 알림을 받으며 `SearchFormHandle`로만 읽고 바꾼다.
 * 이 영역의 DOM은 Preact만 만진다 (ADR-0010).
 */
import { render } from "preact";
import {
  PERIODS,
  TIER_NAME,
  TIER_ORDER,
  type FilterInput,
  type Period,
  type Tier,
} from "./search-filters.js";
import {
  initialSearchForm,
  queryToRerun,
  withPeriod,
  withQuery,
  withTier,
  withTiers,
  type SearchFormState,
} from "./search-form-state.js";

export interface SearchFormProps {
  readonly state: SearchFormState;
  readonly onQuery: (query: string) => void;
  readonly onTier: (tier: Tier, on: boolean) => void;
  readonly onPeriod: (period: Period) => void;
  readonly onSubmit: () => void;
}

export function SearchForm(props: SearchFormProps) {
  const { state } = props;
  return (
    <form
      class="search-form"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit();
      }}
    >
      <input
        id="search-input"
        type="search"
        name="q"
        placeholder="본문에서 찾기…"
        autocomplete="off"
        value={state.query}
        onInput={(e) => props.onQuery(e.currentTarget.value)}
      />
      <button type="submit">찾기</button>
      <div class="search-filters">
        <fieldset class="search-tiers">
          <legend>종류</legend>
          {TIER_ORDER.map((tier) => (
            <label key={tier}>
              <input
                type="checkbox"
                name="tier"
                value={tier}
                checked={state.filters.tiers.has(tier)}
                onChange={(e) => props.onTier(tier, e.currentTarget.checked)}
              />
              {TIER_NAME[tier]}
            </label>
          ))}
        </fieldset>
        <label class="search-period">
          기간{" "}
          <select
            value={state.filters.period}
            onChange={(e) => props.onPeriod(e.currentTarget.value as Period)}
          >
            {PERIODS.map((period) => (
              <option key={period.value} value={period.value}>
                {period.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </form>
  );
}

export interface SearchFormHandle {
  /** 종류를 켠다. 검색어가 있으면 다시 찾는다. */
  enableTiers(tiers: readonly Tier[]): void;
}

/**
 * `root` 안에 입력줄을 그린다. 찾기 버튼과 Enter는 검색어가 비어 있어도
 * `onSearch`를 부르고(결과를 비운다), 조건을 바꿀 때는 검색어가 있을 때만 부른다.
 */
export function mountSearchForm(
  root: HTMLElement,
  onSearch: (query: string, filters: FilterInput) => void,
): SearchFormHandle {
  let state = initialSearchForm();

  const update = (next: SearchFormState, rerun: boolean): void => {
    state = next;
    draw();
    const query = queryToRerun(state);
    if (rerun && query) onSearch(query, state.filters);
  };

  const draw = (): void => {
    render(
      <SearchForm
        state={state}
        onQuery={(query) => update(withQuery(state, query), false)}
        onTier={(tier, on) => update(withTier(state, tier, on), true)}
        onPeriod={(period) => update(withPeriod(state, period), true)}
        onSubmit={() => onSearch(state.query.trim(), state.filters)}
      />,
      root,
    );
  };
  draw();

  return {
    enableTiers: (tiers) => update(withTiers(state, tiers), true),
  };
}
