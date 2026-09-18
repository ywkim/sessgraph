---
slug: 20260918-1430-serve-ui-filtering
status: Current
updated: 2026-09-18
related:
  prd: docs/prd/20260902-0420-serve-command.prd.md
  design: docs/design/20260904-1130-responsive-layout.tdd.md
---

# Spec: Serve UI 필터링 & 세션 목록

## 개요

serve 명령의 웹 UI에서:
1. 펼친 세션 내부에서 어떤 노드를 렌더링할 것인가 (노드 필터링)
2. 좁은 화면에서 콘텐츠를 어떻게 축약할 것인가 (콘텐츠 축약)
3. 여러 세션 목록을 어떻게 표시할 것인가 (세션 목록)

를 정의하는 구현 명세다.

## 데이터 구조

### NodeIndex 필드 (src/core/types.ts)

노드 필터링 관련 필드:

```typescript
export interface NodeIndex {
  readonly uuid: string;
  readonly parentUuid: string | null;
  readonly type: string;       // "user", "assistant", "system", etc.
  readonly subtype: string | null;
  readonly timestamp: string | null;
  readonly lineNo: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  // 필터링 용도
  readonly isSidechain: boolean;        // 도구 병렬 호출인가?
  readonly isToolResultShape: boolean;  // content[0]이 tool_result인가?
}
```

### SessionSummary 필드 (src/core/types.ts)

세션 목록 화면의 각 항목:

```typescript
export interface SessionSummary {
  readonly id: string;              // 조회 키: sha256(path).slice(0, 12)
  readonly label: string;           // 표시용: 절대경로 또는 상대경로
  readonly status: "unread" | "ready" | "failed";
  readonly failure: string | null;  // status="failed"일 때만 값을 가짐
  readonly nodeCount?: number;      // 옵션: 메타정보 (첫 구현에 포함 권장)
  readonly firstTimestamp?: string; // 옵션: 세션의 첫 메시지 시각 (정렬 기준)
}
```

### 화면 너비 상수 (src/web/app.ts)

```typescript
const NARROW_THRESHOLD = 768;  // px
const WIDE_THRESHOLD = 1024;   // px (필요시)
```

컨테이너 쿼리 기준 (CSS, `@container (max-width: 768px)`)과 일치해야 한다.

## 필터링 로직

### 노드 필터링 함수

```typescript
// src/web/app.ts 신규 함수

/** 노드를 DOM에 렌더링할지 판정한다 */
function shouldShowNode(node: NodeIndex): boolean {
  // PRD "콘텐츠 필터링 정책"의 "포함되는 노드" 기준 적용
  const includedTypes = ["user", "assistant", "claude"];
  return includedTypes.includes(node.type);
  
  // 참고: isSidechain/isToolResultShape는 여기서 쓰지 않는다
  // 이들은 segment-branch-view의 분기 시각화용이며, 노드 필터링은
  // serve-command PRD의 필터링 정책에 따른다
}
```

**정책:**
- `type: "user"` → 표시
- `type: "assistant" | "claude"` → 표시
- 도구 호출/결과 → 미표시 (type은 "user"이지만 content 구조가 다름)

**구현 위:**
- `renderVirtualList()`에서 노드 배열을 순회할 때, `shouldShowNode()`로 필터링
- 또는 `SegmentDetail.nodes`를 받을 때 이미 필터링된 배열을 받음 (서버에서 필터링하는 방안도 가능)

### 좁은 화면 콘텐츠 축약

#### uuid 표시

```typescript
// src/web/app.ts: renderNode() 내부

if (screenWidth < NARROW_THRESHOLD) {
  // wide에서: ${uuid} (32자)
  // narrow에서: ${uuid.slice(0, 8)}… 
  // 전체 보기: 클릭/복사 버튼
}
```

**구현:**
- uuid를 span.uuid로 감싸고 data-full-uuid 속성에 전체값 저장
- CSS `@container (max-width: 768px)`에서 `overflow: hidden; text-overflow: ellipsis`
- 호버 시 전체값 표시 또는 클릭 시 클립보드 복사 버튼

#### body 미리보기

**기존 구현 (docs/design/20260907-1500-node-body-full-text.tdd.md):**
- wide: 최대 5줄 + dialog로 전체 보기
- narrow: 최대 2줄 + dialog로 전체 보기
- 축약 표시: `.truncated` 클래스 + "전체 보기" 아이콘

**변경 없음** — 이미 responsive-layout Design에서 구현됨

### 세션 목록 렌더링

```typescript
// src/web/app.ts: renderSessionList()

function renderSessionList(sessions: readonly SessionSummary[]): void {
  // 정렬: firstTimestamp 기준 내림차순 (최근순)
  const sorted = sessions
    .filter(s => s.status !== 'failed' || s.failure !== undefined)
    .sort((a, b) => {
      const aTime = new Date(a.firstTimestamp || 0).getTime();
      const bTime = new Date(b.firstTimestamp || 0).getTime();
      return bTime - aTime; // 내림차순
    });
    
  const list = document.createElement("div");
  list.className = "session-list";
  
  for (const session of sorted) {
    const item = renderSessionItem(session);
    list.append(item);
  }
  
  timelineEl.append(list);
}

function renderSessionItem(session: SessionSummary): HTMLElement {
  const screenWidth = window.innerWidth; // 또는 컨테이너 쿼리 활용
  const isNarrow = screenWidth < NARROW_THRESHOLD;
  
  // 상태 아이콘
  let statusIcon = "•";
  if (session.status === "unread") statusIcon = "⏳";
  else if (session.status === "ready") statusIcon = "✓";
  else if (session.status === "failed") statusIcon = "✗";
  
  // 경로 표시
  const displayPath = isNarrow
    ? session.label.split("/").pop() || session.label  // basename
    : session.label;
  
  const item = document.createElement(session.status === "failed" ? "div" : "button");
  item.className = `session-item ${session.status}`;
  item.type = session.status !== "failed" ? "button" : undefined;
  
  // 상태: wide는 텍스트, narrow는 아이콘만
  const statusText = isNarrow ? statusIcon : `${statusIcon} ${session.status}`;
  
  let html = `
    <span class="session-id">${escapeHtml(session.id)}</span>
    <span class="session-path" title="${escapeHtml(session.label)}">
      ${escapeHtml(displayPath)}
    </span>
    <span class="session-status">${escapeHtml(statusText)}</span>`;
  
  // 메타정보 (wide only)
  if (!isNarrow && session.nodeCount !== undefined) {
    html += `<span class="session-meta">${session.nodeCount}개 노드</span>`;
  }
  
  // 오류 메시지 (실패한 세션)
  if (session.status === "failed" && session.failure) {
    html += `<span class="session-error">${escapeHtml(session.failure)}</span>`;
  }
  
  item.innerHTML = html;
  
  if (session.status !== "failed") {
    item.addEventListener("click", () => {
      location.hash = `#session/${encodeURIComponent(session.id)}`;
    });
  }
  
  return item;
}
```

#### 검색 기능

```typescript
// src/web/app.ts: 세션 목록 위에 검색창 추가

function renderSessionSearch(): HTMLFormElement {
  const form = document.createElement("form");
  form.className = "session-search";
  
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "세션 검색 (파일명 또는 경로)";
  input.addEventListener("input", (e) => {
    const query = (e.target as HTMLInputElement).value.toLowerCase();
    filterSessionList(query); // 아래 구현
  });
  
  form.append(input);
  return form;
}

function filterSessionList(query: string): void {
  const items = document.querySelectorAll<HTMLElement>(".session-item");
  for (const item of items) {
    const pathEl = item.querySelector(".session-path");
    const path = pathEl?.textContent || "";
    const matches = path.toLowerCase().includes(query);
    item.style.display = matches ? "" : "none";
  }
}
```

**구현 위:**
- sessionSearch form을 목록 위에 삽입
- input 이벤트: 현재 화면의 세션들만 필터링 (클라이언트 측)
- 전 세션 검색이 필요하면 `/api/search` 사용

## SegmentDetail 응답 (기존)

```typescript
export type SegmentDetail = {
  readonly nodes: readonly NodeIndex[];
  readonly branches: readonly BranchPoint[];
  readonly suggestedReattachCommand?: string;
  readonly suggestedParentSource?: SuggestedParentSource;
};
```

**변경 필요:** 없음
- `nodes` 배열이 필터링된 배열인지 확인 필요 (PRD의 포함/제외 기준 적용)
- 아니면 `renderVirtualList()`에서 `shouldShowNode()`로 필터링

## 성공 기준

### 노드 필터링
- [ ] wide 화면: 모든 "포함되는 노드"(user, assistant, claude) 표시
- [ ] narrow 화면: wide와 동일한 노드 표시 (콘텐츠만 축약)
- [ ] 도구 호출/결과 노드는 DOM에 렌더링되지 않음
- [ ] segment-branch-view의 "곁가지" 배지와 노드 표시 기준이 일관됨

### 세션 목록
- [ ] 세션이 firstTimestamp 기준 내림차순 정렬
- [ ] wide: 절대경로 표시, 메타정보(노드 수) 표시
- [ ] narrow: basename만 표시, 상태는 아이콘만, 메타정보 생략
- [ ] 호버/클릭으로 전체 경로 확인 가능
- [ ] 파일명으로 검색 가능

### 콘텐츠 축약 (기존 기능 유지)
- [ ] uuid truncate: wide (전체 32자) vs narrow (앞 8자+…)
- [ ] body truncate: wide (5줄) vs narrow (2줄)
- [ ] 축약된 콘텐츠마다 "전체 보기" 수단 (dialog, 클립보드 복사)

## 참고

- **PRD:** [docs/prd/20260902-0420-serve-command.prd.md](../prd/20260902-0420-serve-command.prd.md) "콘텐츠 필터링 정책"
- **Design:** [docs/design/20260904-1130-responsive-layout.tdd.md](../design/20260904-1130-responsive-layout.tdd.md)
- **Design:** [docs/design/20260906-1400-segment-branch-view.tdd.md](../design/20260906-1400-segment-branch-view.tdd.md)
- **기존 기능:** [docs/design/20260907-1500-node-body-full-text.tdd.md](../design/20260907-1500-node-body-full-text.tdd.md)
