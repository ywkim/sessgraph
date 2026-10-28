import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { SearchIndexClient, SearchIndexError } from "./client.js";

const dir = mkdtempSync(path.join(tmpdir(), "search-client-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const line = (text: string, ts: string) =>
  JSON.stringify({
    type: "user",
    uuid: `u-${text}`,
    timestamp: ts,
    message: { content: text },
  }) + "\n";

async function untilReady(client: SearchIndexClient): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const r = await client.searchAll("___");
    if (r.index.ready) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("색인이 준비되지 않았습니다");
}

describe("SearchIndexClient", () => {
  it("백그라운드 색인 후 전 세션·세션 하나를 검색하고, 덧붙인 내용은 다음 요청에 반영한다", async () => {
    const a = path.join(dir, "a.jsonl");
    const b = path.join(dir, "b.jsonl");
    const missing = path.join(dir, "missing.jsonl");
    writeFileSync(a, line("needle in a", "2026-01-01T00:00:00Z"));
    writeFileSync(b, line("other", "2026-01-01T00:00:00Z"));
    const client = new SearchIndexClient({
      cacheDir: path.join(dir, "cache"),
      paths: [a, b, missing],
    });
    try {
      await untilReady(client);

      const all = await client.searchAll("needle");
      assert.deepEqual(
        all.sessions.map((s) => [s.path, s.matchCount]),
        [[a, 1]],
      );
      assert.equal(all.index.indexedSessions, 3);
      assert.deepEqual(
        all.index.failed.map((f) => f.path),
        [missing],
      );

      appendFileSync(b, line("needle later", "2026-01-02T00:00:00Z"));
      const one = await client.searchOne("needle", b);
      assert.equal(one.matchCount, 1);
      assert.equal(one.matches[0]!.excerpt, "needle later");
    } finally {
      await client.close();
    }
  });

  it("캐시 디렉터리를 만들 수 없으면 검색이 unavailable로 실패한다", async () => {
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "");
    const client = new SearchIndexClient({
      cacheDir: path.join(blocker, "cache"),
      paths: [],
    });
    try {
      await assert.rejects(
        client.searchAll("x"),
        (err: unknown) =>
          err instanceof SearchIndexError && err.code === "unavailable",
      );
    } finally {
      await client.close();
    }
  });
});
