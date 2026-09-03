import test from "node:test";
import assert from "node:assert/strict";

import { runSchema } from "./schema.js";
import type { CliSchema } from "../core/types.js";
import type { CommandEnvelope } from "../core/types.js";

function captureWrite(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  const fake = (chunk: unknown): boolean => {
    writes.push(String(chunk));
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- 테스트 전용 stub
  process.stdout.write = fake as typeof process.stdout.write;
  return {
    writes,
    restore: () => {
      process.stdout.write = original;
    },
  };
}

test("runSchema: 항상 종료 코드 0이고 봉투 하나를 stdout에 쓴다", () => {
  const cap = captureWrite();
  let exitCode: number;
  try {
    exitCode = runSchema();
  } finally {
    cap.restore();
  }

  assert.equal(exitCode, 0);
  assert.equal(cap.writes.length, 1);

  const envelope = JSON.parse(cap.writes[0]!) as CommandEnvelope<CliSchema>;
  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, "schema");
  assert.equal(envelope.result?.tool, "sessgraph");
  assert.equal(envelope.result?.schemaVersion, 1);
  assert.ok(envelope.result?.commands.some((c) => c.name === "inspect"));
  assert.ok(envelope.result?.commands.some((c) => c.name === "reattach"));
  assert.ok(!envelope.result?.commands.some((c) => c.name === "verify"));
  assert.ok(envelope.result?.errorCodes.includes("CYCLE_DETECTED"));
  assert.ok(envelope.result?.warningCodes.includes("KEYS_DROPPED"));
  assert.deepEqual(
    envelope.result?.exitCodes.map((e) => e.code),
    [0, 1, 2],
  );
});
