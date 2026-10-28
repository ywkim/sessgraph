import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import { excerptOf, SearchStore, SESSIONS_LIMIT } from "./store.js";

const dir = mkdtempSync(path.join(tmpdir(), "search-store-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function cacheDir(): string {
  return path.join(dir, `cache${n++}`);
}
function session(lines: unknown[], tail = ""): string {
  const file = path.join(dir, `s${n++}.jsonl`);
  writeFileSync(
    file,
    lines.map((l) => JSON.stringify(l) + "\n").join("") + tail,
  );
  return file;
}
const user = (text: string, ts: string | null, uuid = `u-${text}`) => ({
  type: "user",
  uuid,
  timestamp: ts,
  message: { content: text },
});
const toolUse = (cmd: string, ts: string) => ({
  type: "assistant",
  uuid: `t-${cmd}`,
  timestamp: ts,
  message: {
    content: [{ type: "tool_use", id: "x", input: { command: cmd } }],
  },
});

describe("SearchStore", () => {
  it("캐시 디렉터리는 0700, 색인 파일과 WAL은 0600으로 만든다", () => {
    const cache = cacheDir();
    const store = SearchStore.open(cache);
    store.sync(session([user("hello", "2026-01-01T00:00:00Z")]));
    const file = path.join(cache, "search-v1.sqlite");
    assert.equal(statSync(cache).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(`${file}-wal`).mode & 0o777, 0o600);
    store.close();
  });

  it("3글자 이상은 대소문자를 무시하고 구(phrase)로 찾는다", () => {
    const store = SearchStore.open(cacheDir());
    const f = session([
      user("Secret Manager 설정", "2026-01-01T00:00:00Z"),
      user("manager secret", "2026-01-01T00:00:01Z"),
    ]);
    store.sync(f);
    const r = store.searchOne("secret manager", f);
    assert.equal(r.matchCount, 1);
    assert.equal(r.matches[0]!.uuid, "u-Secret Manager 설정");
    store.close();
  });

  it("FTS 연산자와 따옴표를 글자 그대로 찾는다", () => {
    const store = SearchStore.open(cacheDir());
    const f = session([
      user('say "a" AND b*', "2026-01-01T00:00:00Z"),
      user("a b", "2026-01-01T00:00:01Z"),
    ]);
    store.sync(f);
    assert.equal(store.searchOne('"a" AND b*', f).matchCount, 1);
    store.close();
  });

  it("3글자 미만은 LIKE로 찾고 %·_·\\는 글자 그대로다", () => {
    const store = SearchStore.open(cacheDir());
    const f = session([
      user("50% 할인", "2026-01-01T00:00:00Z"),
      user("500 원", "2026-01-01T00:00:01Z"),
      user("a_b", "2026-01-01T00:00:02Z"),
      user("axb", "2026-01-01T00:00:03Z"),
    ]);
    store.sync(f);
    assert.equal(store.searchOne("0%", f).matchCount, 1);
    assert.equal(store.searchOne("_", f).matchCount, 1);
    assert.equal(store.searchOne("할인", f).matchCount, 1);
    store.close();
  });

  it("세션 안 정렬은 등급 → 최근 순, 시각 없는 행은 등급의 맨 뒤", () => {
    const store = SearchStore.open(cacheDir());
    const f = session([
      toolUse("grep needle", "2026-01-03T00:00:00Z"),
      user("needle old", "2026-01-01T00:00:00Z"),
      user("needle none", null),
      user("needle new", "2026-01-02T00:00:00Z"),
    ]);
    store.sync(f);
    const r = store.searchOne("needle", f);
    assert.deepEqual(
      r.matches.map((m) => [m.tier, m.uuid]),
      [
        ["conversation", "u-needle new"],
        ["conversation", "u-needle old"],
        ["conversation", "u-needle none"],
        ["tool", "t-grep needle"],
      ],
    );
    store.close();
  });

  it("세션 사이 정렬은 최고 등급 → 그 등급의 최근 매치 시각 순", () => {
    const store = SearchStore.open(cacheDir());
    const toolOnly = session([toolUse("needle", "2026-01-09T00:00:00Z")]);
    const older = session([user("needle", "2026-01-01T00:00:00Z")]);
    const newer = session([
      user("needle", "2026-01-02T00:00:00Z"),
      toolUse("needle", "2026-01-08T00:00:00Z"),
    ]);
    for (const f of [toolOnly, older, newer]) store.sync(f);
    const r = store.searchAll("needle", new Set([toolOnly, older, newer]));
    assert.deepEqual(
      r.sessions.map((s) => [s.path, s.bestTier, s.latestAt, s.matchCount]),
      [
        [newer, "conversation", "2026-01-02T00:00:00Z", 2],
        [older, "conversation", "2026-01-01T00:00:00Z", 1],
        [toolOnly, "tool", "2026-01-09T00:00:00Z", 1],
      ],
    );
    assert.equal(r.truncatedSessions, false);
    store.close();
  });

  it("등록되지 않은 경로의 행은 지우지 않고 질의에서만 뺀다", () => {
    const store = SearchStore.open(cacheDir());
    const a = session([user("needle", "2026-01-01T00:00:00Z")]);
    const b = session([user("needle", "2026-01-01T00:00:00Z")]);
    store.sync(a);
    store.sync(b);
    assert.deepEqual(
      store.searchAll("needle", new Set([a])).sessions.map((s) => s.path),
      [a],
    );
    assert.equal(store.searchAll("needle", new Set([a, b])).sessions.length, 2);
    store.close();
  });

  it("세션이 50개를 넘으면 잘린 것을 알린다", () => {
    const store = SearchStore.open(cacheDir());
    const paths = new Set<string>();
    for (let i = 0; i <= SESSIONS_LIMIT; i++) {
      const f = session([user("needle", "2026-01-01T00:00:00Z")]);
      store.sync(f);
      paths.add(f);
    }
    const r = store.searchAll("needle", paths);
    assert.equal(r.sessions.length, SESSIONS_LIMIT);
    assert.equal(r.truncatedSessions, true);
    store.close();
  });

  it("덧붙인 줄만 색인하고, 개행 없는 마지막 조각은 다음 동기화로 미룬다", () => {
    const store = SearchStore.open(cacheDir());
    const f = session(
      [user("first", "2026-01-01T00:00:00Z")],
      JSON.stringify(user("partial", "2026-01-01T00:00:01Z")),
    );
    store.sync(f);
    assert.equal(store.searchOne("partial", f).matchCount, 0);
    appendFileSync(
      f,
      "\n" + JSON.stringify(user("third", "2026-01-01T00:00:02Z")) + "\n",
    );
    store.sync(f);
    assert.equal(store.searchOne("first", f).matchCount, 1);
    assert.equal(store.searchOne("partial", f).matchCount, 1);
    assert.equal(store.searchOne("third", f).matchCount, 1);
    store.close();
  });

  it("파일이 교체되거나 짧아지면 그 파일만 처음부터 다시 색인한다", () => {
    const store = SearchStore.open(cacheDir());
    const f = session([user("before-text", "2026-01-01T00:00:00Z")]);
    store.sync(f);
    const replacement = session([user("after-text", "2026-01-01T00:00:00Z")]);
    renameSync(replacement, f);
    store.sync(f);
    assert.equal(store.searchOne("before-text", f).matchCount, 0);
    assert.equal(store.searchOne("after-text", f).matchCount, 1);

    writeFileSync(f, JSON.stringify(user("tiny", null)) + "\n");
    store.sync(f);
    assert.equal(store.searchOne("after-text", f).matchCount, 0);
    assert.equal(store.searchOne("tiny", f).matchCount, 1);
    store.close();
  });

  it("cwd는 세션마다 값당 한 번만 색인한다", () => {
    const store = SearchStore.open(cacheDir());
    const rec = (i: number) => ({ ...user(`m${i}`, null), cwd: "/work/dir" });
    const f = session([rec(1), rec(2)]);
    store.sync(f);
    appendFileSync(f, JSON.stringify(rec(3)) + "\n");
    store.sync(f);
    assert.equal(store.searchOne("/work/dir", f).matchCount, 1);
    store.close();
  });

  it("파일이 사라지면 실패로 기록하고 기존 행은 남긴다", () => {
    const store = SearchStore.open(cacheDir());
    const f = session([user("needle", null)]);
    store.sync(f);
    rmSync(f);
    store.sync(f);
    const [state] = store.states([f]);
    assert.match(state!.failure!, /ENOENT/);
    assert.equal(store.searchOne("needle", f).matchCount, 1);
    store.close();
  });

  it("대화 레코드가 있는데 대화 텍스트가 없으면 suspect", () => {
    const store = SearchStore.open(cacheDir());
    const drift = session([
      { type: "user", uuid: "u", message: { body: "x" } },
    ]);
    const ok = session([user("hi", null)]);
    const noConv = session([{ type: "system", content: "x" }]);
    for (const f of [drift, ok, noConv]) store.sync(f);
    assert.deepEqual(
      store
        .states([drift, ok, noConv, "/never/synced"])
        .map((s) => [s.path, s.suspect]),
      [
        [drift, true],
        [ok, false],
        [noConv, false],
      ],
    );
    store.close();
  });

  it("다시 열면 이전 색인을 이어 쓴다", () => {
    const cache = cacheDir();
    const f = session([user("persisted", null)]);
    const first = SearchStore.open(cache);
    first.sync(f);
    first.close();
    const second = SearchStore.open(cache);
    assert.equal(second.searchOne("persisted", f).matchCount, 1);
    second.close();
  });

  it("스키마 버전이 다르거나 파일이 손상되면 지우고 새로 만든다", () => {
    const cache = cacheDir();
    const f = session([user("stale-row", null)]);
    const store = SearchStore.open(cache);
    store.sync(f);
    store.close();
    const file = path.join(cache, "search-v1.sqlite");
    const raw = new DatabaseSync(file);
    raw.exec("UPDATE meta SET value = '0' WHERE key = 'schema_version'");
    raw.close();
    const reopened = SearchStore.open(cache);
    assert.equal(reopened.searchOne("stale-row", f).matchCount, 0);
    reopened.close();

    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(file + suffix, { force: true });
    }
    writeFileSync(file, "this is not a database");
    const recovered = SearchStore.open(cache);
    recovered.sync(f);
    assert.equal(recovered.searchOne("stale-row", f).matchCount, 1);
    recovered.close();
    assert.ok(existsSync(file));
  });
});

describe("excerptOf", () => {
  it("매치 앞뒤 120 코드 포인트, 잘린 쪽에 …", () => {
    const body = "가".repeat(200) + "Needle" + "나".repeat(200);
    assert.equal(
      excerptOf(body, "needle"),
      "…" + "가".repeat(120) + "Needle" + "나".repeat(120) + "…",
    );
  });

  it("짧으면 자르지 않는다", () => {
    assert.equal(excerptOf("ab needle cd", "NEEDLE"), "ab needle cd");
  });

  it("서로게이트 쌍을 가르지 않는다", () => {
    const body = "😀".repeat(130) + "x";
    assert.equal(excerptOf(body, "x"), "…" + "😀".repeat(120) + "x");
  });

  it("접기에서 길이가 바뀌면 앞부분을 쓴다", () => {
    const body = "İ".repeat(300);
    assert.equal(excerptOf(body, "i̇"), "İ".repeat(240) + "…");
  });
});
