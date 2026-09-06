import { closeSync, openSync, readSync, statSync } from "node:fs";

import { tryFindSegmentForUuid } from "./segment.js";
import type {
  IndexResult,
  MatchAttribution,
  NodeIndex,
  RawMatch,
  SearchMatch,
} from "./types.js";

/** Spec "성능 요구사항" — 파일 전체를 문자열로 올리지 않기 위한 청크 크기. */
const CHUNK_SIZE = 1024 * 1024;
/**
 * Spec "귀속" — 실측이 아니라 방어적 상한(확인 안 됨). Design 대안3의
 * 문자열화 비용(약 2.8ms/MB)을 선형 외삽하면 이 크기의 줄 하나만으로도
 * 성능 목표(1초)를 위협한다.
 */
const LINE_CAP = 32 * 1024 * 1024;
/** Spec "발췌" — 매치 지점 앞뒤로 보여줄 바이트 폭. */
const EXCERPT_RADIUS = 128;
const BOUNDARY_STEP = 64 * 1024;
const NEWLINE = 0x0a;

/**
 * 1단계 원시 바이트 스캔 + 2단계 줄 해석. 인덱스를 보지 않는다
 * (docs/spec/20260906-0900-body-search.spec.md "코어 함수").
 *
 * 매치는 겹치지 않는다 — 한 매치를 찾으면 다음 탐색은 그 매치의 끝부터
 * 시작한다. 청크 경계에 걸친 매치를 놓치지 않도록 청크마다
 * `needle.length - 1`바이트를 이어붙여 읽는다.
 */
export function scanFile(
  filePath: string,
  query: string,
  maxMatches: number,
): { readonly matches: readonly RawMatch[]; readonly truncated: boolean } {
  const needle = Buffer.from(query, "utf8");
  if (needle.length === 0) return { matches: [], truncated: false };

  const fd = openSync(filePath, "r");
  try {
    const fileSize = statSync(filePath).size;
    const matches: RawMatch[] = [];
    let truncated = false;

    let filePos = 0;
    let carry = Buffer.alloc(0);
    let carryBase = 0;
    const chunkBuf = Buffer.alloc(CHUNK_SIZE);

    outer: while (filePos < fileSize) {
      const bytesRead = readSync(fd, chunkBuf, 0, CHUNK_SIZE, filePos);
      if (bytesRead === 0) break;
      const window =
        carry.length === 0
          ? chunkBuf.subarray(0, bytesRead)
          : Buffer.concat([carry, chunkBuf.subarray(0, bytesRead)]);
      const windowBase = carryBase;

      let searchFrom = 0;
      let idx: number;
      while ((idx = window.indexOf(needle, searchFrom)) !== -1) {
        const absOffset = windowBase + idx;
        matches.push(buildRawMatch(fd, fileSize, absOffset, needle.length));
        if (matches.length >= maxMatches) {
          truncated = true;
          break outer;
        }
        searchFrom = idx + needle.length;
      }

      filePos += bytesRead;
      const keep = Math.min(needle.length - 1, window.length);
      carry = window.subarray(window.length - keep);
      carryBase = windowBase + window.length - keep;
    }

    return { matches, truncated };
  } finally {
    closeSync(fd);
  }
}

/**
 * 3단계 — 인덱스와 결합. 순수 함수
 * (docs/spec/20260906-0900-body-search.spec.md "코어 함수").
 */
export function attributeMatches(
  index: IndexResult,
  nodes: ReadonlyMap<string, NodeIndex>,
  raw: readonly RawMatch[],
): readonly SearchMatch[] {
  return raw.map((match) => ({
    byteOffset: match.byteOffset,
    excerpt: match.excerpt,
    attribution: attributeOne(index, nodes, match.uuid),
  }));
}

function attributeOne(
  index: IndexResult,
  nodes: ReadonlyMap<string, NodeIndex>,
  uuid: string | null,
): MatchAttribution {
  if (uuid === null) return { kind: "none" };
  const node = nodes.get(uuid);
  if (!node) return { kind: "unindexed", uuid };
  const segment = tryFindSegmentForUuid(index, nodes, uuid);
  if (segment) {
    return {
      kind: "segment",
      uuid,
      segmentRootUuid: segment.rootUuid,
      lineNo: node.lineNo,
    };
  }
  return { kind: "orphan", uuid, lineNo: node.lineNo };
}

function buildRawMatch(
  fd: number,
  fileSize: number,
  byteOffset: number,
  matchLen: number,
): RawMatch {
  const lineStart = lineStartOf(fd, byteOffset, LINE_CAP);
  const lineEnd = lineEndOf(fd, byteOffset + matchLen, fileSize, LINE_CAP);
  const excerpt = buildExcerpt(fd, byteOffset, matchLen, lineStart, lineEnd);
  const uuid = extractUuid(fd, lineStart, lineEnd);
  return { byteOffset, uuid, excerpt };
}

interface Boundary {
  readonly offset: number;
  /** true면 `cap` 안에서 줄 경계(개행)를 찾지 못했다 — 32MB 상한을 넘는 줄. */
  readonly tooFar: boolean;
}

function lineStartOf(fd: number, byteOffset: number, cap: number): Boundary {
  let cursor = byteOffset;
  let scanned = 0;
  while (cursor > 0 && scanned < cap) {
    const len = Math.min(BOUNDARY_STEP, cursor, cap - scanned);
    const start = cursor - len;
    const buf = readAt(fd, start, len);
    const idx = buf.lastIndexOf(NEWLINE);
    if (idx !== -1) return { offset: start + idx + 1, tooFar: false };
    scanned += len;
    cursor = start;
  }
  return { offset: Math.max(0, byteOffset - cap), tooFar: cursor > 0 };
}

function lineEndOf(
  fd: number,
  byteOffset: number,
  fileSize: number,
  cap: number,
): Boundary {
  let cursor = byteOffset;
  let scanned = 0;
  while (cursor < fileSize && scanned < cap) {
    const len = Math.min(BOUNDARY_STEP, fileSize - cursor, cap - scanned);
    const buf = readAt(fd, cursor, len);
    const idx = buf.indexOf(NEWLINE);
    if (idx !== -1) return { offset: cursor + idx, tooFar: false };
    scanned += len;
    cursor += len;
  }
  return {
    offset: Math.min(fileSize, byteOffset + cap),
    tooFar: cursor < fileSize,
  };
}

function extractUuid(
  fd: number,
  lineStart: Boundary,
  lineEnd: Boundary,
): string | null {
  if (lineStart.tooFar || lineEnd.tooFar) return null;
  const length = lineEnd.offset - lineStart.offset;
  if (length <= 0) return null;
  const buf = readAt(fd, lineStart.offset, length);
  try {
    const parsed = JSON.parse(buf.toString("utf8")) as { uuid?: unknown };
    return typeof parsed.uuid === "string" ? parsed.uuid : null;
  } catch {
    return null;
  }
}

/**
 * `[매치시작-128, 매치끝+128]`을 줄 경계로 잘라 만든다. 줄 전체를 문자열로
 * 만들지 않는다 — 줄 하나가 수 MB일 수 있다 (Spec "발췌").
 */
function buildExcerpt(
  fd: number,
  byteOffset: number,
  matchLen: number,
  lineStart: Boundary,
  lineEnd: Boundary,
): string {
  const desiredStart = byteOffset - EXCERPT_RADIUS;
  const desiredEnd = byteOffset + matchLen + EXCERPT_RADIUS;
  const windowStart = Math.max(lineStart.offset, desiredStart);
  const windowEnd = Math.min(lineEnd.offset, desiredEnd);
  const needsLeftEllipsis = windowStart > lineStart.offset;
  const needsRightEllipsis = windowEnd < lineEnd.offset;

  const raw = readAt(fd, windowStart, windowEnd - windowStart);
  const trimmed = trimUtf8Edges(raw);
  const text = trimmed.toString("utf8");
  return `${needsLeftEllipsis ? "…" : ""}${text}${needsRightEllipsis ? "…" : ""}`;
}

function readAt(fd: number, offset: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(length);
  const read = readSync(fd, buf, 0, length, offset);
  return buf.subarray(0, read);
}

/** 양 끝의 불완전한 UTF-8 바이트 시퀀스를 버린다 (Spec "발췌"). */
function trimUtf8Edges(buf: Buffer): Buffer {
  let start = 0;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;

  let end = buf.length;
  let i = end - 1;
  let checked = 0;
  while (i >= start && checked < 4) {
    const byte = buf[i]!;
    if ((byte & 0xc0) !== 0x80) {
      const need = leaderLength(byte);
      const have = end - i;
      if (need !== 0 && have < need) end = i;
      break;
    }
    i--;
    checked++;
  }
  return buf.subarray(start, end);
}

function leaderLength(byte: number): number {
  if ((byte & 0x80) === 0) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 0;
}
