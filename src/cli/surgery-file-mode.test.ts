import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runReattach } from "./reattach.js";
import { runRevert } from "./revert.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "fixtures",
);

const TARGET = "00000000-0000-4000-8000-000000000003";
const PARENT = "00000000-0000-4000-8000-000000000002";

function makeSession(mode: number): { dir: string; filePath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "sessgraph-file-mode-"));
  const filePath = path.join(dir, "session.jsonl");
  copyFileSync(path.join(fixturesDir, "compact-split.anon.jsonl"), filePath);
  chmodSync(filePath, mode);
  return { dir, filePath };
}

function modeOf(filePath: string): string {
  return (statSync(filePath).mode & 0o777).toString(8).padStart(4, "0");
}

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
  try {
    return await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }
}

function reattach(filePath: string): Promise<number> {
  return quietly(() =>
    runReattach([
      filePath,
      "--uuid",
      TARGET,
      "--parent",
      PARENT,
      "--reason",
      "파일 모드 시험",
      "--commit",
    ]),
  );
}

for (const mode of [0o600, 0o640]) {
  const label = mode.toString(8).padStart(4, "0");

  test(`runReattach --commit: 원본 모드 ${label}를 파일·수술 로그·백업이 모두 유지한다`, async () => {
    const { dir, filePath } = makeSession(mode);
    try {
      assert.equal(await reattach(filePath), 0);

      assert.equal(modeOf(filePath), label);
      assert.equal(modeOf(`${filePath}.surgery.log`), label);
      const backups = readdirSync(dir).filter((f) => f.includes(".bak."));
      assert.equal(backups.length, 1);
      assert.equal(modeOf(path.join(dir, backups[0]!)), label);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`runRevert --commit: 원본 모드 ${label}를 되돌린 파일·수술 로그·직전 백업이 유지한다`, async () => {
    const { dir, filePath } = makeSession(mode);
    try {
      assert.equal(await reattach(filePath), 0);

      const exitCode = await quietly(() =>
        runRevert([filePath, "--last", "--commit"]),
      );
      assert.equal(exitCode, 0);

      assert.equal(modeOf(filePath), label);
      assert.equal(modeOf(`${filePath}.surgery.log`), label);
      for (const backup of readdirSync(dir).filter((f) =>
        f.includes(".bak."),
      )) {
        assert.equal(modeOf(path.join(dir, backup)), label);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
