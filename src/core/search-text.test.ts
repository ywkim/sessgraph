import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractSearchRows, type SearchRow } from "./search-text.js";

const UUID = "00000000-0000-4000-8000-000000000001";
const TS = "2026-01-01T00:00:01.000Z";

const line = (r: unknown) => JSON.stringify(r);
const row = (
  tier: SearchRow["tier"],
  text: string,
  perSession = false,
): SearchRow => ({ tier, text, uuid: UUID, timestamp: TS, perSession });

describe("extractSearchRows", () => {
  it("JSON 파싱 실패면 행이 없고 대화 레코드가 아니다", () => {
    assert.deepEqual(extractSearchRows("{not json"), {
      rows: [],
      conversationRecord: false,
    });
  });

  it("객체가 아닌 JSON은 행이 없다", () => {
    assert.deepEqual(extractSearchRows("[1,2]"), {
      rows: [],
      conversationRecord: false,
    });
    assert.deepEqual(extractSearchRows("null"), {
      rows: [],
      conversationRecord: false,
    });
  });

  it("문자열 content는 conversation 행 하나", () => {
    const r = extractSearchRows(
      line({
        type: "user",
        uuid: UUID,
        timestamp: TS,
        message: { content: "질문" },
      }),
    );
    assert.deepEqual(r, {
      rows: [row("conversation", "질문")],
      conversationRecord: true,
    });
  });

  it("cwd·gitBranch는 perSession meta 행으로 먼저 나온다", () => {
    const r = extractSearchRows(
      line({
        type: "assistant",
        uuid: UUID,
        timestamp: TS,
        cwd: "/w",
        gitBranch: "main",
        message: { content: "답" },
      }),
    );
    assert.deepEqual(r.rows, [
      row("meta", "/w", true),
      row("meta", "main", true),
      row("conversation", "답"),
    ]);
  });

  it("배열 content는 블록 종류별로 등급을 나눈다", () => {
    const r = extractSearchRows(
      line({
        type: "assistant",
        uuid: UUID,
        timestamp: TS,
        message: {
          content: [
            { type: "thinking", thinking: "생각", signature: "SIG" },
            { type: "text", text: "본문" },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Bash",
              input: { command: "ls", description: "목록" },
            },
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: "a.txt" }],
            },
            { type: "mystery", payload: { note: "새 블록" } },
          ],
        },
      }),
    );
    assert.deepEqual(r.rows, [
      row("conversation", "생각"),
      row("conversation", "본문"),
      row("tool", "tool_use\nBash\nls\n목록"),
      row("tool", "tool_result\ntext\na.txt"),
      row("meta", "mystery\n새 블록"),
    ]);
  });

  it("문자열 값 모음은 식별자·시각 키와 base64 객체를 건너뛴다", () => {
    const r = extractSearchRows(
      line({
        type: "user",
        uuid: UUID,
        timestamp: TS,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "AAAA",
                  },
                },
                { type: "text", text: "끝" },
              ],
            },
          ],
        },
      }),
    );
    assert.deepEqual(r.rows, [row("tool", "tool_result\nimage\ntext\n끝")]);
  });

  it("file-history-snapshot·progress는 cwd·gitBranch만 남긴다", () => {
    for (const type of ["file-history-snapshot", "progress"]) {
      const r = extractSearchRows(
        line({
          type,
          uuid: UUID,
          timestamp: TS,
          cwd: "/w",
          data: { body: "소음" },
        }),
      );
      assert.deepEqual(r, {
        rows: [row("meta", "/w", true)],
        conversationRecord: false,
      });
    }
  });

  it("파일 첨부는 건너뛰고, 다른 첨부는 레코드 전체를 meta로", () => {
    const file = extractSearchRows(
      line({
        type: "attachment",
        uuid: UUID,
        timestamp: TS,
        attachment: { type: "file", content: "파일 원문" },
      }),
    );
    assert.deepEqual(file.rows, []);

    const other = extractSearchRows(
      line({
        type: "attachment",
        uuid: UUID,
        timestamp: TS,
        attachment: { type: "hook", content: "훅 출력" },
      }),
    );
    assert.deepEqual(other.rows, [row("meta", "attachment\nhook\n훅 출력")]);
  });

  it("그 밖의 레코드는 toolUseResult를 뺀 문자열 값 모음을 meta로", () => {
    const r = extractSearchRows(
      line({
        type: "system",
        uuid: UUID,
        parentUuid: null,
        sessionId: "s",
        timestamp: TS,
        subtype: "compact_boundary",
        content: "Conversation compacted",
        toolUseResult: { stdout: "중복" },
      }),
    );
    assert.deepEqual(r, {
      rows: [row("meta", "system\ncompact_boundary\nConversation compacted")],
      conversationRecord: false,
    });
  });

  it("content가 문자열도 배열도 아닌 대화 레코드는 레코드 전체를 meta로", () => {
    const r = extractSearchRows(
      line({
        type: "user",
        uuid: UUID,
        timestamp: TS,
        message: { role: "user" },
      }),
    );
    assert.deepEqual(r, {
      rows: [row("meta", "user\nuser")],
      conversationRecord: true,
    });
  });

  it("빈 문자열 행은 만들지 않는다", () => {
    const r = extractSearchRows(
      line({
        type: "assistant",
        uuid: UUID,
        timestamp: TS,
        cwd: "",
        message: {
          content: [
            { type: "text", text: "" },
            { type: "tool_use", id: "toolu_1", input: {} },
          ],
        },
      }),
    );
    assert.deepEqual(r, {
      rows: [row("tool", "tool_use")],
      conversationRecord: true,
    });
  });

  it("uuid·timestamp가 없거나 문자열이 아니면 null", () => {
    const r = extractSearchRows(
      line({ type: "user", timestamp: 1, message: { content: "질문" } }),
    );
    assert.deepEqual(r.rows, [
      {
        tier: "conversation",
        text: "질문",
        uuid: null,
        timestamp: null,
        perSession: false,
      },
    ]);
  });
});
