import { findSegmentForUuid } from "./segment.js";
import type {
  ErrorCode,
  IndexResult,
  NodeIndex,
  RevertPlan,
  SurgeryLogEntry,
} from "./types.js";

/**
 * `revert` 사전 검증 실패를 나타낸다. `reattach`/`verify`의 검증 오류
 * 클래스와 같은 형태다 (docs/spec/20260902-0411-revert-command.spec.md
 * "엣지 케이스 & 에러 처리").
 */
export class RevertValidationError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
  ) {
    super(message);
  }
}

/** `--last` | `--to <timestamp>` 중 하나를 고른다 (Spec "Interface"). */
export type RevertMode = "last" | { readonly to: string };

/**
 * 되돌릴 대상 항목과 복원할 백업을 고른다. 파일을 읽지 않는 순수 함수 —
 * 이미 파싱된 `SurgeryLogEntry[]`만 다룬다 (Spec "데이터 모델").
 */
export function selectRevertTargets(
  log: readonly SurgeryLogEntry[],
  mode: RevertMode,
): { targetEntries: readonly SurgeryLogEntry[]; restoreFromBackup: string } {
  if (mode === "last") {
    const last = log[log.length - 1];
    if (!last) {
      throw new RevertValidationError(
        "되돌릴 수술 이력이 없습니다",
        "FILE_NOT_FOUND",
      );
    }
    return { targetEntries: [last], restoreFromBackup: last.backupPath };
  }

  const sinceThreshold = log.filter((e) => e.timestamp >= mode.to);
  if (sinceThreshold.length === 0) {
    throw new RevertValidationError(
      "해당 시점 이후 수술 이력이 없습니다",
      "TARGET_NOT_FOUND",
    );
  }

  // kind: "revert" 항목은 대상에서 제외한다 — 되돌리기를 또 되돌리는
  // 재귀는 다루지 않는다 (Spec "엣지 케이스").
  const targetEntries = sinceThreshold.filter((e) => e.kind !== "revert");
  if (targetEntries.length === 0) {
    throw new RevertValidationError(
      "해당 구간은 이미 되돌려졌습니다",
      "NOT_REATTACHABLE",
    );
  }

  const earliest = targetEntries.reduce((min, e) =>
    e.timestamp < min.timestamp ? e : min,
  );
  return { targetEntries, restoreFromBackup: earliest.backupPath };
}

/**
 * `expectedChainLength`까지 채운 완전한 `RevertPlan`을 계산한다.
 *
 * Spec은 시그니처를 `buildRevertPlan(surgeryLog, mode)`로 적었지만, 복원
 * 후 체인 길이는 복원될 파일 내용을 인덱싱해야만 계산할 수 있어 순수
 * 함수 하나로는 불가능하다. `restoredIndex`/`restoredNodes`(CLI가
 * `restoreFromBackup`을 먼저 식별해 그 파일을 인덱싱한 결과)를 추가
 * 인자로 받는다 — `reattach`의 `buildReattachPlan`이 같은 이유로
 * `nodes`를 추가 인자로 받은 것과 동일한 보완이다(발견된 Spec 공백을
 * 구현 시점에 보완 — 루트 CLAUDE.md "기준을 결과에 맞춰 고치지 않는다").
 *
 * 체인 길이의 기준점(anchor)은 대상 항목 중 가장 이른 시점(=
 * `restoreFromBackup`에 대응하는 항목)의 `targetUuid`다. 그 항목이
 * `kind: "revert"`라 `targetUuid`가 없으면(=이미 되돌리기 자체를 되돌리는
 * 드문 경우) 특정 지점으로 앵커링할 수 없으므로 전체 노드 수로 대신한다.
 */
export function buildRevertPlan(
  log: readonly SurgeryLogEntry[],
  mode: RevertMode,
  restoredIndex: IndexResult,
  restoredNodes: ReadonlyMap<string, NodeIndex>,
): RevertPlan {
  const { targetEntries, restoreFromBackup } = selectRevertTargets(log, mode);

  const earliest = targetEntries.reduce((min, e) =>
    e.timestamp < min.timestamp ? e : min,
  );
  const anchorUuid = earliest.targetUuid;
  const expectedChainLength =
    anchorUuid && restoredNodes.has(anchorUuid)
      ? findSegmentForUuid(restoredIndex, restoredNodes, anchorUuid).nodeCount
      : restoredIndex.nodeCount;

  return { targetEntries, restoreFromBackup, expectedChainLength };
}
