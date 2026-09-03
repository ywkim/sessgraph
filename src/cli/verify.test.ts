import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runVerify } from "./verify.js";
import type { CommandEnvelope, VerifyResult } from "../core/types.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "fixtures",
);

/**
 * console.log/error를 캡처하고, `--json` 출력용 `write`는 `runVerify`의
 * 두 번째 인자로 직접 주입한다 — `src/cli/envelope.ts`의 `printEnvelope`
 * 코멘트 참고 (전역 `process.stdout.write` patch가 `await` 경계를 넘으면
 * Node v26 test runner에서 형제 테스트가 등록에서 사라진다).
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
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  return {
    logs,
    errors,
    writes,
    write: (chunk) => writes.push(chunk),
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

test("runVerify: 진짜 세션 시작점에 연결되어 있으면 종료 코드 0", () => {
  const cap = captureConsole();
  let exitCode: number;
  try {
    exitCode = runVerify(
      [
        path.join(fixturesDir, "minimal-chain.anon.jsonl"),
        "--uuid",
        "00000000-0000-4000-8000-000000000004",
      ],
      cap.write,
    );
  } finally {
    cap.restore();
  }
  assert.equal(exitCode, 0);
  assert.ok(cap.logs.some((l) => l.includes("세션 시작점까지 연결")));
});

test("runVerify: 컴팩트 경계에서 끊긴 경우도 종료 코드 0", () => {
  const cap = captureConsole();
  let exitCode: number;
  try {
    exitCode = runVerify(
      [
        path.join(fixturesDir, "compact-split.anon.jsonl"),
        "--uuid",
        "00000000-0000-4000-8000-000000000005",
      ],
      cap.write,
    );
  } finally {
    cap.restore();
  }
  assert.equal(exitCode, 0);
  assert.ok(cap.logs.some((l) => l.includes("아직 이전 조각과 끊겨")));
});

test("runVerify --json: 봉투에 VerifyResult가 그대로 담긴다", () => {
  const cap = captureConsole();
  let exitCode: number;
  try {
    exitCode = runVerify(
      [
        path.join(fixturesDir, "compact-split.anon.jsonl"),
        "--uuid",
        "00000000-0000-4000-8000-000000000005",
        "--json",
      ],
      cap.write,
    );
  } finally {
    cap.restore();
  }
  assert.equal(exitCode, 0);
  assert.equal(cap.writes.length, 1);
  const envelope = JSON.parse(cap.writes[0]!) as CommandEnvelope<VerifyResult>;
  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, "verify");
  assert.equal(
    envelope.result?.targetUuid,
    "00000000-0000-4000-8000-000000000005",
  );
  assert.equal(envelope.result?.stillDisconnectedAtRoot, true);
});

test("runVerify: 파일이 없으면 종료 코드 2", () => {
  const cap = captureConsole();
  let exitCode: number;
  try {
    exitCode = runVerify(["없는-파일.jsonl", "--uuid", "아무거나"], cap.write);
  } finally {
    cap.restore();
  }
  assert.equal(exitCode, 2);
});

test("runVerify --json: uuid를 찾을 수 없으면 봉투 오류", () => {
  const cap = captureConsole();
  let exitCode: number;
  try {
    exitCode = runVerify(
      [
        path.join(fixturesDir, "minimal-chain.anon.jsonl"),
        "--uuid",
        "존재하지-않는-uuid",
        "--json",
      ],
      cap.write,
    );
  } finally {
    cap.restore();
  }
  assert.equal(exitCode, 2);
  const envelope = JSON.parse(cap.writes[0]!) as CommandEnvelope<VerifyResult>;
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.code, "TARGET_NOT_FOUND");
});

test("runVerify: --uuid 누락이면 종료 코드 2", () => {
  const cap = captureConsole();
  let exitCode: number;
  try {
    exitCode = runVerify(
      [path.join(fixturesDir, "minimal-chain.anon.jsonl")],
      cap.write,
    );
  } finally {
    cap.restore();
  }
  assert.equal(exitCode, 2);
});
