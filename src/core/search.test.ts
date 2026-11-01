import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildIndexDetailed } from "./build-index.js";
import { attributeOne } from "./search.js";

function indexOf(content: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "sessgraph-search-"));
  const file = path.join(dir, "session.jsonl");
  writeFileSync(file, content);
  return buildIndexDetailed(file);
}

function record(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

test("attributeOne: 세그먼트에 속한 uuid는 kind segment", () => {
  const { index, nodes } = indexOf(
    record({ uuid: "root", parentUuid: null }) + "\n",
  );
  assert.deepEqual(attributeOne(index, nodes, "root"), {
    kind: "segment",
    uuid: "root",
    segmentRootUuid: "root",
    lineNo: 1,
  });
});

test("attributeOne: 인덱스가 배제한 unresolvedDuplicate는 kind unindexed", () => {
  // 같은 uuid가 서로 다른 parentUuid로 두 번 등장 — prefer-parent가 우열을
  // 가릴 수 없어 인덱스에서 제외되지만, 검색 결과에서는 버려선 안 된다
  // (ADR-0004, Spec "귀속").
  const { index, nodes } = indexOf(
    record({ uuid: "dup", parentUuid: "p1" }) +
      "\n" +
      record({ uuid: "dup", parentUuid: "p2" }) +
      "\n",
  );
  assert.equal(index.unresolvedDuplicates.length, 1);
  assert.deepEqual(attributeOne(index, nodes, "dup"), {
    kind: "unindexed",
    uuid: "dup",
  });
});

test("attributeOne: 부모가 없는 orphan 하위 노드는 kind orphan", () => {
  const { index, nodes } = indexOf(
    record({ uuid: "child", parentUuid: "missing-parent" }) + "\n",
  );
  assert.equal(index.orphans.length, 1);
  assert.equal(attributeOne(index, nodes, "child").kind, "orphan");
});

test("attributeOne: uuid가 없으면 kind none", () => {
  const { index, nodes } = indexOf(
    record({ uuid: "root", parentUuid: null }) + "\n",
  );
  assert.deepEqual(attributeOne(index, nodes, null), { kind: "none" });
});
