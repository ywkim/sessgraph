import test from "node:test";
import assert from "node:assert/strict";

import { resolveSegmentBranches } from "./segment-branch.js";
import type { NodeIndex } from "./types.js";

function node(overrides: Partial<NodeIndex> & { uuid: string }): NodeIndex {
  return {
    uuid: overrides.uuid,
    parentUuid: overrides.parentUuid ?? null,
    type: overrides.type ?? "user",
    subtype: overrides.subtype ?? null,
    timestamp: overrides.timestamp ?? null,
    lineNo: overrides.lineNo ?? 0,
    byteOffset: overrides.byteOffset ?? 0,
    byteLength: overrides.byteLength ?? 0,
    isSidechain: overrides.isSidechain ?? false,
    isToolResultShape: overrides.isToolResultShape ?? false,
  };
}

test("resolveSegmentBranches: 진짜 사용자 메시지가 둘 이상 갈라지면 BranchPoint를 만든다", () => {
  const a = node({ uuid: "a" });
  const b = node({ uuid: "b" });
  const childrenByParent = new Map([["p", [a, b]]]);

  const branches = resolveSegmentBranches(childrenByParent);

  assert.equal(branches.length, 1);
  assert.equal(branches[0]!.parentUuid, "p");
  assert.equal(branches[0]!.adoptedUuid, "b"); // 배열의 마지막 원소
  assert.deepEqual(branches[0]!.discardedUuids, ["a"]);
});

test("resolveSegmentBranches: 자식이 전부 tool_result 모양이면 만들지 않는다 (도구 병렬 호출 노이즈)", () => {
  const a = node({ uuid: "a", isToolResultShape: true });
  const b = node({ uuid: "b", isToolResultShape: true });
  const childrenByParent = new Map([["p", [a, b]]]);

  assert.deepEqual(resolveSegmentBranches(childrenByParent), []);
});

test("resolveSegmentBranches: 자식이 전부 sidechain이면 만들지 않는다", () => {
  const a = node({ uuid: "a", isSidechain: true });
  const b = node({ uuid: "b", isSidechain: true });
  const childrenByParent = new Map([["p", [a, b]]]);

  assert.deepEqual(resolveSegmentBranches(childrenByParent), []);
});

test("resolveSegmentBranches: 자식이 2개미만이면 만들지 않는다", () => {
  const a = node({ uuid: "a" });
  const childrenByParent = new Map([["p", [a]]]);

  assert.deepEqual(resolveSegmentBranches(childrenByParent), []);
});

test("resolveSegmentBranches: 진짜 자식이 3개 중 2개면 tool_result 자식은 discardedUuids에서 빠진다", () => {
  const a = node({ uuid: "a" });
  const b = node({ uuid: "b", isToolResultShape: true });
  const c = node({ uuid: "c" });
  const childrenByParent = new Map([["p", [a, b, c]]]);

  const branches = resolveSegmentBranches(childrenByParent);

  assert.equal(branches.length, 1);
  assert.equal(branches[0]!.adoptedUuid, "c");
  assert.deepEqual(branches[0]!.discardedUuids, ["a"]);
});
