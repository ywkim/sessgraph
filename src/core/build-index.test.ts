import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  buildIndex,
  buildIndexDetailed,
  buildIndexFromFile,
} from "./build-index.js";
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

test("buildIndexFromFile: 반복 결합한 작은 파일도 buildIndex(text)와 같게 읽는다", () => {
  // duplicate-parents 픽스처를 400번 이어 붙인 약 283KB 파일이다. CHUNK_SIZE(1MB)
  // 경계를 넘지 않으므로 청크 경계 시험이 아니다. 청크 경계는 아래
  // "청크 경계" 시험들이 다룬다.
  const base = readFixture("duplicate-parents").trimEnd();
  const repeated = Array(400).fill(base).join("\n");
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

const CHUNK_BYTES = 1024 * 1024; // build-index.ts의 CHUNK_SIZE와 같은 값

/**
 * 구조 필드만 가진 합성 선형 체인 한 줄(줄바꿈 제외)을 정확히 `lineBytes`
 * 바이트로 만든다. 길이는 ASCII `pad` 필드로 맞춘다.
 */
function chainLine(i: number, lineBytes: number): string {
  const uuid = `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
  const parent =
    i === 0
      ? "null"
      : `"00000000-0000-4000-8000-${String(i).padStart(12, "0")}"`;
  const head = `{"uuid":"${uuid}","parentUuid":${parent},"type":"user","timestamp":"2026-01-01T00:00:00.000Z","pad":"`;
  const tail = `"}`;
  const padLen = lineBytes - head.length - tail.length;
  assert.ok(padLen >= 0, `줄 길이 ${lineBytes}B가 최소 길이보다 짧다`);
  return head + "x".repeat(padLen) + tail;
}

/** 줄 길이 목록으로 체인 파일을 만들어 임시 경로에 쓰고 본문을 돌려준다. */
function writeChain(tmpPath: string, lineBytes: readonly number[]): string {
  const text = lineBytes.map((n, i) => chainLine(i, n)).join("\n") + "\n";
  writeFileSync(tmpPath, text);
  return text;
}

/** 줄 길이 `len`인 줄을 `count`개 반복한 길이 목록. */
function repeatLen(len: number, count: number): number[] {
  return Array<number>(count).fill(len);
}

/**
 * 파일 읽기 결과가 파일 전체를 문자열로 읽은 결과와 노드·세그먼트·orphan·
 * 깨진 줄·줄 번호·바이트 오프셋까지 같고, 모든 노드의 byteOffset이 줄 시작인지
 * 확인한다.
 */
function assertFileMatchesText(tmpPath: string, text: string): void {
  const fromText = withoutDuration(buildIndex(text));
  const fromFile = withoutDuration(buildIndexFromFile(tmpPath));
  assert.deepEqual(fromFile, fromText);

  const buf = Buffer.from(text, "utf8");
  for (const [uuid, node] of buildIndexDetailed(tmpPath).nodes) {
    assert.ok(
      node.byteOffset === 0 || buf[node.byteOffset - 1] === 0x0a,
      `${uuid}의 byteOffset ${node.byteOffset}이 줄 시작이 아니다`,
    );
  }
}

function withTmpFile(name: string, run: (tmpPath: string) => void): void {
  const tmpPath = path.join(fixturesDir, name);
  try {
    run(tmpPath);
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      // 파일이 만들어지기 전에 실패한 경우
    }
  }
}

test("buildIndexFromFile: 청크 경계 — 첫 경계가 줄 중간이고 파일이 청크의 2.5배를 넘어도 한 체인으로 읽는다", () => {
  // 줄 길이 1,000B는 1MiB로 나누어떨어지지 않아 첫 경계가 줄 중간에 온다.
  // 약 2.6MB 이상이어야 두 번째 읽기가 첫 청크의 미완성 줄 자리를 덮어쓴다.
  withTmpFile(".tmp-chunk-mid-line.jsonl", (tmpPath) => {
    const lens = repeatLen(1000, 2700);
    const text = writeChain(tmpPath, lens);
    assert.ok(Buffer.byteLength(text) > CHUNK_BYTES * 2.5);
    assertFileMatchesText(tmpPath, text);
    const result = buildIndexFromFile(tmpPath);
    assert.equal(result.malformedLines.length, 0);
    assert.equal(result.nodeCount, lens.length);
    assert.equal(result.segments.length, 1);
    assert.equal(result.segments[0]!.nodeCount, lens.length);
  });
});

test("buildIndexFromFile: 청크 경계 — 줄 길이가 달라도(300B·1,023B·3,000B) 같은 결과", () => {
  for (const len of [300, 1023, 3000]) {
    withTmpFile(`.tmp-chunk-len-${len}.jsonl`, (tmpPath) => {
      const count = Math.ceil((CHUNK_BYTES * 2.7) / (len + 1));
      const text = writeChain(tmpPath, repeatLen(len, count));
      assertFileMatchesText(tmpPath, text);
    });
  }
});

test("buildIndexFromFile: 청크 경계 — 첫 경계가 줄바꿈에서 정확히 끝나면 그 다음 경계도 안전하다", () => {
  // 앞 1MiB는 줄 길이 1,023B(+개행 = 1,024B) 1,024줄이라 첫 청크가 줄바꿈에서
  // 정확히 끝난다. 이어지는 줄은 1,000B라 두 번째 경계는 줄 중간에 온다.
  // 직전 청크가 줄바꿈으로 끝나 pending이 비어 있던 청크의 끝에서도 같은
  // 결함이 생기는지 본다.
  withTmpFile(".tmp-chunk-exact-then-mid.jsonl", (tmpPath) => {
    const lens = [...repeatLen(1023, 1024), ...repeatLen(1000, 3000)];
    const text = writeChain(tmpPath, lens);
    assert.equal(
      Buffer.byteLength(text.slice(0, 1024 * 1024)),
      CHUNK_BYTES,
      "첫 청크가 줄바꿈에서 정확히 끝나야 한다",
    );
    assertFileMatchesText(tmpPath, text);
  });
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
