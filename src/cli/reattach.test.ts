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
  restore: () => void;
} {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  console.warn = (...args: unknown[]) => errors.push(args.join(" "));
  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
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
