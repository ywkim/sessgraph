import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildIndexDetailed } from "./build-index.js";
import { attributeMatches, scanFile } from "./search.js";

function tempFile(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sessgraph-search-"));
  const file = path.join(dir, "session.jsonl");
  writeFileSync(file, content);
  return file;
}

function record(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

test("scanFile: 매치가 없으면 빈 배열", () => {
  const file = tempFile(record({ uuid: "a", parentUuid: null }) + "\n");
  const { matches, truncated } = scanFile(file, "존재하지않음", 1000);
  assert.deepEqual(matches, []);
  assert.equal(truncated, false);
});

test("scanFile: 빈 파일은 매치 0건", () => {
  const file = tempFile("");
  const { matches } = scanFile(file, "x", 1000);
  assert.deepEqual(matches, []);
});

test("scanFile: 매치는 겹치지 않는다 ('aa'를 'aaa'에서 찾으면 1건)", () => {
  const file = tempFile(record({ uuid: "a", parentUuid: null, note: "aaa" }));
  const { matches } = scanFile(file, "aa", 1000);
  assert.equal(matches.length, 1);
});

test("scanFile: 매치가 든 줄의 uuid를 함께 반환한다", () => {
  const file = tempFile(
    record({ uuid: "target-uuid", parentUuid: null, text: "hello world" }) +
      "\n",
  );
  const { matches } = scanFile(file, "hello", 1000);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.uuid, "target-uuid");
  assert.match(matches[0]!.excerpt, /hello world/);
});

test("scanFile: 매치 상한에 도달하면 truncated true", () => {
  const lines = Array.from({ length: 10 }, (_, i) =>
    record({ uuid: `u${i}`, parentUuid: null, text: "needle" }),
  ).join("\n");
  const { matches, truncated } = scanFile(tempFile(lines), "needle", 5);
  assert.equal(matches.length, 5);
  assert.equal(truncated, true);
});

test("scanFile: 매치는 byteOffset 오름차순이다", () => {
  const lines = Array.from({ length: 5 }, (_, i) =>
    record({ uuid: `u${i}`, parentUuid: null, text: "needle" }),
  ).join("\n");
  const { matches } = scanFile(tempFile(lines), "needle", 1000);
  const offsets = matches.map((m) => m.byteOffset);
  assert.deepEqual(
    offsets,
    [...offsets].sort((a, b) => a - b),
  );
});

test("scanFile: 청크 경계에 걸친 매치도 놓치지 않는다", () => {
  // CHUNK_SIZE(1MB) 경계 바로 앞뒤에 매치가 걸치도록 패딩한다.
  const CHUNK_SIZE = 1024 * 1024;
  const needle = "boundary-needle";
  const before = record({ uuid: "pad", parentUuid: null }) + "\n";
  const padLen = CHUNK_SIZE - before.length - Math.floor(needle.length / 2);
  const padding = "x".repeat(Math.max(0, padLen));
  const content =
    before +
    record({ uuid: "target", parentUuid: null, text: padding + needle }) +
    "\n";
  const { matches } = scanFile(tempFile(content), needle, 1000);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.uuid, "target");
});

test("attributeMatches: 세그먼트에 속한 uuid는 kind segment", () => {
  const content =
    record({ uuid: "root", parentUuid: null, text: "needle" }) + "\n";
  const file = tempFile(content);
  const { index, nodes } = buildIndexDetailed(file);
  const { matches: raw } = scanFile(file, "needle", 1000);
  const [match] = attributeMatches(index, nodes, raw);
  assert.equal(match!.attribution.kind, "segment");
  if (match!.attribution.kind === "segment") {
    assert.equal(match!.attribution.segmentRootUuid, "root");
  }
});

test("attributeMatches: 인덱스가 배제한 unresolvedDuplicate는 kind unindexed", () => {
  // 같은 uuid가 서로 다른 parentUuid로 두 번 등장 — prefer-parent가 우열을
  // 가릴 수 없어 인덱스에서 제외되지만(unresolvedDuplicates), 검색 결과에서는
  // 버려선 안 된다 (ADR-0004, Spec "귀속").
  const content =
    record({ uuid: "dup", parentUuid: "p1", text: "needle" }) +
    "\n" +
    record({ uuid: "dup", parentUuid: "p2", text: "needle" }) +
    "\n";
  const file = tempFile(content);
  const { index, nodes } = buildIndexDetailed(file);
  assert.equal(index.unresolvedDuplicates.length, 1);
  const { matches: raw } = scanFile(file, "needle", 1000);
  const attributed = attributeMatches(index, nodes, raw);
  assert.equal(attributed.length, 2);
  for (const match of attributed) {
    assert.equal(match.attribution.kind, "unindexed");
  }
});

test("attributeMatches: 부모가 없는 orphan 하위 노드는 kind orphan", () => {
  const content =
    record({
      uuid: "child",
      parentUuid: "missing-parent",
      text: "needle",
    }) + "\n";
  const file = tempFile(content);
  const { index, nodes } = buildIndexDetailed(file);
  assert.equal(index.orphans.length, 1);
  const { matches: raw } = scanFile(file, "needle", 1000);
  const [match] = attributeMatches(index, nodes, raw);
  assert.equal(match!.attribution.kind, "orphan");
});

test("attributeMatches: uuid가 없는 줄의 매치는 kind none", () => {
  const content = record({ note: "needle, but no uuid field" }) + "\n";
  const file = tempFile(content);
  const { index, nodes } = buildIndexDetailed(file);
  const { matches: raw } = scanFile(file, "needle", 1000);
  const [match] = attributeMatches(index, nodes, raw);
  assert.equal(match!.attribution.kind, "none");
});
