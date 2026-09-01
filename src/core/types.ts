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
 */
export type DuplicatePolicy = "first-wins" | "last-wins" | "prefer-parent";

/** 정책으로 해소되지 않은 중복 — 숨기지 않고 결과에 포함해 보고한다. */
export interface UnresolvedDuplicate {
  readonly uuid: string;
  readonly conflictingParents: readonly (string | null)[];
  readonly lineNos: readonly number[];
}
