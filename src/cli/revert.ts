import {
  accessSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  readFileSync,
  appendFileSync,
} from "node:fs";
import { rename } from "node:fs/promises";
import { parseArgs } from "node:util";

import { buildIndexDetailed } from "../core/build-index.js";
import {
  buildRevertPlan,
  RevertValidationError,
  selectRevertTargets,
} from "../core/revert.js";
import type {
  ErrorCode,
  RevertResult,
  SurgeryLogEntry,
} from "../core/types.js";
import { errorEnvelope, okEnvelope, printEnvelope } from "./envelope.js";
import { uniqueBackupPath } from "./reattach.js";

export async function runRevert(
  argv: readonly string[],
  write?: (chunk: string) => void,
): Promise<number> {
  let values: {
    last?: boolean;
    to?: string;
    commit?: boolean;
    json?: boolean;
  };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        last: { type: "boolean", default: false },
        to: { type: "string" },
        commit: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
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

  const json = Boolean(values.json);

  const file = positionals[0];
  if (!file) {
    return fail(json, "MISSING_ARGUMENT", "세션 파일 경로가 필요합니다", write);
  }
  if (!existsSync(file)) {
    return fail(
      json,
      "FILE_NOT_FOUND",
      `파일을 찾을 수 없습니다: ${file}`,
      write,
    );
  }
  if (values.last && values.to !== undefined) {
    return fail(
      json,
      "UNKNOWN_ARGUMENT",
      "--last와 --to는 함께 쓸 수 없습니다",
      write,
    );
  }

  const surgeryLogPath = `${file}.surgery.log`;
  if (!existsSync(surgeryLogPath)) {
    return fail(json, "FILE_NOT_FOUND", "되돌릴 수술 이력이 없습니다", write);
  }

  const log = parseSurgeryLog(surgeryLogPath);
  const mode = values.to !== undefined ? { to: values.to } : ("last" as const);

  let targets;
  try {
    targets = selectRevertTargets(log, mode);
  } catch (err) {
    if (err instanceof RevertValidationError) {
      return fail(json, err.code, err.message, write);
    }
    throw err;
  }

  for (const entry of targets.targetEntries) {
    if (!existsSync(entry.backupPath)) {
      return fail(
        json,
        "FILE_NOT_FOUND",
        `백업을 찾을 수 없습니다 (${entry.timestamp}): ${entry.backupPath}`,
        write,
      );
    }
  }

  // expectedChainLength는 복원될 파일(restoreFromBackup)을 실제로
  // 인덱싱해야 계산할 수 있다 — 원본 파일은 아직 건드리지 않는다.
  let restoredIndex, restoredNodes;
  try {
    ({ index: restoredIndex, nodes: restoredNodes } = buildIndexDetailed(
      targets.restoreFromBackup,
    ));
  } catch (err) {
    return fail(json, "SCHEMA_DRIFT", (err as Error).message, write);
  }
  const plan = buildRevertPlan(log, mode, restoredIndex, restoredNodes);

  if (!values.commit) {
    const result: RevertResult = { plan, committed: false };
    if (json) {
      printEnvelope(okEnvelope("revert", result), write);
    } else {
      console.log(
        `되돌릴 대상: ${plan.targetEntries.length}건 (${plan.targetEntries.map((e) => e.reason).join(", ")})`,
      );
      console.log(`복원 후 예상 체인 길이: ${plan.expectedChainLength}`);
      console.log(
        "dry-run — 파일을 수정하지 않았습니다. 적용하려면 --commit을 추가하세요",
      );
    }
    return 0;
  }

  try {
    accessSync(file, fsConstants.W_OK);
  } catch {
    return fail(
      json,
      "FILE_NOT_WRITABLE",
      `쓰기 권한이 없습니다: ${file}`,
      write,
    );
  }

  const preRevertBackupPath = uniqueBackupPath(file);
  copyFileSync(file, preRevertBackupPath, fsConstants.COPYFILE_EXCL);

  const tempPath = `${file}.tmp.${process.pid}.${Date.now()}`;
  copyFileSync(plan.restoreFromBackup, tempPath);
  await rename(tempPath, file);

  const entry: SurgeryLogEntry = {
    timestamp: new Date().toISOString(),
    kind: "revert",
    revertedEntries: plan.targetEntries.map((e) => e.timestamp),
    reason: `되돌리기: ${plan.targetEntries.length}건 (${plan.targetEntries.map((e) => e.reason).join("; ")})`,
    backupPath: preRevertBackupPath,
  };
  appendFileSync(surgeryLogPath, `${JSON.stringify(entry)}\n`);

  // 복원 후 실제 체인 길이가 계획과 일치하는지 확인한다 — 조용히 성공을
  // 보고하지 않는다 (Spec "엣지 케이스", ADR-0004).
  let verifiedIndex, verifiedNodes;
  try {
    ({ index: verifiedIndex, nodes: verifiedNodes } = buildIndexDetailed(file));
  } catch (err) {
    return fail(json, "SCHEMA_DRIFT", (err as Error).message, write);
  }
  const anchorUuid = plan.targetEntries.reduce((min, e) =>
    e.timestamp < min.timestamp ? e : min,
  ).targetUuid;
  const actualChainLength =
    anchorUuid && verifiedNodes.has(anchorUuid)
      ? buildRevertPlan(log, mode, verifiedIndex, verifiedNodes)
          .expectedChainLength
      : verifiedIndex.nodeCount;

  if (actualChainLength !== plan.expectedChainLength) {
    return fail(
      json,
      "SCHEMA_DRIFT",
      `복원 후 체인 길이(${actualChainLength})가 예상(${plan.expectedChainLength})과 다릅니다`,
      write,
    );
  }

  const result: RevertResult = {
    plan,
    committed: true,
    preRevertBackupPath,
    surgeryLogPath,
  };
  if (json) {
    printEnvelope(okEnvelope("revert", result), write);
  } else {
    console.log(
      `${plan.targetEntries.length}건을 되돌렸습니다. 구조적으로 ${plan.expectedChainLength}개 노드가 이었던 상태로 돌아갔습니다`,
    );
    console.log(`되돌리기 직전 백업: ${preRevertBackupPath}`);
    console.log(`수술 로그: ${surgeryLogPath}`);
    console.log(
      "실제로 이전 내용을 기억하는지는 세션을 재개해 직접 확인하세요",
    );
  }
  return 0;
}

function parseSurgeryLog(path: string): SurgeryLogEntry[] {
  const text = readFileSync(path, "utf8").trimEnd();
  if (text === "") return [];
  return text.split("\n").map((line) => JSON.parse(line) as SurgeryLogEntry);
}

function fail(
  json: boolean,
  code: ErrorCode,
  message: string,
  write?: (chunk: string) => void,
): number {
  if (json) {
    printEnvelope(errorEnvelope("revert", code, message, []), write);
  } else {
    console.error(message);
  }
  return 2;
}
