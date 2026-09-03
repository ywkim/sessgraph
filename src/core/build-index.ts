import { closeSync, openSync, readSync, statSync } from "node:fs";

import { COMPACT_BOUNDARY } from "./types.js";
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
  readonly logicalParentUuid: string | null;
}

/**
 * 한 줄씩 넘겨받아 인덱스를 누적하는 상태기계.
 *
 * `buildIndex`(문자열 전체를 받는 픽스처 테스트 전용 경로)와
 * `buildIndexFromFile`(스트리밍 경로) 양쪽이 이 클래스를 공유한다 —
 * 파싱·정책 적용 로직이 두 경로에서 갈리지 않게 하기 위해서다
 * (docs/spec/20260901-1337-inspect-command.spec.md "함수 계약").
 */
class IndexAccumulator {
  private readonly occurrencesByUuid = new Map<string, RawOccurrence[]>();
  private readonly malformedLines: number[] = [];
  private totalLines = 0;
  private recordsWithUuid = 0;
  private anyParentFieldPresent = false;

  addLine(line: string, lineNo: number, byteOffset: number): void {
    this.totalLines = lineNo;
    const lineByteLength = Buffer.byteLength(line, "utf8");

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.malformedLines.push(lineNo);
      return;
    }

    const uuid = typeof parsed.uuid === "string" ? parsed.uuid : undefined;
    if (uuid === undefined) return;
    this.recordsWithUuid++;

    if (Object.prototype.hasOwnProperty.call(parsed, "parentUuid")) {
      this.anyParentFieldPresent = true;
    }

    const occurrence: RawOccurrence = {
      lineNo,
      byteOffset,
      byteLength: lineByteLength,
      parentUuid: (parsed.parentUuid as string | null | undefined) ?? null,
      type: typeof parsed.type === "string" ? parsed.type : "",
      subtype: typeof parsed.subtype === "string" ? parsed.subtype : null,
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : null,
      logicalParentUuid:
        (parsed.logicalParentUuid as string | null | undefined) ?? null,
    };

    const existing = this.occurrencesByUuid.get(uuid);
    if (existing) existing.push(occurrence);
    else this.occurrencesByUuid.set(uuid, [occurrence]);
  }

  private nodesSnapshot: ReadonlyMap<string, NodeIndex> = new Map();

  /**
   * `finalize()` 호출 후 접근 가능한 uuid→NodeIndex 조회 테이블.
   * `IndexResult`는 세그먼트 root/leaf만 노출하므로, 임의 uuid의 부모를
   * 찾아야 하는 `reattach`(순환 검사, 존재 확인)는 이 맵이 필요하다
   * (docs/spec/20260901-2309-reattach-command.spec.md — Spec이 명시한
   * `buildReattachPlan(index, uuid, parent)` 시그니처만으로는 부모 조회가
   * 불가능해 확장했다. `IndexResult` 자체는 바꾸지 않는다 — 골든 픽스처
   * 계약을 건드리지 않기 위해서다).
   */
  getNodes(): ReadonlyMap<string, NodeIndex> {
    return this.nodesSnapshot;
  }

  finalize(policy: DuplicatePolicy, start: number): IndexResult {
    // 시끄러운 실패: uuid 레코드는 있는데 parentUuid 필드가 전멸 → 스키마 변경 의심
    // (src/core/CLAUDE.md "시끄러운 실패", ADR-0004)
    if (this.recordsWithUuid > 0 && !this.anyParentFieldPresent) {
      throw new Error(
        "parentUuid 필드가 전혀 없습니다 — 스키마 변경 의심 (ADR-0004)",
      );
    }

    const unresolvedDuplicates: UnresolvedDuplicate[] = [];
    const nodes = new Map<string, NodeIndex>();
    // NodeIndex는 본문 인접 필드만 노출한다 (src/core/CLAUDE.md). rootLogicalParentUuid
    // 계산에만 쓰는 값이라 별도 맵으로 둔다.
    const logicalParentByUuid = new Map<string, string | null>();

    for (const [uuid, occurrences] of this.occurrencesByUuid) {
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

      logicalParentByUuid.set(uuid, chosen.logicalParentUuid);
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

    this.nodesSnapshot = nodes;

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
        rootLogicalParentUuid:
          root.subtype === COMPACT_BOUNDARY
            ? (logicalParentByUuid.get(root.uuid) ?? null)
            : null,
      };
    });
    segments.sort((a, b) =>
      (a.startTimestamp ?? "").localeCompare(b.startTimestamp ?? ""),
    );

    return {
      totalLines: this.totalLines,
      recordsWithUuid: this.recordsWithUuid,
      nodeCount: nodes.size,
      segments,
      orphans,
      unresolvedDuplicates,
      malformedLines: this.malformedLines,
      durationMs: performance.now() - start,
    };
  }
}

/**
 * JSONL 텍스트를 파싱해 그래프 구조를 계산한다. 본문 필드는 읽지 않는다
 * (src/core/CLAUDE.md "인덱스는 본문을 담지 않는다").
 *
 * 골든 픽스처 테스트 전용 경로다 (`test/fixtures/`는 모두 V8 문자열 한계에
 * 걸리지 않는 작은 합성 파일). 실제 파일을 다루는 호출부는
 * `buildIndexFromFile`을 쓴다 (docs/spec/20260901-1337-inspect-command.spec.md
 * "함수 계약").
 *
 * 기본 정책은 `prefer-parent` — inspect Spec, ADR-0004 근거.
 */
export function buildIndex(
  text: string,
  policy: DuplicatePolicy = "prefer-parent",
): IndexResult {
  const start = performance.now();
  const acc = new IndexAccumulator();

  const lines = text.length === 0 ? [] : text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  let byteOffset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    acc.addLine(line, i + 1, byteOffset);
    byteOffset += Buffer.byteLength(line, "utf8") + 1;
  }

  return acc.finalize(policy, start);
}

const CHUNK_SIZE = 1024 * 1024; // 1MB — 파일 전체를 한 문자열로 올리지 않기 위한 상한

/**
 * 파일을 한 줄씩 스트리밍으로 읽어 인덱스를 계산한다. 파일 전체를 하나의
 * 문자열로 메모리에 올리지 않는다 — V8의 문자열 길이 한계
 * (`buffer.constants.MAX_STRING_LENGTH`, 536,870,888자)를 넘는 실제 세션
 * 파일이 존재하기 때문이다 (docs/spec/20260901-1337-inspect-command.spec.md
 * "함수 계약").
 *
 * 고정 크기 청크를 동기 `readSync`로 읽고, 청크 경계에 걸친 줄만 다음 청크와
 * 이어붙인다 — 파일 전체가 아니라 한 줄만큼만 문자열을 새로 만든다.
 */
export function buildIndexFromFile(
  filePath: string,
  policy: DuplicatePolicy = "prefer-parent",
): IndexResult {
  const start = performance.now();
  const acc = new IndexAccumulator();
  feedFile(acc, filePath);
  return acc.finalize(policy, start);
}

/**
 * `buildIndexFromFile`과 같은 계산을 하되, uuid→NodeIndex 조회 테이블도
 * 함께 반환한다. `reattach`가 대상/부모 존재 확인과 순환 검사에 쓴다
 * (docs/spec/20260901-2309-reattach-command.spec.md).
 */
export function buildIndexDetailed(
  filePath: string,
  policy: DuplicatePolicy = "prefer-parent",
): { index: IndexResult; nodes: ReadonlyMap<string, NodeIndex> } {
  const start = performance.now();
  const acc = new IndexAccumulator();
  feedFile(acc, filePath);
  const index = acc.finalize(policy, start);
  return { index, nodes: acc.getNodes() };
}

function feedFile(acc: IndexAccumulator, filePath: string): void {
  const fd = openSync(filePath, "r");
  try {
    const fileSize = statSync(filePath).size;
    const chunk = Buffer.alloc(CHUNK_SIZE);
    let pending = Buffer.alloc(0);
    let filePos = 0;
    let lineStartOffset = 0;
    let lineNo = 0;

    while (filePos < fileSize) {
      const bytesRead = readSync(fd, chunk, 0, CHUNK_SIZE, filePos);
      if (bytesRead === 0) break;
      filePos += bytesRead;

      const combined =
        pending.length === 0
          ? chunk.subarray(0, bytesRead)
          : Buffer.concat([pending, chunk.subarray(0, bytesRead)]);

      let searchFrom = 0;
      let newlineIndex: number;
      while ((newlineIndex = combined.indexOf(0x0a, searchFrom)) !== -1) {
        const lineBuf = combined.subarray(searchFrom, newlineIndex);
        lineNo++;
        acc.addLine(lineBuf.toString("utf8"), lineNo, lineStartOffset);
        lineStartOffset += newlineIndex - searchFrom + 1;
        searchFrom = newlineIndex + 1;
      }
      pending = combined.subarray(searchFrom);
    }

    if (pending.length > 0) {
      lineNo++;
      acc.addLine(pending.toString("utf8"), lineNo, lineStartOffset);
    }
  } finally {
    closeSync(fd);
  }
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
