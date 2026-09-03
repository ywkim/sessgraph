import test from "node:test";
import assert from "node:assert/strict";

import { selectRevertTargets, RevertValidationError } from "./revert.js";
import type { SurgeryLogEntry } from "./types.js";

const entries: SurgeryLogEntry[] = [
  {
    timestamp: "2026-01-01T00:00:01.000Z",
    kind: "reattach",
    targetUuid: "u1",
    previousParent: null,
    newParent: "p1",
    reason: "첫 번째 수술",
    backupPath: "/tmp/a.bak.1",
  },
  {
    timestamp: "2026-01-01T00:00:02.000Z",
    kind: "reattach",
    targetUuid: "u2",
    previousParent: null,
    newParent: "p2",
    reason: "두 번째 수술",
    backupPath: "/tmp/a.bak.2",
  },
];

test("selectRevertTargets: --last은 마지막 항목 하나만 고른다", () => {
  const { targetEntries, restoreFromBackup } = selectRevertTargets(
    entries,
    "last",
  );
  assert.equal(targetEntries.length, 1);
  assert.equal(targetEntries[0]!.reason, "두 번째 수술");
  assert.equal(restoreFromBackup, "/tmp/a.bak.2");
});

test("selectRevertTargets: --to는 그 시각 이후 모든 항목을 고르고 가장 이른 백업으로 복원한다", () => {
  const { targetEntries, restoreFromBackup } = selectRevertTargets(entries, {
    to: "2026-01-01T00:00:01.500Z",
  });
  assert.equal(targetEntries.length, 1);
  assert.equal(targetEntries[0]!.reason, "두 번째 수술");
  assert.equal(restoreFromBackup, "/tmp/a.bak.2");

  const both = selectRevertTargets(entries, {
    to: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(both.targetEntries.length, 2);
  assert.equal(both.restoreFromBackup, "/tmp/a.bak.1");
});

test("selectRevertTargets: --to가 로그의 모든 항목보다 이르면(사실은 늦으면) 오류", () => {
  assert.throws(
    () => selectRevertTargets(entries, { to: "2026-01-01T00:00:03.000Z" }),
    (err: unknown) =>
      err instanceof RevertValidationError &&
      err.code === "TARGET_NOT_FOUND" &&
      err.message === "해당 시점 이후 수술 이력이 없습니다",
  );
});

test("selectRevertTargets: --to가 가리키는 구간이 이미 revert된 경우 오류", () => {
  const withRevert: SurgeryLogEntry[] = [
    ...entries,
    {
      timestamp: "2026-01-01T00:00:03.000Z",
      kind: "revert",
      revertedEntries: ["2026-01-01T00:00:02.000Z"],
      reason: "되돌리기",
      backupPath: "/tmp/a.bak.3",
    },
  ];
  assert.throws(
    () =>
      selectRevertTargets(withRevert, {
        to: "2026-01-01T00:00:03.000Z",
      }),
    (err: unknown) =>
      err instanceof RevertValidationError &&
      err.code === "NOT_REATTACHABLE" &&
      err.message === "해당 구간은 이미 되돌려졌습니다",
  );
});

test("selectRevertTargets: 빈 로그는 오류", () => {
  assert.throws(
    () => selectRevertTargets([], "last"),
    (err: unknown) =>
      err instanceof RevertValidationError &&
      err.message === "되돌릴 수술 이력이 없습니다",
  );
});
