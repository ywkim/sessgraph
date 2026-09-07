// 이 파일은 JSONL을 파싱하지 않는다. 세그먼트·orphan 판정은 이미 src/core가
// 끝낸 결과(/api/index)를 받아 그리기만 한다 (src/web/CLAUDE.md).
//
// `import type`만 core에서 가져온다 — 런타임에는 완전히 소거되므로 번들러 없이
// 이 파일 그대로 브라우저에 ESM으로 서빙할 수 있으면서도, `IndexResult` 등의
// 필드가 바뀌면 컴파일러가 여기를 잡는다 (ADR-0001 "컴파일러가 모든 사용처를
// 잡아준다"를 웹 경계까지 적용).

import type {
  BranchLane,
  BranchPoint,
  IndexResult,
  NodeIndex,
  Segment,
  SegmentDetail,
  NodeBody,
  SearchMatch,
  SearchResult,
  SessionSearchResult,
  SessionSummary,
} from "../core/types.js";
import { computeBranchLanes } from "../core/segment-branch.js";
import { summarizeRaw, formatTime, escapeHtml } from "./format.js";

// 레인 렌더링 폭 상한 — 실측(scripts/measure-branch-structure.mjs)에서
// laneDepth<=4가 세션의 68%를 덮는다. 그 이상(p90=10, max=41)은 컬럼을
// 이 값에 눌러 담아 폭 폭발을 막는다(넘치는 레인은 색이 겹치지만, 배지 텍스트
// "곁가지 N개"가 정확한 개수는 계속 알려준다).
const LANE_CAP = 5;
const LANE_WIDTH = 10;

// .node 한 줄의 고정 높이 (가상 스크롤 계산 기준). app.css의 --row-height와
// 값이 같아야 한다 — 행 높이를 콘텐츠·폭과 무관한 상수로 고정하는 것이
// docs/design/20260904-1130-responsive-layout.tdd.md의 핵심 결정이라,
// 재계산이 필요 없어 여기서는 리터럴로 둔다.
const ROW_HEIGHT = 52;
const OVERSCAN = 5;

const summaryEl = document.getElementById("summary")!;
const bannerEl = document.getElementById("banner")!;
const warningsEl = document.getElementById("warnings")!;
const timelineEl = document.getElementById("timeline")!;
const searchFormEl = document.getElementById("search-form") as HTMLFormElement;
const searchInputEl = document.getElementById(
  "search-input",
) as HTMLInputElement;
const searchResultsEl = document.getElementById("search-results")!;

const bodyCache = new Map<string, string>();

/** 화면에 세션 목록이 떠 있으면 null — 그때 검색은 /api/search로 전 세션을 훑는다. */
let currentSessionId: string | null = null;
let knownSessions: readonly SessionSummary[] = [];

/** 검색어에 큰따옴표·역슬래시·개행이 있으면 저장 형태가 달라 0건이 나올 수 있다 (Spec "화면"). */
const UNESCAPABLE_CHARS = /["\\\n]/;

searchFormEl.addEventListener("submit", (e) => {
  e.preventDefault();
  void runSearch(searchInputEl.value.trim());
});

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

void main();

async function main(): Promise<void> {
  let sessions: SessionSummary[];
  try {
    sessions = await getJson<SessionSummary[]>("/api/sessions");
  } catch (err) {
    showBanner(`세션 목록을 읽지 못했습니다: ${(err as Error).message}`);
    return;
  }

  if (sessions.length === 0) {
    timelineEl.innerHTML = `<p class="muted">표시할 세션이 없습니다</p>`;
    return;
  }

  // 세션이 하나뿐이면 목록 없이 바로 그 타임라인으로 진입한다 — 기존
  // 단일 파일 호출의 동작을 그대로 둔다
  // (docs/design/20260905-0641-multi-session-serve.tdd.md).
  if (sessions.length === 1) {
    await openSession(sessions[0]!, sessions);
    return;
  }

  window.addEventListener("hashchange", () => void routeFromHash(sessions));
  void routeFromHash(sessions);
}

interface HashRoute {
  readonly sessionId: string;
  readonly segmentRootUuid: string | null;
}

function parseHash(): HashRoute | null {
  const match = /^#session\/([^/]+)(?:\/segment\/([^/]+))?$/.exec(
    location.hash,
  );
  if (!match) return null;
  return {
    sessionId: decodeURIComponent(match[1]!),
    segmentRootUuid: match[2] ? decodeURIComponent(match[2]) : null,
  };
}

async function routeFromHash(
  sessions: readonly SessionSummary[],
): Promise<void> {
  const route = parseHash();
  const target = route
    ? sessions.find((s) => s.id === route.sessionId)
    : undefined;
  if (target && route) {
    await openSession(target, sessions);
    if (route.segmentRootUuid) expandSegment(route.segmentRootUuid);
  } else {
    renderSessionList(sessions);
  }
}

/** 세션이 둘 이상일 때, 열기 전 목록 화면. 실패한 세션도 숨기지 않고 사유와 함께 보여준다 (ADR-0004). */
function renderSessionList(sessions: readonly SessionSummary[]): void {
  currentSessionId = null;
  knownSessions = sessions;
  searchResultsEl.innerHTML = "";
  summaryEl.textContent = `세션 ${sessions.length}개`;
  bannerEl.hidden = true;
  warningsEl.innerHTML = "";
  timelineEl.innerHTML = "";

  const list = document.createElement("div");
  list.className = "session-list";
  for (const session of sessions) {
    if (session.status === "failed") {
      const item = document.createElement("div");
      item.className = "session-item failed";
      item.innerHTML = `
        <span class="session-label">${escapeHtml(session.label)}</span>
        <span class="warning">${escapeHtml(session.failure ?? "읽지 못했습니다")}</span>`;
      list.append(item);
      continue;
    }
    const item = document.createElement("button");
    item.type = "button";
    item.className = "session-item";
    item.innerHTML = `<span class="session-label">${escapeHtml(session.label)}</span>`;
    item.addEventListener("click", () => {
      location.hash = `#session/${encodeURIComponent(session.id)}`;
    });
    list.append(item);
  }
  timelineEl.append(list);
}

async function openSession(
  session: SessionSummary,
  sessions: readonly SessionSummary[],
): Promise<void> {
  currentSessionId = session.id;
  knownSessions = sessions;
  searchResultsEl.innerHTML = "";
  bannerEl.hidden = true;
  warningsEl.innerHTML = "";
  timelineEl.innerHTML = `<p class="muted">읽는 중…</p>`;

  let index: IndexResult;
  try {
    index = await getJson<IndexResult>(
      `/api/session/${encodeURIComponent(session.id)}/index`,
    );
  } catch (err) {
    timelineEl.innerHTML = "";
    showBanner(`인덱스를 읽지 못했습니다: ${(err as Error).message}`);
    return;
  }

  summaryEl.textContent =
    `조각 ${index.segments.length}개 · 노드 ${index.nodeCount}개 · ` +
    `줄 ${index.totalLines}개 (인덱싱 ${Math.round(index.durationMs)}ms)`;

  renderWarnings(index);
  timelineEl.innerHTML = "";

  if (sessions.length > 1) {
    const back = document.createElement("button");
    back.type = "button";
    back.className = "back-to-sessions";
    back.textContent = `← 세션 목록 (${escapeHtml(session.label)})`;
    back.addEventListener("click", () => {
      location.hash = "";
    });
    timelineEl.append(back);
  }

  if (index.segments.length === 0) {
    timelineEl.append(
      Object.assign(document.createElement("p"), {
        className: "muted",
        textContent: "표시할 기록이 없습니다",
      }),
    );
    return;
  }

  for (const segment of index.segments) {
    timelineEl.append(renderSegment(session.id, segment));
  }
}

/** 도구가 판단하지 못한 케이스를 숨기지 않는다 (ADR-0004). */
function renderWarnings(index: IndexResult): void {
  const items: string[] = [];
  if (index.unresolvedDuplicates.length > 0) {
    items.push(
      `해소되지 않은 중복 uuid ${index.unresolvedDuplicates.length}건 — ` +
        `정책으로 어느 쪽을 채택할지 정하지 못해 인덱스에서 제외했습니다: ` +
        index.unresolvedDuplicates.map((d) => d.uuid).join(", "),
    );
  }
  if (index.orphans.length > 0) {
    items.push(
      `부모가 파일에 없는 노드 ${index.orphans.length}건 — 어떤 조각에도 속하지 않습니다`,
    );
  }
  if (index.malformedLines.length > 0) {
    items.push(`${index.malformedLines.length}개 줄을 읽지 못함`);
  }
  for (const text of items) {
    const div = document.createElement("div");
    div.className = "warning";
    div.textContent = text;
    warningsEl.append(div);
  }
}

function renderSegment(sessionId: string, segment: Segment): HTMLElement {
  // 끊김을 구분해 보이되 오류로 단정하지 않는다 — 컴팩트 경계는 정상
  // 동작의 결과다 (src/web/CLAUDE.md "표시 규칙").
  const isCut = segment.rootSubtype === "compact_boundary";

  const wrap = document.createElement("section");
  wrap.className = isCut ? "segment cut" : "segment";

  const head = document.createElement("button");
  head.className = "segment-head";
  head.type = "button";
  head.dataset.rootUuid = segment.rootUuid;
  head.setAttribute("aria-expanded", "false");
  head.innerHTML = `
    <span class="badge ${isCut ? "cut" : ""}">${isCut ? "컴팩트 경계" : "세션 시작점"}</span>
    <span class="grow uuid">${escapeHtml(segment.rootUuid)}</span>
    <span class="muted">${segment.nodeCount}개 노드</span>
    <span class="muted">${formatTime(segment.startTimestamp)}</span>`;
  wrap.append(head);

  const body = document.createElement("div");
  body.className = "segment-body";
  body.hidden = true;
  wrap.append(body);

  let loaded = false;
  head.addEventListener("click", () => {
    body.hidden = !body.hidden;
    head.setAttribute("aria-expanded", String(!body.hidden));
    if (!body.hidden && !loaded) {
      loaded = true;
      void loadDetail(sessionId, segment.rootUuid, body);
    }
  });

  return wrap;
}

async function loadDetail(
  sessionId: string,
  rootUuid: string,
  container: HTMLElement,
): Promise<void> {
  container.innerHTML = `<p class="muted">불러오는 중…</p>`;
  let detail: SegmentDetail;
  try {
    detail = await getJson<SegmentDetail>(
      `/api/session/${encodeURIComponent(sessionId)}/segment/${encodeURIComponent(rootUuid)}`,
    );
  } catch (err) {
    container.innerHTML = "";
    container.append(
      errorLine(`조각을 불러오지 못했습니다: ${(err as Error).message}`),
    );
    return;
  }

  container.innerHTML = "";
  if (detail.suggestedReattachCommand) {
    container.append(renderReattach(detail));
  }
  container.append(
    renderVirtualList(sessionId, detail.nodes, detail.branches),
  );
}

function renderReattach(
  detail: SegmentDetail & { suggestedReattachCommand: string },
): HTMLElement {
  const box = document.createElement("div");
  box.className = "reattach";

  const label = document.createElement("div");
  label.className = "muted";
  // 기록된 부모와 추정값을 구분해 표시한다 — "직전 leaf" 단독 가정은
  // 실측에서 44%, 9.5% 틀렸다 (ADR-0005).
  if (detail.suggestedParentSource === "recorded") {
    label.textContent = "기록된 부모";
  } else {
    label.className = "inferred";
    label.textContent = "추정값(직전 조각의 마지막 노드) — 확인 후 사용";
  }
  box.append(label);

  const command = detail.suggestedReattachCommand;
  const code = document.createElement("code");
  code.textContent = command;
  box.append(code);

  // 웹 → CLI 핸드오프는 클립보드가 전부다. 중간 파일 포맷을 두지 않는다
  // (ADR-0003).
  const copy = document.createElement("button");
  copy.className = "copy";
  copy.type = "button";
  copy.textContent = "명령어 복사";
  copy.addEventListener("click", () => {
    void navigator.clipboard
      .writeText(command)
      .then(() => {
        copy.textContent = "복사됨 — --reason을 채워서 실행하세요";
      })
      .catch(() => {
        copy.textContent = "복사 실패 — 직접 선택해 복사하세요";
      });
  });
  box.append(copy);

  return box;
}

/**
 * 노드 수가 수천 개여도 화면에 보이는 것만 DOM에 올린다. 본문은 그 행이
 * 실제로 보일 때 `/api/body`로 한 줄씩 가져온다.
 */
/** computeBranchLanes가 필요로 하는 부모→자식 맵을 세그먼트 노드만으로 다시 만든다. */
function buildChildrenByParent(
  nodes: readonly NodeIndex[],
): Map<string, NodeIndex[]> {
  const map = new Map<string, NodeIndex[]>();
  for (const node of nodes) {
    if (node.parentUuid === null) continue;
    const siblings = map.get(node.parentUuid);
    if (siblings) siblings.push(node);
    else map.set(node.parentUuid, [node]);
  }
  return map;
}

/**
 * 각 행에서 "지금 열려 있는" 레인 목록을 구한다 — 자기 갈래뿐 아니라 같은
 * 시간대에 겹치는 다른 갈래도 배경 세로선으로 계속 그려야 git 그래프처럼
 * 끊기지 않는다.
 */
function computeActiveLanes(
  nodes: readonly NodeIndex[],
  laneByUuid: ReadonlyMap<string, BranchLane>,
): ReadonlyMap<string, readonly number[]> {
  const rangeBySubtree = new Map<
    string,
    { lane: number; start: number; end: number }
  >();
  for (const node of nodes) {
    const l = laneByUuid.get(node.uuid);
    if (!l) continue;
    const r = rangeBySubtree.get(l.subtreeId);
    if (!r) {
      rangeBySubtree.set(l.subtreeId, {
        lane: l.lane,
        start: node.lineNo,
        end: node.lineNo,
      });
    } else {
      if (node.lineNo < r.start) r.start = node.lineNo;
      if (node.lineNo > r.end) r.end = node.lineNo;
    }
  }
  // trunk(lane 0)은 항상 존재해 모든 행에 걸쳐 있으므로 선으로 그리지 않는다 —
  // 곁가지가 하나도 없는 절대다수 세션(실측 71.6%)에서 거터가 안 나타나야
  // 지금까지의 화면과 다를 게 없다.
  const ranges = [...rangeBySubtree.values()].filter((r) => r.lane > 0);
  const result = new Map<string, readonly number[]>();
  for (const node of nodes) {
    const active = new Set<number>();
    for (const r of ranges) {
      if (r.start <= node.lineNo && node.lineNo <= r.end) {
        active.add(Math.min(r.lane, LANE_CAP));
      }
    }
    result.set(node.uuid, [...active].sort((a, b) => a - b));
  }
  return result;
}

function renderVirtualList(
  sessionId: string,
  nodes: readonly NodeIndex[],
  branches: readonly BranchPoint[],
): HTMLElement {
  const branchByParent = new Map<string, BranchPoint>();
  for (const b of branches) branchByParent.set(b.parentUuid, b);

  const laneByUuid = computeBranchLanes(
    nodes,
    buildChildrenByParent(nodes),
    branches,
  );
  const activeLanesByUuid = computeActiveLanes(nodes, laneByUuid);

  const viewport = document.createElement("div");
  viewport.className = "viewport";
  const spacer = document.createElement("div");
  spacer.className = "spacer";
  spacer.style.height = `${nodes.length * ROW_HEIGHT}px`;
  viewport.append(spacer);

  const mounted = new Map<number, HTMLElement>();

  function paint(): void {
    const first = Math.max(
      0,
      Math.floor(viewport.scrollTop / ROW_HEIGHT) - OVERSCAN,
    );
    const last = Math.min(
      nodes.length - 1,
      Math.ceil((viewport.scrollTop + viewport.clientHeight) / ROW_HEIGHT) +
        OVERSCAN,
    );

    for (const [i, el] of mounted) {
      if (i < first || i > last) {
        el.remove();
        mounted.delete(i);
      }
    }
    for (let i = first; i <= last; i++) {
      if (mounted.has(i)) continue;
      const node = nodes[i]!;
      const el = renderNode(
        sessionId,
        node,
        i,
        branchByParent.get(node.uuid),
        laneByUuid.get(node.uuid),
        activeLanesByUuid.get(node.uuid) ?? [],
      );
      mounted.set(i, el);
      spacer.append(el);
    }
  }

  viewport.addEventListener("scroll", paint, { passive: true });
  // 뷰포트가 레이아웃된 뒤 첫 페인트를 한다 (clientHeight가 0이면 아무것도
  // 안 그려진다).
  requestAnimationFrame(paint);
  return viewport;
}

/**
 * 레인 거터 HTML을 만든다 — git log --graph 컬럼처럼, 이 행에서 열려 있는
 * 모든 레인을 세로선으로 그리고, 이 노드 자신의 갈래가 여기서 시작/끝나면
 * 그 레인만 반쪽 선(위/아래)으로 끊어 범위를 드러낸다
 * (docs/prd/20260906-1400-segment-branch-view.prd.md "레인 기반 표시").
 */
function renderLaneGutter(
  ownLane: BranchLane | undefined,
  activeLanes: readonly number[],
): string {
  if (activeLanes.length === 0) return "";
  const clampedOwn = ownLane ? Math.min(ownLane.lane, LANE_CAP) : -1;
  const bars = activeLanes
    .map((lane) => {
      const colorClass = `lane-c${lane % 6}`;
      const isOwn = lane === clampedOwn;
      const edgeClass = isOwn
        ? ownLane!.isSubtreeStart
          ? " lane-start"
          : ownLane!.isSubtreeEnd
            ? " lane-end"
            : ""
        : "";
      return `<span class="lane-line ${colorClass}${edgeClass}" style="left:${lane * LANE_WIDTH}px"></span>`;
    })
    .join("");
  const width = (LANE_CAP + 1) * LANE_WIDTH;
  return `<div class="lane-gutter" style="width:${width}px">${bars}</div>`;
}

function renderNode(
  sessionId: string,
  node: NodeIndex,
  position: number,
  branch: BranchPoint | undefined,
  ownLane: BranchLane | undefined,
  activeLanes: readonly number[],
): HTMLElement {
  const el = document.createElement("div");
  el.className = "node";
  el.style.top = `${position * ROW_HEIGHT}px`;
  el.style.height = `${ROW_HEIGHT}px`;
  if (activeLanes.length > 0) {
    el.style.setProperty(
      "--lane-gutter-width",
      `${(LANE_CAP + 1) * LANE_WIDTH}px`,
    );
  }
  // 곁가지 표시는 존재와 개수만 알린다 — 클릭 동작 없음(Spec "화면"). 행의
  // 고정 높이를 지키기 위해 새 줄이 아니라 head 안에 배지로 얹는다.
  const branchBadge = branch
    ? `<span class="branch muted">곁가지 ${branch.discardedUuids.length}개(재실행/수정)</span>`
    : "";
  el.innerHTML = `
    ${renderLaneGutter(ownLane, activeLanes)}
    <div class="node-head">
      <span class="node-type">${escapeHtml(node.subtype ?? node.type)}</span>
      <span class="uuid grow">${escapeHtml(node.uuid)}</span>
      ${branchBadge}
      <span class="muted">${formatTime(node.timestamp)}</span>
    </div>
    <div class="node-body">불러오는 중…</div>`;
  const bodyEl = el.querySelector<HTMLElement>(".node-body")!;

  // uuid는 한 세션 안에서만 유일하므로 캐시 키도 세션으로 구분한다 —
  // 서로 다른 세션의 같은 uuid가 조용히 섞이는 것을 막는다
  // (docs/design/20260905-0641-multi-session-serve.tdd.md).
  const cacheKey = `${sessionId}:${node.uuid}`;
  const cached = bodyCache.get(cacheKey);
  if (cached !== undefined) {
    bodyEl.textContent = cached;
    return el;
  }

  getJson<NodeBody>(
    `/api/session/${encodeURIComponent(sessionId)}/body?uuid=${encodeURIComponent(node.uuid)}`,
  )
    .then((body) => {
      const text = summarizeRaw(body.raw);
      bodyCache.set(cacheKey, text);
      bodyEl.textContent = text;
    })
    .catch((err: unknown) => {
      const error = err as HttpError;
      bodyEl.textContent = `본문을 읽지 못했습니다: ${error.message}`;
      if (error.status === 409) showBanner(error.message);
    });

  return el;
}

/** 세션이 열려 있으면 그 안에서만, 목록 화면이면 전 세션에서 찾는다. */
async function runSearch(query: string): Promise<void> {
  if (!query) {
    searchResultsEl.innerHTML = "";
    return;
  }
  searchResultsEl.innerHTML = `<p class="muted">찾는 중…</p>`;
  try {
    if (currentSessionId) {
      const result = await getJson<SearchResult>(
        `/api/session/${encodeURIComponent(currentSessionId)}/search?q=${encodeURIComponent(query)}`,
      );
      searchResultsEl.innerHTML = "";
      searchResultsEl.append(
        renderSearchResult(currentSessionId, result, query, null),
      );
    } else {
      const results = await getJson<SessionSearchResult[]>(
        `/api/search?q=${encodeURIComponent(query)}`,
      );
      renderMultiSessionResults(results, query);
    }
  } catch (err) {
    searchResultsEl.innerHTML = "";
    searchResultsEl.append(
      errorLine(`검색하지 못했습니다: ${(err as Error).message}`),
    );
  }
}

function renderMultiSessionResults(
  results: readonly SessionSearchResult[],
  query: string,
): void {
  searchResultsEl.innerHTML = "";
  let any = false;
  for (const entry of results) {
    if (entry.failure !== null) {
      searchResultsEl.append(errorLine(`세션 검색 실패: ${entry.failure}`));
      continue;
    }
    if (entry.result.matches.length === 0) continue;
    any = true;
    const session = knownSessions.find((s) => s.id === entry.sessionId);
    searchResultsEl.append(
      renderSearchResult(
        entry.sessionId,
        entry.result,
        query,
        session?.label ?? entry.sessionId,
      ),
    );
  }
  if (!any) searchResultsEl.append(noMatchesNote(query));
}

/** 결과는 세그먼트별로 묶어 보여준다 (Spec "화면"). */
function renderSearchResult(
  sessionId: string,
  result: SearchResult,
  query: string,
  label: string | null,
): HTMLElement {
  const box = document.createElement("div");
  box.className = "search-result";

  if (label !== null) {
    const heading = document.createElement("div");
    heading.className = "muted";
    heading.textContent = label;
    box.append(heading);
  }

  if (result.matches.length === 0) {
    box.append(noMatchesNote(query));
    return box;
  }

  if (result.truncated) {
    box.append(
      Object.assign(document.createElement("div"), {
        className: "warning",
        textContent: "매치가 너무 많아 앞의 1,000건만 표시합니다",
      }),
    );
  }

  const clickable = result.matches.filter(
    (m) => m.attribution.kind === "segment",
  );
  const rest = result.matches.filter((m) => m.attribution.kind !== "segment");

  for (const match of clickable)
    box.append(renderMatchLine(sessionId, match, true));

  if (rest.length > 0) {
    const restBox = document.createElement("div");
    restBox.className = "search-unattributed";
    restBox.append(
      Object.assign(document.createElement("div"), {
        className: "muted",
        // "이 매치를 버리는 것이 이 설계가 막으려는 실패다" (Spec "귀속") —
        // 조용히 빼지 않고 별도 묶음으로 보여준다.
        textContent: `조각으로 이동할 수 없는 매치 ${rest.length}건 — 인덱스가 배제했거나 구조를 판단하지 못한 레코드입니다`,
      }),
    );
    for (const match of rest)
      restBox.append(renderMatchLine(sessionId, match, false));
    box.append(restBox);
  }

  return box;
}

function noMatchesNote(query: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "muted";
  p.textContent = "찾지 못했습니다";
  // 확신에 찬 0건이 가장 위험한 답이다 (ADR-0004, Spec "화면").
  if (UNESCAPABLE_CHARS.test(query)) {
    p.textContent +=
      " — 검색어에 큰따옴표·역슬래시·개행이 있으면 저장 형태가 달라 찾지 못할 수 있습니다";
  }
  return p;
}

function renderMatchLine(
  sessionId: string,
  match: SearchMatch,
  clickable: boolean,
): HTMLElement {
  const el = document.createElement(clickable ? "button" : "div");
  el.className = clickable ? "search-match" : "search-match unindexed";
  if (el instanceof HTMLButtonElement) el.type = "button";
  el.innerHTML = `<span class="search-excerpt">${escapeHtml(match.excerpt)}</span>`;

  if (clickable && match.attribution.kind === "segment") {
    const rootUuid = match.attribution.segmentRootUuid;
    el.addEventListener("click", () => {
      if (currentSessionId === sessionId) {
        expandSegment(rootUuid);
        return;
      }
      location.hash = `#session/${encodeURIComponent(sessionId)}/segment/${encodeURIComponent(rootUuid)}`;
    });
  }

  return el;
}

function expandSegment(rootUuid: string): void {
  const head = timelineEl.querySelector<HTMLButtonElement>(
    `[data-root-uuid="${CSS.escape(rootUuid)}"]`,
  );
  if (!head) return;
  if (head.getAttribute("aria-expanded") !== "true") head.click();
  head.scrollIntoView({ block: "center" });
}

function showBanner(message: string): void {
  bannerEl.textContent = message;
  bannerEl.hidden = false;
}

function errorLine(message: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "warning";
  p.textContent = message;
  return p;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const payload: unknown = await res.json().catch(() => ({}));
    const message = (payload as { error?: unknown })?.error;
    throw new HttpError(
      typeof message === "string" ? message : `HTTP ${res.status}`,
      res.status,
    );
  }
  return (await res.json()) as T;
}
