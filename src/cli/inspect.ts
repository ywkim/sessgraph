import { existsSync } from "node:fs";
import { parseArgs } from "node:util";

import { buildIndexFromFile } from "../core/build-index.js";
import { COMPACT_BOUNDARY } from "../core/types.js";
import type { DuplicatePolicy, IndexResult, Segment } from "../core/types.js";
import { errorEnvelope, okEnvelope, printEnvelope } from "./envelope.js";

const VALID_POLICIES: readonly DuplicatePolicy[] = [
  "first-wins",
  "last-wins",
  "prefer-parent",
];

export function runInspect(
  argv: readonly string[],
  write?: (chunk: string) => void,
): number {
  let values: { json?: boolean; "duplicate-policy"?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        json: { type: "boolean", default: false },
        "duplicate-policy": { type: "string" },
      },
    }));
  } catch (err) {
    return fail(
      false,
      "UNKNOWN_ARGUMENT",
      `인자 파싱 실패: ${(err as Error).message}`,
      write,
    );
  }

  const file = positionals[0];
  if (!file) {
    return fail(
      Boolean(values.json),
      "MISSING_ARGUMENT",
      "세션 파일 경로가 필요합니다",
      write,
    );
  }

  const rawPolicy = values["duplicate-policy"];
  let policy: DuplicatePolicy = "prefer-parent";
  if (rawPolicy !== undefined) {
    if (!VALID_POLICIES.includes(rawPolicy as DuplicatePolicy)) {
      return fail(
        Boolean(values.json),
        "UNKNOWN_ARGUMENT",
        `--duplicate-policy는 ${VALID_POLICIES.join(" | ")} 중 하나여야 합니다`,
        write,
      );
    }
    policy = rawPolicy as DuplicatePolicy;
  }

  if (!existsSync(file)) {
    return fail(
      Boolean(values.json),
      "FILE_NOT_FOUND",
      `파일을 찾을 수 없습니다: ${file}`,
      write,
    );
  }

  let index: IndexResult;
  try {
    index = buildIndexFromFile(file, policy);
  } catch (err) {
    return fail(
      Boolean(values.json),
      "SCHEMA_DRIFT",
      (err as Error).message,
      write,
    );
  }

  if (values.json) {
    printEnvelope(okEnvelope("inspect", index), write);
  } else {
    printHumanReport(index);
  }
  return 0;
}

function fail(
  json: boolean,
  code: Parameters<typeof errorEnvelope>[1],
  message: string,
  write?: (chunk: string) => void,
): number {
  if (json) {
    printEnvelope(errorEnvelope("inspect", code, message), write);
  } else {
    console.error(message);
  }
  return 2;
}

function printHumanReport(index: IndexResult): void {
  console.log(
    `총 ${index.totalLines}줄, uuid 있는 레코드 ${index.recordsWithUuid}개, 노드 ${index.nodeCount}개`,
  );

  if (index.malformedLines.length > 0) {
    console.log(
      `⚠️  올바른 JSON이 아니어서 건너뛴 줄: ${index.malformedLines.length}개 (${index.malformedLines.join(", ")})`,
    );
  }

  console.log(`\n조각(segment) ${index.segments.length}개:`);
  for (const segment of index.segments) {
    console.log(`  ${describeSegment(segment)}`);
  }

  if (index.orphans.length > 0) {
    console.log(`\n끊긴 노드(orphan) ${index.orphans.length}개:`);
    for (const orphan of index.orphans) {
      console.log(
        `  ${orphan.uuid} (줄 ${orphan.lineNo}, type=${orphan.type}) → 없는 부모 ${orphan.missingParentUuid}`,
      );
    }
  }

  if (index.unresolvedDuplicates.length > 0) {
    console.log(
      `\n⚠️  정책으로 해소되지 않은 중복 ${index.unresolvedDuplicates.length}개 — 임의로 고르지 않았습니다:`,
    );
    for (const dup of index.unresolvedDuplicates) {
      console.log(
        `  ${dup.uuid} (줄 ${dup.lineNos.join(", ")}) — 서로 다른 부모: ${dup.conflictingParents.map((p) => p ?? "없음").join(", ")}`,
      );
    }
  }
}

function describeSegment(segment: Segment): string {
  const kind =
    segment.rootSubtype === COMPACT_BOUNDARY
      ? "끊김(compact_boundary)"
      : "세션 시작점";
  const base = `${segment.rootUuid} → ${segment.leafUuid} (노드 ${segment.nodeCount}개, ${kind})`;
  if (segment.rootLogicalParentUuid) {
    return `${base} — 원래 부모로 추정: ${segment.rootLogicalParentUuid}`;
  }
  return base;
}
