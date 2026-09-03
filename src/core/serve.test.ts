import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildIndexDetailed } from "./build-index.js";
import { buildSegmentDetail } from "./serve.js";

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

function detailFor(name: string, rootUuid: string) {
  const file = fixturePath(name);
  const { index, nodes } = buildIndexDetailed(file);
  return { detail: buildSegmentDetail(index, nodes, file, rootUuid), index };
}

const U = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("buildSegmentDetail: 세그먼트 노드를 root → leaf 순서로 담는다", () => {
  const { detail } = detailFor("minimal-chain", U(1));
  assert.ok(detail);
  assert.deepEqual(
    detail.nodes.map((n) => n.uuid),
    [U(1), U(2), U(3), U(4)],
  );
  assert.equal(detail.segment.rootUuid, U(1));
  assert.equal(detail.segment.leafUuid, U(4));
});

test("buildSegmentDetail: 진짜 세션 시작점은 재연결 명령어를 제안하지 않는다", () => {
  const { detail } = detailFor("minimal-chain", U(1));
  assert.ok(detail);
  assert.equal(detail.suggestedReattachCommand, null);
  assert.equal(detail.suggestedParentSource, null);
});

test("buildSegmentDetail: logicalParentUuid가 있으면 recorded로 표시한다", () => {
  const { detail } = detailFor("logical-parent", U(3));
  assert.ok(detail);
  assert.equal(detail.suggestedParentSource, "recorded");
  assert.match(
    detail.suggestedReattachCommand ?? "",
    new RegExp(`--uuid ${U(3)} --parent ${U(2)} `),
  );
});

test("buildSegmentDetail: logicalParentUuid가 없으면 직전 조각의 leaf로 추정하고 inferred로 표시한다", () => {
  const { detail } = detailFor("compact-split", U(3));
  assert.ok(detail);
  assert.equal(detail.suggestedParentSource, "inferred");
  assert.match(
    detail.suggestedReattachCommand ?? "",
    new RegExp(`--uuid ${U(3)} --parent ${U(2)} `),
  );
});

test("buildSegmentDetail: --reason은 사용자가 채우도록 빈 자리로 둔다", () => {
  const { detail } = detailFor("compact-split", U(3));
  assert.ok(detail?.suggestedReattachCommand?.endsWith('--reason ""'));
});

test("buildSegmentDetail: 어떤 세그먼트의 root도 아니면 null", () => {
  const { detail } = detailFor("compact-split", U(4));
  assert.equal(detail, null);
});
