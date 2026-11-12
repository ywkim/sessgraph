import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  describeExcluded,
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
  it("종류 셋 모두에 기간 전체면 아무것도 싣지 않는다", () => {
    assert.equal(filterQuery(input(), NOW), "");
  });

  it("처음 화면의 종류(대화만)는 tiers=conversation을 싣고 조건 줄은 없다", () => {
    const first = input(["conversation"]);
    assert.equal(filterQuery(first, NOW), "&tiers=conversation");
    assert.equal(describeFilters(first), "");
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
      describeFilters(input(["conversation"], "7d")),
      "조건: 기간 최근 7일",
    );
    assert.equal(describeFilters(input(["meta"])), "조건: 종류 기타");
  });

  it("기본값과 다르면 종류 셋 모두도 조건 줄에 보인다", () => {
    assert.equal(describeFilters(input()), "조건: 종류 대화, 도구, 기타");
  });
});

describe("describeExcluded", () => {
  it("빠진 종류의 이름과 건수를 한 줄로 보여준다", () => {
    assert.equal(
      describeExcluded(input(["conversation"]), 1234),
      "도구·기타에도 1,234건 더 있습니다",
    );
    assert.equal(
      describeExcluded(input(["conversation", "tool"]), 3),
      "기타에도 3건 더 있습니다",
    );
  });

  it("건수가 0이거나 빠진 종류가 없으면 비어 있다", () => {
    assert.equal(describeExcluded(input(["conversation"]), 0), "");
    assert.equal(describeExcluded(input(), 5), "");
  });
});
