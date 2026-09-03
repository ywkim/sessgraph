import test from "node:test";
import assert from "node:assert/strict";

import { runSchema } from "./schema.js";
import type { CliSchema } from "../core/types.js";
import type { CommandEnvelope } from "../core/types.js";

test("runSchema: 항상 종료 코드 0이고 봉투 하나를 stdout에 쓴다", () => {
  const writes: string[] = [];
  const exitCode = runSchema((chunk) => writes.push(chunk));

  assert.equal(exitCode, 0);
  assert.equal(writes.length, 1);

  const envelope = JSON.parse(writes[0]!) as CommandEnvelope<CliSchema>;
  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, "schema");
  assert.equal(envelope.result?.tool, "sessgraph");
  assert.equal(envelope.result?.schemaVersion, 1);
  assert.ok(envelope.result?.commands.some((c) => c.name === "inspect"));
  assert.ok(envelope.result?.commands.some((c) => c.name === "reattach"));
  assert.ok(envelope.result?.commands.some((c) => c.name === "verify"));
  assert.ok(envelope.result?.commands.some((c) => c.name === "revert"));
  assert.ok(!envelope.result?.commands.some((c) => c.name === "serve"));
  assert.ok(envelope.result?.errorCodes.includes("CYCLE_DETECTED"));
  assert.ok(envelope.result?.warningCodes.includes("KEYS_DROPPED"));
  assert.deepEqual(
    envelope.result?.exitCodes.map((e) => e.code),
    [0, 1, 2],
  );
});
