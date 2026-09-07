#!/usr/bin/env node
// 일회성 측정 스크립트 — 곁가지 서브트리의 깊이/크기 분포를 실측한다.
// PRD docs/prd/20260906-1400-segment-branch-view.prd.md 재조정 근거 데이터.
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { buildIndexDetailed } from "../dist/core/build-index.js";
import { resolveSegmentBranches } from "../dist/core/segment-branch.js";

function buildChildrenByParent(nodes) {
  const map = new Map();
  for (const node of nodes.values()) {
    if (node.parentUuid === null) continue;
    if (!nodes.has(node.parentUuid)) continue;
    const siblings = map.get(node.parentUuid);
    if (siblings) siblings.push(node);
    else map.set(node.parentUuid, [node]);
  }
  return map;
}

// discardedUuid를 root로 하는 서브트리의 (size, maxDepth)를 잰다.
function measureSubtree(rootUuid, childrenByParent) {
  let size = 0;
  let maxDepth = 0;
  const visited = new Set(); // 손상된 파일의 순환 참조로부터 방어
  const stack = [[rootUuid, 1]];
  while (stack.length > 0) {
    const [uuid, depth] = stack.pop();
    if (visited.has(uuid)) continue;
    visited.add(uuid);
    size++;
    if (depth > maxDepth) maxDepth = depth;
    for (const child of childrenByParent.get(uuid) ?? []) {
      stack.push([child.uuid, depth + 1]);
    }
  }
  return { size, maxDepth };
}

// git log --graph의 컬럼 폭은 "커밋 깊이"가 아니라 "그 순간 동시에 열려 있는
// 브랜치 수"로 정해진다. laneDepth(node) = 루트에서 이 노드까지 오는 동안
// 거쳐온 branch-member 조상의 개수(자기 자신 포함) — 일직선 커밋 체인은
// 아무리 길어도 이 값을 올리지 않고, 실제 분기 지점만 올린다.
function computeMaxLaneDepth(nodes, childrenByParent, branchMemberUuids) {
  // 재귀 대신 BFS로 부모→자식 순서를 보장한다 (실측 max depth 1,429 —
  // 재귀면 스택 오버플로).
  const laneDepth = new Map();
  const roots = [];
  for (const node of nodes.values()) {
    if (node.parentUuid === null || !nodes.has(node.parentUuid)) roots.push(node.uuid);
  }
  let max = 0;
  const queue = roots.map((uuid) => [uuid, branchMemberUuids.has(uuid) ? 1 : 0]);
  let head = 0;
  while (head < queue.length) {
    const [uuid, depth] = queue[head++];
    if (laneDepth.has(uuid)) continue;
    laneDepth.set(uuid, depth);
    if (depth > max) max = depth;
    for (const child of childrenByParent.get(uuid) ?? []) {
      const childDepth = depth + (branchMemberUuids.has(child.uuid) ? 1 : 0);
      queue.push([child.uuid, childDepth]);
    }
  }
  return max;
}

const sizes = [];
const depths = [];
const maxLaneDepths = [];
let branchPointCount = 0;
let sessionsWithBranches = 0;
let nestedBranchPoints = 0; // 곁가지 서브트리 안에 또 다른 branch point가 있는 경우

// node:fs/promises glob은 이 트리에서 OOM(스캔이 안 끝남, 아마 심볼릭 링크 루프) —
// find는 기본적으로 심볼릭 링크를 따라가지 않아 안전하다.
const projectsDir = path.join(homedir(), ".claude/projects");
const files = execFileSync("find", [projectsDir, "-name", "*.jsonl"], {
  maxBuffer: 64 * 1024 * 1024,
})
  .toString()
  .trim()
  .split("\n")
  .filter(Boolean);

for (const file of files) {
  let nodes;
  try {
    ({ nodes } = buildIndexDetailed(file));
  } catch {
    continue;
  }
  const childrenByParent = buildChildrenByParent(nodes);
  const branches = resolveSegmentBranches(childrenByParent);
  if (branches.length === 0) continue;
  sessionsWithBranches++;
  branchPointCount += branches.length;

  const allBranchParents = new Set(branches.map((b) => b.parentUuid));
  const branchMemberUuids = new Set();
  for (const b of branches) {
    branchMemberUuids.add(b.adoptedUuid);
    for (const uuid of b.discardedUuids) branchMemberUuids.add(uuid);
  }
  maxLaneDepths.push(computeMaxLaneDepth(nodes, childrenByParent, branchMemberUuids));

  for (const b of branches) {
    for (const discardedUuid of b.discardedUuids) {
      const { size, maxDepth } = measureSubtree(discardedUuid, childrenByParent);
      sizes.push(size);
      depths.push(maxDepth);

      // 서브트리 내부에 다른 branch point의 parentUuid가 있는지 (중첩 여부)
      const stack = [discardedUuid];
      const seen = new Set();
      while (stack.length > 0) {
        const u = stack.pop();
        if (seen.has(u)) continue;
        seen.add(u);
        if (allBranchParents.has(u) && u !== discardedUuid) nestedBranchPoints++;
        for (const c of childrenByParent.get(u) ?? []) stack.push(c.uuid);
      }
    }
  }
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

console.log(`세션 수(전체): ${files.length}`);
console.log(`분기 있는 세션 수: ${sessionsWithBranches}`);
console.log(`branch point 총 개수: ${branchPointCount}`);
console.log(`곁가지(discarded) 서브트리 총 개수: ${sizes.length}`);
console.log("");
console.log("곁가지 서브트리 크기(size, 자기 자신 포함 노드 수) 분포:");
console.log(`  min=${Math.min(...sizes)} p50=${percentile(sizes, 0.5)} p90=${percentile(sizes, 0.9)} p99=${percentile(sizes, 0.99)} max=${Math.max(...sizes)}`);
console.log(`  size===1 (자식 없음) 비율: ${((sizes.filter((s) => s === 1).length / sizes.length) * 100).toFixed(1)}%`);
console.log("");
console.log("곁가지 서브트리 최대 깊이(maxDepth) 분포:");
console.log(`  min=${Math.min(...depths)} p50=${percentile(depths, 0.5)} p90=${percentile(depths, 0.9)} p99=${percentile(depths, 0.99)} max=${Math.max(...depths)}`);
console.log(`  depth===1 (자식 없는 리프) 비율: ${((depths.filter((d) => d === 1).length / depths.length) * 100).toFixed(1)}%`);
console.log("");
console.log(`곁가지 서브트리 내부에 또 다른 branch point가 중첩된 경우: ${nestedBranchPoints}건`);
console.log("");
console.log("세션당 최대 동시 open 브랜치 수(laneDepth, git log --graph 컬럼 폭에 해당):");
console.log(`  min=${Math.min(...maxLaneDepths)} p50=${percentile(maxLaneDepths, 0.5)} p90=${percentile(maxLaneDepths, 0.9)} p99=${percentile(maxLaneDepths, 0.99)} max=${Math.max(...maxLaneDepths)}`);
console.log(`  laneDepth<=2 비율: ${((maxLaneDepths.filter((d) => d <= 2).length / maxLaneDepths.length) * 100).toFixed(1)}%`);
console.log(`  laneDepth<=4 비율: ${((maxLaneDepths.filter((d) => d <= 4).length / maxLaneDepths.length) * 100).toFixed(1)}%`);
