import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildIndexDetailed } from "./build-index.js";
import { resolveSegmentOrigins } from "./segment-origin.js";

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

function originsFor(name: string) {
  const { index, nodes } = buildIndexDetailed(fixturePath(name));
  return { origins: resolveSegmentOrigins(index, nodes), index };
}

const U = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("resolveSegmentOrigins: index.segments와 같은 길이·같은 순서다", () => {
  const { origins, index } = originsFor("compact-split");
  assert.equal(origins.length, index.segments.length);
});

test("resolveSegmentOrigins: 진짜 세션 시작점은 start", () => {
  const { origins } = originsFor("compact-split");
  assert.deepEqual(origins[0], { kind: "start" });
});

test("resolveSegmentOrigins: logicalParentUuid가 있고 파일에 있으면 recorded", () => {
  const { origins } = originsFor("logical-parent");
  assert.deepEqual(origins[1], {
    kind: "recorded",
    parentUuid: U(2),
    parentSegmentRootUuid: U(1),
  });
});

test("resolveSegmentOrigins: logicalParentUuid가 없으면 직전 조각의 leaf로 inferred", () => {
  const { origins } = originsFor("compact-split");
  assert.deepEqual(origins[1], {
    kind: "inferred",
    parentUuid: U(2),
    parentSegmentRootUuid: U(1),
  });
});

test("resolveSegmentOrigins: logicalParentUuid가 파일에 없으면 missing (recorded로 위장하지 않는다)", () => {
  const { origins } = originsFor("missing-logical-parent");
  assert.deepEqual(origins[1], { kind: "missing", parentUuid: U(99) });
});

test("resolveSegmentOrigins: 첫 조각이 컴팩트 경계이고 기록된 부모도 직전 조각도 없으면 unresolved", () => {
  // logical-parent 픽스처의 첫 레코드(U(1))는 진짜 시작점이라 이 케이스를
  // 재현하려면 첫 조각 자체가 경계여야 한다 — minimal-chain 계열에는 없으므로
  // logical-parent에서 두 번째 조각(U(3), 기록된 부모 있음)이 아니라 별도로
  // 확인한다: 첫 조각이 start가 아니면서 recorded도 없는 픽스처가 없으므로
  // unresolved는 이 스위트에서 직접 만든 인덱스로 검증한다.
  const { index, nodes } = buildIndexDetailed(fixturePath("compact-split"));
  const noRecordedFirstSegment = {
    ...index,
    segments: [
      { ...index.segments[0]!, rootSubtype: "compact_boundary" as const },
      ...index.segments.slice(1),
    ],
  };
  const origins = resolveSegmentOrigins(noRecordedFirstSegment, nodes);
  assert.deepEqual(origins[0], { kind: "unresolved" });
});
