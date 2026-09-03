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
  const originalWrite = process.stdout.write.bind(process.stdout);
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  const fakeWrite = (chunk: unknown): boolean => {
    writes.push(String(chunk));
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- 테스트 전용 stub
  process.stdout.write = fakeWrite as typeof process.stdout.write;
  return {
    logs,
    errors,
    writes,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
      process.stdout.write = originalWrite;
    },
  };
}

test("runVerify: 진짜 세션 시작점에 연결되어 있으면 종료 코드 0", () => {
  const cap = captureConsole();
  let exitCode: number;
  try {
    exitCode = runVerify([
      path.join(fixturesDir, "minimal-chain.anon.jsonl"),
      "--uuid",
      "00000000-0000-4000-8000-000000000004",
    ]);
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
    exitCode = runVerify([
      path.join(fixturesDir, "compact-split.anon.jsonl"),
      "--uuid",
      "00000000-0000-4000-8000-000000000005",
    ]);
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
    exitCode = runVerify([
      path.join(fixturesDir, "compact-split.anon.jsonl"),
      "--uuid",
      "00000000-0000-4000-8000-000000000005",
      "--json",
    ]);
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
    exitCode = runVerify(["없는-파일.jsonl", "--uuid", "아무거나"]);
  } finally {
    cap.restore();
  }
  assert.equal(exitCode, 2);
});

test("runVerify --json: uuid를 찾을 수 없으면 봉투 오류", () => {
  const cap = captureConsole();
  let exitCode: number;
  try {
    exitCode = runVerify([
      path.join(fixturesDir, "minimal-chain.anon.jsonl"),
      "--uuid",
      "존재하지-않는-uuid",
      "--json",
    ]);
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
    exitCode = runVerify([path.join(fixturesDir, "minimal-chain.anon.jsonl")]);
  } finally {
    cap.restore();
  }
  assert.equal(exitCode, 2);
});
