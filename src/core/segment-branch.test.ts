import test from "node:test";
import assert from "node:assert/strict";

import { computeBranchLanes, resolveSegmentBranches } from "./segment-branch.js";
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

test("computeBranchLanes: 분기 없으면 전부 trunk(레인 0)", () => {
  const r = node({ uuid: "r", lineNo: 1 });
  const p = node({ uuid: "p", parentUuid: "r", lineNo: 2 });
  const nodes = [r, p];
  const childrenByParent = new Map([["r", [p]]]);

  const lanes = computeBranchLanes(nodes, childrenByParent, []);

  assert.equal(lanes.get("r")!.lane, 0);
  assert.equal(lanes.get("p")!.lane, 0);
  assert.equal(lanes.get("r")!.subtreeId, "trunk");
  assert.equal(lanes.get("r")!.isSubtreeStart, true);
  assert.equal(lanes.get("p")!.isSubtreeEnd, true);
});

test("computeBranchLanes: 곁가지는 새 레인을 받고 시작·끝을 자기 범위로 잡는다", () => {
  const r = node({ uuid: "r", lineNo: 1 });
  const p = node({ uuid: "p", parentUuid: "r", lineNo: 2 });
  const a = node({ uuid: "a", parentUuid: "p", lineNo: 3 }); // 곁가지
  const b = node({ uuid: "b", parentUuid: "p", lineNo: 4 }); // 채택
  const nodes = [r, p, a, b];
  const childrenByParent = new Map([
    ["r", [p]],
    ["p", [a, b]],
  ]);
  const branches = resolveSegmentBranches(childrenByParent);

  const lanes = computeBranchLanes(nodes, childrenByParent, branches);

  assert.equal(lanes.get("b")!.lane, 0); // 채택 경로는 trunk 유지
  assert.equal(lanes.get("a")!.lane, 1);
  assert.equal(lanes.get("a")!.branchParentUuid, "p");
  assert.equal(lanes.get("a")!.depth, 1);
  assert.equal(lanes.get("a")!.isSubtreeStart, true);
  assert.equal(lanes.get("a")!.isSubtreeEnd, true);
  assert.equal(lanes.get("r")!.isSubtreeEnd, false); // trunk는 b(lineNo4)까지 이어짐
  assert.equal(lanes.get("b")!.isSubtreeEnd, true);
});

test("computeBranchLanes: lineNo 구간이 안 겹치는 곁가지끼리는 레인을 재사용한다", () => {
  const ra = node({ uuid: "ra", lineNo: 1 });
  const pa = node({ uuid: "pa", parentUuid: "ra", lineNo: 2 });
  const da = node({ uuid: "da", parentUuid: "pa", lineNo: 3 });
  const aa = node({ uuid: "aa", parentUuid: "pa", lineNo: 10 });
  const rb = node({ uuid: "rb", lineNo: 4 });
  const pb = node({ uuid: "pb", parentUuid: "rb", lineNo: 5 });
  const db = node({ uuid: "db", parentUuid: "pb", lineNo: 6 });
  const ab = node({ uuid: "ab", parentUuid: "pb", lineNo: 11 });
  const nodes = [ra, pa, da, aa, rb, pb, db, ab];
  const childrenByParent = new Map([
    ["ra", [pa]],
    ["pa", [da, aa]],
    ["rb", [pb]],
    ["pb", [db, ab]],
  ]);
  const branches = resolveSegmentBranches(childrenByParent);

  const lanes = computeBranchLanes(nodes, childrenByParent, branches);

  assert.equal(lanes.get("da")!.lane, 1);
  assert.equal(lanes.get("db")!.lane, 1); // da가 3에서 끝나고 db는 6에서 시작 — 안 겹치니 재사용
});

test("computeBranchLanes: lineNo 구간이 겹치는 곁가지는 서로 다른 레인을 받는다", () => {
  const ra = node({ uuid: "ra", lineNo: 1 });
  const pa = node({ uuid: "pa", parentUuid: "ra", lineNo: 2 });
  const da = node({ uuid: "da", parentUuid: "pa", lineNo: 3 });
  const dac = node({ uuid: "dac", parentUuid: "da", lineNo: 8 }); // da 갈래를 8까지 늘린다
  const aa = node({ uuid: "aa", parentUuid: "pa", lineNo: 10 });
  const rb = node({ uuid: "rb", lineNo: 4 });
  const pb = node({ uuid: "pb", parentUuid: "rb", lineNo: 5 });
  const db = node({ uuid: "db", parentUuid: "pb", lineNo: 6 }); // da(3~8) 구간 안에서 시작
  const ab = node({ uuid: "ab", parentUuid: "pb", lineNo: 11 });
  const nodes = [ra, pa, da, dac, aa, rb, pb, db, ab];
  const childrenByParent = new Map([
    ["ra", [pa]],
    ["pa", [da, aa]],
    ["da", [dac]],
    ["rb", [pb]],
    ["pb", [db, ab]],
  ]);
  const branches = resolveSegmentBranches(childrenByParent);

  const lanes = computeBranchLanes(nodes, childrenByParent, branches);

  assert.equal(lanes.get("da")!.lane, 1);
  assert.equal(lanes.get("dac")!.lane, 1); // 같은 갈래라 레인도 같다
  assert.equal(lanes.get("db")!.lane, 2); // da(3~8)와 겹쳐서 재사용 못 한다
});
