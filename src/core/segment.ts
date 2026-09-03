import type { IndexResult, NodeIndex, Segment } from "./types.js";

/**
 * uuid가 속한 세그먼트를 찾는다. 새 순회를 하지 않는다 — 부모 체인을
 * root까지 거슬러 올라간 뒤 `index.segments`에서 그 root를 가진 항목을
 * 조회만 한다 (docs/spec/20260902-0411-verify-command.spec.md "데이터 모델").
 *
 * `inspect`가 이미 계산한 세그먼트 목록을 재사용하는 것이 핵심이다 —
 * `verify`뿐 아니라 `reattach`의 체인 길이 계산, `revert`의 복원 검증도
 * 이 함수를 공유해 같은 계산이 두 곳에서 따로 구현되는 것을 막는다
 * (docs/design/20260902-0411-verify-command.tdd.md "적용하는 기존 ADR" ADR-0004).
 *
 * `uuid`가 `nodes`에 존재함은 호출부가 이미 확인했다고 가정한다.
 */
export function findSegmentForUuid(
  index: IndexResult,
  nodes: ReadonlyMap<string, NodeIndex>,
  uuid: string,
): Segment {
  let cursor = uuid;
  const visited = new Set<string>();
  for (;;) {
    const node = nodes.get(cursor);
    if (!node || node.parentUuid === null) break;
    if (visited.has(cursor)) break;
    visited.add(cursor);
    cursor = node.parentUuid;
  }
  const segment = index.segments.find((s) => s.rootUuid === cursor);
  if (!segment) {
    throw new Error(
      `내부 불일치: uuid ${uuid}가 귀결되는 root ${cursor}에 대응하는 세그먼트가 없습니다`,
    );
  }
  return segment;
}
