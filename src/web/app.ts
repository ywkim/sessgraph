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
  IndexStatus,
  MatchAttribution,
  SearchHit,
  SearchMatch,
  SearchResponse,
  SessionSearchResponse,
  SessionSummary,
} from "../core/types.js";
import { computeBranchLanes } from "../core/segment-branch.js";
import { isCollapsedByDefault } from "../core/serve.js";
import {
  summarizeRaw,
  formatTime,
  escapeHtml,
  sortByRecency,
  sessionSubline,
  matchesQuery,
} from "./format.js";
import { renderFormatted } from "./formatted-text.js";
import {
  describeExcluded,
  describeFilters,
  excludedTiers,
  filterQuery,
  PERIODS,
  type FilterInput,
  type Period,
  type Tier,
} from "./search-filters.js";

// 레인 렌더링 개수 상한 — 실측(scripts/measure-branch-structure.mjs)에서
// laneDepth<=4가 세션의 68%를 덮는다. 그 이상(p90=10, max=41)은 컬럼을
// 이 값에 눌러 담아 폭 폭발을 막는다(넘치는 레인은 색이 겹치지만, 배지 텍스트
// "곁가지 N개"가 정확한 개수는 계속 알려준다). 레인 하나의 실제 px 폭은
// app.css의 --lane-width가 갖고 있다 — 좁은 화면에서 컨테이너 쿼리가 그
// 값만 줄이면 되게 하려고 JS는 개수만 다룬다(2026-09-07).
const LANE_CAP = 5;

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
const searchFiltersEl = document.getElementById("search-filters")!;
const searchPeriodEl = document.getElementById(
  "search-period",
) as HTMLSelectElement;
for (const period of PERIODS) {
  searchPeriodEl.append(new Option(period.label, period.value));
}

const bodyCache = new Map<string, string>();

// 노드마다 만들지 않고 페이지에 하나만 두고 재사용한다 — 가상 스크롤이 뷰포트
// 밖 행을 DOM에서 지우는 것처럼, dialog도 노드마다 만들면 스크롤이 지나간
// 뒤에도 계속 쌓인다 (docs/design/20260907-1500-node-body-full-text.tdd.md).
const bodyDialogEl = document.createElement("dialog");
bodyDialogEl.className = "body-dialog";
const bodyDialogTextEl = document.createElement("pre");
bodyDialogTextEl.className = "body-dialog-text";
const bodyDialogCloseEl = document.createElement("button");
bodyDialogCloseEl.className = "body-dialog-close";
bodyDialogCloseEl.type = "button";
bodyDialogCloseEl.autofocus = true;
bodyDialogCloseEl.textContent = "닫기";
bodyDialogCloseEl.addEventListener("click", () => bodyDialogEl.close());
const bodyDialogNoticeEl = document.createElement("p");
bodyDialogNoticeEl.className = "body-dialog-notice warning";
bodyDialogNoticeEl.hidden = true;
const bodyDialogFormattedEl = document.createElement("div");
bodyDialogFormattedEl.className = "body-dialog-formatted";
bodyDialogFormattedEl.hidden = true;
const bodyDialogModeEl = document.createElement("button");
bodyDialogModeEl.className = "body-dialog-mode";
bodyDialogModeEl.type = "button";
bodyDialogModeEl.hidden = true;
bodyDialogEl.append(
  bodyDialogNoticeEl,
  bodyDialogTextEl,
  bodyDialogFormattedEl,
  bodyDialogModeEl,
  bodyDialogCloseEl,
);
document.body.append(bodyDialogEl);

/** 서식 보기가 이 길이(글자 수)를 넘는 글은 원문만 보인다. 상한은 실측으로 정했다 (Spec "엣지 케이스"). */
const FORMAT_MAX_CHARS = 300_000;

/** 서식 보기의 DOM과 안내를 비운다. */
function clearFormatted(): void {
  bodyDialogFormattedEl.replaceChildren();
  bodyDialogFormattedEl.hidden = true;
  bodyDialogNoticeEl.hidden = true;
  bodyDialogModeEl.hidden = true;
}

function showFormatted(formatted: boolean): void {
  bodyDialogFormattedEl.hidden = !formatted;
  bodyDialogTextEl.hidden = formatted;
  bodyDialogModeEl.textContent = formatted ? "원문 보기" : "서식 보기";
}

bodyDialogModeEl.addEventListener("click", () =>
  showFormatted(bodyDialogFormattedEl.hidden),
);
// 닫을 때 서식 보기의 DOM도 비운다. 곧바로 다시 열린 경우(close 이벤트는 비동기)는 건드리지 않는다
bodyDialogEl.addEventListener("close", () => {
  if (!bodyDialogEl.open) clearFormatted();
});

/** 대화 글이면 서식 보기 대상이다. 도구 입출력 모양은 원문만 보인다 (Spec "서식 보기"). */
function isFormattable(node: NodeIndex): boolean {
  return (
    (node.type === "user" || node.type === "assistant") &&
    !node.isToolResultShape
  );
}

/**
 * 잘린 본문 미리보기의 전체 텍스트를 공용 dialog에 채우고 연다. formattable이면
 * 서식 보기로 열고 원문 보기와 오가는 버튼을 보인다.
 */
function openBodyDialog(fullText: string, formattable: boolean): void {
  if (bodyDialogEl.open) bodyDialogEl.close();
  clearFormatted();
  bodyDialogTextEl.textContent = fullText;
  showFormatted(false);
  if (formattable) {
    if (fullText.length > FORMAT_MAX_CHARS) {
      showNotice("본문이 길어 원문으로 보여줍니다");
    } else {
      try {
        bodyDialogFormattedEl.replaceChildren(renderFormatted(fullText));
        bodyDialogModeEl.hidden = false;
        showFormatted(true);
      } catch {
        bodyDialogFormattedEl.replaceChildren();
        showNotice("서식을 해석하지 못해 원문으로 보여줍니다");
      }
    }
  }
  bodyDialogEl.showModal();
}

function showNotice(message: string): void {
  bodyDialogNoticeEl.textContent = message;
  bodyDialogNoticeEl.hidden = false;
}

/** 화면에 세션 목록이 떠 있으면 null — 그때 검색은 /api/search로 전 세션을 훑는다. */
let currentSessionId: string | null = null;
let knownSessions: readonly SessionSummary[] = [];

/**
 * 검색 요청 순번. 마지막 요청이 아닌 응답은 버린다. 세션을 열거나 목록으로
 * 돌아가면 올려서 진행 중인 응답도 버린다 (Spec "화면").
 */
let searchSeq = 0;
/** 전 세션 결과에서 막 누른 레코드. 그 이동의 귀속 요청에만 검색어·순위를 실어 기록한다 (Spec "검색 기록"). */
let pendingOpen: {
  sessionId: string;
  uuid: string;
  query: string;
  rank: number;
  filterQuery: string;
} | null = null;

/**
 * 검색 결과에서 이동해 온 레코드. 가상 스크롤이 행을 다시 만들어도 강조가
 * 유지되도록 uuid를 모듈 상태로 두고 행을 만들 때 대조한다 (Spec "조각 안 위치").
 */
let revealedUuid: string | null = null;

/** 조각 상세 불러오기. 펼침이 시작한 불러오기가 끝나길 기다려 위치로 이동하는 데 쓴다. */
interface LoadedSegment {
  readonly nodes: readonly NodeIndex[];
  readonly viewport: HTMLElement;
}
const segmentLoads = new WeakMap<HTMLElement, Promise<LoadedSegment | null>>();

searchFormEl.addEventListener("submit", (e) => {
  e.preventDefault();
  void runSearch(searchInputEl.value.trim());
});

/** 조건을 바꾸면 검색어가 있을 때 다시 찾는다 (Spec "검색 조건 입력"). */
searchFiltersEl.addEventListener("change", () => {
  const query = searchInputEl.value.trim();
  if (query) void runSearch(query);
});

function readFilterInput(): FilterInput {
  const tiers = new Set<Tier>();
  for (const box of Array.from(
    searchFiltersEl.querySelectorAll<HTMLInputElement>('input[name="tier"]'),
  )) {
    if (box.checked) tiers.add(box.value as Tier);
  }
  return { tiers, period: searchPeriodEl.value as Period };
}

/** 화면에 떠 있는 결과를 만든 검색의 조건. 결과를 눌렀을 때 귀속 요청에 싣는다. */
let shownFilterQuery = "";

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
  /** 전 세션 검색 결과에서 누른 레코드. 세션을 연 뒤 조각을 찾는다 (Spec "귀속") */
  readonly recordUuid: string | null;
}

function parseHash(): HashRoute | null {
  const match = /^#session\/([^/]+)(?:\/(segment|uuid)\/([^/]+))?$/.exec(
    location.hash,
  );
  if (!match) return null;
  const target = match[3] ? decodeURIComponent(match[3]) : null;
  return {
    sessionId: decodeURIComponent(match[1]!),
    segmentRootUuid: match[2] === "segment" ? target : null,
    recordUuid: match[2] === "uuid" ? target : null,
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
    if (route.segmentRootUuid)
      await revealInSegment(route.segmentRootUuid, null);
    if (route.recordUuid) await revealRecord(target.id, route.recordUuid);
  } else {
    renderSessionList(sessions);
  }
}

/** 세션이 둘 이상일 때, 열기 전 목록 화면. 실패한 세션도 숨기지 않고 사유와 함께 보여준다 (ADR-0004). */
function renderSessionList(sessions: readonly SessionSummary[]): void {
  currentSessionId = null;
  knownSessions = sessions;
  revealedUuid = null;
  discardPendingSearch();
  searchResultsEl.innerHTML = "";
  summaryEl.textContent = `세션 ${sessions.length}개`;
  bannerEl.hidden = true;
  warningsEl.innerHTML = "";
  timelineEl.innerHTML = "";

  const list = document.createElement("div");
  list.className = "session-list";

  const filter = document.createElement("input");
  filter.type = "search";
  filter.className = "session-filter";
  filter.placeholder = "세션 필터 (제목, 파일명 또는 경로)";
  filter.setAttribute("aria-label", "세션 필터");
  filter.addEventListener("input", () => {
    for (const item of Array.from(
      list.querySelectorAll<HTMLElement>(".session-item"),
    )) {
      item.hidden = !matchesQuery(item.dataset.filterText ?? "", filter.value);
    }
  });
  timelineEl.append(filter);

  // 실패한 세션도 목록에 남긴다 (ADR-0004). 좁은 화면 처리는 CSS가 맡는다 —
  // 렌더 시점에 폭을 재지 않으므로 리사이즈에도 안전하다.
  for (const session of sortByRecency(sessions)) {
    const failed = session.status === "failed";
    const item = document.createElement(failed ? "div" : "button");
    item.className = failed ? "session-item failed" : "session-item";
    item.dataset.filterText = `${session.label}\n${session.title ?? ""}`;
    if (item instanceof HTMLButtonElement) item.type = "button";

    const heading = document.createElement("span");
    heading.className =
      session.title !== null ? "session-title" : "session-label";
    heading.textContent = session.title ?? session.label;
    heading.title = session.title ?? session.label;
    item.append(heading);

    const subline = sessionSubline(session);
    if (subline) {
      const sub = document.createElement("span");
      sub.className = "session-meta muted";
      sub.textContent = subline;
      sub.title = session.label;
      item.append(sub);
    }

    if (failed) {
      const reason = document.createElement("span");
      reason.className = "warning";
      reason.textContent = session.failure ?? "읽지 못했습니다";
      item.append(reason);
    } else {
      item.addEventListener("click", () => {
        location.hash = `#session/${encodeURIComponent(session.id)}`;
      });
    }
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
  revealedUuid = null;
  discardPendingSearch();
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
    // 세그먼트가 접히면 그 안의 .node-body가 화면에서 사라지므로, 열려
    // 있던 dialog가 있다면 원본을 잃은 채 떠 있지 않게 닫는다
    // (docs/design/20260907-1500-node-body-full-text.tdd.md).
    if (body.hidden && bodyDialogEl.open) bodyDialogEl.close();
    if (!body.hidden && !loaded) {
      loaded = true;
      segmentLoads.set(body, loadDetail(sessionId, segment.rootUuid, body));
    }
  });

  return wrap;
}

async function loadDetail(
  sessionId: string,
  rootUuid: string,
  container: HTMLElement,
): Promise<LoadedSegment | null> {
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
    return null;
  }

  container.innerHTML = "";
  if (detail.suggestedReattachCommand) {
    container.append(renderReattach(detail));
  }
  const viewport = renderVirtualList(sessionId, detail.nodes, detail.branches);
  container.append(viewport);
  return { nodes: detail.nodes, viewport };
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
    result.set(
      node.uuid,
      [...active].sort((a, b) => a - b),
    );
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
      // 리프 노드(한 줄짜리 곁가지)는 start와 end가 같은 행 — 두 클래스를
      // 함께 붙여 위/아래 반쪽을 모두 비우고 시작점 동그라미만 남긴다
      // (2026-09-07 PR #53 리뷰에서 lane-start만 적용되던 문제 확인).
      const edgeClass = isOwn
        ? (ownLane!.isSubtreeStart ? " lane-start" : "") +
          (ownLane!.isSubtreeEnd ? " lane-end" : "")
        : "";
      // 폭 자체가 아니라 "몇 번째 레인인지"만 넘긴다 — 실제 px 계산은
      // CSS의 --lane-width로 미룬다(narrow 컨테이너 쿼리가 그 값을 줄일
      // 수 있어야 하기 때문. 아래 renderNode의 --lane-count 주석 참고).
      return `<span class="lane-line ${colorClass}${edgeClass}" style="left:calc(var(--lane-width) * ${lane})"></span>`;
    })
    .join("");
  return `<div class="lane-gutter">${bars}</div>`;
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
  el.className = node.uuid === revealedUuid ? "node revealed" : "node";
  el.style.top = `${position * ROW_HEIGHT}px`;
  el.style.height = `${ROW_HEIGHT}px`;
  // 폭(px)이 아니라 레인 "개수"만 넘긴다 — 실제 폭은 CSS의
  // calc(--lane-count * --lane-width)가 계산한다. 폭 자체를 인라인으로
  // 넣으면 좁은 컨테이너 쿼리의 --lane-width 축소를 인라인 스타일이 항상
  // 이겨버려 모바일에서 .node-head가 감기는 사고가 난다(2026-09-07).
  if (activeLanes.length > 0) {
    el.style.setProperty("--lane-count", String(LANE_CAP + 1));
  }
  // 곁가지 표시는 존재와 개수만 알린다 — 클릭 동작 없음(Spec "화면"). 행의
  // 고정 높이를 지키기 위해 새 줄이 아니라 head 안에 배지로 얹는다.
  const branchBadge = branch
    ? `<span class="branch muted">곁가지 ${branch.discardedUuids.length}개(재실행/수정)</span>`
    : "";
  // 접힘은 .node-body만 가린다 — 행 높이는 그대로다(ROW_HEIGHT 불변).
  // 토글은 가상 스크롤이 행을 다시 만들면 초기 상태로 돌아간다.
  const collapsible = isCollapsedByDefault(node);
  if (collapsible) el.classList.add("collapsed");
  const bodyId = `node-body-${sessionId}-${node.uuid}`;
  const toggle = collapsible
    ? `<button type="button" class="node-toggle" aria-expanded="false" aria-controls="${escapeHtml(bodyId)}">펼치기</button>`
    : "";
  el.innerHTML = `
    ${renderLaneGutter(ownLane, activeLanes)}
    <div class="node-head">
      ${toggle}
      <span class="node-type">${escapeHtml(node.subtype ?? node.type)}</span>
      <span class="uuid grow">${escapeHtml(node.uuid)}</span>
      ${branchBadge}
      <span class="muted">${formatTime(node.timestamp)}</span>
    </div>
    <div class="node-body" id="${escapeHtml(bodyId)}"${collapsible ? " hidden" : ""}>불러오는 중…</div>`;
  const bodyEl = el.querySelector<HTMLElement>(".node-body")!;
  const toggleEl = el.querySelector<HTMLButtonElement>(".node-toggle");
  toggleEl?.addEventListener("click", () => {
    const collapsed = el.classList.toggle("collapsed");
    bodyEl.hidden = collapsed;
    toggleEl.setAttribute("aria-expanded", String(!collapsed));
    toggleEl.textContent = collapsed ? "펼치기" : "접기";
    if (!collapsed) markIfTruncated(bodyEl);
  });

  // uuid는 한 세션 안에서만 유일하므로 캐시 키도 세션으로 구분한다 —
  // 서로 다른 세션의 같은 uuid가 조용히 섞이는 것을 막는다
  // (docs/design/20260905-0641-multi-session-serve.tdd.md).
  const cacheKey = `${sessionId}:${node.uuid}`;

  bodyEl.addEventListener("click", () => {
    if (bodyEl.classList.contains("truncated")) {
      openBodyDialog(bodyCache.get(cacheKey) || "", isFormattable(node));
    }
  });
  bodyEl.addEventListener("keydown", (e) => {
    if (
      bodyEl.classList.contains("truncated") &&
      (e.key === "Enter" || e.key === " ")
    ) {
      e.preventDefault();
      openBodyDialog(bodyCache.get(cacheKey) || "", isFormattable(node));
    }
  });
  const cached = bodyCache.get(cacheKey);
  if (cached !== undefined) {
    bodyEl.textContent = cached;
    markIfTruncated(bodyEl);
    return el;
  }

  getJson<NodeBody>(
    `/api/session/${encodeURIComponent(sessionId)}/body?uuid=${encodeURIComponent(node.uuid)}`,
  )
    .then((body) => {
      const text = summarizeRaw(body.raw);
      bodyCache.set(cacheKey, text);
      bodyEl.textContent = text;
      markIfTruncated(bodyEl);
    })
    .catch((err: unknown) => {
      const error = err as HttpError;
      bodyEl.textContent = `본문을 읽지 못했습니다: ${error.message}`;
      if (error.status === 409) showBanner(error.message);
    });

  return el;
}

/** scrollHeight/clientHeight는 레이아웃이 끝난 뒤에만 정확하므로 다음
 * 프레임에서 판정한다 (docs/design/20260907-1500-node-body-full-text.tdd.md). */
function markIfTruncated(bodyEl: HTMLElement): void {
  requestAnimationFrame(() => {
    const hidden = bodyEl.closest(".node.collapsed") !== null;
    if (!hidden && bodyEl.scrollHeight > bodyEl.clientHeight) {
      bodyEl.classList.add("truncated");
      bodyEl.setAttribute("role", "button");
      bodyEl.setAttribute("tabindex", "0");
      bodyEl.setAttribute("aria-label", "본문 전체 보기");
    } else {
      bodyEl.classList.remove("truncated");
      bodyEl.removeAttribute("role");
      bodyEl.removeAttribute("tabindex");
      bodyEl.removeAttribute("aria-label");
    }
  });
}

function discardPendingSearch(): void {
  searchSeq++;
}

/** 세션이 열려 있으면 그 안에서만, 목록 화면이면 전 세션에서 찾는다. */
async function runSearch(query: string): Promise<void> {
  const seq = ++searchSeq;
  if (!query) {
    searchResultsEl.innerHTML = "";
    return;
  }
  const input = readFilterInput();
  if (input.tiers.size === 0) {
    searchResultsEl.innerHTML = "";
    searchResultsEl.append(errorLine("종류를 하나 이상 고르세요"));
    return;
  }
  const conditions = filterQuery(input);
  searchResultsEl.innerHTML = `<p class="muted">찾는 중…</p>`;
  let excludedMatchCount = 0;
  try {
    if (currentSessionId) {
      const sessionId = currentSessionId;
      const result = await getJson<SessionSearchResponse>(
        `/api/session/${encodeURIComponent(sessionId)}/search?q=${encodeURIComponent(query)}${conditions}`,
      );
      if (seq !== searchSeq) return;
      excludedMatchCount = result.excludedMatchCount;
      searchResultsEl.innerHTML = "";
      searchResultsEl.append(...indexNotes(result.index));
      const box = renderMatches(result.matches);
      if (result.matchCount > result.matches.length) {
        box.prepend(countNote(result.matchCount, result.matches.length));
      }
      searchResultsEl.append(
        result.matchCount === 0 ? noMatchesNote(result.index) : box,
      );
    } else {
      const result = await getJson<SearchResponse>(
        `/api/search?q=${encodeURIComponent(query)}${conditions}`,
      );
      if (seq !== searchSeq) return;
      excludedMatchCount = result.excludedMatchCount;
      renderMultiSessionResults(result);
    }
    shownFilterQuery = conditions;
    const excludedText = describeExcluded(input, excludedMatchCount);
    if (excludedText) {
      searchResultsEl.prepend(excludedNote(excludedText, input));
    }
    const line = describeFilters(input);
    if (line) {
      searchResultsEl.prepend(
        Object.assign(document.createElement("p"), {
          className: "muted search-conditions",
          textContent: line,
        }),
      );
    }
  } catch (err) {
    if (seq !== searchSeq) return;
    searchResultsEl.innerHTML = "";
    searchResultsEl.append(
      errorLine(`검색하지 못했습니다: ${(err as Error).message}`),
    );
  }
}

/** 종류 조건 때문에 빠진 매치가 있다는 안내와, 그 종류를 켜서 다시 찾는 버튼. */
function excludedNote(text: string, input: FilterInput): HTMLElement {
  const note = Object.assign(document.createElement("p"), {
    className: "muted search-excluded",
  });
  note.append(`${text} `);
  const button = Object.assign(document.createElement("button"), {
    type: "button",
    textContent: "함께 보기",
  });
  button.addEventListener("click", () => {
    for (const tier of excludedTiers(input)) {
      const box = searchFiltersEl.querySelector<HTMLInputElement>(
        `input[name="tier"][value="${tier}"]`,
      );
      if (box) box.checked = true;
    }
    searchFiltersEl.dispatchEvent(new Event("change"));
  });
  note.append(button);
  return note;
}

function sessionName(sessionId: string): string {
  const session = knownSessions.find((s) => s.id === sessionId);
  return session?.title ?? session?.label ?? sessionId;
}

/** 색인 진행 상태와 실패 세션. 결과가 일부일 수 있음을 결과 위에 알린다 (Spec "기동과 첫 생성"). */
function indexNotes(index: IndexStatus): HTMLElement[] {
  const notes: HTMLElement[] = [];
  if (!index.ready) {
    notes.push(
      Object.assign(document.createElement("div"), {
        className: "warning",
        textContent: `색인 중 (${index.indexedSessions}/${index.totalSessions} 세션) — 결과가 일부일 수 있습니다`,
      }),
    );
  }
  for (const failure of index.failed) {
    notes.push(
      errorLine(
        `색인하지 못한 세션: ${sessionName(failure.sessionId)} — ${failure.reason}`,
      ),
    );
  }
  return notes;
}

function renderMultiSessionResults(result: SearchResponse): void {
  searchResultsEl.innerHTML = "";
  searchResultsEl.append(...indexNotes(result.index));
  if (result.sessions.length === 0) {
    searchResultsEl.append(noMatchesNote(result.index));
    return;
  }
  if (result.truncatedSessions) {
    searchResultsEl.append(
      Object.assign(document.createElement("div"), {
        className: "warning",
        textContent: "매치가 있는 세션이 많아 상위 50개만 표시합니다",
      }),
    );
  }
  for (const [i, hits] of result.sessions.entries()) {
    const rank = i + 1;
    const box = document.createElement("div");
    box.className = "search-result";
    const heading = Object.assign(document.createElement("div"), {
      className: "search-heading",
      textContent: sessionName(hits.sessionId),
    });
    if (hits.matchCount > hits.matches.length) {
      heading.append(countNote(hits.matchCount, hits.matches.length));
    }
    box.append(heading);
    // 귀속은 누를 때 한다 — uuid가 있으면 누를 수 있다 (Spec "귀속")
    for (const hit of hits.matches) {
      const uuid = hit.uuid;
      const el = renderMatchLine(hit, uuid !== null);
      if (uuid !== null) {
        el.addEventListener("click", () => {
          pendingOpen = {
            sessionId: hits.sessionId,
            uuid,
            query: result.query,
            rank,
            filterQuery: shownFilterQuery,
          };
          const hash = `#session/${encodeURIComponent(hits.sessionId)}/uuid/${encodeURIComponent(uuid)}`;
          // 주소가 그대로면 hashchange가 오지 않으므로 이동을 직접 다시 실행한다
          if (location.hash === hash && currentSessionId === hits.sessionId) {
            void revealRecord(hits.sessionId, uuid);
          } else {
            location.hash = hash;
          }
        });
      }
      box.append(el);
    }
    searchResultsEl.append(box);
  }
}

/** 전 세션 결과에서 누른 레코드의 조각을 찾아 펼친다. 조각에 속하지 않으면 알린다. */
async function revealRecord(sessionId: string, uuid: string): Promise<void> {
  const open = pendingOpen;
  pendingOpen = null;
  let from = "";
  if (open && open.sessionId === sessionId && open.uuid === uuid) {
    from = `&q=${encodeURIComponent(open.query)}&rank=${open.rank}${open.filterQuery}`;
  }
  try {
    const attribution = await getJson<MatchAttribution>(
      `/api/session/${encodeURIComponent(sessionId)}/attribution?uuid=${encodeURIComponent(uuid)}${from}`,
    );
    if (currentSessionId !== sessionId) return;
    if (attribution.kind === "segment") {
      await revealInSegment(attribution.segmentRootUuid, uuid);
    } else {
      showBanner(`이 레코드는 조각에 속하지 않습니다 (${uuid})`);
    }
  } catch (err) {
    showBanner(`조각을 찾지 못했습니다: ${(err as Error).message}`);
  }
}

function countNote(total: number, shown: number): HTMLElement {
  return Object.assign(document.createElement("span"), {
    className: "muted search-count",
    textContent: ` ${total.toLocaleString()}건 중 ${shown.toLocaleString()}건`,
  });
}
/**
 * 세션 하나 결과. 조각으로 이동할 수 있는 매치와 없는 매치를 나눠 보여준다
 * (Spec "화면"). 이 세션은 이미 열려 있으므로 누르면 그 자리에서 펼친다.
 */
function renderMatches(matches: readonly SearchMatch[]): HTMLElement {
  const box = document.createElement("div");
  box.className = "search-result";

  const clickable = matches.filter((m) => m.attribution.kind === "segment");
  const rest = matches.filter((m) => m.attribution.kind !== "segment");

  for (const match of clickable) {
    const el = renderMatchLine(match, true);
    if (match.attribution.kind === "segment") {
      const rootUuid = match.attribution.segmentRootUuid;
      const uuid = match.attribution.uuid;
      el.addEventListener("click", () => void revealInSegment(rootUuid, uuid));
    }
    box.append(el);
  }

  if (rest.length > 0) {
    const restBox = document.createElement("div");
    restBox.className = "search-unattributed";
    restBox.append(
      Object.assign(document.createElement("div"), {
        className: "muted",
        textContent: `조각으로 이동할 수 없는 매치 ${rest.length}건 — 인덱스가 배제했거나 구조를 판단하지 못한 레코드입니다`,
      }),
    );
    for (const match of rest) restBox.append(renderMatchLine(match, false));
    box.append(restBox);
  }

  return box;
}

/** 확신에 찬 0건이 가장 위험한 답이다 (ADR-0004) — 색인 중이거나 실패 세션이 있으면 덧붙인다. */
function noMatchesNote(index: IndexStatus): HTMLElement {
  const p = document.createElement("p");
  p.className = "muted";
  p.textContent = "찾지 못했습니다";
  if (!index.ready) p.textContent += " — 아직 색인 중이라 결과가 일부입니다";
  if (index.failed.length > 0) {
    p.textContent += ` — 색인하지 못한 세션 ${index.failed.length}개는 찾지 않았습니다`;
  }
  return p;
}

const TIER_LABEL: Record<SearchMatch["tier"], string> = {
  conversation: "대화",
  tool: "도구",
  meta: "기타",
};

/** 매치 한 줄. 누를 때의 동작은 호출하는 쪽이 붙인다. */
function renderMatchLine(hit: SearchHit, clickable: boolean): HTMLElement {
  const el = document.createElement(clickable ? "button" : "div");
  el.className = clickable ? "search-match" : "search-match unindexed";
  if (el instanceof HTMLButtonElement) el.type = "button";
  el.innerHTML = `<span class="search-tier tier-${escapeHtml(hit.tier)}">${TIER_LABEL[hit.tier]}</span> <span class="search-excerpt">${escapeHtml(hit.excerpt)}</span>`;
  return el;
}

/**
 * 조각을 펼치고(이미 펼쳐져 있으면 그대로 둔다) 그 안의 레코드가 영역 가운데에
 * 오게 스크롤해 강조한다. uuid가 null이면 조각 머리까지만 간다
 * (Spec "조각 안 위치").
 */
async function revealInSegment(
  rootUuid: string,
  uuid: string | null,
): Promise<void> {
  const sessionId = currentSessionId;
  const head = timelineEl.querySelector<HTMLButtonElement>(
    `[data-root-uuid="${CSS.escape(rootUuid)}"]`,
  );
  if (!head) {
    showBanner(`조각을 찾지 못했습니다 (${rootUuid})`);
    return;
  }
  if (head.getAttribute("aria-expanded") !== "true") head.click();
  const body = head.nextElementSibling as HTMLElement;
  revealedUuid = uuid;
  if (uuid === null) {
    head.scrollIntoView({ block: "center" });
    return;
  }
  const loaded = await segmentLoads.get(body);
  // 기다리는 사이 세션이 바뀌었거나 다른 매치로 이동했으면 그만둔다
  if (currentSessionId !== sessionId || revealedUuid !== uuid) return;
  // 불러오기가 실패했으면 그 오류 표시가 남아 있다
  if (!loaded) return;
  const index = loaded.nodes.findIndex((n) => n.uuid === uuid);
  if (index < 0) {
    revealedUuid = null;
    showBanner(`조각 안에서 레코드를 찾지 못했습니다 (${uuid})`);
    return;
  }
  const { viewport } = loaded;
  viewport.scrollTop = Math.max(
    0,
    index * ROW_HEIGHT - viewport.clientHeight / 2,
  );
  // scroll 이벤트는 비동기라 강조가 첫 페인트에 반영되도록 직접 그리게 한다
  viewport.dispatchEvent(new Event("scroll"));
  applyRevealed();
  viewport.scrollIntoView({ block: "center" });
}

/** 이미 그려진 행의 강조를 `revealedUuid`에 맞춘다. 새로 그려지는 행은 renderNode가 맞춘다. */
function applyRevealed(): void {
  const rows = Array.from(timelineEl.querySelectorAll<HTMLElement>(".node"));
  for (const el of rows) {
    const uuid = el.querySelector(".node-head .uuid")?.textContent;
    el.classList.toggle("revealed", uuid === revealedUuid);
  }
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
