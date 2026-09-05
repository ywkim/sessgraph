// 이 파일은 JSONL을 파싱하지 않는다. 세그먼트·orphan 판정은 이미 src/core가
// 끝낸 결과(/api/index)를 받아 그리기만 한다 (src/web/CLAUDE.md).
//
// `import type`만 core에서 가져온다 — 런타임에는 완전히 소거되므로 번들러 없이
// 이 파일 그대로 브라우저에 ESM으로 서빙할 수 있으면서도, `IndexResult` 등의
// 필드가 바뀌면 컴파일러가 여기를 잡는다 (ADR-0001 "컴파일러가 모든 사용처를
// 잡아준다"를 웹 경계까지 적용).

import type {
  IndexResult,
  NodeIndex,
  Segment,
  SegmentDetail,
  NodeBody,
  SessionSummary,
} from "../core/types.js";
import { summarizeRaw, formatTime, escapeHtml } from "./format.js";

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

const bodyCache = new Map<string, string>();

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

function idFromHash(): string | null {
  const match = /^#session\/(.+)$/.exec(location.hash);
  return match ? decodeURIComponent(match[1]!) : null;
}

async function routeFromHash(
  sessions: readonly SessionSummary[],
): Promise<void> {
  const id = idFromHash();
  const target = id ? sessions.find((s) => s.id === id) : undefined;
  if (target) {
    await openSession(target, sessions);
  } else {
    renderSessionList(sessions);
  }
}

/** 세션이 둘 이상일 때, 열기 전 목록 화면. 실패한 세션도 숨기지 않고 사유와 함께 보여준다 (ADR-0004). */
function renderSessionList(sessions: readonly SessionSummary[]): void {
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
  container.append(renderVirtualList(sessionId, detail.nodes));
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
function renderVirtualList(
  sessionId: string,
  nodes: readonly NodeIndex[],
): HTMLElement {
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
      const el = renderNode(sessionId, nodes[i]!, i);
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

function renderNode(
  sessionId: string,
  node: NodeIndex,
  position: number,
): HTMLElement {
  const el = document.createElement("div");
  el.className = "node";
  el.style.top = `${position * ROW_HEIGHT}px`;
  el.style.height = `${ROW_HEIGHT}px`;
  el.innerHTML = `
    <div class="node-head">
      <span class="node-type">${escapeHtml(node.subtype ?? node.type)}</span>
      <span class="uuid grow">${escapeHtml(node.uuid)}</span>
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
