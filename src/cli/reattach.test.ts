import test from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runReattach } from "./reattach.js";
import type { CommandEnvelope } from "../core/types.js";
import type { ReattachResult } from "../core/types.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "fixtures",
);

/** 콘솔 출력을 캡처하며 원래 함수를 복원한다. */
function captureConsole(): {
  logs: string[];
  errors: string[];
  writes: string[];
  restore: () => void;
} {
  const logs: string[] = [];
  const errors: string[] = [];
  const writes: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalWrite = process.stdout.write.bind(process.stdout);
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  console.warn = (...args: unknown[]) => errors.push(args.join(" "));
  const fakeWrite = (chunk: unknown): boolean => {
    writes.push(String(chunk));
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- 테스트 전용 stub, 콜백/encoding 오버로드는 안 씀
  process.stdout.write = fakeWrite as typeof process.stdout.write;
  return {
    logs,
    errors,
    writes,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
      process.stdout.write = originalWrite;
    },
  };
}

test("runReattach: dry-run은 파일을 건드리지 않는다", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sessgraph-reattach-"));
  const filePath = path.join(dir, "session.jsonl");
  copyFileSync(path.join(fixturesDir, "compact-split.anon.jsonl"), filePath);
  const originalContent = readFileSync(filePath, "utf8");

  const cap = captureConsole();
  let exitCode: number;
  try {
    exitCode = await runReattach([
      filePath,
      "--uuid",
      "00000000-0000-4000-8000-000000000003",
      "--parent",
      "00000000-0000-4000-8000-000000000002",
      "--reason",
      "테스트",
    ]);
  } finally {
    cap.restore();
  }

  assert.equal(exitCode, 0);
  assert.equal(readFileSync(filePath, "utf8"), originalContent);
  assert.ok(!existsSync(`${filePath}.surgery.log`));
  assert.ok(cap.logs.some((l) => l.includes("dry-run")));

  rmSync(dir, { recursive: true, force: true });
});

test("runReattach: --commit은 대상 줄의 parentUuid만 바꾸고 나머지는 그대로 둔다", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sessgraph-reattach-"));
  const filePath = path.join(dir, "session.jsonl");
  copyFileSync(path.join(fixturesDir, "compact-split.anon.jsonl"), filePath);
  const originalLines = readFileSync(filePath, "utf8").trimEnd().split("\n");

  const cap = captureConsole();
  let exitCode: number;
  try {
    exitCode = await runReattach([
      filePath,
      "--uuid",
      "00000000-0000-4000-8000-000000000003",
      "--parent",
      "00000000-0000-4000-8000-000000000002",
      "--reason",
      "테스트: 끊긴 지점 연결",
      "--commit",
    ]);
  } finally {
    cap.restore();
  }

  assert.equal(exitCode, 0);

  const newLines = readFileSync(filePath, "utf8").trimEnd().split("\n");
  assert.equal(newLines.length, originalLines.length);

  for (let i = 0; i < originalLines.length; i++) {
    const parsed = JSON.parse(newLines[i]!) as {
      uuid?: string;
      parentUuid?: string | null;
    };
    if (parsed.uuid === "00000000-0000-4000-8000-000000000003") {
      assert.equal(parsed.parentUuid, "00000000-0000-4000-8000-000000000002");
    } else {
      // 대상이 아닌 줄은 바이트 단위로 그대로다.
      assert.equal(newLines[i], originalLines[i]);
    }
  }

  const backupFiles = readdirSync(dir).filter((f) => f.includes(".bak."));
  assert.equal(backupFiles.length, 1);
  const backupContent = readFileSync(path.join(dir, backupFiles[0]!), "utf8");
  assert.equal(backupContent, originalLines.join("\n") + "\n");

  assert.ok(existsSync(`${filePath}.surgery.log`));
  const logLine = readFileSync(`${filePath}.surgery.log`, "utf8").trimEnd();
  const entry = JSON.parse(logLine) as { kind: string; targetUuid: string };
  assert.equal(entry.kind, "reattach");
  assert.equal(entry.targetUuid, "00000000-0000-4000-8000-000000000003");

  rmSync(dir, { recursive: true, force: true });
});

test("runReattach: --reason 누락은 종료 코드 2", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sessgraph-reattach-"));
  const filePath = path.join(dir, "session.jsonl");
  copyFileSync(path.join(fixturesDir, "minimal-chain.anon.jsonl"), filePath);

  const cap = captureConsole();
  let exitCode: number;
  try {
    exitCode = await runReattach([
      filePath,
      "--uuid",
      "00000000-0000-4000-8000-000000000002",
      "--parent",
      "00000000-0000-4000-8000-000000000001",
    ]);
  } finally {
    cap.restore();
  }

  assert.equal(exitCode, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("runReattach: 순환이면 종료 코드 2이고 파일을 건드리지 않는다", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sessgraph-reattach-"));
  const filePath = path.join(dir, "session.jsonl");
  copyFileSync(path.join(fixturesDir, "minimal-chain.anon.jsonl"), filePath);
  const originalContent = readFileSync(filePath, "utf8");

  const cap = captureConsole();
  let exitCode: number;
  try {
    exitCode = await runReattach([
      filePath,
      "--uuid",
      "00000000-0000-4000-8000-000000000002",
      "--parent",
      "00000000-0000-4000-8000-000000000004",
      "--reason",
      "사유",
      "--commit",
    ]);
  } finally {
    cap.restore();
  }

  assert.equal(exitCode, 2);
  assert.equal(readFileSync(filePath, "utf8"), originalContent);
  rmSync(dir, { recursive: true, force: true });
});

test("runReattach: --json --commit은 봉투에 ReattachResult를 담고 stderr는 비운다", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sessgraph-reattach-"));
  const filePath = path.join(dir, "session.jsonl");
  copyFileSync(path.join(fixturesDir, "compact-split.anon.jsonl"), filePath);

  const cap = captureConsole();
  let exitCode: number;
  try {
    exitCode = await runReattach([
      filePath,
      "--uuid",
      "00000000-0000-4000-8000-000000000003",
      "--parent",
      "00000000-0000-4000-8000-000000000002",
      "--reason",
      "테스트: --json",
      "--commit",
      "--json",
    ]);
  } finally {
    cap.restore();
  }

  assert.equal(exitCode, 0);
  assert.equal(cap.logs.length, 0);
  assert.equal(cap.errors.length, 0);

  // 이 테스트는 실제 파일 I/O(pipeline/rename)로 await한다 — 그 사이 node:test
  // 리포터 자신의 TAP 출력도 process.stdout.write를 거쳐 이 캡처에 함께
  // 걸릴 수 있다. 우리 봉투만 골라낸다 (마지막에 우리 코드가 동기로 쓴다).
  const envelopeLine = cap.writes.findLast((w) =>
    w.includes('"command":"reattach"'),
  );
  assert.ok(envelopeLine, "reattach 봉투가 stdout에 쓰여야 합니다");
  const envelope = JSON.parse(
    envelopeLine,
  ) as CommandEnvelope<ReattachResult>;
  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, "reattach");
  assert.equal(envelope.error, null);
  assert.equal(envelope.result?.committed, true);
  assert.ok(envelope.result?.backupPath);
  assert.ok(envelope.result?.surgeryLogPath);

  rmSync(dir, { recursive: true, force: true });
});

test("runReattach: --json dry-run은 committed: false를 담고 파일을 건드리지 않는다", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sessgraph-reattach-"));
  const filePath = path.join(dir, "session.jsonl");
  copyFileSync(path.join(fixturesDir, "compact-split.anon.jsonl"), filePath);
  const originalContent = readFileSync(filePath, "utf8");

  const cap = captureConsole();
  let exitCode: number;
  try {
    exitCode = await runReattach([
      filePath,
      "--uuid",
      "00000000-0000-4000-8000-000000000003",
      "--parent",
      "00000000-0000-4000-8000-000000000002",
      "--reason",
      "테스트: dry-run --json",
      "--json",
    ]);
  } finally {
    cap.restore();
  }

  assert.equal(exitCode, 0);
  assert.equal(readFileSync(filePath, "utf8"), originalContent);

  const envelope = JSON.parse(
    cap.writes[0]!,
  ) as CommandEnvelope<ReattachResult>;
  assert.equal(envelope.result?.committed, false);

  rmSync(dir, { recursive: true, force: true });
});

test("runReattach: --json이면 순환은 CYCLE_DETECTED, nextActions는 빈 배열", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sessgraph-reattach-"));
  const filePath = path.join(dir, "session.jsonl");
  copyFileSync(path.join(fixturesDir, "minimal-chain.anon.jsonl"), filePath);

  const cap = captureConsole();
  let exitCode: number;
  try {
    exitCode = await runReattach([
      filePath,
      "--uuid",
      "00000000-0000-4000-8000-000000000002",
      "--parent",
      "00000000-0000-4000-8000-000000000004",
      "--reason",
      "사유",
      "--commit",
      "--json",
    ]);
  } finally {
    cap.restore();
  }

  assert.equal(exitCode, 2);
  assert.equal(cap.errors.length, 0);
  const envelope = JSON.parse(cap.writes[0]!) as CommandEnvelope<never>;
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.code, "CYCLE_DETECTED");
  assert.deepEqual(envelope.error?.nextActions, []);

  rmSync(dir, { recursive: true, force: true });
});

test("runReattach: --json이면 파일 없음은 FILE_NOT_FOUND", async () => {
  const cap = captureConsole();
  let exitCode: number;
  try {
    exitCode = await runReattach([
      "/no/such/file.jsonl",
      "--uuid",
      "x",
      "--parent",
      "y",
      "--reason",
      "사유",
      "--json",
    ]);
  } finally {
    cap.restore();
  }

  assert.equal(exitCode, 2);
  const envelope = JSON.parse(cap.writes[0]!) as CommandEnvelope<never>;
  assert.equal(envelope.error?.code, "FILE_NOT_FOUND");
});
