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

  it("1글자는 LIKE로 찾고 %·_는 글자 그대로다", () => {
    const store = SearchStore.open(cacheDir());
    const f = session([
      user("50% 할인", "2026-01-01T00:00:00Z"),
      user("500 원", "2026-01-01T00:00:01Z"),
      user("a_b", "2026-01-01T00:00:02Z"),
      user("axb", "2026-01-01T00:00:03Z"),
    ]);
    store.sync(f);
    assert.equal(store.searchOne("%", f).matchCount, 1);
    assert.equal(store.searchOne("_", f).matchCount, 1);
    store.close();
  });

  it("2글자는 보조 색인으로 찾고 %·_·공백은 글자 그대로다", () => {
    const store = SearchStore.open(cacheDir());
    const f = session([
      user("50% 할인", "2026-01-01T00:00:00Z"),
      user("500 원", "2026-01-01T00:00:01Z"),
      user("a_b", "2026-01-01T00:00:02Z"),
      user("axb", "2026-01-01T00:00:03Z"),
    ]);
    store.sync(f);
    assert.equal(store.searchOne("0%", f).matchCount, 1);
    assert.equal(store.searchOne("_b", f).matchCount, 1);
    assert.equal(store.searchOne("0 ", f).matchCount, 1);
    assert.equal(store.searchOne("할인", f).matchCount, 1);
    assert.equal(store.searchOne("인할", f).matchCount, 0);
    store.close();
  });

  it("2글자는 비ASCII도 대소문자를 무시한다", () => {
    const store = SearchStore.open(cacheDir());
    const f = session([
      user("ÉCOLE normale", "2026-01-01T00:00:00Z"),
      user("école", "2026-01-01T00:00:01Z"),
      user("ecole", "2026-01-01T00:00:02Z"),
    ]);
    store.sync(f);
    assert.equal(store.searchOne("éc", f).matchCount, 2);
    assert.equal(store.searchOne("ÉC", f).matchCount, 2);
    assert.equal(store.searchOne("EC", f).matchCount, 1);
    store.close();
  });

  it("2글자는 접으면 길이가 바뀌는 글자도 LIKE로 대신해 찾는다", () => {
    const store = SearchStore.open(cacheDir());
    const f = session([user("İx 표기", "2026-01-01T00:00:00Z")]);
    store.sync(f);
    assert.equal(store.searchOne("İx", f).matchCount, 1);
    store.close();
  });

  it("2글자 결과는 LIKE로 센 건수와 같다 (전 세션·한 세션, 이모지 포함)", () => {
    const cache = cacheDir();
    const store = SearchStore.open(cache);
    const bodies = [
      "에러가 났다 에러",
      "고아 페이지",
      "😀😀 emoji pair",
      "ab ab ba",
      "a",
      "",
      "Tab\tand\nnewline",
    ];
    const f = session(
      bodies.map((b, i) => user(b, `2026-01-01T00:00:0${i}Z`, `u${i}`)),
    );
    store.sync(f);
    const raw = new DatabaseSync(path.join(cache, "search-v1.sqlite"), {
      readOnly: true,
    });
    for (const q of [
      "에러",
      "고아",
      "😀😀",
      "ab",
      "ba",
      "a ",
      "\t",
      " e",
      "zz",
    ]) {
      const expected = (
        raw
          .prepare(
            "SELECT count(*) AS c FROM rows WHERE body LIKE ? ESCAPE '\\'",
          )
          .get(`%${q}%`) as { c: number }
      ).c;
      assert.equal(store.searchOne(q, f).matchCount, expected, q);
      const all = store.searchAll(q, new Set([f]));
      assert.equal(
        all.sessions.reduce((t, x) => t + x.matchCount, 0),
        expected,
        q,
      );
    }
    raw.close();
    store.close();
  });

  it("본문의 첫 NUL 뒤는 저장하지 않고, 두 검색이 같은 글자를 본다", () => {
    const store = SearchStore.open(cacheDir());
    const f = session([
      user("앞부분 ab\u0000뒷부분 cd", "2026-01-01T00:00:00Z"),
    ]);
    store.sync(f);
    for (const q of ["ab", "앞부", "뒷부", "cd", "뒷부분"]) {
      assert.equal(
        store.searchOne(q, f).matchCount,
        q.startsWith("ab") || q.startsWith("앞") ? 1 : 0,
        q,
      );
    }
    store.close();
  });

  it("짝 없는 서로게이트는 U+FFFD로 저장된 글자로 찾는다", () => {
    const store = SearchStore.open(cacheDir());
    const f = session([user("x\ud800y z", "2026-01-01T00:00:00Z")]);
    store.sync(f);
    assert.equal(store.searchOne("\ufffdy", f).matchCount, 1);
    assert.equal(store.searchOne("y z", f).matchCount, 1);
    store.close();
  });

  it("덧붙인 줄은 보조 색인에도 더하고, 파일이 교체되면 옛 항목을 지운다", () => {
    const store = SearchStore.open(cacheDir());
    const f = session([user("가나 다라", "2026-01-01T00:00:00Z")]);
    store.sync(f);
    appendFileSync(f, JSON.stringify(user("마바 사아", null)) + "\n");
    store.sync(f);
    assert.equal(store.searchOne("가나", f).matchCount, 1);
    assert.equal(store.searchOne("마바", f).matchCount, 1);

    const replacement = session([user("자차 카타", "2026-01-01T00:00:00Z")]);
    renameSync(replacement, f);
    store.sync(f);
    assert.equal(store.searchOne("가나", f).matchCount, 0);
    assert.equal(store.searchOne("마바", f).matchCount, 0);
    assert.equal(store.searchOne("자차", f).matchCount, 1);
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

describe("검색 조건", () => {
  const f = () =>
    session([
      user("alpha day1", "2026-01-01T00:00:00Z", "d1"),
      user("alpha day2", "2026-01-02T00:00:00Z", "d2"),
      user("alpha nodate", null, "d3"),
      toolUse("alpha tool", "2026-01-02T00:00:00Z"),
    ]);

  it("기간은 시작 이상·끝 미만이고 시각 없는 행은 날짜 조건에서 빠진다", () => {
    const store = SearchStore.open(cacheDir());
    const file = f();
    store.sync(file);
    const count = (q: string, since: string | null, until: string | null) =>
      store.searchOne(q, file, { since, until, tiers: null }).matchCount;
    // 세 질의 경로(3글자 이상, 2글자, 1글자)가 같은 결과를 낸다
    for (const q of ["alpha", "al", "a"]) {
      assert.equal(count(q, null, null), 4, q);
      assert.equal(count(q, "2026-01-02T00:00:00.000Z", null), 2, q);
      assert.equal(count(q, null, "2026-01-02T00:00:00.000Z"), 1, q);
      assert.equal(
        count(q, "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"),
        1,
        q,
      );
    }
    store.close();
  });

  it("종류 조건과 전 세션 검색의 순위·묶음이 조건에 맞는 행만으로 계산된다", () => {
    const store = SearchStore.open(cacheDir());
    const file = f();
    store.sync(file);
    for (const q of ["alpha", "al", "a"]) {
      const tool = { since: null, until: null, tiers: ["tool" as const] };
      assert.equal(store.searchOne(q, file, tool).matchCount, 1, q);
      const all = store.searchAll(q, new Set([file]), tool);
      assert.equal(all.sessions[0]!.bestTier, "tool", q);
      assert.equal(all.sessions[0]!.matchCount, 1, q);
      const none = {
        since: "2027-01-01T00:00:00.000Z",
        until: null,
        tiers: null,
      };
      assert.equal(
        store.searchAll(q, new Set([file]), none).sessions.length,
        0,
        q,
      );
    }
    store.close();
  });
});
