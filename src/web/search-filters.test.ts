import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  describeFilters,
  filterQuery,
  type FilterInput,
  type Period,
  type Tier,
} from "./search-filters.js";

const NOW = new Date(2026, 10, 12, 15, 30);

const input = (
  tiers: Tier[] = ["conversation", "tool", "meta"],
  period: Period = "all",
): FilterInput => ({ tiers: new Set(tiers), period });

describe("filterQuery", () => {
  it("기본값이면 아무것도 싣지 않는다", () => {
    assert.equal(filterQuery(input(), NOW), "");
    assert.equal(describeFilters(input()), "");
  });

  it("최근 N일은 오늘을 포함한 N일 전 0시(로컬 시간대)부터다", () => {
    const week = new URLSearchParams(filterQuery(input(undefined, "7d"), NOW));
    assert.equal(week.get("since"), new Date(2026, 10, 6).toISOString());
    assert.equal(week.get("until"), null);
    const month = new URLSearchParams(
      filterQuery(input(undefined, "30d"), NOW),
    );
    assert.equal(month.get("since"), new Date(2026, 9, 14).toISOString());
  });

  it("달·해를 넘겨도 맞다", () => {
    const q = new URLSearchParams(
      filterQuery(input(undefined, "90d"), new Date(2026, 0, 10, 9)),
    );
    assert.equal(q.get("since"), new Date(2025, 9, 13).toISOString());
  });

  it("종류는 고른 것만 순서대로 싣는다", () => {
    const q = new URLSearchParams(
      filterQuery(input(["tool", "conversation"]), NOW),
    );
    assert.equal(q.get("tiers"), "conversation,tool");
    assert.equal(q.get("since"), null);
  });
});

describe("describeFilters", () => {
  it("기간과 종류를 한 줄로 보여준다", () => {
    assert.equal(
      describeFilters(input(["conversation", "tool"], "30d")),
      "조건: 기간 최근 30일 · 종류 대화, 도구",
    );
    assert.equal(
      describeFilters(input(undefined, "7d")),
      "조건: 기간 최근 7일",
    );
    assert.equal(describeFilters(input(["meta"])), "조건: 종류 기타");
  });
});
