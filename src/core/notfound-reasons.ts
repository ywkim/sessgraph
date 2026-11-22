/**
 * "못 찾았다"를 누른 뒤 고르는 이유 (Spec "검색 기록"). 화면과 서버가 같은 목록을 쓴다.
 * 사용자의 자기 판단이라 실제 원인과 다를 수 있다.
 */
export const NOTFOUND_REASONS = [
  { code: "wrong-term", label: "낱말을 잘못 골랐다" },
  { code: "not-in-results", label: "결과에 그 내용이 없다" },
  { code: "below-fold", label: "결과에 있는데 아래쪽이라 못 봤다" },
  { code: "filtered", label: "기간·종류 조건에 걸렸다" },
  { code: "other", label: "기타" },
] as const;

export type NotfoundReason = (typeof NOTFOUND_REASONS)[number]["code"];

export function isNotfoundReason(value: string): value is NotfoundReason {
  return NOTFOUND_REASONS.some((r) => r.code === value);
}
