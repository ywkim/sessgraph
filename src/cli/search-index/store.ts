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

import { extractSearchRows, type SearchTier } from "../../core/search-text.js";

const SCHEMA_VERSION = "1";
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
        db.prepare("DELETE FROM rows WHERE path = ?").run(filePath);
        db.prepare("DELETE FROM per_session_seen WHERE path = ?").run(filePath);
      }

      const insertRow = db.prepare(
        "INSERT INTO rows (path, tier, uuid, ts, body) VALUES (?, ?, ?, ?, ?)",
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
          insertRow.run(
            filePath,
            TIERS.indexOf(row.tier),
            row.uuid,
            row.timestamp,
            row.text,
          );
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
  ): { readonly sessions: PathHits[]; readonly truncatedSessions: boolean } {
    const byPath = new Map<string, Hit[]>();
    for (const hit of this.#match(query, null)) {
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
    return { sessions, truncatedSessions: groups.length > SESSIONS_LIMIT };
  }

  /** 세션 하나 검색 (Spec "순위와 상한"). */
  searchOne(
    query: string,
    filePath: string,
  ): { readonly matchCount: number; readonly matches: StoredMatch[] } {
    const hits = this.#match(query, filePath);
    hits.sort(compareHits);
    return {
      matchCount: hits.length,
      matches: this.#materialize(hits.slice(0, SESSION_MATCH_LIMIT), query),
    };
  }

  /** 매치의 위치 정보만 가져온다 — 본문은 반환할 행만 다시 읽는다 (Design "순위"). */
  #match(query: string, onlyPath: string | null): Hit[] {
    const pathClause = onlyPath === null ? "" : " AND path = ?";
    const params: string[] = [];
    let where: string;
    if (codePointLength(query) >= 3) {
      where = "rows MATCH ?";
      params.push(`"${query.replaceAll('"', '""')}"`);
    } else {
      where = "body LIKE ? ESCAPE '\\'";
      params.push(`%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    if (onlyPath !== null) params.push(onlyPath);
    return this.#db
      .prepare(
        `SELECT path, tier, ts, rowid FROM rows WHERE ${where}${pathClause}`,
      )
      .all(...params) as unknown as Hit[];
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
