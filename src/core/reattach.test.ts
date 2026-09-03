import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildIndex } from "./build-index.js";
import { buildReattachPlan, ReattachValidationError } from "./reattach.js";
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

// build-index.ts는 텍스트 입력용 nodes 조회 함수를 노출하지 않는다
// (`buildIndexDetailed`는 파일 경로 전용 — reattach는 항상 실제 파일을
// 다루므로). 테스트는 buildReattachPlan이 실제로 쓰는 필드(uuid,
// parentUuid)만 채운 NodeIndex를 픽스처 텍스트에서 직접 구성한다. 나머지
// 필드는 buildReattachPlan이 읽지 않으므로 자리표시자로 채운다.
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

test("buildReattachPlan: compact-split — 끊긴 두 번째 세그먼트를 첫 번째 leaf에 잇는다", () => {
  const index = buildIndex(readFixture("compact-split"));
  const nodes = nodesFromFixture("compact-split");

  const plan = buildReattachPlan(
    index,
    nodes,
    "00000000-0000-4000-8000-000000000003", // 두 번째 세그먼트 root(compact_boundary)
    "00000000-0000-4000-8000-000000000002", // 첫 번째 세그먼트 leaf
    "테스트: 끊긴 지점 연결",
  );

  assert.deepEqual(plan, {
    targetUuid: "00000000-0000-4000-8000-000000000003",
    previousParent: null,
    newParent: "00000000-0000-4000-8000-000000000002",
    reason: "테스트: 끊긴 지점 연결",
    beforeChainLength: 3, // 두 번째 세그먼트 노드 수 (0003,0004,0005)
    afterChainLength: 5, // 첫 번째 세그먼트(2) + 이동한 subtree(3)
  });
});

test("buildReattachPlan: 이미 연결되어 있으면 체인 길이가 그대로다", () => {
  const index = buildIndex(readFixture("minimal-chain"));
  const nodes = nodesFromFixture("minimal-chain");

  const plan = buildReattachPlan(
    index,
    nodes,
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000001", // 이미 현재 부모
    "테스트: 이미 연결됨",
  );

  assert.equal(plan.previousParent, plan.newParent);
  assert.equal(plan.beforeChainLength, plan.afterChainLength);
});

test("buildReattachPlan: 대상 uuid가 없으면 오류", () => {
  const index = buildIndex(readFixture("minimal-chain"));
  const nodes = nodesFromFixture("minimal-chain");

  assert.throws(
    () =>
      buildReattachPlan(
        index,
        nodes,
        "존재하지-않는-uuid",
        "00000000-0000-4000-8000-000000000001",
        "사유",
      ),
    (err: unknown) =>
      err instanceof ReattachValidationError &&
      err.message === "대상 uuid를 찾을 수 없습니다",
  );
});

test("buildReattachPlan: 부모 uuid가 없으면 오류", () => {
  const index = buildIndex(readFixture("minimal-chain"));
  const nodes = nodesFromFixture("minimal-chain");

  assert.throws(
    () =>
      buildReattachPlan(
        index,
        nodes,
        "00000000-0000-4000-8000-000000000002",
        "존재하지-않는-uuid",
        "사유",
      ),
    (err: unknown) =>
      err instanceof ReattachValidationError &&
      err.message === "지정한 부모 uuid를 찾을 수 없습니다",
  );
});

test("buildReattachPlan: 자손을 부모로 지정하면 순환 오류", () => {
  const index = buildIndex(readFixture("minimal-chain"));
  const nodes = nodesFromFixture("minimal-chain");

  // 0002를 0004(0002의 자손) 아래로 재연결하려 하면 순환이 생긴다.
  assert.throws(
    () =>
      buildReattachPlan(
        index,
        nodes,
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000004",
        "사유",
      ),
    (err: unknown) =>
      err instanceof ReattachValidationError &&
      err.message === "순환이 생겨 적용할 수 없습니다",
  );
});

test("buildReattachPlan: 자기 자신을 부모로 지정하면 순환 오류", () => {
  const index = buildIndex(readFixture("minimal-chain"));
  const nodes = nodesFromFixture("minimal-chain");

  assert.throws(
    () =>
      buildReattachPlan(
        index,
        nodes,
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000002",
        "사유",
      ),
    (err: unknown) =>
      err instanceof ReattachValidationError &&
      err.message === "순환이 생겨 적용할 수 없습니다",
  );
});

test("buildReattachPlan: 사유가 빈 문자열이면 오류", () => {
  const index = buildIndex(readFixture("minimal-chain"));
  const nodes = nodesFromFixture("minimal-chain");

  assert.throws(
    () =>
      buildReattachPlan(
        index,
        nodes,
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000001",
        "   ",
      ),
    (err: unknown) =>
      err instanceof ReattachValidationError &&
      err.message === "사유를 입력해야 합니다",
  );
});

test("buildReattachPlan: 정책으로 해소되지 않은 중복 대상이면 오류 (ADR-0004)", () => {
  const index = buildIndex(readFixture("duplicate-parents"), "prefer-parent");
  // prefer-parent 정책에서 ...0003은 우열을 가릴 수 없어 buildIndex의
  // nodes에는 담기지 않지만, unresolvedDuplicates 검사가 nodes 조회보다
  // 먼저 실행되므로 nodesFromFixture가 채운 자리표시자로도 충분하다.
  const nodes = nodesFromFixture("duplicate-parents");

  assert.throws(
    () =>
      buildReattachPlan(
        index,
        nodes,
        "00000000-0000-4000-8000-000000000003",
        "00000000-0000-4000-8000-000000000001",
        "사유",
      ),
    (err: unknown) =>
      err instanceof ReattachValidationError &&
      err.message.includes("여러 번 출현"),
  );
});
