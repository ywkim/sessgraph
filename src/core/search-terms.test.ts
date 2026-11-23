import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { highlightSegments, searchTerms } from "./search-terms.js";

function hits(text: string, query: string): string[] {
  return highlightSegments(text, query)
    .filter((s) => s.hit)
    .map((s) => s.text);
}

function joined(text: string, query: string): string {
  return highlightSegments(text, query)
    .map((s) => s.text)
    .join("");
}

describe("searchTerms", () => {
  it("공백으로 나누고 중복을 뺀다", () => {
    assert.deepEqual(searchTerms("a  b a"), ["a", "b"]);
  });

  it("전체가 큰따옴표면 안쪽이 낱말 하나다", () => {
    assert.deepEqual(searchTerms('"이게 답"'), ["이게 답"]);
  });

  it("공백뿐인 검색어는 그대로 낱말 하나다", () => {
    assert.deepEqual(searchTerms("  "), ["  "]);
  });
});

describe("highlightSegments", () => {
  it("대소문자를 무시하고 원문 글자를 그대로 돌려준다", () => {
    assert.deepEqual(hits("Measure Twice, cut once", "twice CUT"), [
      "Twice",
      "cut",
    ]);
  });

  it("한글 낱말을 찾는다", () => {
    assert.deepEqual(hits("이게 답이다. 이게답은 아니다", "이게"), [
      "이게",
      "이게",
    ]);
  });

  it("공백으로 나뉜 낱말은 각각 찾아 붙어 있으면 합쳐 칠한다", () => {
    assert.deepEqual(hits("이게답", "이게 답"), ["이게답"]);
  });

  it("따옴표 구절은 공백이 다른 변형을 일치로 치지 않는다", () => {
    assert.deepEqual(hits("이게답", '"이게 답"'), []);
  });

  it("따옴표 구절은 구절 전체를 한 덩어리로 칠한다", () => {
    assert.deepEqual(hits("a 이게 답 b 이게 c 답", '"이게 답"'), ["이게 답"]);
  });

  it("같은 낱말이 여러 번 나오면 모두 칠한다", () => {
    assert.deepEqual(hits("abcabc", "bc"), ["bc", "bc"]);
  });

  it("겹치거나 맞닿은 일치는 하나로 합친다", () => {
    assert.deepEqual(hits("abcde", "abc cde"), ["abcde"]);
    assert.deepEqual(hits("abcd", "ab cd"), ["abcd"]);
  });

  it("일치가 없으면 가르지 않는다", () => {
    assert.deepEqual(highlightSegments("abc", "zzz"), [
      { text: "abc", hit: false },
    ]);
  });

  it("소문자로 바꾸면 길이가 달라지는 글자가 있으면 가르지 않는다", () => {
    assert.deepEqual(highlightSegments("İstanbul abc", "abc"), [
      { text: "İstanbul abc", hit: false },
    ]);
  });

  it("앞뒤 `…`와 개행이 있어도 이어 붙이면 원문과 같다", () => {
    const text = "…앞\n중간 Foo 끝…";
    assert.equal(joined(text, "foo"), text);
    assert.deepEqual(hits(text, "foo"), ["Foo"]);
  });

  it("정규식 특수문자는 글자 그대로 찾는다", () => {
    assert.deepEqual(hits("a.b a+b (x)", ".b (x)"), [".b", "(x)"]);
  });

  it("빈 발췌는 빈 조각 하나 없이 돌려준다", () => {
    assert.deepEqual(highlightSegments("", "a"), [{ text: "", hit: false }]);
  });
});
