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
  message?: { content?: unknown } | null;
};

function readWindow(
  fd: number,
  position: number,
  length: number,
): { text: string; truncatedTail: boolean } {
  const buf = Buffer.alloc(length);
  const read = readSync(fd, buf, 0, length, position);
  return {
    text: buf.subarray(0, read).toString("utf8"),
    truncatedTail: read === length,
  };
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
    if (rec.type !== "user") continue;
    const text = userText(rec);
    if (text) return text;
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
    const head = readWindow(fd, 0, META_WINDOW_BYTES);
    const headLines = head.text.split("\n");
    // 창이 가득 찼으면 마지막 조각은 잘렸을 수 있다
    if (head.truncatedTail) headLines.pop();
    const headRecs = parseLines(headLines);

    let tailRecs = headRecs;
    if (size > META_WINDOW_BYTES) {
      const tail = readWindow(fd, size - META_WINDOW_BYTES, META_WINDOW_BYTES);
      const tailLines = tail.text.split("\n");
      tailLines.shift(); // 창 시작이 줄 중간일 수 있다
      tailRecs = parseLines(tailLines);
    }

    const custom = lastTitle(tailRecs, "custom-title", "customTitle");
    if (custom) {
      return {
        firstTimestamp: firstTimestampOf(headRecs),
        title: custom,
        titleSource: "custom-title",
      };
    }
    const ai = lastTitle(tailRecs, "ai-title", "aiTitle");
    if (ai) {
      return {
        firstTimestamp: firstTimestampOf(headRecs),
        title: ai,
        titleSource: "ai-title",
      };
    }
    const first = firstUserMessage(headRecs);
    return {
      firstTimestamp: firstTimestampOf(headRecs),
      title: first,
      titleSource: first ? "first-user-message" : null,
    };
  } finally {
    closeSync(fd);
  }
}
