import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
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

import { assertNoOtherOpenHandles } from "./open-handles.js";
import { runReattach } from "./reattach.js";
import { runRevert } from "./revert.js";
import type { CommandEnvelope } from "../core/types.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "fixtures",
);

const TARGET = "00000000-0000-4000-8000-000000000003";
const PARENT = "00000000-0000-4000-8000-000000000002";

function makeSession(): { dir: string; filePath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "sessgraph-open-handles-"));
  const filePath = path.join(dir, "session.jsonl");
  copyFileSync(path.join(fixturesDir, "compact-split.anon.jsonl"), filePath);
  return { dir, filePath };
}

/** 파일을 append로 연 채 죽을 때까지 붙들고 있는 자식 프로세스. 열린 뒤에 반환한다. */
async function holdOpen(filePath: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `require("node:fs").openSync(process.argv[1], "a");
       console.log("opened");
       setInterval(() => {}, 1000);`,
      filePath,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdout?.once("data", () => resolve());
  });
  return child;
}

async function release(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolve) => child.once("exit", resolve));
  child.kill();
  await exited;
}

/** console 출력을 막고 `--json` 출력은 `write`로 받는다. */
async function quietly<T>(
  run: (write: (chunk: string) => void) => Promise<T>,
): Promise<{ value: T; stdout: string }> {
  const chunks: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
  try {
    const value = await run((chunk) => chunks.push(chunk));
    return { value, stdout: chunks.join("") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }
}

test("assertNoOtherOpenHandles: 연 프로세스가 없으면 통과한다", () => {
  const { dir, filePath } = makeSession();
  try {
    assertNoOtherOpenHandles(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assertNoOtherOpenHandles: 다른 프로세스가 열고 있으면 PID를 대고 던진다", async () => {
  const { dir, filePath } = makeSession();
  const child = await holdOpen(filePath);
  try {
    assert.throws(
      () => assertNoOtherOpenHandles(filePath),
      (err: Error) =>
        err.message.includes(`PID ${child.pid}`) &&
        err.message.includes("세션을 종료한 뒤"),
    );
  } finally {
    await release(child);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assertNoOtherOpenHandles: lsof를 실행하지 못하면 없다고 가정하지 않고 던진다", () => {
  const { dir, filePath } = makeSession();
  try {
    assert.throws(
      () => assertNoOtherOpenHandles(filePath, "sessgraph-no-such-lsof"),
      /확인하지 못했습니다/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runReattach --commit: 다른 프로세스가 파일을 열고 있으면 아무것도 쓰지 않고 종료 코드 2로 끝난다", async () => {
  const { dir, filePath } = makeSession();
  const original = readFileSync(filePath, "utf8");
  const child = await holdOpen(filePath);
  try {
    const { value: exitCode, stdout } = await quietly((write) =>
      runReattach(
        [
          filePath,
          "--uuid",
          TARGET,
          "--parent",
          PARENT,
          "--reason",
          "열린 핸들 시험",
          "--commit",
          "--json",
        ],
        write,
      ),
    );

    assert.equal(exitCode, 2);
    const envelope = JSON.parse(stdout) as CommandEnvelope<unknown>;
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error?.code, "FILE_NOT_WRITABLE");
    assert.match(envelope.error?.message ?? "", new RegExp(`PID ${child.pid}`));

    assert.equal(readFileSync(filePath, "utf8"), original);
    assert.deepEqual(readdirSync(dir), ["session.jsonl"]);
  } finally {
    await release(child);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runReattach --commit: 그 프로세스가 끝나면 같은 명령이 적용된다", async () => {
  const { dir, filePath } = makeSession();
  const child = await holdOpen(filePath);
  await release(child);
  try {
    const { value: exitCode } = await quietly((write) =>
      runReattach(
        [
          filePath,
          "--uuid",
          TARGET,
          "--parent",
          PARENT,
          "--reason",
          "열린 핸들 시험",
          "--commit",
        ],
        write,
      ),
    );

    assert.equal(exitCode, 0);
    assert.ok(existsSync(`${filePath}.surgery.log`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runRevert --commit: 다른 프로세스가 파일을 열고 있으면 되돌리지 않고 종료 코드 2로 끝난다", async () => {
  const { dir, filePath } = makeSession();
  try {
    const reattached = await quietly((write) =>
      runReattach(
        [
          filePath,
          "--uuid",
          TARGET,
          "--parent",
          PARENT,
          "--reason",
          "열린 핸들 시험",
          "--commit",
        ],
        write,
      ),
    );
    assert.equal(reattached.value, 0);
    const afterReattach = readFileSync(filePath, "utf8");
    const filesBefore = readdirSync(dir).sort();

    const child = await holdOpen(filePath);
    try {
      const { value: exitCode } = await quietly((write) =>
        runRevert([filePath, "--last", "--commit"], write),
      );

      assert.equal(exitCode, 2);
      assert.equal(readFileSync(filePath, "utf8"), afterReattach);
      assert.deepEqual(readdirSync(dir).sort(), filesBefore);
    } finally {
      await release(child);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
