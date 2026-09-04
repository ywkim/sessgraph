import test from "node:test";
import assert from "node:assert/strict";

import { summarizeRaw, formatTime, escapeHtml } from "./format.js";

test("summarizeRaw: message.content가 문자열이면 그대로 반환한다", () => {
  const raw = JSON.stringify({ message: { content: "hello" } });
  assert.equal(summarizeRaw(raw), "hello");
});

test("summarizeRaw: text 파트는 텍스트를 이어붙인다", () => {
  const raw = JSON.stringify({
    message: {
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    },
  });
  assert.equal(summarizeRaw(raw), "a b");
});

test("summarizeRaw: tool_use는 도구 이름을 보여준다", () => {
  const raw = JSON.stringify({
    message: { content: [{ type: "tool_use", name: "Bash" }] },
  });
  assert.equal(summarizeRaw(raw), "[도구 Bash]");
});

test("summarizeRaw: tool_result는 고정 문구로 표시한다", () => {
  const raw = JSON.stringify({
    message: { content: [{ type: "tool_result" }] },
  });
  assert.equal(summarizeRaw(raw), "[도구 결과]");
});

test("summarizeRaw: 모르는 파트 타입은 대괄호로 감싼다", () => {
  const raw = JSON.stringify({
    message: { content: [{ type: "unknown_thing" }] },
  });
  assert.equal(summarizeRaw(raw), "[unknown_thing]");
});

test("summarizeRaw: content가 문자열이면 300자를 넘어도 자르지 않는다", () => {
  const raw = JSON.stringify({ message: { content: "x".repeat(400) } });
  assert.equal(summarizeRaw(raw).length, 400);
});

test("summarizeRaw: text 파트를 이어붙인 결과는 300자로 자른다", () => {
  const raw = JSON.stringify({
    message: { content: [{ type: "text", text: "x".repeat(400) }] },
  });
  assert.equal(summarizeRaw(raw).length, 300);
});

test("summarizeRaw: JSON이 아니면 원문을 300자까지 잘라 반환한다", () => {
  assert.equal(summarizeRaw("not json"), "not json");
});

test("summarizeRaw: message.content가 없으면 원문을 300자까지 잘라 반환한다", () => {
  const raw = JSON.stringify({ type: "system" });
  assert.equal(summarizeRaw(raw), raw);
});

test("formatTime: null이면 빈 문자열", () => {
  assert.equal(formatTime(null), "");
});

test("formatTime: ISO 타임스탬프를 로컬 시간대로 변환해 YYYY-MM-DD HH:MM:SS 포맷으로 표시한다", () => {
  const result = formatTime("2026-09-03T12:34:56.789Z");
  // 포맷이 맞는지 확인 (값은 시간대에 따라 다르므로 regex로만 검증)
  assert.match(result, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  // 같은 입력에 대해 일관된 결과인지 확인
  assert.equal(formatTime("2026-09-03T12:34:56.789Z"), result);
});

test("escapeHtml: HTML 특수문자를 이스케이프한다", () => {
  assert.equal(
    escapeHtml(`<script>alert("x'&y")</script>`),
    "&lt;script&gt;alert(&quot;x&#39;&amp;y&quot;)&lt;/script&gt;",
  );
});

test("escapeHtml: 문자열이 아닌 값도 String()으로 변환한다", () => {
  assert.equal(escapeHtml(42), "42");
});
