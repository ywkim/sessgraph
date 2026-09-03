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

/**
 * console.log/error/warn을 캡처하고, `--json` 출력용 `write`는
 * `runReattach`의 두 번째 인자로 직접 주입한다.
 *
 * 예전에는 여기서 전역 `process.stdout.write`도 patch했는데, `runReattach`가
 * `await`로 실제 비동기 파일 I/O(rename) 경계를 넘는 동안 전역 patch가
 * 살아있으면 Node v26 test runner 자신의 TAP 리포터가 stdout.write를 쓰다
 * 깨져서 형제 테스트가 등록 자체에서 조용히 사라지는 문제가 있었다(재현:
 * `/tmp/repro*.test.js`). 아래 `--commit`류 테스트들이 실제로 이 문제로
 * 5개 중 2개만 등록되는 걸 확인했다. `write`를 인자로 직접 넘기면 전역
 * 상태를 건드리지 않아 이 문제를 원천적으로 피한다
 * (`src/cli/envelope.ts`의 `printEnvelope` 코멘트 참고).
 */
function captureConsole(): {
  logs: string[];
  errors: string[];
  writes: string[];
  write: (chunk: string) => void;
  restore: () => void;
} {
  const logs: string[] = [];
  const errors: string[] = [];
  const writes: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  console.warn = (...args: unknown[]) => errors.push(args.join(" "));
  return {
    logs,
    errors,
    writes,
    write: (chunk) => writes.push(chunk),
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
    exitCode = await runReattach(
      [
        filePath,
        "--uuid",
        "00000000-0000-4000-8000-000000000003",
        "--parent",
        "00000000-0000-4000-8000-000000000002",
        "--reason",
        "테스트",
      ],
      cap.write,
    );
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
    exitCode = await runReattach(
      [
        filePath,
        "--uuid",
        "00000000-0000-4000-8000-000000000003",
        "--parent",
        "00000000-0000-4000-8000-000000000002",
        "--reason",
        "테스트: 끊긴 지점 연결",
        "--commit",
      ],
      cap.write,
    );
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
    exitCode = await runReattach(
      [
        filePath,
        "--uuid",
        "00000000-0000-4000-8000-000000000002",
        "--parent",
        "00000000-0000-4000-8000-000000000001",
      ],
      cap.write,
    );
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
    exitCode = await runReattach(
      [
        filePath,
        "--uuid",
        "00000000-0000-4000-8000-000000000002",
        "--parent",
        "00000000-0000-4000-8000-000000000004",
        "--reason",
        "사유",
        "--commit",
      ],
      cap.write,
    );
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
    exitCode = await runReattach(
      [
        filePath,
        "--uuid",
        "00000000-0000-4000-8000-000000000003",
        "--parent",
        "00000000-0000-4000-8000-000000000002",
        "--reason",
        "테스트: --json",
        "--commit",
        "--json",
      ],
      cap.write,
    );
  } finally {
    cap.restore();
  }

  assert.equal(exitCode, 0);
  assert.equal(cap.logs.length, 0);
  assert.equal(cap.errors.length, 0);
  assert.equal(cap.writes.length, 1);

  const envelope = JSON.parse(
    cap.writes[0]!,
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
    exitCode = await runReattach(
      [
        filePath,
        "--uuid",
        "00000000-0000-4000-8000-000000000003",
        "--parent",
        "00000000-0000-4000-8000-000000000002",
        "--reason",
        "테스트: dry-run --json",
        "--json",
      ],
      cap.write,
    );
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
    exitCode = await runReattach(
      [
        filePath,
        "--uuid",
        "00000000-0000-4000-8000-000000000002",
        "--parent",
        "00000000-0000-4000-8000-000000000004",
        "--reason",
        "사유",
        "--commit",
        "--json",
      ],
      cap.write,
    );
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
    exitCode = await runReattach(
      [
        "/no/such/file.jsonl",
        "--uuid",
        "x",
        "--parent",
        "y",
        "--reason",
        "사유",
        "--json",
      ],
      cap.write,
    );
  } finally {
    cap.restore();
  }

  assert.equal(exitCode, 2);
  const envelope = JSON.parse(cap.writes[0]!) as CommandEnvelope<never>;
  assert.equal(envelope.error?.code, "FILE_NOT_FOUND");
});
