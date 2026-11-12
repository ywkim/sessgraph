/**
 * 검색 색인 파일 하나를 다루는 동기 계층. 워커 스레드만 이 모듈을 불러온다 —
 * `node:sqlite`는 `serve` 경로에서만 로드한다 (ADR-0008 "향후 기능이 따를 원칙").
 *
 * docs/spec/20261015-1821-search-index.spec.md "색인 파일"·"동기화"·"질의".
 */
import {
  closeSync,
  chmodSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { NO_FILTERS } from "../../core/search-filters.js";
import { extractSearchRows, type SearchTier } from "../../core/search-text.js";
import type { SearchFilters } from "../../core/types.js";
import { bigramQuery, bigramTokens } from "./bigram.js";

const SCHEMA_VERSION = "2";
const FILE_NAME = "search-v1.sqlite";
const TIERS: readonly SearchTier[] = ["conversation", "tool", "meta"];
const READ_CHUNK = 4 * 1024 * 1024;
const NEWLINE = 0x0a;

/** Spec "순위와 상한". */
export const SESSION_MATCH_LIMIT = 1000;
export const SESSIONS_LIMIT = 50;
export const MATCHES_PER_SESSION = 20;
/** Spec "발췌" — 매치 앞뒤 코드 포인트 수. */
const EXCERPT_RADIUS = 120;

export interface StoredMatch {
  readonly tier: SearchTier;
  readonly timestamp: string | null;
  readonly uuid: string | null;
  readonly excerpt: string;
}

export interface PathHits {
  readonly path: string;
  readonly bestTier: SearchTier;
  readonly latestAt: string | null;
  readonly matchCount: number;
  readonly matches: readonly StoredMatch[];
}

export interface FileState {
  readonly path: string;
  readonly failure: string | null;
  /** 대화 레코드가 있는데 대화 텍스트 행이 하나도 없다 (Spec "불변식") */
  readonly suspect: boolean;
}

interface Hit {
  readonly path: string;
  readonly tier: number;
  readonly ts: string | null;
  readonly rowid: number;
}

export class SearchStore {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /**
   * 색인 파일을 열거나 만든다. 스키마 버전이 다르거나 SQLite가 파일을 읽지
   * 못하면 지우고 새로 만든다 — 색인은 캐시다 (Spec "기동과 첫 생성").
   * 캐시 디렉터리를 만들 수 없으면 throw한다.
   */
  static open(cacheDir: string): SearchStore {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const file = path.join(cacheDir, FILE_NAME);
    try {
      return new SearchStore(openValid(file));
    } catch {
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(file + suffix, { force: true });
      }
      return new SearchStore(openValid(file));
    }
  }

  close(): void {
    this.#db.close();
  }

  /**
   * 파일 하나를 증분 동기화한다. 한 번의 트랜잭션이다 (Spec "동기화").
   * 실패는 throw하지 않고 `files.failure`에 남긴다.
   */
  sync(filePath: string): void {
    let stat;
    try {
      stat = statSync(filePath);
    } catch (err) {
      this.#recordFailure(filePath, (err as Error).message);
      return;
    }
    const db = this.#db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const prev = db
        .prepare(
          "SELECT ino, indexed_offset, conversation_records, conversation_rows FROM files WHERE path = ?",
        )
        .get(filePath) as
        | {
            ino: number;
            indexed_offset: number;
            conversation_records: number;
            conversation_rows: number;
          }
        | undefined;
      let offset = 0;
      let records = 0;
      let convRows = 0;
      if (prev && prev.ino === stat.ino && stat.size >= prev.indexed_offset) {
        offset = prev.indexed_offset;
        records = prev.conversation_records;
        convRows = prev.conversation_rows;
      } else if (prev && prev.indexed_offset > 0) {
        // path는 UNINDEXED라 이 DELETE는 테이블 전체를 훑는다(전체 색인에서 실측 327ms).
        // 행은 indexed_offset 이전 바이트에서만 나오므로(Spec "불변식") 0이면 지울 것이 없다
        const dropBigrams = db.prepare("DELETE FROM bigrams WHERE rowid = ?");
        const stale = db
          .prepare("SELECT rowid FROM rows WHERE path = ?")
          .all(filePath) as { rowid: number }[];
        for (const { rowid } of stale) dropBigrams.run(rowid);
        db.prepare("DELETE FROM rows WHERE path = ?").run(filePath);
        db.prepare("DELETE FROM per_session_seen WHERE path = ?").run(filePath);
      }

      const insertRow = db.prepare(
        "INSERT INTO rows (path, tier, uuid, ts, body) VALUES (?, ?, ?, ?, ?)",
      );
      const insertBigrams = db.prepare(
        "INSERT INTO bigrams (rowid, t) VALUES (?, ?)",
      );
      const markSeen = db.prepare(
        "INSERT OR IGNORE INTO per_session_seen (path, value) VALUES (?, ?)",
      );
      offset = forEachCompleteLine(filePath, offset, stat.size, (line) => {
        const { rows, conversationRecord } = extractSearchRows(line);
        if (conversationRecord) records++;
        for (const row of rows) {
          if (
            row.perSession &&
            markSeen.run(filePath, row.text).changes === 0
          ) {
            continue;
          }
          if (row.tier === "conversation") convRows++;
          const text = storedText(row.text);
          const { lastInsertRowid } = insertRow.run(
            filePath,
            TIERS.indexOf(row.tier),
            row.uuid,
            row.timestamp,
            text,
          );
          const tokens = bigramTokens(text);
          if (tokens !== "") insertBigrams.run(lastInsertRowid, tokens);
        }
      });

      db.prepare(
        `INSERT INTO files (path, ino, indexed_offset, conversation_records, conversation_rows, failure)
         VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT(path) DO UPDATE SET ino = excluded.ino,
           indexed_offset = excluded.indexed_offset,
           conversation_records = excluded.conversation_records,
           conversation_rows = excluded.conversation_rows,
           failure = NULL`,
      ).run(filePath, stat.ino, offset, records, convRows);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      this.#recordFailure(filePath, (err as Error).message);
    }
  }

  /** 등록 경로들의 동기화 상태. 한 번도 동기화하지 않은 경로는 빠진다. */
  states(paths: readonly string[]): FileState[] {
    const get = this.#db.prepare(
      "SELECT failure, conversation_records, conversation_rows FROM files WHERE path = ?",
    );
    const out: FileState[] = [];
    for (const p of paths) {
      const row = get.get(p) as
        | {
            failure: string | null;
            conversation_records: number;
            conversation_rows: number;
          }
        | undefined;
      if (!row) continue;
      out.push({
        path: p,
        failure: row.failure,
        suspect: row.conversation_records > 0 && row.conversation_rows === 0,
      });
    }
    return out;
  }

  /** 전 세션 검색 (Spec "순위와 상한"). `paths` 밖의 행은 보지 않는다. */
  searchAll(
    query: string,
    paths: ReadonlySet<string>,
    filters: SearchFilters = NO_FILTERS,
  ): {
    readonly sessions: PathHits[];
    readonly truncatedSessions: boolean;
    readonly excludedMatchCount: number;
  } {
    const byPath = new Map<string, Hit[]>();
    for (const hit of this.#match(query, null, filters)) {
      if (!paths.has(hit.path)) continue;
      let list = byPath.get(hit.path);
      if (!list) byPath.set(hit.path, (list = []));
      list.push(hit);
    }
    const groups = [...byPath.entries()].map(([p, hits]) => {
      hits.sort(compareHits);
      const best = hits[0]!;
      return { path: p, hits, bestTier: best.tier, latestAt: best.ts };
    });
    groups.sort(
      (a, b) =>
        a.bestTier - b.bestTier || compareTsDesc(a.latestAt, b.latestAt),
    );
    const sessions = groups.slice(0, SESSIONS_LIMIT).map((g) => ({
      path: g.path,
      bestTier: TIERS[g.bestTier]!,
      latestAt: g.latestAt,
      matchCount: g.hits.length,
      matches: this.#materialize(g.hits.slice(0, MATCHES_PER_SESSION), query),
    }));
    return {
      sessions,
      truncatedSessions: groups.length > SESSIONS_LIMIT,
      excludedMatchCount: this.#excludedCount(query, null, filters, paths),
    };
  }

  /** 세션 하나 검색 (Spec "순위와 상한"). */
  searchOne(
    query: string,
    filePath: string,
    filters: SearchFilters = NO_FILTERS,
  ): {
    readonly matchCount: number;
    readonly matches: StoredMatch[];
    readonly excludedMatchCount: number;
  } {
    const hits = this.#match(query, filePath, filters);
    hits.sort(compareHits);
    return {
      matchCount: hits.length,
      excludedMatchCount: this.#excludedCount(query, filePath, filters, null),
      matches: this.#materialize(hits.slice(0, SESSION_MATCH_LIMIT), query),
    };
  }

  /**
   * 종류 조건 때문에 빠진 매치의 수 (Spec "제외된 종류의 건수"). 종류 조건이
   * 없거나 모든 종류를 고른 검색은 0이다. `paths`가 있으면 그 경로의 행만 센다.
   */
  #excludedCount(
    query: string,
    onlyPath: string | null,
    filters: SearchFilters,
    paths: ReadonlySet<string> | null,
  ): number {
    if (filters.tiers === null) return 0;
    const excluded = TIERS.filter((t) => !filters.tiers!.includes(t));
    if (excluded.length === 0) return 0;
    const { fromWhere, params } = this.#fromWhere(query, onlyPath, {
      ...filters,
      tiers: excluded,
    });
    // 행 수십만 건을 옮기지 않도록 경로별 개수만 가져온다
    const rows = this.#db
      .prepare(
        `SELECT rows.path AS path, COUNT(*) AS n FROM ${fromWhere} GROUP BY rows.path`,
      )
      .all(...params) as unknown as { path: string; n: number }[];
    let total = 0;
    for (const row of rows) {
      if (paths === null || paths.has(row.path)) total += row.n;
    }
    return total;
  }

  /** 매치의 위치 정보만 가져온다 — 본문은 반환할 행만 다시 읽는다 (Design "순위"). */
  #match(
    query: string,
    onlyPath: string | null,
    filters: SearchFilters,
  ): Hit[] {
    const { fromWhere, params } = this.#fromWhere(query, onlyPath, filters);
    return this.#db
      .prepare(
        `SELECT rows.path AS path, rows.tier AS tier, rows.ts AS ts, rows.rowid AS rowid FROM ${fromWhere}`,
      )
      .all(...params) as unknown as Hit[];
  }

  /** 세 질의 경로(3글자 이상·2글자·1글자)와 검색 조건을 이은 `FROM … WHERE …` 조각. */
  #fromWhere(
    query: string,
    onlyPath: string | null,
    filters: SearchFilters,
  ): { fromWhere: string; params: (string | number)[] } {
    const params: (string | number)[] = [];
    let from: string;
    if (codePointLength(query) >= 3) {
      from = "rows WHERE rows MATCH ?";
      params.push(`"${query.replaceAll('"', '""')}"`);
    } else {
      const token = codePointLength(query) === 2 ? bigramQuery(query) : null;
      if (token !== null) {
        // 2글자는 보조 색인에서 토큰 하나를 찾고 rowid로 행을 잇는다
        from =
          "bigrams JOIN rows ON rows.rowid = bigrams.rowid WHERE bigrams MATCH ?";
        params.push(token);
      } else {
        from = "rows WHERE body LIKE ? ESCAPE '\\'";
        params.push(`%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      }
    }
    // 세 질의 경로가 같은 조건을 붙인다. ts가 null인 행은 날짜 조건에서 빠진다
    const clauses: string[] = [];
    if (filters.since !== null) {
      clauses.push("rows.ts >= ?");
      params.push(filters.since);
    }
    if (filters.until !== null) {
      clauses.push("rows.ts < ?");
      params.push(filters.until);
    }
    if (filters.tiers !== null) {
      clauses.push(`rows.tier IN (${filters.tiers.map(() => "?").join(", ")})`);
      params.push(...filters.tiers.map((t) => TIERS.indexOf(t)));
    }
    if (onlyPath !== null) {
      clauses.push("rows.path = ?");
      params.push(onlyPath);
    }
    const pathClause = clauses.map((c) => ` AND ${c}`).join("");
    return { fromWhere: `${from}${pathClause}`, params };
  }

  #materialize(hits: readonly Hit[], query: string): StoredMatch[] {
    const get = this.#db.prepare("SELECT uuid, body FROM rows WHERE rowid = ?");
    return hits.map((hit) => {
      const row = get.get(hit.rowid) as { uuid: string | null; body: string };
      return {
        tier: TIERS[hit.tier]!,
        timestamp: hit.ts,
        uuid: row.uuid,
        excerpt: excerptOf(row.body, query),
      };
    });
  }

  #recordFailure(filePath: string, reason: string): void {
    this.#db
      .prepare(
        `INSERT INTO files (path, ino, indexed_offset, conversation_records, conversation_rows, failure)
         VALUES (?, 0, 0, 0, 0, ?)
         ON CONFLICT(path) DO UPDATE SET failure = excluded.failure`,
      )
      .run(filePath, reason);
  }
}

function openValid(file: string): DatabaseSync {
  // SQLite는 -wal·-shm을 본 파일과 같은 권한으로 만든다. 처음부터 소유자 전용으로 만든다
  closeSync(openSync(file, "a", 0o600));
  chmodSync(file, 0o600);
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    const hasMeta = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
      )
      .get();
    if (!hasMeta) {
      db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE files (
          path TEXT PRIMARY KEY,
          ino INTEGER NOT NULL,
          indexed_offset INTEGER NOT NULL,
          conversation_records INTEGER NOT NULL,
          conversation_rows INTEGER NOT NULL,
          failure TEXT
        );
        CREATE TABLE per_session_seen (path TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (path, value));
        CREATE VIRTUAL TABLE rows USING fts5(
          path UNINDEXED, tier UNINDEXED, uuid UNINDEXED, ts UNINDEXED, body,
          tokenize = 'trigram'
        );
        CREATE VIRTUAL TABLE bigrams USING fts5(
          t, content = '', contentless_delete = 1, detail = none,
          tokenize = 'unicode61'
        );
      `);
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?)",
      ).run(SCHEMA_VERSION);
    }
    const version = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    if (version?.value !== SCHEMA_VERSION) {
      throw new Error(
        `색인 스키마 버전이 다릅니다: ${version?.value ?? "없음"}`,
      );
    }
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * `start`부터 `end`까지 개행으로 끝나는 줄만 넘기고, 마지막으로 처리한 개행의
 * 다음 바이트를 돌려준다. 개행 없는 마지막 조각은 다음 동기화로 미룬다.
 */
function forEachCompleteLine(
  filePath: string,
  start: number,
  end: number,
  onLine: (line: string) => void,
): number {
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(READ_CHUNK);
    let pos = start;
    let consumed = start;
    let carry: Buffer[] = [];
    while (pos < end) {
      const n = readSync(fd, buf, 0, Math.min(READ_CHUNK, end - pos), pos);
      if (n === 0) break;
      const chunk = buf.subarray(0, n);
      let from = 0;
      let idx: number;
      while ((idx = chunk.indexOf(NEWLINE, from)) !== -1) {
        const part = chunk.subarray(from, idx);
        const line =
          carry.length === 0
            ? part.toString("utf8")
            : Buffer.concat([...carry, part]).toString("utf8");
        carry = [];
        onLine(line);
        consumed = pos + idx + 1;
        from = idx + 1;
      }
      if (from < n) carry.push(Buffer.from(chunk.subarray(from)));
      pos += n;
    }
    return consumed;
  } finally {
    closeSync(fd);
  }
}

/**
 * `rows.body`가 실제로 저장하는 글자. SQLite는 텍스트를 첫 NUL 앞까지만 저장하고
 * (바이너리 덤프를 찍은 도구 결과), 짝이 없는 서로게이트는 U+FFFD로 바꿔 저장한다.
 * 보조 색인이 저장본과 다른 글자를 보면 두 검색의 답이 갈리므로 저장 전에 맞춘다.
 */
function storedText(text: string): string {
  const nul = text.indexOf("\u0000");
  return (nul === -1 ? text : text.slice(0, nul)).replace(
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
    "\ufffd",
  );
}

/** 정렬 키 `(tier 오름차순, ts 내림차순)`, ts가 null이면 같은 등급의 맨 뒤. */
function compareHits(a: Hit, b: Hit): number {
  return a.tier - b.tier || compareTsDesc(a.ts, b.ts) || b.rowid - a.rowid;
}

function compareTsDesc(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? 1 : -1;
}

function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Spec "발췌" — 매치 앞뒤 120 코드 포인트, 잘린 쪽에 `…`. */
export function excerptOf(body: string, query: string): string {
  const lowered = body.toLowerCase();
  let at = -1;
  if (lowered.length === body.length) at = lowered.indexOf(query.toLowerCase());
  if (at === -1) {
    const end = advance(body, 0, EXCERPT_RADIUS * 2);
    return body.slice(0, end) + (end < body.length ? "…" : "");
  }
  const start = retreat(body, at, EXCERPT_RADIUS);
  const matchEnd = at + query.length;
  const end = advance(body, matchEnd, EXCERPT_RADIUS);
  return (
    (start > 0 ? "…" : "") +
    body.slice(start, end) +
    (end < body.length ? "…" : "")
  );
}

/** `from`에서 코드 포인트 `count`개 뒤의 UTF-16 위치. */
function advance(s: string, from: number, count: number): number {
  let i = from;
  for (let k = 0; k < count && i < s.length; k++) {
    i += isHighSurrogate(s.charCodeAt(i)) && i + 1 < s.length ? 2 : 1;
  }
  return i;
}

/** `from`에서 코드 포인트 `count`개 앞의 UTF-16 위치. */
function retreat(s: string, from: number, count: number): number {
  let i = from;
  for (let k = 0; k < count && i > 0; k++) {
    i -=
      i >= 2 &&
      isLowSurrogate(s.charCodeAt(i - 1)) &&
      isHighSurrogate(s.charCodeAt(i - 2))
        ? 2
        : 1;
  }
  return i;
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}
