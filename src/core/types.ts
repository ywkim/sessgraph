/**
 * Claude Code 세션 JSONL 레코드의 타입 정의 — 이 프로젝트의 스키마 단일 진실.
 *
 * ⚠️ 이 필드들은 공식 문서가 "internal, changes between versions"로 명시한
 * 비공개 스키마다 (https://code.claude.com/docs/en/sessions.md).
 * 전부 리버스엔지니어링 결과이며 Claude Code 업데이트로 깨질 수 있다.
 * 필드를 추가할 때는 그 필드가 사라졌을 때의 동작도 함께 정의한다.
 */

/**
 * 관측된 레코드 타입. 이 목록에 없는 값이 나와도 파싱은 실패하지 않되,
 * 스키마 변경 신호로 보고한다.
 */
export type RecordType =
  | "user"
  | "assistant"
  | "system"
  | "progress"
  | "attachment"
  | "file-history-snapshot"
  | "queue-operation"
  | "custom-title"
  | "agent-name"
  | "last-prompt"
  | "bridge-session"
  | "permission-mode"
  | "mode";

/** 체인이 끊기는 지점을 표시하는 `system` 레코드의 subtype. */
export const COMPACT_BOUNDARY = "compact_boundary";

/**
 * JSONL 한 줄에서 이 도구가 읽는 필드.
 *
 * `uuid`가 없는 레코드가 존재한다 (메타데이터성 레코드 — `custom-title`,
 * `file-history-snapshot` 등). 이들은 그래프에 참여하지 않는다.
 */
export interface SessionRecord {
  readonly uuid?: string;
  /** `null`이면 조각의 시작점. 컴팩트 경계 레코드가 대표적이다. */
  readonly parentUuid?: string | null;
  readonly type?: string;
  readonly subtype?: string;
  readonly timestamp?: string;
  readonly sessionId?: string;
  /**
   * `compact_boundary` 레코드가 이어야 할 부모를 이미 담고 있는 필드다
   * (ADR-0005). `parentUuid`와 마찬가지로 없을 수 있으므로 옵셔널이다.
   */
  readonly logicalParentUuid?: string | null;
}

/**
 * 인덱스 항목 — 본문을 담지 않는다.
 *
 * 세션 파일은 노드 수에 비해 본문이 압도적으로 크다. 본문이 필요하면
 * `byteOffset`으로 seek해서 그때 읽는다 (src/core/CLAUDE.md 참고).
 */
export interface NodeIndex {
  readonly uuid: string;
  readonly parentUuid: string | null;
  readonly type: string;
  readonly subtype: string | null;
  readonly timestamp: string | null;
  readonly lineNo: number;
  readonly byteOffset: number;
  readonly byteLength: number;
}

/**
 * 같은 uuid가 여러 번 출현할 때 어느 것을 채택할지 결정하는 정책.
 *
 * ⚠️ 정책마다 결과가 달라진다. 실측에서 세 정책이 같은 파일에 대해
 * 서로 다른 root/orphan 수를 냈고, 그중 하나는 끊긴 노드가 있는데도
 * `orphans: 0`을 보고했다 (docs/adr/ADR-0004).
 *
 * 따라서 이 값을 구현자가 즉흥적으로 고르지 않는다 — Spec 문서에
 * 명문화된 정책만 사용하고, 정책이 없는 케이스는 보고한다.
 *
 * 기본값은 `prefer-parent`다 (`inspect` Spec) — orphan을 과소보고하지 않는
 * 정책이 가장 안전하다. ADR-0004 실측에서 `last-wins`는 끊긴 노드가 있어도
 * `orphans: 0`을 보고했다.
 */
export type DuplicatePolicy = "first-wins" | "last-wins" | "prefer-parent";

/** 정책으로 해소되지 않은 중복 — 숨기지 않고 결과에 포함해 보고한다. */
export interface UnresolvedDuplicate {
  readonly uuid: string;
  readonly conflictingParents: readonly (string | null)[];
  readonly lineNos: readonly number[];
}

/* ── inspect (docs/spec/20260901-1337-inspect-command.spec.md) ────────────── */

/**
 * 컴팩트 경계로 나뉜 하나의 조각.
 *
 * orphan은 세그먼트 root가 되지 않는다 — root는 `parentUuid`가 `null`인 노드이고,
 * orphan은 존재하지 않는 부모를 가리키는 노드다.
 */
export interface Segment {
  readonly rootUuid: string;
  readonly leafUuid: string;
  readonly nodeCount: number;
  readonly startTimestamp: string | null;
  readonly endTimestamp: string | null;
  /** root 레코드의 subtype. `compact_boundary`가 아니면 세션의 진짜 시작점. */
  readonly rootSubtype: string | null;
  /**
   * root가 `compact_boundary`일 때, 그 레코드의 `logicalParentUuid` 값.
   * rootSubtype이 `compact_boundary`가 아니거나 레코드에 `logicalParentUuid`가
   * 없으면 `null` (ADR-0005).
   */
  readonly rootLogicalParentUuid: string | null;
}

/** 부모 uuid를 가리키지만 그 부모가 파일에 없는 노드. */
export interface OrphanNode {
  readonly uuid: string;
  readonly missingParentUuid: string;
  readonly lineNo: number;
  readonly type: string;
}

/**
 * 인덱싱 결과 — `inspect`, `verify`, `serve`가 공유하는 하나의 계산 결과.
 *
 * 각 명령이 자기 순회를 새로 구현하지 않는다. 같은 파일에 대해 두 명령이
 * 다른 답을 내는 것을 구조적으로 막기 위해서다 (ADR-0004).
 */
export interface IndexResult {
  readonly totalLines: number;
  readonly recordsWithUuid: number;
  readonly nodeCount: number;
  readonly segments: readonly Segment[];
  readonly orphans: readonly OrphanNode[];
  readonly unresolvedDuplicates: readonly UnresolvedDuplicate[];
  /** 올바른 JSON이 아니어서 건너뛴 줄 번호. 비어있지 않으면 리포트에 노출한다. */
  readonly malformedLines: readonly number[];
  readonly durationMs: number;
}

/* ── verify (docs/spec/20260902-0411-verify-command.spec.md) ──────────────── */

export interface VerifyResult {
  readonly targetUuid: string;
  readonly segment: Segment;
  /** `segment.rootSubtype === COMPACT_BOUNDARY`일 때 true — 아직 그 이전과 끊긴 상태. */
  readonly stillDisconnectedAtRoot: boolean;
}

/* ── reattach (docs/spec/20260901-2309-reattach-command.spec.md) ──────────── */

export interface ReattachPlan {
  readonly targetUuid: string;
  readonly previousParent: string | null;
  readonly newParent: string;
  readonly reason: string;
  /** 재연결 전, targetUuid가 속한 세그먼트의 노드 수 */
  readonly beforeChainLength: number;
  /** 재연결 후 예상되는 병합 세그먼트의 노드 수 */
  readonly afterChainLength: number;
}

export interface ReattachResult {
  readonly plan: ReattachPlan;
  readonly committed: boolean;
  /** `committed === true`일 때만 존재 */
  readonly backupPath?: string;
  readonly surgeryLogPath?: string;
}

/* ── revert (docs/spec/20260902-0411-revert-command.spec.md) ──────────────── */

/** `{세션}.surgery.log`의 한 줄. append-only. */
export interface SurgeryLogEntry {
  readonly timestamp: string;
  readonly kind: "reattach" | "revert";
  readonly targetUuid?: string;
  readonly previousParent?: string | null;
  readonly newParent?: string;
  /** kind가 `revert`일 때, 되돌린 대상 항목들의 timestamp */
  readonly revertedEntries?: readonly string[];
  readonly reason: string;
  readonly backupPath: string;
}

export interface RevertPlan {
  readonly targetEntries: readonly SurgeryLogEntry[];
  readonly restoreFromBackup: string;
  readonly expectedChainLength: number;
}

export interface RevertResult {
  readonly plan: RevertPlan;
  readonly committed: boolean;
  readonly preRevertBackupPath?: string;
  readonly surgeryLogPath?: string;
}

/* ── serve (docs/spec/20260902-0420-serve-command.spec.md) ────────────────── */

export interface SegmentDetail {
  readonly segment: Segment;
  /** 이 세그먼트에 속한 노드들 (root → leaf 순서). 본문은 포함하지 않는다. */
  readonly nodes: readonly NodeIndex[];
  /** root가 compact_boundary일 때 화면에 표시할 재연결 명령어. 아니면 null. */
  readonly suggestedReattachCommand: string | null;
}

export interface NodeBody {
  readonly uuid: string;
  /** 원본 JSONL 한 줄 (파싱하지 않은 그대로) */
  readonly raw: string;
}
