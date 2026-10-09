---
slug: 20260918-1430-serve-ui-filtering
status: Current
updated: 2026-10-09
related:
  prd: docs/prd/20260902-0420-serve-command.prd.md
  design: docs/design/20260904-1130-responsive-layout.tdd.md
---

# Spec: Serve UI 노드 표시 & 세션 목록

## 개요

serve 명령의 웹 UI에서:

1. 펼친 세션 내부에서 노드를 어떻게 표시할 것인가 (기본 접기 상태)
2. 좁은 화면에서 콘텐츠를 어떻게 축약할 것인가 (콘텐츠 축약)
3. 여러 세션 목록을 어떻게 표시할 것인가 (세션 목록)

를 정의하는 구현 명세다.

## 데이터 구조

### NodeIndex 필드 (src/core/types.ts)

노드 표시 상태 판정에 필요한 필드:

```typescript
export interface NodeIndex {
  readonly uuid: string;
  readonly parentUuid: string | null;
  readonly type: string; // "user", "assistant", "system", etc.
  readonly subtype: string | null;
  readonly timestamp: string | null;
  readonly lineNo: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  // 기본 접기 판정용
  readonly isSidechain: boolean; // 도구 병렬 호출인가?
  readonly isToolResultShape: boolean; // content[0]이 tool_result인가?
}
```

### SessionSummary 필드 (src/core/types.ts)

세션 목록 화면의 각 항목:

```typescript
export interface SessionSummary {
  readonly id: string; // 조회 키: sha256(path).slice(0, 12)
  readonly label: string; // 표시용: 절대경로 또는 상대경로
  readonly status: "unread" | "ready" | "failed";
  readonly failure: string | null; // status="failed"일 때만 값을 가짐
  readonly filteredNodeCount: number; // 도구 호출 제외한 노드 수 (필수)
  readonly firstTimestamp: string; // 세션의 첫 메시지 시각 (정렬 기준, 필수)
}
```

**변경사항:**

- `nodeCount`, `firstTimestamp` → 선택에서 **필수**로 변경
- `filteredNodeCount` 추가: 도구 호출·결과 제외한 노드 수

### 화면 너비 상수 (src/web/app.ts)

```typescript
const NARROW_THRESHOLD = 768; // px
```

컨테이너 쿼리 기준 (CSS, `@container (max-width: 768px)`)과 일치해야 한다.

## 노드 표시 로직

### 기본 접기 판정 함수

```typescript
// src/web/app.ts 신규 함수

/** 노드를 기본 접힌 상태로 렌더링할지 판정한다 */
function isCollapsedByDefault(node: NodeIndex): boolean {
  // tool_result 블록을 content에 가진 노드를 기본 접침
  return node.isToolResultShape === true;
  // 도구 호출 분기(isSidechain=true인 대부분의 노드)도 함께 접힘
}
```

**정책:**

- `isToolResultShape: true` → 기본 접힌 상태
- `isSidechain: true` → 도구 분기 노드 (기본 접힌 상태에 포함될 수 있음)
- 나머지 모든 노드 → 펼친 상태

**구현 위:**

- `renderVirtualList()`에서 노드를 렌더링할 때:
  1. 모든 노드를 DOM에 추가 (숨기지 않음)
  2. 기본 접기 노드에 `.collapsed` 클래스 적용
  3. 펼치기 버튼으로 클래스 토글 가능

### 콘텐츠 축약 (기존 정책 유지)

#### uuid 표시

```typescript
// src/web/app.ts: renderNode() 내부

if (screenWidth < NARROW_THRESHOLD) {
  // wide에서: ${uuid} (32자)
  // narrow에서: ${uuid.slice(0, 8)}…
}
```

**구현:**

- uuid를 span.uuid로 감싸고 data-full-uuid 속성에 전체값 저장
- CSS `@container (max-width: 768px)`에서 `overflow: hidden; text-overflow: ellipsis`
- 호버 시 전체값 표시 또는 클릭 시 클립보드 복사 버튼

#### body 미리보기 (기존 구현)

- wide: 최대 5줄 + dialog로 전체 보기
- narrow: 최대 2줄 + dialog로 전체 보기
- 축약 표시: `.truncated` 클래스 + "전체 보기" 아이콘

## 세션 목록 렌더링

### 정렬 및 표시 함수

```typescript
// src/web/app.ts: renderSessionList()

function renderSessionList(sessions: readonly SessionSummary[]): void {
  // 정렬: firstTimestamp 기준 내림차순 (최근순)
  const sorted = sessions
    .filter((s) => s.status !== "failed" || s.failure !== undefined)
    .sort((a, b) => {
      const aTime = new Date(a.firstTimestamp).getTime();
      const bTime = new Date(b.firstTimestamp).getTime();
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
    ? session.label.split("/").pop() || session.label // basename
    : session.label;

  const item = document.createElement(
    session.status === "failed" ? "div" : "button",
  );
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
  if (!isNarrow) {
    html += `<span class="session-meta">${session.filteredNodeCount}개 노드</span>`;
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

### 검색 기능

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
    filterSessionList(query);
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

## Interface

### 웹 API 응답 구조

```typescript
// GET /api/sessions
SessionSummary[] {
  id, label, status, failure?, filteredNodeCount, firstTimestamp
}

// GET /api/session/:id/segment/:rootUuid
SegmentDetail {
  nodes: NodeIndex[] (모든 노드, 필터링 없음)
  branches: BranchPoint[]
}
```

### 클라이언트 함수 시그니처

```typescript
isCollapsedByDefault(node: NodeIndex): boolean
renderSessionList(sessions: readonly SessionSummary[]): void
renderSessionItem(session: SessionSummary): HTMLElement
filterSessionList(query: string): void
```

## 데이터 모델

### NodeIndex 기본 접기 필드

```typescript
isSidechain: boolean; // 도구 병렬 호출 분기인가?
isToolResultShape: boolean; // content[0]이 tool_result인가?
```

### SessionSummary 정렬 필드

```typescript
firstTimestamp: string; // ISO 8601 format (정렬 기준)
filteredNodeCount: number; // 도구 호출 제외한 노드 수
```

## 엣지 케이스 & 에러 처리

### 기본 접기 후 펼친 상태에서 콘텐츠 확인

- 노드가 기본 접혀 있어도 펼치기 버튼으로 항상 내용 확인 가능
- 숨김이 아니라 UI 상태일 뿐이므로 "전체 보기" 수단이 항상 존재

### SessionSummary에 firstTimestamp가 없는 경우

- 필수 필드이므로 서버 오류로 처리
- API 응답 시 반드시 포함되어야 함

### 검색 쿼리가 특수문자인 경우

- 리터럴 문자열 비교만 사용 (toLowerCase() 포함)
- 정규식 변환 없음

### 필터링된 노드 수가 0인 경우

- 모든 노드가 도구 호출·결과인 경우
- 메타 정보로 "0개 노드"로 표시
- 세션 자체는 표시됨 (완전히 숨기지 않음)

## 성능 요구사항

### 노드 기본 접기 판정

- **목표:** < 1ms for 10,000 노드
- **방법:** 배열 순회 O(n), 각 노드 isToolResultShape 확인 O(1)

### 세션 목록 정렬

- **목표:** 초기 렌더링 < 100ms (1633개 세션 기준)
- **방법:** Array.sort() O(n log n), 정렬 1회만
- **캐싱:** 정렬된 목록을 상주시키기 (재정렬 필요 시만 갱신)

### 검색 필터링

- **목표:** 입력할 때마다 < 50ms (클라이언트 측)
- **방법:** 현재 화면의 세션들만 순회 (일반적으로 50개 미만)

## Out of Scope

- 세션 목록 초기 로드 시 1633개 전부 인덱싱 (지연 로드 유지)
- 세션 검색 시 `/api/search` 대신 클라이언트 필터링만 사용
- 도구 호출 노드의 세부 내용 표시 (펼칠 수 있지만 별도 UI 없음)
- 기본 접기 여부를 사용자가 토글하는 설정
- 무한 스크롤이나 가상화 개선 (기존 가상 스크롤 유지)

## 성공 기준

### 노드 표시 및 기본 접기

- [ ] 모든 노드가 타임라인에 표시됨
- [ ] isToolResultShape=true 노드가 기본 접힌 상태로 렌더링됨
- [ ] 펼치기/접기 토글이 정상 동작
- [ ] wide/narrow에서 모두 일관되게 표시됨

### 세션 목록

- [ ] 세션이 firstTimestamp 기준 내림차순 정렬
- [ ] wide: 절대경로 + nodeCount 메타 표시
- [ ] narrow: basename + 상태 아이콘만 표시
- [ ] 호버/클릭으로 전체 경로 확인 가능
- [ ] 파일명으로 검색 가능

### 콘텐츠 축약 (기존 기능 유지)

- [ ] uuid truncate: wide (전체 32자) vs narrow (앞 8자+…)
- [ ] body truncate: wide (5줄) vs narrow (2줄)
- [ ] 축약된 콘텐츠마다 "전체 보기" 수단 (dialog, 클립보드 복사)

## 참고

- **PRD:** [docs/prd/20260902-0420-serve-command.prd.md](../prd/20260902-0420-serve-command.prd.md) "노드 표시 및 필터링 정책"
- **Design:** [docs/design/20260904-1130-responsive-layout.tdd.md](../design/20260904-1130-responsive-layout.tdd.md)
- **Design:** [docs/design/20260906-1400-segment-branch-view.tdd.md](../design/20260906-1400-segment-branch-view.tdd.md)
- **기존 기능:** [docs/design/20260907-1500-node-body-full-text.tdd.md](../design/20260907-1500-node-body-full-text.tdd.md)
