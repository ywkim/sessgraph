import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  describeFilters,
  filterQuery,
  type FilterInput,
  type Tier,
} from "./search-filters.js";

const input = (
  tiers: Tier[] = ["conversation", "tool", "meta"],
  from = "",
  to = "",
): FilterInput => ({ tiers: new Set(tiers), from, to });

describe("filterQuery", () => {
  it("기본값이면 아무것도 싣지 않는다", () => {
    assert.equal(filterQuery(input()), "");
    assert.equal(describeFilters(input()), "");
  });

  it("시작일은 그날 0시, 끝일은 다음 날 0시(로컬 시간대)다", () => {
    const q = new URLSearchParams(
      filterQuery(input(undefined, "2026-11-01", "2026-11-10")),
    );
    assert.equal(q.get("since"), new Date(2026, 10, 1).toISOString());
    assert.equal(q.get("until"), new Date(2026, 10, 11).toISOString());
    assert.equal(q.get("tiers"), null);
  });

  it("한쪽만 있어도 된다. 달·해를 넘기는 끝일도 맞다", () => {
    const only = new URLSearchParams(
      filterQuery(input(undefined, "", "2026-12-31")),
    );
    assert.equal(only.get("since"), null);
    assert.equal(only.get("until"), new Date(2027, 0, 1).toISOString());
  });

  it("종류는 고른 것만 순서대로 싣는다", () => {
    const q = new URLSearchParams(filterQuery(input(["tool", "conversation"])));
    assert.equal(q.get("tiers"), "conversation,tool");
  });
});

describe("describeFilters", () => {
  it("기간과 종류를 한 줄로 보여준다", () => {
    assert.equal(
      describeFilters(
        input(["conversation", "tool"], "2026-11-01", "2026-11-10"),
      ),
      "조건: 기간 2026-11-01~2026-11-10 · 종류 대화, 도구",
    );
    assert.equal(
      describeFilters(input(undefined, "2026-11-01")),
      "조건: 기간 2026-11-01~",
    );
    assert.equal(describeFilters(input(["meta"])), "조건: 종류 기타");
  });
});
