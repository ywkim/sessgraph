/**
 * 검색 조건 입력을 요청 값과 안내 문구로 바꾸는 순수 함수
 * (docs/spec/20261015-1821-search-index.spec.md "검색 조건 입력").
 */
export type Tier = "conversation" | "tool" | "meta";

export const TIER_ORDER: readonly Tier[] = ["conversation", "tool", "meta"];
const TIER_NAME: Record<Tier, string> = {
  conversation: "대화",
  tool: "도구",
  meta: "기타",
};

export interface FilterInput {
  readonly tiers: ReadonlySet<Tier>;
  /** `YYYY-MM-DD`. 비어 있으면 "" */
  readonly from: string;
  readonly to: string;
}

/** 로컬 시간대의 `YYYY-MM-DD` 0시를 UTC ISO 문자열로. 해석하지 못하면 null. */
function localMidnight(date: string, plusDays: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + plusDays);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function allTiers(input: FilterInput): boolean {
  return TIER_ORDER.every((t) => input.tiers.has(t));
}

/**
 * 요청에 덧붙일 쿼리 문자열(`&since=…&until=…&tiers=…`). 기본값인 조건은 싣지
 * 않는다. 시작일은 그날 0시, 끝일은 다음 날 0시가 된다.
 */
export function filterQuery(input: FilterInput): string {
  const params = new URLSearchParams();
  const since = localMidnight(input.from, 0);
  if (since) params.set("since", since);
  const until = localMidnight(input.to, 1);
  if (until) params.set("until", until);
  if (!allTiers(input)) {
    params.set("tiers", TIER_ORDER.filter((t) => input.tiers.has(t)).join(","));
  }
  const text = params.toString();
  return text ? `&${text}` : "";
}

/** 기본값과 다른 조건이 있으면 한 줄로, 없으면 "". */
export function describeFilters(input: FilterInput): string {
  const parts: string[] = [];
  if (input.from || input.to) {
    parts.push(`기간 ${input.from}~${input.to}`);
  }
  if (!allTiers(input)) {
    parts.push(
      `종류 ${TIER_ORDER.filter((t) => input.tiers.has(t))
        .map((t) => TIER_NAME[t])
        .join(", ")}`,
    );
  }
  return parts.length ? `조건: ${parts.join(" · ")}` : "";
}
