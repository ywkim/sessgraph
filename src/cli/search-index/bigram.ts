/**
 * 2글자 검색용 보조 색인의 토큰 (docs/spec/20261015-1821-search-index.spec.md "색인 파일").
 *
 * trigram은 3글자 미만 검색어를 처리하지 못한다. 본문의 인접한 두 코드 포인트를
 * 토큰 하나로 바꿔 FTS5(`unicode61`)에 넣으면 2글자 검색이 토큰 하나의 조회가 된다.
 * 토큰은 코드 포인트를 16진수로 적은 `x` + 6자리 두 개이므로 FTS5 토크나이저가
 * 자르거나 접지 않는다. 대소문자는 이 함수가 유니코드 소문자로 접는다.
 */

function hex(codePoint: number): string {
  return codePoint.toString(16).padStart(6, "0");
}

function tokenOf(a: number, b: number): string {
  return `x${hex(a)}${hex(b)}`;
}

function codePointsOf(text: string): number[] {
  return Array.from(text.toLowerCase(), (c) => c.codePointAt(0)!);
}

/** 본문의 인접한 코드 포인트 쌍마다 토큰 하나 (중복 제거). 2글자 미만이면 빈 문자열. */
export function bigramTokens(text: string): string {
  const cps = codePointsOf(text);
  const tokens = new Set<string>();
  for (let i = 0; i + 1 < cps.length; i++) {
    tokens.add(tokenOf(cps[i]!, cps[i + 1]!));
  }
  return [...tokens].join(" ");
}

/**
 * 2글자 검색어의 토큰. 소문자로 접은 뒤 코드 포인트가 정확히 둘이 아니면 null —
 * 접으면 길이가 바뀌는 글자(예: `İ`)는 호출한 쪽이 `LIKE`로 대신한다.
 */
export function bigramQuery(query: string): string | null {
  const cps = codePointsOf(query);
  return cps.length === 2 ? tokenOf(cps[0]!, cps[1]!) : null;
}
