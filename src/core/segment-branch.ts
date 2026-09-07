import type { BranchLane, BranchPoint, NodeIndex } from "./types.js";

/**
 * 한 세그먼트 안에서 사용자 재실행/수정으로 갈라진 지점만 골라낸다.
 * 자식이 전부 `isSidechain`이거나 전부 `isToolResultShape`인 부모는
 * 도구 병렬 호출로 생긴 구조적 산물이므로 제외한다
 * (docs/spec/20260906-1400-segment-branch-view.spec.md "불변식").
 *
 * `childrenByParent`는 `buildSegmentDetail`이 이미 만든 맵을 그대로
 * 받아쓴다 — 트리 순회를 두 번 하지 않는다.
 */
export function resolveSegmentBranches(
  childrenByParent: ReadonlyMap<string, readonly NodeIndex[]>,
): readonly BranchPoint[] {
  const branches: BranchPoint[] = [];

  for (const [parentUuid, children] of childrenByParent) {
    if (children.length < 2) continue;

    const real = children.filter(
      (c) => !c.isSidechain && !c.isToolResultShape,
    );
    if (real.length < 2) continue; // 전부 사이드체인 또는 전부 도구 결과 — 노이즈

    // 채택 경로는 새로 정의하지 않는다 — DFS가 스택에 push하는 순서와
    // 같은 배열의 마지막 원소를 그대로 채택 경로로 인정한다
    // (docs/design/20260906-1400-segment-branch-view.tdd.md "채택 경로는 새로 정의하지 않는다").
    const adopted = children[children.length - 1]!;
    const discarded = real
      .filter((c) => c.uuid !== adopted.uuid)
      .map((c) => c.uuid);
    if (discarded.length === 0) continue; // 채택된 것만 real이었던 경우

    branches.push({
      parentUuid,
      adoptedUuid: adopted.uuid,
      discardedUuids: discarded,
    });
  }

  return branches;
}

/**
 * 각 노드가 화면의 어느 레인(git log --graph 컬럼에 해당)에 그려질지 계산한다
 * (docs/prd/20260906-1400-segment-branch-view.prd.md "레인 기반 표시").
 *
 * 세 단계:
 * 1. 갈래(subtree) 식별 — 채택 경로는 부모의 갈래를 그대로 물려받고, 곁가지는
 *    branch point에서 새 갈래로 갈라진다. 중첩된 branch point는 그 갈래 안에서
 *    또 새 갈래를 만든다(depth 증가).
 * 2. 갈래별 시작·끝 lineNo 범위를 구한다 — "갈래의 시작과 끝"을 그대로 답한다.
 * 3. 레인 번호를 배정한다 — 구간이 겹치지 않는 갈래끼리는 레인을 재사용한다
 *    (interval graph coloring). 이게 실측한 "동시 open 브랜치 수(laneDepth)"를
 *    그대로 화면 폭으로 옮기는 방법이다 — 원시 깊이가 아니라 겹치는 구간
 *    개수만큼만 레인이 늘어난다.
 */
export function computeBranchLanes(
  nodes: readonly NodeIndex[],
  childrenByParent: ReadonlyMap<string, readonly NodeIndex[]>,
  branches: readonly BranchPoint[],
): ReadonlyMap<string, BranchLane> {
  const branchByParent = new Map<string, BranchPoint>();
  for (const b of branches) branchByParent.set(b.parentUuid, b);

  const nodeByUuid = new Map(nodes.map((n) => [n.uuid, n]));

  interface Meta {
    subtreeId: string;
    branchParentUuid: string | null;
    depth: number;
  }
  const metaByUuid = new Map<string, Meta>();
  let subtreeCounter = 0;

  function metaFor(node: NodeIndex, parentMeta: Meta): Meta {
    if (node.parentUuid === null) return parentMeta;
    const bp = branchByParent.get(node.parentUuid);
    if (!bp || node.uuid === bp.adoptedUuid) return parentMeta;
    if (!bp.discardedUuids.includes(node.uuid)) return parentMeta; // 노이즈 자식 — 부모 갈래 그대로
    return {
      subtreeId: `d${subtreeCounter++}`,
      branchParentUuid: node.parentUuid,
      depth: parentMeta.depth + 1,
    };
  }

  const trunkMeta: Meta = { subtreeId: "trunk", branchParentUuid: null, depth: 0 };
  const roots = nodes.filter(
    (n) => n.parentUuid === null || !nodeByUuid.has(n.parentUuid),
  );
  const stack: NodeIndex[] = [...roots];
  for (const root of roots) metaByUuid.set(root.uuid, trunkMeta);
  while (stack.length > 0) {
    const current = stack.pop()!;
    const currentMeta = metaByUuid.get(current.uuid)!;
    for (const child of childrenByParent.get(current.uuid) ?? []) {
      metaByUuid.set(child.uuid, metaFor(child, currentMeta));
      stack.push(child);
    }
  }

  // 갈래별 시작·끝 lineNo 범위.
  const range = new Map<string, { start: number; end: number }>();
  for (const node of nodes) {
    const id = metaByUuid.get(node.uuid)!.subtreeId;
    const r = range.get(id);
    if (!r) range.set(id, { start: node.lineNo, end: node.lineNo });
    else {
      if (node.lineNo < r.start) r.start = node.lineNo;
      if (node.lineNo > r.end) r.end = node.lineNo;
    }
  }

  // 레인 배정 — trunk는 항상 0, 곁가지는 구간이 안 겹치면 재사용한다.
  const nonTrunkIds = [...range.keys()]
    .filter((id) => id !== "trunk")
    .sort((a, b) => range.get(a)!.start - range.get(b)!.start);
  const laneOf = new Map<string, number>([["trunk", 0]]);
  let nextLane = 1;
  const freeLanes: number[] = [];
  const active: { lane: number; end: number }[] = [];
  for (const id of nonTrunkIds) {
    const r = range.get(id)!;
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i]!.end < r.start) {
        freeLanes.push(active[i]!.lane);
        active.splice(i, 1);
      }
    }
    let lane: number;
    if (freeLanes.length > 0) {
      freeLanes.sort((a, b) => a - b);
      lane = freeLanes.shift()!;
    } else {
      lane = nextLane++;
    }
    active.push({ lane, end: r.end });
    laneOf.set(id, lane);
  }

  const result = new Map<string, BranchLane>();
  for (const node of nodes) {
    const meta = metaByUuid.get(node.uuid)!;
    const r = range.get(meta.subtreeId)!;
    result.set(node.uuid, {
      lane: laneOf.get(meta.subtreeId)!,
      subtreeId: meta.subtreeId,
      branchParentUuid: meta.branchParentUuid,
      depth: meta.depth,
      isSubtreeStart: node.lineNo === r.start,
      isSubtreeEnd: node.lineNo === r.end,
    });
  }
  return result;
}
