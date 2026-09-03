import {
  accessSync,
  constants as fsConstants,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  readSync,
  openSync,
  closeSync,
  appendFileSync,
} from "node:fs";
import { rename } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";

import { buildIndexDetailed } from "../core/build-index.js";
import {
  buildReattachPlan,
  ReattachValidationError,
} from "../core/reattach.js";
import type {
  NodeIndex,
  ReattachPlan,
  ReattachResult,
  SurgeryLogEntry,
} from "../core/types.js";

export async function runReattach(argv: readonly string[]): Promise<number> {
  let values: {
    uuid?: string;
    parent?: string;
    reason?: string;
    commit?: boolean;
  };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        uuid: { type: "string" },
        parent: { type: "string" },
        reason: { type: "string" },
        commit: { type: "boolean", default: false },
      },
    }));
  } catch (err) {
    console.error(`인자 파싱 실패: ${(err as Error).message}`);
    return 2;
  }

  const file = positionals[0];
  if (!file) {
    console.error("세션 파일 경로가 필요합니다");
    return 2;
  }
  if (!existsSync(file)) {
    console.error(`파일을 찾을 수 없습니다: ${file}`);
    return 2;
  }
  if (!values.uuid) {
    console.error("--uuid는 필수입니다");
    return 2;
  }
  if (!values.parent) {
    console.error("--parent는 필수입니다");
    return 2;
  }
  if (!values.reason || values.reason.trim() === "") {
    console.error("사유를 입력해야 합니다");
    return 2;
  }

  let index;
  let nodes;
  try {
    ({ index, nodes } = buildIndexDetailed(file));
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }

  let plan: ReattachPlan;
  try {
    plan = buildReattachPlan(
      index,
      nodes,
      values.uuid,
      values.parent,
      values.reason,
    );
  } catch (err) {
    if (err instanceof ReattachValidationError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }

  if (plan.previousParent === plan.newParent) {
    console.log("이미 연결되어 있습니다. 변경 사항 없음");
    return 0;
  }

  console.log(
    `${plan.targetUuid} (현재 부모: ${plan.previousParent ?? "없음"}) → ${plan.newParent}로 연결`,
  );
  console.log(
    `체인 길이: ${plan.beforeChainLength} → ${plan.afterChainLength}`,
  );

  if (!values.commit) {
    console.log(
      "dry-run — 파일을 수정하지 않았습니다. 적용하려면 --commit을 추가하세요",
    );
    return 0;
  }

  const target = nodes.get(plan.targetUuid);
  if (!target) {
    // buildReattachPlan이 이미 존재를 확인했으므로 도달할 수 없다.
    throw new Error("내부 오류: 대상 노드를 다시 찾을 수 없습니다");
  }

  try {
    const result = await applyReattach(file, plan, target);
    console.log(`백업: ${result.backupPath}`);
    console.log(`수술 로그: ${result.surgeryLogPath}`);
    console.log(
      "체인 길이가 늘었습니다. 실제로 이전 내용을 기억하는지는 세션을 재개해 직접 확인하세요",
    );
    return 0;
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
}

/**
 * 대상 줄의 `parentUuid` 값만 바꿔 파일을 수정한다. 나머지 줄과 대상 줄의
 * 다른 필드는 바이트 단위로 원본 그대로 유지한다 — 재직렬화하지 않는다
 * (docs/design/20260901-2309-reattach-command.tdd.md "고려한 대안 & 기각 이유").
 */
export async function applyReattach(
  filePath: string,
  plan: ReattachPlan,
  target: NodeIndex,
): Promise<ReattachResult> {
  try {
    accessSync(filePath, fsConstants.W_OK);
  } catch {
    throw new Error(`쓰기 권한이 없습니다: ${filePath}`);
  }

  const originalLine = readLineAt(
    filePath,
    target.byteOffset,
    target.byteLength,
  );
  const newLine = replaceParentUuid(originalLine, plan.newParent);

  // 사후 검증: parentUuid를 뺀 키 집합이 그대로인지 확인한다. 문자열
  // 치환이라 원래 바뀔 수 없지만, compactMetadata/preservedMessages
  // 보존이 ADR-0002의 핵심 전제이므로 회귀가 있으면 침묵하지 않고 경고한다
  // (docs/spec/20260901-2309-reattach-command.spec.md "엣지 케이스").
  warnIfKeysChanged(originalLine, newLine);

  const backupPath = uniqueBackupPath(filePath);
  copyFileSync(filePath, backupPath, fsConstants.COPYFILE_EXCL);

  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await writeReplacedFile(filePath, tempPath, target, newLine);
  await rename(tempPath, filePath);

  const surgeryLogPath = `${filePath}.surgery.log`;
  const entry: SurgeryLogEntry = {
    timestamp: new Date().toISOString(),
    kind: "reattach",
    targetUuid: plan.targetUuid,
    previousParent: plan.previousParent,
    newParent: plan.newParent,
    reason: plan.reason,
    backupPath,
  };
  appendFileSync(surgeryLogPath, `${JSON.stringify(entry)}\n`);

  return { plan, committed: true, backupPath, surgeryLogPath };
}

function readLineAt(
  filePath: string,
  byteOffset: number,
  byteLength: number,
): string {
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(byteLength);
    readSync(fd, buf, 0, byteLength, byteOffset);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

const PARENT_UUID_PATTERN = /"parentUuid"\s*:\s*(null|"[^"]*")/;

function replaceParentUuid(line: string, newParent: string): string {
  if (!PARENT_UUID_PATTERN.test(line)) {
    throw new Error("대상 줄에서 parentUuid 필드를 찾지 못했습니다");
  }
  return line.replace(PARENT_UUID_PATTERN, `"parentUuid":"${newParent}"`);
}

function warnIfKeysChanged(originalLine: string, newLine: string): void {
  const originalKeys = new Set(
    Object.keys(JSON.parse(originalLine) as Record<string, unknown>).filter(
      (k) => k !== "parentUuid",
    ),
  );
  const newKeys = new Set(
    Object.keys(JSON.parse(newLine) as Record<string, unknown>).filter(
      (k) => k !== "parentUuid",
    ),
  );
  const missing = [...originalKeys].filter((k) => !newKeys.has(k));
  if (missing.length > 0) {
    console.warn(
      `경고: 재작성 후 사라진 필드가 있습니다 (${missing.join(", ")}) — compactMetadata/preservedMessages 보존을 확인하세요 (ADR-0002)`,
    );
  }
}

async function writeReplacedFile(
  sourcePath: string,
  destPath: string,
  target: NodeIndex,
  newLine: string,
): Promise<void> {
  const writeStream = createWriteStream(destPath);
  const before = target.byteOffset;
  const after = target.byteOffset + target.byteLength + 1; // +1: 원본 줄바꿈 건너뛰기

  if (before > 0) {
    await pipeline(
      createReadStream(sourcePath, { start: 0, end: before - 1 }),
      writeStream,
      { end: false },
    );
  }
  await new Promise<void>((resolve, reject) => {
    writeStream.write(`${newLine}\n`, (err) => (err ? reject(err) : resolve()));
  });
  await pipeline(createReadStream(sourcePath, { start: after }), writeStream);
}

/**
 * `{file}.bak.{YYYYMMDDTHHmm}` 형식. 같은 분 안에 재시도하면 초 단위,
 * 그래도 충돌하면 일련번호를 붙여 기존 백업을 덮어쓰지 않는다
 * (src/cli/CLAUDE.md "쓰기 규칙" 3번).
 */
function uniqueBackupPath(filePath: string): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");
  const time = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;

  const minuteCandidate = `${filePath}.bak.${stamp}T${time}`;
  if (!existsSync(minuteCandidate)) return minuteCandidate;

  const seconds = String(now.getSeconds()).padStart(2, "0");
  const secondCandidate = `${minuteCandidate}${seconds}`;
  if (!existsSync(secondCandidate)) return secondCandidate;

  for (let serial = 1; ; serial++) {
    const candidate = `${secondCandidate}.${serial}`;
    if (!existsSync(candidate)) return candidate;
  }
}
