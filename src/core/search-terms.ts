/**
 * 검색어의 낱말과 발췌 안의 일치 위치. 파일 I/O 없는 순수 함수
 * (docs/spec/20261015-1821-search-index.spec.md "검색어의 낱말", "화면").
 */

/**
 * Spec "검색어의 낱말" — 공백으로 나눈 낱말(중복 제거). 검색어 전체가 큰따옴표로
 * 감싸여 있으면 안쪽을 낱말 하나로 보고, 공백뿐인 검색어는 그대로 낱말 하나다.
 */
export function searchTerms(query: string): string[] {
  if (query.length > 2 && query.startsWith('"') && query.endsWith('"')) {
    return [query.slice(1, -1)];
  }
  const terms = [...new Set(query.split(/\s+/).filter((t) => t !== ""))];
  return terms.length > 0 ? terms : [query];
}

export interface TextSegment {
  readonly text: string;
  /** 검색어의 낱말과 일치하는 부분이면 true */
  readonly hit: boolean;
}

/**
 * 발췌를 검색어의 낱말과 일치하는 부분(대소문자 무시)과 아닌 부분으로 가른다.
 * 일치를 찾는 규칙은 발췌를 자르는 `excerptOf`와 같다: 낱말마다 부분 문자열로
 * 찾고, 소문자로 바꾸면 길이가 달라지는 글자(예: `İ`)가 있으면 위치를 맞출 수
 * 없어 가르지 않는다. 이어 붙이면 언제나 `text`와 같다.
 */
export function highlightSegments(
  text: string,
  query: string,
): readonly TextSegment[] {
  const lowered = text.toLowerCase();
  if (lowered.length !== text.length) return [{ text, hit: false }];

  const ranges: Array<[number, number]> = [];
  for (const term of searchTerms(query)) {
    const needle = term.toLowerCase();
    if (needle === "") continue;
    for (
      let i = lowered.indexOf(needle);
      i !== -1;
      i = lowered.indexOf(needle, i + needle.length)
    ) {
      ranges.push([i, i + needle.length]);
    }
  }
  if (ranges.length === 0) return [{ text, hit: false }];

  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      merged.push([range[0], range[1]]);
    }
  }

  const segments: TextSegment[] = [];
  let pos = 0;
  for (const [start, end] of merged) {
    if (start > pos)
      segments.push({ text: text.slice(pos, start), hit: false });
    segments.push({ text: text.slice(start, end), hit: true });
    pos = end;
  }
  if (pos < text.length) segments.push({ text: text.slice(pos), hit: false });
  return segments;
}
