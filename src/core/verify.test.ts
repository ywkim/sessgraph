import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildIndex } from "./build-index.js";
import { buildVerifyResult, VerifyValidationError } from "./verify.js";
import type { NodeIndex } from "./types.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "fixtures",
);

function readFixture(name: string): string {
  return readFileSync(path.join(fixturesDir, `${name}.anon.jsonl`), "utf8");
}

// src/core/reattach.test.ts와 같은 이유로 텍스트 픽스처에서 nodes를 직접
// 구성한다 (buildIndexDetailed는 파일 경로 전용).
function nodesFromFixture(name: string): Map<string, NodeIndex> {
  const nodes = new Map<string, NodeIndex>();
  let lineNo = 0;
  for (const line of readFixture(name).trimEnd().split("\n")) {
    lineNo++;
    const parsed = JSON.parse(line) as {
      uuid?: string;
      parentUuid?: string | null;
      type?: string;
      subtype?: string;
      timestamp?: string;
    };
    if (parsed.uuid === undefined) continue;
    nodes.set(parsed.uuid, {
      uuid: parsed.uuid,
      parentUuid: parsed.parentUuid ?? null,
      type: parsed.type ?? "",
      subtype: parsed.subtype ?? null,
      timestamp: parsed.timestamp ?? null,
      lineNo,
      byteOffset: 0,
      byteLength: 0,
    });
  }
  return nodes;
}

test("buildVerifyResult: 세션 시작점(진짜 root)에 연결된 경우", () => {
  const index = buildIndex(readFixture("minimal-chain"));
  const nodes = nodesFromFixture("minimal-chain");

  const result = buildVerifyResult(
    index,
    nodes,
    "00000000-0000-4000-8000-000000000004",
  );

  assert.equal(result.stillDisconnectedAtRoot, false);
  assert.equal(result.segment.rootUuid, "00000000-0000-4000-8000-000000000001");
  assert.equal(result.segment.nodeCount, 4);
});

test("buildVerifyResult: 컴팩트 경계 root — 아직 끊긴 상태", () => {
  const index = buildIndex(readFixture("compact-split"));
  const nodes = nodesFromFixture("compact-split");

  const result = buildVerifyResult(
    index,
    nodes,
    "00000000-0000-4000-8000-000000000005",
  );

  assert.equal(result.stillDisconnectedAtRoot, true);
  assert.equal(result.segment.rootUuid, "00000000-0000-4000-8000-000000000003");
  assert.equal(result.segment.nodeCount, 3);
});

test("buildVerifyResult: uuid가 인덱스에 없으면 오류", () => {
  const index = buildIndex(readFixture("minimal-chain"));
  const nodes = nodesFromFixture("minimal-chain");

  assert.throws(
    () => buildVerifyResult(index, nodes, "존재하지-않는-uuid"),
    (err: unknown) =>
      err instanceof VerifyValidationError &&
      err.code === "TARGET_NOT_FOUND" &&
      err.message === "해당 uuid를 찾을 수 없습니다",
  );
});

test("buildVerifyResult: 정책으로 해소되지 않은 중복 대상이면 오류 (ADR-0004)", () => {
  const index = buildIndex(readFixture("duplicate-parents"), "prefer-parent");
  const nodes = nodesFromFixture("duplicate-parents");

  assert.throws(
    () =>
      buildVerifyResult(index, nodes, "00000000-0000-4000-8000-000000000003"),
    (err: unknown) =>
      err instanceof VerifyValidationError &&
      err.code === "AMBIGUOUS_DUPLICATE" &&
      err.message.includes("여러 번 출현"),
  );
});
