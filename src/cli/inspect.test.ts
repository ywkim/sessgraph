import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runInspect } from "./inspect.js";
import type { CommandEnvelope } from "../core/types.js";
import type { IndexResult } from "../core/types.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "fixtures",
);

function fixturePath(name: string): string {
  return path.join(fixturesDir, `${name}.anon.jsonl`);
}

/**
 * console.log/error를 캡처하고, `--json` 출력용 `write`는 전역
 * `process.stdout.write`를 patch하는 대신 `runInspect`의 두 번째 인자로
 * 직접 주입한다. 전역 patch를 `await` 경계 너머로 유지하면 Node v26
 * test runner의 리포터가 깨져 형제 테스트가 등록에서 사라지는 문제가
 * 있었다 — `src/cli/envelope.ts`의 `printEnvelope` 코멘트 참고.
 * `runInspect`는 동기 함수라 원래는 안전하지만, 다른 CLI 테스트와
 * 패턴을 통일해 같은 실수가 재도입되지 않게 한다.
 */
function captureOutput(): {
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
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
    return true;
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
    return true;
  };
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

test("runInspect: 사람용 출력은 세그먼트·orphan 요약을 포함한다", () => {
  const cap = captureOutput();
  let exitCode: number;
  try {
    exitCode = runInspect([fixturePath("compact-split")], cap.write);
  } finally {
    cap.restore();
  }

  assert.equal(exitCode, 0);
  const combined = cap.logs.join("\n");
  assert.match(combined, /조각\(segment\)/);
  assert.match(combined, /노드/);
});

test("runInspect: --json은 봉투에 IndexResult를 그대로 담는다", () => {
  const cap = captureOutput();
  let exitCode: number;
  try {
    exitCode = runInspect([fixturePath("compact-split"), "--json"], cap.write);
  } finally {
    cap.restore();
  }

  assert.equal(exitCode, 0);
  assert.equal(cap.writes.length, 1);
  assert.equal(cap.logs.length, 0);
  assert.equal(cap.errors.length, 0);

  const envelope = JSON.parse(cap.writes[0]!) as CommandEnvelope<IndexResult>;
  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, "inspect");
  assert.equal(envelope.error, null);
  assert.ok(envelope.result);
  assert.ok(envelope.result.segments.length > 0);
});

test("runInspect: 파일이 없으면 종료 코드 2, --json이면 FILE_NOT_FOUND", () => {
  const cap = captureOutput();
  let exitCode: number;
  try {
    exitCode = runInspect(["/no/such/file.jsonl", "--json"], cap.write);
  } finally {
    cap.restore();
  }

  assert.equal(exitCode, 2);
  const envelope = JSON.parse(cap.writes[0]!) as CommandEnvelope<never>;
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.code, "FILE_NOT_FOUND");
  assert.deepEqual(envelope.error?.nextActions, []);
});

test("runInspect: 파일 경로 누락은 종료 코드 2 (사람용)", () => {
  const cap = captureOutput();
  let exitCode: number;
  try {
    exitCode = runInspect([], cap.write);
  } finally {
    cap.restore();
  }

  assert.equal(exitCode, 2);
  assert.ok(cap.errors.length > 0);
});

test("runInspect: 잘못된 --duplicate-policy는 UNKNOWN_ARGUMENT", () => {
  const cap = captureOutput();
  let exitCode: number;
  try {
    exitCode = runInspect(
      [fixturePath("compact-split"), "--duplicate-policy=bogus", "--json"],
      cap.write,
    );
  } finally {
    cap.restore();
  }

  assert.equal(exitCode, 2);
  const envelope = JSON.parse(cap.writes[0]!) as CommandEnvelope<never>;
  assert.equal(envelope.error?.code, "UNKNOWN_ARGUMENT");
});

test("runInspect: orphan 픽스처는 orphans 배열을 채운다", () => {
  const cap = captureOutput();
  let exitCode: number;
  try {
    exitCode = runInspect([fixturePath("orphan"), "--json"], cap.write);
  } finally {
    cap.restore();
  }

  assert.equal(exitCode, 0);
  const envelope = JSON.parse(cap.writes[0]!) as CommandEnvelope<IndexResult>;
  assert.ok(envelope.result!.orphans.length > 0);
});

test("runInspect: 정책으로 해소되지 않은 중복은 unresolvedDuplicates에 담긴다", () => {
  const cap = captureOutput();
  let exitCode: number;
  try {
    exitCode = runInspect(
      [fixturePath("duplicate-parents"), "--json"],
      cap.write,
    );
  } finally {
    cap.restore();
  }

  assert.equal(exitCode, 0);
  const envelope = JSON.parse(cap.writes[0]!) as CommandEnvelope<IndexResult>;
  assert.ok(envelope.result!.unresolvedDuplicates.length > 0);
});

test("runInspect: 빈 파일은 정상 종료하고 노드 0개를 보고한다", () => {
  const cap = captureOutput();
  let exitCode: number;
  try {
    exitCode = runInspect([fixturePath("empty"), "--json"], cap.write);
  } finally {
    cap.restore();
  }

  assert.equal(exitCode, 0);
  const envelope = JSON.parse(cap.writes[0]!) as CommandEnvelope<IndexResult>;
  assert.equal(envelope.result!.nodeCount, 0);
});

test("runInspect: parentUuid 필드 전멸은 SCHEMA_DRIFT로 종료 코드 2", () => {
  const cap = captureOutput();
  let exitCode: number;
  try {
    exitCode = runInspect(
      [fixturePath("no-parent-field"), "--json"],
      cap.write,
    );
  } finally {
    cap.restore();
  }

  assert.equal(exitCode, 2);
  const envelope = JSON.parse(cap.writes[0]!) as CommandEnvelope<never>;
  assert.equal(envelope.error?.code, "SCHEMA_DRIFT");
});
