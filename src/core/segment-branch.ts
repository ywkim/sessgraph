import type { BranchPoint, NodeIndex } from "./types.js";

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
