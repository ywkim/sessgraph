import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseSearchFilters } from "./search-filters.js";

const parse = (
  since: string | null,
  until: string | null,
  tiers: string | null,
) => parseSearchFilters({ since, until, tiers });

describe("parseSearchFilters", () => {
  it("값이 없으면 조건이 없다", () => {
    assert.deepEqual(parse(null, null, null), {
      ok: true,
      filters: { since: null, until: null, tiers: null },
    });
  });

  it("시각은 UTC 밀리초 Z 문자열로 정규화한다", () => {
    const r = parse("2026-01-01T09:00:00+09:00", "2026-01-02", null);
    assert.deepEqual(r, {
      ok: true,
      filters: {
        since: "2026-01-01T00:00:00.000Z",
        until: "2026-01-02T00:00:00.000Z",
        tiers: null,
      },
    });
  });

  it("종류는 중복을 하나로 보고, 셋 모두면 조건 없음이다", () => {
    assert.deepEqual(parse(null, null, "tool,conversation,tool"), {
      ok: true,
      filters: { since: null, until: null, tiers: ["conversation", "tool"] },
    });
    assert.deepEqual(parse(null, null, "meta,tool,conversation"), {
      ok: true,
      filters: { since: null, until: null, tiers: null },
    });
  });

  it("잘못된 값은 사유를 돌려준다", () => {
    assert.deepEqual(parse("x", null, null), {
      ok: false,
      error: "시작 시각 형식이 올바르지 않습니다",
    });
    assert.deepEqual(parse(null, "x", null), {
      ok: false,
      error: "끝 시각 형식이 올바르지 않습니다",
    });
    assert.deepEqual(parse("2026-01-02", "2026-01-02", null), {
      ok: false,
      error: "기간이 비어 있습니다",
    });
    assert.deepEqual(parse(null, null, ""), {
      ok: false,
      error: "종류가 올바르지 않습니다",
    });
    assert.deepEqual(parse(null, null, "tool,foo"), {
      ok: false,
      error: "종류가 올바르지 않습니다",
    });
  });
});
