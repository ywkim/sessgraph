import { findSegmentForUuid } from "./segment.js";
import type {
  ErrorCode,
  IndexResult,
  NodeIndex,
  ReattachPlan,
} from "./types.js";

/**
 * `reattach` 사전 검증 실패를 나타낸다. 메시지는 Spec의 "엣지 케이스 & 에러
 * 처리" 절 문구를 그대로 쓴다 — CLI는 이 메시지를 그대로 출력하고
 * 종료 코드 2로 끝낸다 (docs/spec/20260901-2309-reattach-command.spec.md).
 *
 * `code`는 기계 판독 출력 규약(docs/spec/20260903-1218-machine-readable-output.spec.md)의
 * `ErrorCode` — 각 검증 실패가 어떤 코드에 대응하는지는 그 문서의 대응표를 따른다.
 */
export class ReattachValidationError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
  ) {
    super(message);
  }
}

/**
 * `--uuid`를 `--parent` 아래로 재연결하는 계획을 계산한다. 파일을 쓰지
 * 않는 순수 함수다 — 실제 쓰기는 `src/cli/reattach.ts`의 `applyReattach`가
 * 한다 (src/core/CLAUDE.md "이 스코프가 하지 않는 것").
 *
 * Spec은 시그니처를 `buildReattachPlan(index, uuid, parent)`로 적었지만,
 * `IndexResult`는 세그먼트 root/leaf만 노출해 임의 uuid의 부모 조회·순환
 * 검사를 할 수 없다. `nodes`(uuid→NodeIndex)와 `reason`(ReattachPlan이
 * 이미 요구하는 필드)을 추가 인자로 받는다 — 발견된 Spec 공백을 구현
 * 시점에 보완한다 (루트 CLAUDE.md "기준을 결과에 맞춰 고치지 않는다": 이
 * 보완 사실을 여기 기록해 둔다).
 */
export function buildReattachPlan(
  index: IndexResult,
  nodes: ReadonlyMap<string, NodeIndex>,
  uuid: string,
  parent: string,
  reason: string,
): ReattachPlan {
  if (reason.trim() === "") {
    throw new ReattachValidationError("사유를 입력해야 합니다", "EMPTY_REASON");
  }

  const target = nodes.get(uuid);
  if (!target) {
    // 인덱스는 uuid 없는 메타데이터성 레코드(custom-title 등)를 애초에
    // 담지 않는다 — "존재하지 않음"과 "그래프에 참여하지 않는 유형"을
    // 구분할 수 없어 Spec의 두 메시지 중 하나로 합친다.
    throw new ReattachValidationError(
      "대상 uuid를 찾을 수 없습니다",
      "TARGET_NOT_FOUND",
    );
  }
  const newParentNode = nodes.get(parent);
  if (!newParentNode) {
    throw new ReattachValidationError(
      "지정한 부모 uuid를 찾을 수 없습니다",
      "PARENT_NOT_FOUND",
    );
  }

  if (index.unresolvedDuplicates.some((d) => d.uuid === uuid)) {
    throw new ReattachValidationError(
      "이 레코드는 여러 번 출현하며 어느 것이 최신 상태인지 도구가 판단할 수 없습니다. 먼저 inspect --json으로 확인하세요",
      "AMBIGUOUS_DUPLICATE",
    );
  }

  if (parent === uuid) {
    throw new ReattachValidationError(
      "순환이 생겨 적용할 수 없습니다",
      "CYCLE_DETECTED",
    );
  }
  const visited = new Set<string>();
  let cursor: string | null = parent;
  while (cursor !== null) {
    if (cursor === uuid) {
      throw new ReattachValidationError(
        "순환이 생겨 적용할 수 없습니다",
        "CYCLE_DETECTED",
      );
    }
    if (visited.has(cursor)) break; // 기존 파일에 이미 순환이 있어도 무한 루프에 빠지지 않는다
    visited.add(cursor);
    const node = nodes.get(cursor);
    cursor = node ? node.parentUuid : null;
  }

  const previousParent = target.parentUuid;

  if (previousParent === parent) {
    // 이미 연결되어 있음 — Spec은 이를 오류가 아니라 정상 종료(0)로 다룬다.
    // CLI가 이 경우를 감지해 "변경 사항 없음"을 출력하고 쓰기를 건너뛴다.
    const beforeChainLength = segmentNodeCountContaining(index, nodes, uuid);
    return {
      targetUuid: uuid,
      previousParent,
      newParent: parent,
      reason,
      beforeChainLength,
      afterChainLength: beforeChainLength,
    };
  }

  const childrenByParent = new Map<string, string[]>();
  for (const node of nodes.values()) {
    if (node.parentUuid === null) continue;
    const siblings = childrenByParent.get(node.parentUuid);
    if (siblings) siblings.push(node.uuid);
    else childrenByParent.set(node.parentUuid, [node.uuid]);
  }
  const subtreeSize = countSubtree(uuid, childrenByParent);

  const beforeChainLength = segmentNodeCountContaining(index, nodes, uuid);
  const afterChainLength =
    segmentNodeCountContaining(index, nodes, parent) + subtreeSize;

  return {
    targetUuid: uuid,
    previousParent,
    newParent: parent,
    reason,
    beforeChainLength,
    afterChainLength,
  };
}

function countSubtree(
  uuid: string,
  childrenByParent: ReadonlyMap<string, string[]>,
): number {
  let count = 0;
  const stack = [uuid];
  while (stack.length > 0) {
    const current = stack.pop()!;
    count++;
    const kids = childrenByParent.get(current);
    if (kids) stack.push(...kids);
  }
  return count;
}

/**
 * uuid가 속한 세그먼트의 nodeCount. `verify` Spec이 정의한 공유 조회
 * 함수(`findSegmentForUuid`)를 그대로 쓴다 — 체인 길이 계산을 이 파일에
 * 따로 구현하지 않는다 (docs/design/20260902-0411-verify-command.tdd.md
 * "향후 확장 고려사항").
 */
function segmentNodeCountContaining(
  index: IndexResult,
  nodes: ReadonlyMap<string, NodeIndex>,
  uuid: string,
): number {
  try {
    return findSegmentForUuid(index, nodes, uuid).nodeCount;
  } catch {
    throw new ReattachValidationError(
      "이 레코드는 재연결 대상이 될 수 없습니다",
      "NOT_REATTACHABLE",
    );
  }
}
