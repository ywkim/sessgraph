import { closeSync, fstatSync, openSync, readSync } from "node:fs";

import type { TitleSource } from "./types.js";

/** 앞·뒤 창 크기. 파일당 최대 2회 읽기, 인덱싱하지 않는다. */
export const META_WINDOW_BYTES = 64 * 1024;

const TITLE_MAX_CHARS = 200;

export interface SessionMeta {
  readonly firstTimestamp: string | null;
  readonly title: string | null;
  readonly titleSource: TitleSource | null;
}

type Rec = {
  type?: unknown;
  timestamp?: unknown;
  snapshot?: { timestamp?: unknown } | null;
  customTitle?: unknown;
  aiTitle?: unknown;
  isMeta?: unknown;
  message?: { content?: unknown } | null;
};

function readWindow(fd: number, position: number, length: number): string {
  const buf = Buffer.alloc(length);
  const read = readSync(fd, buf, 0, length, position);
  return buf.subarray(0, read).toString("utf8");
}

function parseLines(lines: string[]): Rec[] {
  const out: Rec[] = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Rec | null;
      if (parsed && typeof parsed === "object") out.push(parsed);
    } catch {
      // 깨진 줄은 건너뛴다 — 목록 메타이며 구조 판정에 쓰지 않는다
    }
  }
  return out;
}

function normalize(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const chars = Array.from(text);
  return chars.length > TITLE_MAX_CHARS
    ? chars.slice(0, TITLE_MAX_CHARS).join("") + "…"
    : text;
}

function userText(rec: Rec): string | null {
  const content = rec.message?.content;
  if (typeof content === "string") return normalize(content);
  if (Array.isArray(content)) {
    for (const part of content as { type?: unknown; text?: unknown }[]) {
      if (part?.type === "text") return normalize(part.text);
    }
  }
  return null;
}

function firstTimestampOf(recs: Rec[]): string | null {
  for (const rec of recs) {
    const ts = rec.timestamp ?? rec.snapshot?.timestamp;
    if (typeof ts === "string") return ts;
  }
  return null;
}

function lastTitle(recs: Rec[], type: string, field: keyof Rec): string | null {
  for (let i = recs.length - 1; i >= 0; i--) {
    const rec = recs[i]!;
    if (rec.type !== type) continue;
    const title = normalize(rec[field]);
    if (title) return title;
  }
  return null;
}

function firstUserMessage(recs: Rec[]): string | null {
  for (const rec of recs) {
    if (rec.type !== "user" || rec.isMeta === true) continue;
    const text = userText(rec);
    // `<`로 시작하면 명령 envelope·시스템 주입이다
    if (text && !text.startsWith("<")) return text;
  }
  return null;
}

/**
 * 파일 앞·뒤 창에서 목록용 메타를 읽는다.
 * 읽기 오류는 throw한다 — null로 삼키지 않는다.
 * 깨진 JSON 줄은 건너뛴다.
 */
export function readSessionMeta(filePath: string): SessionMeta {
  const fd = openSync(filePath, "r");
  try {
    const size = fstatSync(fd).size;
    const headLines = readWindow(fd, 0, META_WINDOW_BYTES).split("\n");
    // 파일이 창보다 길면 마지막 조각은 잘렸을 수 있다
    if (size > META_WINDOW_BYTES) headLines.pop();
    const headRecs = parseLines(headLines);

    let tailRecs = headRecs;
    if (size > META_WINDOW_BYTES) {
      // 창 시작 직전 1바이트까지 읽어 시작이 줄 경계인지 판단한다
      const start = size - META_WINDOW_BYTES;
      const tailLines = readWindow(fd, start - 1, META_WINDOW_BYTES + 1).split(
        "\n",
      );
      tailLines.shift(); // 직전 바이트가 개행이면 빈 조각, 아니면 잘린 줄
      tailRecs = parseLines(tailLines);
    }

    const firstTimestamp = firstTimestampOf(headRecs);
    const custom =
      lastTitle(tailRecs, "custom-title", "customTitle") ??
      lastTitle(headRecs, "custom-title", "customTitle");
    if (custom) {
      return { firstTimestamp, title: custom, titleSource: "custom-title" };
    }
    const ai = lastTitle(tailRecs, "ai-title", "aiTitle");
    if (ai) return { firstTimestamp, title: ai, titleSource: "ai-title" };
    const first = firstUserMessage(headRecs);
    return {
      firstTimestamp,
      title: first,
      titleSource: first ? "first-user-message" : null,
    };
  } finally {
    closeSync(fd);
  }
}
