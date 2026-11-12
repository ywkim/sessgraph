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

/** 처음 화면의 종류. 대화 글을 찾는 일이 가장 많아 도구·기타는 꺼 둔다 (Spec "검색 조건 입력"). */
export const DEFAULT_TIERS: readonly Tier[] = ["conversation"];

export type Period = "all" | "7d" | "30d" | "90d";

/** 기간 선택지. `days`는 오늘을 포함한 날 수이고 `all`은 제한이 없다. */
export const PERIODS: readonly {
  readonly value: Period;
  readonly label: string;
  readonly days: number | null;
}[] = [
  { value: "all", label: "전체", days: null },
  { value: "7d", label: "최근 7일", days: 7 },
  { value: "30d", label: "최근 30일", days: 30 },
  { value: "90d", label: "최근 90일", days: 90 },
];

export interface FilterInput {
  readonly tiers: ReadonlySet<Tier>;
  readonly period: Period;
}

export function allTiers(input: FilterInput): boolean {
  return TIER_ORDER.every((t) => input.tiers.has(t));
}

/** 기간의 시작 시각(UTC ISO). 로컬 시간대의 오늘 0시에서 days-1일 전. 제한이 없으면 null. */
function periodSince(period: Period, now: Date): string | null {
  const days = PERIODS.find((p) => p.value === period)?.days ?? null;
  if (days === null) return null;
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - (days - 1),
  ).toISOString();
}

/**
 * 요청에 덧붙일 쿼리 문자열(`&since=…&tiers=…`). 기본값인 조건은 싣지 않는다.
 * `now`는 "오늘"의 기준이다.
 */
export function filterQuery(input: FilterInput, now = new Date()): string {
  const params = new URLSearchParams();
  const since = periodSince(input.period, now);
  if (since) params.set("since", since);
  if (!allTiers(input)) {
    params.set("tiers", TIER_ORDER.filter((t) => input.tiers.has(t)).join(","));
  }
  const text = params.toString();
  return text ? `&${text}` : "";
}

function isDefaultTiers(input: FilterInput): boolean {
  return (
    input.tiers.size === DEFAULT_TIERS.length &&
    DEFAULT_TIERS.every((t) => input.tiers.has(t))
  );
}

/** 기본값과 다른 조건이 있으면 한 줄로, 없으면 "". */
export function describeFilters(input: FilterInput): string {
  const parts: string[] = [];
  const period = PERIODS.find((p) => p.value === input.period);
  if (period && period.days !== null) {
    parts.push(`기간 ${period.label}`);
  }
  if (!isDefaultTiers(input)) {
    parts.push(
      `종류 ${TIER_ORDER.filter((t) => input.tiers.has(t))
        .map((t) => TIER_NAME[t])
        .join(", ")}`,
    );
  }
  return parts.length ? `조건: ${parts.join(" · ")}` : "";
}

/** 체크하지 않은 종류. 없으면 빈 배열. */
export function excludedTiers(input: FilterInput): Tier[] {
  return TIER_ORDER.filter((t) => !input.tiers.has(t));
}

/** 제외된 종류의 매치가 더 있다는 안내 문구. 건수가 0이거나 제외한 종류가 없으면 "". */
export function describeExcluded(input: FilterInput, count: number): string {
  const tiers = excludedTiers(input);
  if (count <= 0 || tiers.length === 0) return "";
  const names = tiers.map((t) => TIER_NAME[t]).join("·");
  return `${names}에도 ${count.toLocaleString("ko-KR")}건 더 있습니다`;
}
