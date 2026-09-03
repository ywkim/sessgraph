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
} from "../core/types.js";

const ROW_HEIGHT = 52; // .node 한 줄의 고정 높이 (가상 스크롤 계산 기준)
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
  let index: IndexResult;
  try {
    index = await getJson<IndexResult>("/api/index");
  } catch (err) {
    showBanner(`인덱스를 읽지 못했습니다: ${(err as Error).message}`);
    return;
  }

  summaryEl.textContent =
    `조각 ${index.segments.length}개 · 노드 ${index.nodeCount}개 · ` +
    `줄 ${index.totalLines}개 (인덱싱 ${Math.round(index.durationMs)}ms)`;

  renderWarnings(index);

  if (index.segments.length === 0) {
    timelineEl.innerHTML = `<p class="muted">표시할 기록이 없습니다</p>`;
    return;
  }

  for (const segment of index.segments) {
    timelineEl.append(renderSegment(segment));
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

function renderSegment(segment: Segment): HTMLElement {
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
      void loadDetail(segment.rootUuid, body);
    }
  });

  return wrap;
}

async function loadDetail(
  rootUuid: string,
  container: HTMLElement,
): Promise<void> {
  container.innerHTML = `<p class="muted">불러오는 중…</p>`;
  let detail: SegmentDetail;
  try {
    detail = await getJson<SegmentDetail>(
      `/api/segment/${encodeURIComponent(rootUuid)}`,
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
  container.append(renderVirtualList(detail.nodes));
}

function renderReattach(detail: SegmentDetail): HTMLElement {
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

  const command = detail.suggestedReattachCommand!;
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
function renderVirtualList(nodes: readonly NodeIndex[]): HTMLElement {
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
      const el = renderNode(nodes[i]!, i);
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

function renderNode(node: NodeIndex, position: number): HTMLElement {
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

  const cached = bodyCache.get(node.uuid);
  if (cached !== undefined) {
    bodyEl.textContent = cached;
    return el;
  }

  getJson<NodeBody>(`/api/body?uuid=${encodeURIComponent(node.uuid)}`)
    .then((body) => {
      const text = summarizeRaw(body.raw);
      bodyCache.set(node.uuid, text);
      bodyEl.textContent = text;
    })
    .catch((err: unknown) => {
      const error = err as HttpError;
      bodyEl.textContent = `본문을 읽지 못했습니다: ${error.message}`;
      if (error.status === 409) showBanner(error.message);
    });

  return el;
}

/**
 * 본문 한 줄에서 사람이 읽을 부분만 뽑는다. 그래프 구조를 다시 계산하지는
 * 않는다 — 여기서 파싱하는 것은 표시용 텍스트뿐이다.
 */
function summarizeRaw(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw.slice(0, 300);
  }
  const content = (parsed as { message?: { content?: unknown } })?.message
    ?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as { type?: string; text?: string; name?: string }[])
      .map((part) => {
        if (part?.type === "text") return part.text ?? "";
        if (part?.type === "tool_use") return `[도구 ${part.name}]`;
        if (part?.type === "tool_result") return "[도구 결과]";
        return `[${part?.type ?? "?"}]`;
      })
      .join(" ")
      .slice(0, 300);
  }
  return raw.slice(0, 300);
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

function formatTime(timestamp: string | null): string {
  if (!timestamp) return "";
  return timestamp.replace("T", " ").slice(0, 19);
}

function escapeHtml(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      (
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }) as Record<string, string>
      )[c]!,
  );
}
