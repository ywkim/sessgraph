import type {
  DuplicatePolicy,
  IndexResult,
  NodeIndex,
  OrphanNode,
  Segment,
  UnresolvedDuplicate,
} from "./types.js";

interface RawOccurrence {
  readonly lineNo: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly parentUuid: string | null;
  readonly type: string;
  readonly subtype: string | null;
  readonly timestamp: string | null;
}

/**
 * JSONL 텍스트를 파싱해 그래프 구조를 계산한다. 본문 필드는 읽지 않는다
 * (src/core/CLAUDE.md "인덱스는 본문을 담지 않는다").
 *
 * 기본 정책은 `prefer-parent` — inspect Spec, ADR-0004 근거.
 */
export function buildIndex(
  text: string,
  policy: DuplicatePolicy = "prefer-parent",
): IndexResult {
  const start = performance.now();

  const lines = text.length === 0 ? [] : text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const totalLines = lines.length;

  const malformedLines: number[] = [];
  const occurrencesByUuid = new Map<string, RawOccurrence[]>();
  let recordsWithUuid = 0;
  let anyParentFieldPresent = false;

  let byteOffset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    const lineByteLength = Buffer.byteLength(line, "utf8");
    const lineByteLengthWithNewline = lineByteLength + 1;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      malformedLines.push(lineNo);
      byteOffset += lineByteLengthWithNewline;
      continue;
    }

    const uuid = typeof parsed.uuid === "string" ? parsed.uuid : undefined;
    if (uuid === undefined) {
      byteOffset += lineByteLengthWithNewline;
      continue;
    }
    recordsWithUuid++;

    if (Object.prototype.hasOwnProperty.call(parsed, "parentUuid")) {
      anyParentFieldPresent = true;
    }

    const occurrence: RawOccurrence = {
      lineNo,
      byteOffset,
      byteLength: lineByteLength,
      parentUuid: (parsed.parentUuid as string | null | undefined) ?? null,
      type: typeof parsed.type === "string" ? parsed.type : "",
      subtype: typeof parsed.subtype === "string" ? parsed.subtype : null,
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : null,
    };

    const existing = occurrencesByUuid.get(uuid);
    if (existing) existing.push(occurrence);
    else occurrencesByUuid.set(uuid, [occurrence]);

    byteOffset += lineByteLengthWithNewline;
  }

  // 시끄러운 실패: uuid 레코드는 있는데 parentUuid 필드가 전멸 → 스키마 변경 의심
  // (src/core/CLAUDE.md "시끄러운 실패", ADR-0004)
  if (recordsWithUuid > 0 && !anyParentFieldPresent) {
    throw new Error(
      "parentUuid 필드가 전혀 없습니다 — 스키마 변경 의심 (ADR-0004)",
    );
  }

  const unresolvedDuplicates: UnresolvedDuplicate[] = [];
  const nodes = new Map<string, NodeIndex>();

  for (const [uuid, occurrences] of occurrencesByUuid) {
    if (occurrences.length > 1) {
      const distinctParents = new Set(occurrences.map((o) => o.parentUuid));
      if (distinctParents.size > 1) {
        unresolvedDuplicates.push({
          uuid,
          conflictingParents: occurrences.map((o) => o.parentUuid),
          lineNos: occurrences.map((o) => o.lineNo),
        });
      }
    }

    const chosen = resolveOccurrence(occurrences, policy);
    if (chosen === null) continue; // prefer-parent이 우열을 가릴 수 없어 보고만 함

    nodes.set(uuid, {
      uuid,
      parentUuid: chosen.parentUuid,
      type: chosen.type,
      subtype: chosen.subtype,
      timestamp: chosen.timestamp,
      lineNo: chosen.lineNo,
      byteOffset: chosen.byteOffset,
      byteLength: chosen.byteLength,
    });
  }

  const childrenByParent = new Map<string, NodeIndex[]>();
  const orphans: OrphanNode[] = [];

  for (const node of nodes.values()) {
    if (node.parentUuid === null) continue;
    if (!nodes.has(node.parentUuid)) {
      orphans.push({
        uuid: node.uuid,
        missingParentUuid: node.parentUuid,
        lineNo: node.lineNo,
        type: node.type,
      });
      continue;
    }
    const siblings = childrenByParent.get(node.parentUuid);
    if (siblings) siblings.push(node);
    else childrenByParent.set(node.parentUuid, [node]);
  }

  const roots = [...nodes.values()].filter((n) => n.parentUuid === null);

  const segments: Segment[] = roots.map((root) => {
    const collected: NodeIndex[] = [];
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop()!;
      collected.push(current);
      const kids = childrenByParent.get(current.uuid);
      if (kids) stack.push(...kids);
    }
    collected.sort((a, b) => a.lineNo - b.lineNo);
    const leaf = collected[collected.length - 1]!;
    return {
      rootUuid: root.uuid,
      leafUuid: leaf.uuid,
      nodeCount: collected.length,
      startTimestamp: root.timestamp,
      endTimestamp: leaf.timestamp,
      rootSubtype: root.subtype,
    };
  });
  segments.sort((a, b) =>
    (a.startTimestamp ?? "").localeCompare(b.startTimestamp ?? ""),
  );

  return {
    totalLines,
    recordsWithUuid,
    nodeCount: nodes.size,
    segments,
    orphans,
    unresolvedDuplicates,
    malformedLines,
    durationMs: performance.now() - start,
  };
}

/**
 * 중복 uuid 출현 중 하나를 정책에 따라 채택한다.
 * `null`을 반환하면 (prefer-parent가 우열을 가릴 수 없는 경우) 그 uuid는
 * 인덱스에 노드로 포함되지 않고 unresolvedDuplicates로만 보고된다
 * (inspect Spec "엣지 케이스").
 */
function resolveOccurrence(
  occurrences: readonly RawOccurrence[],
  policy: DuplicatePolicy,
): RawOccurrence | null {
  if (occurrences.length === 1) return occurrences[0]!;

  switch (policy) {
    case "first-wins":
      return occurrences[0]!;
    case "last-wins":
      return occurrences[occurrences.length - 1]!;
    case "prefer-parent": {
      const withParent = occurrences.filter((o) => o.parentUuid !== null);
      if (withParent.length === 0) return occurrences[0]!;
      const distinctParents = new Set(withParent.map((o) => o.parentUuid));
      if (distinctParents.size > 1) return null;
      return withParent[0]!;
    }
  }
}
