import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it, test } from "node:test";

import { META_WINDOW_BYTES, readSessionMeta } from "./session-meta.js";

const U = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const dir = mkdtempSync(path.join(tmpdir(), "session-meta-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function write(lines: unknown[], raw = ""): string {
  const file = path.join(dir, `s${n++}.jsonl`);
  writeFileSync(
    file,
    lines
      .map((l) => (typeof l === "string" ? l : JSON.stringify(l)))
      .join("\n") +
      "\n" +
      raw,
  );
  return file;
}

const user = (text: unknown, ts = "2026-01-01T00:00:01.000Z") => ({
  type: "user",
  timestamp: ts,
  message: { content: text },
});
const filler = (bytes: number) => ({
  type: "assistant",
  message: { content: "x".repeat(bytes) },
});

describe("readSessionMeta", () => {
  it("custom-title이 ai-title보다 우선한다", () => {
    const f = write([
      user("질문"),
      { type: "ai-title", aiTitle: "AI" },
      { type: "custom-title", customTitle: "내 제목" },
    ]);
    const m = readSessionMeta(f);
    assert.equal(m.title, "내 제목");
    assert.equal(m.titleSource, "custom-title");
    assert.equal(m.firstTimestamp, "2026-01-01T00:00:01.000Z");
  });

  it("같은 종류 제목은 마지막 레코드를 쓴다", () => {
    const f = write([
      { type: "ai-title", aiTitle: "첫째" },
      { type: "ai-title", aiTitle: "둘째" },
    ]);
    assert.equal(readSessionMeta(f).title, "둘째");
  });

  it("제목이 없으면 첫 user 메시지로 떨어지고 출처를 표시한다", () => {
    const f = write([
      user("   "),
      user([{ type: "text", text: "시작\n질문" }]),
    ]);
    const m = readSessionMeta(f);
    assert.equal(m.title, "시작 질문");
    assert.equal(m.titleSource, "first-user-message");
  });

  it("아무것도 없으면 title과 titleSource가 모두 null", () => {
    const m = readSessionMeta(write([{ type: "summary" }]));
    assert.equal(m.title, null);
    assert.equal(m.titleSource, null);
    assert.equal(m.firstTimestamp, null);
  });

  it("200자를 넘으면 …로 자른다", () => {
    const m = readSessionMeta(write([user("가".repeat(300))]));
    assert.equal(Array.from(m.title!).length, 201);
    assert.ok(m.title!.endsWith("…"));
  });

  it("공백뿐인 제목은 다음 우선순위로 넘어간다", () => {
    const f = write([
      { type: "ai-title", aiTitle: "AI" },
      { type: "custom-title", customTitle: "  \n " },
    ]);
    assert.equal(readSessionMeta(f).titleSource, "ai-title");
  });

  it("깨진 줄은 건너뛴다", () => {
    const f = write(["{broken", { type: "ai-title", aiTitle: "OK" }]);
    assert.equal(readSessionMeta(f).title, "OK");
  });

  it("뒤 창에서만 보이는 제목을 찾고, 앞 창 밖 오래된 제목은 쓰지 않는다", () => {
    const big = filler(META_WINDOW_BYTES);
    const old = write([
      user("질문"),
      { type: "ai-title", aiTitle: "오래된" },
      big,
      big,
    ]);
    const mOld = readSessionMeta(old);
    assert.equal(mOld.titleSource, "first-user-message");

    const fresh = write([
      user("질문"),
      big,
      big,
      { type: "ai-title", aiTitle: "최신" },
    ]);
    const mFresh = readSessionMeta(fresh);
    assert.equal(mFresh.title, "최신");
    assert.equal(mFresh.titleSource, "ai-title");
  });

  it("뒤 창의 잘린 첫 줄은 버린다", () => {
    const f = write([
      user("질문"),
      filler(META_WINDOW_BYTES * 2),
      { type: "ai-title", aiTitle: "끝" },
    ]);
    assert.equal(readSessionMeta(f).title, "끝");
  });

  it("읽기 오류는 throw한다", () => {
    assert.throws(() => readSessionMeta(path.join(dir, "없음.jsonl")));
  });

  it("앞 창의 custom-title이 뒤 창의 ai-title보다 우선한다", () => {
    const big = filler(META_WINDOW_BYTES);
    const f = write([
      { type: "custom-title", customTitle: "직접 지음" },
      big,
      big,
      { type: "ai-title", aiTitle: "AI" },
    ]);
    const m = readSessionMeta(f);
    assert.equal(m.title, "직접 지음");
    assert.equal(m.titleSource, "custom-title");
  });

  it("뒤 창 시작이 줄 경계이면 그 줄을 버리지 않는다", () => {
    const base = { type: "ai-title", aiTitle: "경계", pad: "" };
    const overhead = Buffer.byteLength(JSON.stringify(base)) + 1;
    const last = JSON.stringify({
      ...base,
      pad: "p".repeat(META_WINDOW_BYTES - overhead),
    });
    assert.equal(Buffer.byteLength(last) + 1, META_WINDOW_BYTES);
    const file = path.join(dir, `s${n++}.jsonl`);
    writeFileSync(
      file,
      JSON.stringify(filler(META_WINDOW_BYTES)) + "\n" + last + "\n",
    );
    assert.equal(readSessionMeta(file).title, "경계");
  });

  it("정확히 창 크기이고 개행 없는 파일의 마지막 줄을 버리지 않는다", () => {
    const base = { type: "ai-title", aiTitle: "끝줄", pad: "" };
    const overhead = Buffer.byteLength(JSON.stringify(base));
    const last = JSON.stringify({
      ...base,
      pad: "p".repeat(META_WINDOW_BYTES - overhead),
    });
    assert.equal(Buffer.byteLength(last), META_WINDOW_BYTES);
    const file = path.join(dir, `s${n++}.jsonl`);
    writeFileSync(file, last);
    assert.equal(readSessionMeta(file).title, "끝줄");
  });

  it("isMeta와 < 로 시작하는 user 메시지는 건너뛴다", () => {
    const f = write([
      { ...user("메타 문구"), isMeta: true },
      user("<command-name>/clear</command-name>"),
      user("진짜 질문"),
    ]);
    assert.equal(readSessionMeta(f).title, "진짜 질문");
  });
});

function tmpJsonl(content: string): string {
  const file = path.join(dir, `t${n++}.jsonl`);
  writeFileSync(file, content);
  return file;
}

const firstTimestampOf = (file: string): string | null =>
  readSessionMeta(file).firstTimestamp;

const line = (n: number, timestamp?: string): string =>
  JSON.stringify({
    uuid: U(n),
    parentUuid: null,
    type: "user",
    ...(timestamp ? { timestamp } : {}),
  });

test("firstTimestamp: 첫 timestamp 문자열을 돌려준다", () => {
  const file = tmpJsonl(`${line(1, "2026-01-01T00:00:01.000Z")}\n${line(2)}\n`);
  assert.equal(firstTimestampOf(file), "2026-01-01T00:00:01.000Z");
});

test("firstTimestamp: timestamp 없는 줄은 건너뛰고 다음 줄 값을 찾는다", () => {
  const file = tmpJsonl(`${line(1)}\n${line(2, "2026-01-02T00:00:00.000Z")}\n`);
  assert.equal(firstTimestampOf(file), "2026-01-02T00:00:00.000Z");
});

test("firstTimestamp: 깨진 JSON 줄은 건너뛰고 다음 줄 값을 찾는다", () => {
  const file = tmpJsonl(`{not json\n${line(2, "2026-01-03T00:00:00.000Z")}\n`);
  assert.equal(firstTimestampOf(file), "2026-01-03T00:00:00.000Z");
});

test("firstTimestamp: timestamp가 문자열이 아니면 건너뛴다", () => {
  const bad = JSON.stringify({ uuid: U(1), timestamp: 12345 });
  const file = tmpJsonl(`${bad}\n${line(2, "2026-01-04T00:00:00.000Z")}\n`);
  assert.equal(firstTimestampOf(file), "2026-01-04T00:00:00.000Z");
});

test("firstTimestamp: 메시지가 없으면 snapshot.timestamp를 쓴다", () => {
  const snap = JSON.stringify({
    type: "file-history-snapshot",
    messageId: U(1),
    snapshot: { messageId: U(1), timestamp: "2026-01-08T00:00:00.000Z" },
  });
  const summary = JSON.stringify({
    type: "summary",
    summary: "x",
    leafUuid: U(9),
  });
  const file = tmpJsonl(`${summary}\n${snap}\n`);
  assert.equal(firstTimestampOf(file), "2026-01-08T00:00:00.000Z");
});

test("firstTimestamp: 최상위 timestamp와 snapshot.timestamp 중 먼저 나온 줄을 쓴다", () => {
  const snap = JSON.stringify({
    type: "file-history-snapshot",
    snapshot: { timestamp: "2026-01-09T00:00:00.000Z" },
  });
  const file = tmpJsonl(`${snap}\n${line(1, "2026-01-09T00:00:05.000Z")}\n`);
  assert.equal(firstTimestampOf(file), "2026-01-09T00:00:00.000Z");
});

test("firstTimestamp: snapshot이 null이거나 timestamp가 문자열이 아니면 건너뛴다", () => {
  const a = JSON.stringify({ type: "file-history-snapshot", snapshot: null });
  const b = JSON.stringify({ snapshot: { timestamp: 1 } });
  const file = tmpJsonl(`${a}\n${b}\n${line(1, "2026-01-10T00:00:00.000Z")}\n`);
  assert.equal(firstTimestampOf(file), "2026-01-10T00:00:00.000Z");
});

test("firstTimestamp: 빈 파일이거나 timestamp가 전혀 없으면 null", () => {
  assert.equal(firstTimestampOf(tmpJsonl("")), null);
  assert.equal(firstTimestampOf(tmpJsonl(`${line(1)}\n${line(2)}\n`)), null);
});

test("firstTimestamp: 창 경계에서 잘린 마지막 줄은 버리고 앞 줄 값을 쓴다", () => {
  const first = line(1, "2026-01-05T00:00:00.000Z");
  const pad = "x".repeat(META_WINDOW_BYTES - first.length - 1);
  // 창 끝에 걸친 두 번째 줄은 잘려 깨진 JSON이 된다 — 완결된 첫 줄만 쓴다
  const cut = JSON.stringify({
    uuid: U(2),
    pad,
    timestamp: "2099-01-01T00:00:00.000Z",
  });
  const file = tmpJsonl(`${first}\n${cut}\n`);
  assert.equal(firstTimestampOf(file), "2026-01-05T00:00:00.000Z");
});

test("firstTimestamp: 창 안에서 끝나지 않는 첫 줄은 null", () => {
  const huge = JSON.stringify({
    uuid: U(1),
    pad: "x".repeat(META_WINDOW_BYTES),
    timestamp: "2026-01-06T00:00:00.000Z",
  });
  const file = tmpJsonl(`${huge}\n${line(2, "2026-01-07T00:00:00.000Z")}\n`);
  assert.equal(firstTimestampOf(file), null);
});
