import { findSegmentForUuid } from "./segment.js";
import { COMPACT_BOUNDARY } from "./types.js";
import type {
  ErrorCode,
  IndexResult,
  NodeIndex,
  VerifyResult,
} from "./types.js";

/**
 * `verify` 사전 검증 실패를 나타낸다. `reattach`의 `ReattachValidationError`와
 * 같은 형태다 — CLI가 그대로 종료 코드 2로 출력한다
 * (docs/spec/20260902-0411-verify-command.spec.md "엣지 케이스 & 에러 처리").
 */
export class VerifyValidationError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
  ) {
    super(message);
  }
}

/**
 * `--uuid`가 속한 세그먼트를 조회해 연결 상태를 보고한다. 새 순회를 하지
 * 않는다 — `findSegmentForUuid`가 이미 계산된 `index.segments`를 조회할
 * 뿐이다 (Spec "데이터 모델").
 *
 * `nodes`는 uuid 없는 메타데이터성 레코드를 애초에 담지 않으므로,
 * "uuid가 인덱스에 없음"과 "그래프에 참여하지 않는 유형"을 구분할 수
 * 없다 — `reattach`의 `buildReattachPlan`과 같은 이유로 하나의 메시지로
 * 합친다 (`src/core/reattach.ts`의 동일 코멘트 참고).
 */
export function buildVerifyResult(
  index: IndexResult,
  nodes: ReadonlyMap<string, NodeIndex>,
  uuid: string,
): VerifyResult {
  const target = nodes.get(uuid);
  if (!target) {
    throw new VerifyValidationError(
      "해당 uuid를 찾을 수 없습니다",
      "TARGET_NOT_FOUND",
    );
  }

  if (index.unresolvedDuplicates.some((d) => d.uuid === uuid)) {
    throw new VerifyValidationError(
      "이 레코드는 여러 번 출현하며 어느 것이 최신 상태인지 도구가 판단할 수 없습니다. 먼저 inspect --json으로 확인하세요",
      "AMBIGUOUS_DUPLICATE",
    );
  }

  const segment = findSegmentForUuid(index, nodes, uuid);
  return {
    targetUuid: uuid,
    segment,
    stillDisconnectedAtRoot: segment.rootSubtype === COMPACT_BOUNDARY,
  };
}
