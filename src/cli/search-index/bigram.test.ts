import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { bigramQuery, bigramTokens } from "./bigram.js";

describe("bigram", () => {
  it("인접한 코드 포인트 쌍마다 토큰 하나를 만들고 중복은 합친다", () => {
    assert.equal(bigramTokens("abab").split(" ").length, 2);
    assert.equal(bigramTokens("a"), "");
    assert.equal(bigramTokens(""), "");
  });

  it("질의 토큰은 본문 토큰 중 하나와 같다", () => {
    const tokens = bigramTokens("고아 페이지").split(" ");
    assert.ok(tokens.includes(bigramQuery("고아")!));
    assert.ok(tokens.includes(bigramQuery("아 ")!));
    assert.ok(!tokens.includes(bigramQuery("아고")!));
  });

  it("서로게이트 쌍을 한 글자로 센다", () => {
    assert.notEqual(bigramQuery("😀😀"), null);
    assert.equal(bigramQuery("😀"), null);
  });

  it("대소문자를 접고, 접어서 길이가 바뀌면 null", () => {
    assert.equal(bigramQuery("AB"), bigramQuery("ab"));
    assert.equal(bigramQuery("É\u0301"), bigramQuery("é\u0301"));
    assert.equal(bigramQuery("İx"), null);
  });
});
