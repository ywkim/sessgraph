import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildIndex, buildIndexFromFile } from "./build-index.js";
import type { IndexResult } from "./types.js";

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

function readFixture(name: string): string {
  return readFileSync(fixturePath(name), "utf8");
}

function readExpected(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      path.join(fixturesDir, "expected", `${name}.expected.json`),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

/** durationMs는 비결정적이므로 골든 비교에서 제외한다 (test/fixtures/README.md). */
function withoutDuration(result: IndexResult): Omit<IndexResult, "durationMs"> {
  const { durationMs: _durationMs, ...rest } = result;
  return rest;
}

const structuralFixtures = [
  "minimal-chain",
  "compact-split",
  "logical-parent",
  "orphan",
  "malformed-line",
  "empty",
];

for (const name of structuralFixtures) {
  test(`buildIndex: ${name}`, () => {
    const expected = readExpected(name);
    const result = buildIndex(readFixture(name));
    assert.deepEqual(withoutDuration(result), expected.expected);
  });
}

test("buildIndex: duplicate-parents — 정책별로 답이 갈린다 (ADR-0004)", () => {
  const expected = readExpected("duplicate-parents");
  const byPolicy = expected.byPolicy as Record<string, unknown>;
  const unresolvedExpected = expected.unresolvedDuplicatesAllPolicies;

  for (const policy of ["first-wins", "prefer-parent", "last-wins"] as const) {
    const result = buildIndex(readFixture("duplicate-parents"), policy);
    const { durationMs: _durationMs, unresolvedDuplicates, ...rest } = result;
    assert.deepEqual(rest, byPolicy[policy], `policy=${policy}`);
    assert.deepEqual(
      unresolvedDuplicates,
      unresolvedExpected,
      `unresolvedDuplicates should not depend on policy (policy=${policy})`,
    );
  }
});

test("buildIndex: 기본 정책은 prefer-parent다 (inspect Spec)", () => {
  const expected = readExpected("duplicate-parents");
  const byPolicy = expected.byPolicy as Record<string, unknown>;
  const withoutPolicyArg = buildIndex(readFixture("duplicate-parents"));
  const explicitDefault = buildIndex(
    readFixture("duplicate-parents"),
    "prefer-parent",
  );
  assert.deepEqual(
    withoutDuration(withoutPolicyArg),
    withoutDuration(explicitDefault),
  );
  assert.equal(expected.defaultPolicy, "prefer-parent");
  assert.deepEqual(
    withoutDuration(withoutPolicyArg).segments,
    (byPolicy["prefer-parent"] as { segments: unknown }).segments,
  );
});

test("buildIndex: parentUuid 필드가 전멸하면 throw한다 (시끄러운 실패)", () => {
  const expected = readExpected("no-parent-field");
  const expectThrows = expected.expectThrows as { messageIncludes: string };
  assert.throws(
    () => buildIndex(readFixture("no-parent-field")),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes(expectThrows.messageIncludes),
  );
});

test("buildIndex: byteOffset/byteLength는 원본 파일에서 그 uuid 자신을 가리킨다", () => {
  // IndexResult.segments/orphans는 root/leaf/uuid만 노출하고 byteOffset은
  // 노출하지 않는다 (SegmentDetail이 노드 전체를 노출하는 것은 serve Spec의
  // 몫이다). 여기서는 각 uuid가 파일의 어디에 있는지 직접 찾아, 그 구간을
  // 슬라이스했을 때 같은 uuid가 나오는지로 불변식을 검증한다
  // (test/fixtures/README.md "기대값에 넣지 않은 것").
  for (const name of ["minimal-chain", "compact-split", "orphan"]) {
    const text = readFixture(name);
    const buf = Buffer.from(text, "utf8");
    const result = buildIndex(text);

    const uuidsToCheck = [
      ...result.segments.flatMap((s) => [s.rootUuid, s.leafUuid]),
      ...result.orphans.map((o) => o.uuid),
    ];

    for (const uuid of uuidsToCheck) {
      assert.ok(
        sliceContainsUuid(buf, uuid),
        `${name}: ${uuid}의 byteOffset이 파일 내 자신을 가리키지 않는다`,
      );
    }
  }
});

for (const name of structuralFixtures) {
  test(`buildIndexFromFile: ${name} — buildIndex(text)와 같은 결과`, () => {
    const fromText = withoutDuration(buildIndex(readFixture(name)));
    const fromFile = withoutDuration(buildIndexFromFile(fixturePath(name)));
    assert.deepEqual(fromFile, fromText);
  });
}

test("buildIndexFromFile: 1MB 청크 경계에 걸친 줄도 안 끊고 하나로 읽는다", () => {
  // duplicate-parents 픽스처를 반복 결합해 최소 하나의 줄 경계가
  // CHUNK_SIZE(1MB) 배수 근처에 오도록 만든다. 청크가 줄 중간에서 끊겨도
  // 다음 청크와 이어붙여 온전한 한 줄로 파싱되는지 확인한다
  // (buildIndexFromFile "청크 경계" 처리).
  const base = readFixture("duplicate-parents").trimEnd();
  const repeated = Array(400).fill(base).join("\n"); // 약 1.x MB
  const tmpPath = path.join(fixturesDir, ".tmp-chunk-boundary.jsonl");
  writeFileSync(tmpPath, repeated);
  try {
    const fromText = buildIndex(repeated, "first-wins");
    const fromFile = buildIndexFromFile(tmpPath, "first-wins");
    assert.equal(fromFile.totalLines, fromText.totalLines);
    assert.equal(fromFile.nodeCount, fromText.nodeCount);
    assert.equal(fromFile.malformedLines.length, 0);
  } finally {
    unlinkSync(tmpPath);
  }
});

/** 파일을 직접 훑어 uuid가 있는 줄을 찾고, 그 줄만 슬라이스해도 같은 uuid로 파싱되는지 확인한다. */
function sliceContainsUuid(buf: Buffer, uuid: string): boolean {
  const text = buf.toString("utf8");
  const lines = text.split("\n");
  let offset = 0;
  for (const line of lines) {
    const lineByteLength = Buffer.byteLength(line, "utf8");
    try {
      const parsed = JSON.parse(line) as { uuid?: string };
      if (parsed.uuid === uuid) {
        const sliced = buf
          .subarray(offset, offset + lineByteLength)
          .toString("utf8");
        return (JSON.parse(sliced) as { uuid?: string }).uuid === uuid;
      }
    } catch {
      // malformed line — 이 테스트의 대상이 아니다
    }
    offset += lineByteLength + 1;
  }
  return false;
}
