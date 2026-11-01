/**
 * 레코드 한 줄 → 색인할 행들. 파일 I/O 없는 순수 함수
 * (docs/spec/20261015-1821-search-index.spec.md "추출 규칙").
 */

export type SearchTier = "conversation" | "tool" | "meta";

export interface SearchRow {
  readonly tier: SearchTier;
  readonly text: string;
  /** 레코드의 uuid. 없으면 null. 색인에 저장만 하고 검색 대상은 아니다 */
  readonly uuid: string | null;
  /** 레코드의 timestamp(ISO 문자열). 없으면 null */
  readonly timestamp: string | null;
  /** true면 세션 단위로 값마다 한 번만 색인한다 (cwd, gitBranch) */
  readonly perSession: boolean;
}

export interface ExtractedLine {
  readonly rows: readonly SearchRow[];
  /** type이 "user" 또는 "assistant"인 레코드였는가 (Spec "불변식"의 드리프트 감지용) */
  readonly conversationRecord: boolean;
}

/** Spec "문자열 값 모음" — 식별자·시각과 중복 사본은 검색 대상이 아니다. */
const SKIPPED_KEYS = new Set([
  "uuid",
  "parentUuid",
  "logicalParentUuid",
  "sessionId",
  "requestId",
  "messageId",
  "leafUuid",
  "id",
  "tool_use_id",
  "timestamp",
  "signature",
  "toolUseResult",
]);

const NONE: ExtractedLine = { rows: [], conversationRecord: false };

/** JSONL 한 줄. JSON 파싱 실패면 { rows: [], conversationRecord: false } */
export function extractSearchRows(line: string): ExtractedLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return NONE;
  }
  if (!isObject(parsed)) return NONE;
  const r = parsed;

  const uuid = typeof r.uuid === "string" ? r.uuid : null;
  const timestamp = typeof r.timestamp === "string" ? r.timestamp : null;
  const conversationRecord = r.type === "user" || r.type === "assistant";
  const rows: SearchRow[] = [];
  const push = (tier: SearchTier, text: string, perSession = false) => {
    if (text !== "") rows.push({ tier, text, uuid, timestamp, perSession });
  };

  if (typeof r.cwd === "string") push("meta", r.cwd, true);
  if (typeof r.gitBranch === "string") push("meta", r.gitBranch, true);

  if (r.type === "file-history-snapshot" || r.type === "progress") {
    return { rows, conversationRecord };
  }
  if (
    r.type === "attachment" &&
    isObject(r.attachment) &&
    r.attachment.type === "file"
  ) {
    return { rows, conversationRecord };
  }

  const content = isObject(r.message) ? r.message.content : undefined;
  if (conversationRecord && typeof content === "string") {
    push("conversation", content);
  } else if (conversationRecord && Array.isArray(content)) {
    for (const block of content) {
      if (isObject(block) && block.type === "text") {
        if (typeof block.text === "string") push("conversation", block.text);
      } else if (isObject(block) && block.type === "thinking") {
        if (typeof block.thinking === "string") {
          push("conversation", block.thinking);
        }
      } else if (
        isObject(block) &&
        (block.type === "tool_use" || block.type === "tool_result")
      ) {
        push("tool", collectStrings(block));
      } else {
        push("meta", collectStrings(block));
      }
    }
  } else {
    // 모르는 형태는 버리지 않고 가장 낮은 등급으로 넣는다 (ADR-0008 제외 목록 방식)
    push("meta", collectStrings(r));
  }
  return { rows, conversationRecord };
}

function collectStrings(value: unknown): string {
  const out: string[] = [];
  walk(value, out);
  return out.join("\n");
}

function walk(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (value !== "") out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) walk(item, out);
  } else if (isObject(value)) {
    if (value.type === "base64" && typeof value.data === "string") return;
    for (const [key, child] of Object.entries(value)) {
      if (!SKIPPED_KEYS.has(key)) walk(child, out);
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
