import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialSearchForm,
  queryToRerun,
  withPeriod,
  withQuery,
  withTier,
  withTiers,
} from "./search-form-state.js";

test("처음에는 대화만 켜져 있고 기간은 전체다", () => {
  const state = initialSearchForm();
  assert.deepEqual([...state.filters.tiers], ["conversation"]);
  assert.equal(state.filters.period, "all");
  assert.equal(state.query, "");
});

test("종류를 켜고 끄면 새 상태를 돌려주고 원래 상태는 그대로다", () => {
  const before = initialSearchForm();
  const on = withTier(before, "tool", true);
  assert.deepEqual([...on.filters.tiers].sort(), ["conversation", "tool"]);
  assert.deepEqual([...before.filters.tiers], ["conversation"]);
  const off = withTier(on, "conversation", false);
  assert.deepEqual([...off.filters.tiers], ["tool"]);
});

test("withTiers는 이미 켜진 종류를 겹쳐 넣지 않는다", () => {
  const state = withTiers(initialSearchForm(), ["conversation", "meta"]);
  assert.deepEqual([...state.filters.tiers].sort(), ["conversation", "meta"]);
});

test("기간을 바꿔도 종류와 검색어는 유지된다", () => {
  const state = withPeriod(
    withQuery(withTier(initialSearchForm(), "tool", true), "대기열"),
    "7d",
  );
  assert.equal(state.filters.period, "7d");
  assert.equal(state.query, "대기열");
  assert.equal(state.filters.tiers.has("tool"), true);
});

test("다시 찾을 검색어는 앞뒤 공백을 떼고, 비어 있으면 null이다", () => {
  assert.equal(
    queryToRerun(withQuery(initialSearchForm(), "  압축 까지 ")),
    "압축 까지",
  );
  assert.equal(queryToRerun(withQuery(initialSearchForm(), "   ")), null);
  assert.equal(queryToRerun(initialSearchForm()), null);
});
