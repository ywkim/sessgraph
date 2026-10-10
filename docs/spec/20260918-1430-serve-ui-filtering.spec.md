---
slug: 20260918-1430-serve-ui-filtering
status: Current
updated: 2026-10-10
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
  readonly filteredNodeCount: number | null; // 기본 접힘이 아닌 노드 수. 인덱싱 전·실패 시 null
  readonly firstTimestamp: string | null; // 파일 앞부분의 첫 timestamp. 못 찾거나 실패 시 null
}
```

**메타데이터 계산 (지연 인덱싱과의 조화):**

- 전체 세션을 인덱싱하지 않는다. 그래서 두 필드는 null을 허용한다.
  - `firstTimestamp`: 파일 앞 64KB만 읽어 가장 앞선 `timestamp`를 찾는다. 메시지 줄의 최상위 `timestamp`를 쓰되, 메시지가 없는 파일은 `file-history-snapshot` 줄의 `snapshot.timestamp`를 쓴다. 결과는 세션별로 캐시한다. 찾지 못하거나 읽기에 실패하면 null이다.
  - `filteredNodeCount`: 이미 인덱싱된 세션만 `!isCollapsedByDefault(node)` 노드를 센다. 인덱싱 전이거나 실패한 세션은 null이다.
  - `status`: 기존 로직 그대로.
- 전체 노드 콘텐츠는 사용자가 세션을 클릭했을 때 `/api/session/:id/segment/:rootUuid`에서 로드 (지연)

### 반응형 처리

JS에서 화면 폭을 재지 않는다. 좁은 화면 대응은 CSS 미디어 쿼리만 쓴다 (`@media (max-width: 480px)`에서 `.session-meta` 숨김). 렌더 시점에 폭을 읽지 않으므로 창 크기를 바꿔도 다시 그릴 필요가 없다.

**기존 Spec 기준(768px, basename + 상태 아이콘)에서 바꾼 이유:**

- **768px → 480px:** 노드 목록의 컨테이너 쿼리가 이미 `max-width: 480px`을 좁은 화면 기준으로 쓴다 (`src/web/app.css`, responsive-layout 설계). 세션 목록만 768px을 쓰면 같은 앱 안에 좁은 화면 기준이 두 개가 된다.
- **컨테이너 쿼리 대신 `@media`:** 세션 목록 화면에는 `container-name: node-list`인 `.viewport`가 없다 (`#timeline` 안에 목록만 있다). 반응할 컨테이너가 없어 뷰포트 폭으로 대신한다. 이 화면이 별도 패널 안에 놓이게 되면 컨테이너 쿼리로 옮겨야 한다.
- **basename 제거:** 라벨을 줄바꿈해 전체 경로를 그대로 보이고 `title`로도 남긴다. basename만 보이면 같은 파일명이 다른 디렉터리에 있을 때 구분할 수 없다.
- **상태 아이콘 제거:** 목록은 상태 글자를 따로 그리지 않는다. 실패한 세션만 `.failed` 스타일과 사유(`.warning`)로 구분하고, `ready`/`unread` 차이는 표시하지 않는다. 이 판단은 설계 논의 없이 구현 중에 내렸다.

**검증 범위:** 375px 폭에서 메타가 숨겨지고 가로 스크롤이 없음을 확인했다. 480px 경계 자체와 그 위 폭(481~767px)은 실측하지 않았다.

## 노드 표시 로직

### 기본 접기 판정 함수

```typescript
// src/core/serve.ts — 서버(filteredNodeCount)와 웹(렌더링)이 함께 쓴다

/** 노드를 기본 접힌 상태로 렌더링할지 판정한다 */
export function isCollapsedByDefault(
  node: Pick<NodeIndex, "isToolResultShape" | "isSidechain">,
): boolean {
  return node.isToolResultShape || node.isSidechain;
}
```

웹은 `../core/serve.js`에서 이 함수를 import한다.

**정책:**

- `isToolResultShape: true` → tool_result 노드, 기본 접힌 상태
- `isSidechain: true` → 도구 호출 분기 노드, 기본 접힌 상태
- 둘 다 false → 사용자 대화 노드, 펼친 상태

**행 높이 불변성 (responsive-layout 제약):**

- 가상 스크롤은 모든 행이 정확히 52px 높이를 가정한다
- 접힌 노드의 본문(`.node-body`)에는 `hidden` 속성을 걸어 접근성 트리와 포커스에서도 뺀다. 행 높이는 바꾸지 않는다
- 토글 버튼은 `aria-expanded`로 상태를, `aria-controls`로 본문 id(`node-body-{sessionId}-{uuid}`)를 가리킨다
- CSS 구현:
  ```css
  .node-body[hidden] {
    display: none; /* 행 자체는 여전히 52px */
  }
  ```

**구현 위:**

- `renderVirtualList()`에서 노드를 렌더링할 때:
  1. 모든 노드를 DOM에 추가 (숨기지 않음)
  2. 기본 접기 노드에 `.collapsed` 클래스 적용
  3. 펼치기 버튼으로 `.collapsed` 클래스와 본문 `hidden`을 함께 토글
  4. 토글해도 행 높이는 불변

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

> **정정 (2026-10-10):** 목록의 노드 수 표시(`N개 노드`)는 [세션 목록 Spec](20261010-0135-serve-session-list.spec.md) 제6항에 따라 중단한다. 이 절의 노드 수 표시, 아래 "filteredNodeCount가 null인 경우"의 목록 표시 부분, 성공 기준의 노드 수 항목은 그 결정으로 대체된다. `filteredNodeCount` 필드는 API에 그대로 남는다.

`renderSessionList(sessions)` (src/web/app.ts)가 담당한다.

- **정렬:** `sortByRecency` (src/web/format.ts). `firstTimestamp` 내림차순이며, null이거나 해석할 수 없는 값은 맨 뒤에 입력 순서대로 둔다.
- **항목:** `ready`/`unread`는 `button`, `failed`는 `div`다. 실패한 세션도 목록에 남기고 `failure` 사유를 `.warning`으로 보인다 (ADR-0004).
- **표시:** 라벨(전체 경로, `title`로 호버 시 확인) + `.session-meta`(`formatTime(firstTimestamp)`). 값이 null인 항목은 생략한다. (노드 수 표시는 정정 참조)
- **좁은 화면:** CSS(`@media (max-width: 480px)`)가 `.session-meta`를 숨기고 라벨을 줄바꿈한다. JS는 폭을 재지 않는다.

### 필터

- 목록 위의 `input.session-filter`가 입력할 때마다 각 항목의 `data-label`을 `matchesQuery(label, query)`로 비교해 `item.hidden`을 설정한다.
- `matchesQuery`는 대소문자를 무시한 리터럴 `includes`다. 정규식으로 해석하지 않는다.
- 클라이언트 측 필터이며 서버 호출이 없다.

## 아키텍처 결정 (핵심 설계 충돌 해결)

### 1. 행 높이 불변성과 기본 접기의 조화

**충돌:** 가상 스크롤은 `ROW_HEIGHT = 52`를 고정값으로 가정하는데, 기본 접기 상태가 행 높이를 변경하면 가상 스크롤 계산이 깨진다.

**해결:**

- 접힌 노드는 본문에 `hidden`을 걸어 숨기기만 함 (행 높이 규칙은 건드리지 않음)
- 행 자체는 항상 52px 높이를 유지
- 결과: 가상 스크롤 상태가 변경되지 않고, 창 크기 변경 시에도 재계산 불필요

**구현 제약:** 행 높이 동적 조정 없이, 도구 노드를 "접힌 상태"로 표시. 사용자는 펼치기 버튼으로 내용을 확인 가능.

**알려진 한계:** 접어도 행 높이는 52px 그대로라 세로 공간이 줄지 않는다. 접힘의 효과는 본문(`.node-body`)을 숨기고 헤드를 흐리게(`opacity`) 보이는 구분에 한정된다.

### 2. 도구 호출 분기 감지 (feature completeness)

**충돌:** `isToolResultShape`는 tool_result 노드만 감지하고, tool_use 노드는 감지하지 못함.

**해결:**

- `isToolResultShape: true` → tool_result 노드
- `isSidechain: true` → 도구 호출 분기 노드 (대부분이 tool_use 분기)
- 둘 중 하나라도 true면 기본 접힌 상태

**근거:** segment-branch-view 설계에서 "곁가지"를 `isSidechain` 기반으로 식별함. serve-command도 같은 필드를 사용하여 일관성 유지. 판정 함수는 `src/core/serve.ts`에 한 번만 두고 서버와 웹이 공유한다.

**미검증 가정:** 실제 Claude Code 세션에서 `isSidechain: true`가 tool_use 분기에 해당한다는 점은 실측하지 않았다 (픽스처에는 해당 노드가 없다).

### 3. 지연 인덱싱과 메타데이터 필드의 조화

**충돌:** `filteredNodeCount`를 모든 세션에 채우려면 전부 인덱싱해야 해서 지연 인덱싱과 충돌한다.

**해결:**

- `firstTimestamp`: 파일 앞 64KB만 읽어 채운다 (세션별 캐시). 정렬에 쓴다.
- `filteredNodeCount`: 이미 인덱싱된 세션만 채우고 나머지는 null이다. 세션을 연 뒤 목록으로 돌아오면 값이 보인다.
- 두 필드 모두 null을 허용하며, 클라이언트는 null이면 해당 표시를 생략한다.
- 전체 세션 콘텐츠는 사용자가 세션을 클릭했을 때 `/api/session/:id/segment/:rootUuid`에서 로드 (지연)

## Interface

### 웹 API 응답 구조

```typescript
// GET /api/sessions
SessionSummary[] {
  id, label, status, failure, filteredNodeCount (number | null), firstTimestamp (string | null)
}

// GET /api/session/:id/segment/:rootUuid
SegmentDetail {
  nodes: NodeIndex[] (모든 노드, 필터링 없음)
  branches: BranchPoint[]
}
```

### 클라이언트 함수 시그니처

```typescript
// src/core/serve.ts
isCollapsedByDefault(node: Pick<NodeIndex, "isToolResultShape" | "isSidechain">): boolean

// src/web/format.ts
sortByRecency<T extends { firstTimestamp: string | null }>(sessions: readonly T[]): T[]
matchesQuery(label: string, query: string): boolean

// src/web/app.ts
renderSessionList(sessions: readonly SessionSummary[]): void
```

## 데이터 모델

### NodeIndex 기본 접기 필드

```typescript
isSidechain: boolean; // 도구 병렬 호출 분기인가?
isToolResultShape: boolean; // content[0]이 tool_result인가?
```

### SessionSummary 정렬 필드

```typescript
firstTimestamp: string | null; // ISO 8601 (정렬 기준). 없으면 null
filteredNodeCount: number | null; // 기본 접힘이 아닌 노드 수. 인덱싱 전이면 null
```

## 엣지 케이스 & 에러 처리

### 기본 접기 후 펼친 상태에서 콘텐츠 확인

- 노드가 기본 접혀 있어도 펼치기 버튼으로 항상 내용 확인 가능
- 숨김이 아니라 UI 상태일 뿐이므로 "전체 보기" 수단이 항상 존재

### firstTimestamp가 null인 경우

- 오류가 아니다. 목록에서 시각 표시를 생략하고 정렬은 맨 뒤에 둔다 (입력 순서 유지).
- 파일이 비었거나, 앞 64KB 안에 두 종류의 timestamp(메시지 줄의 `timestamp`, 스냅샷 줄의 `snapshot.timestamp`)가 모두 없거나, 읽기에 실패한 경우다.
- 상시 인스턴스 실측(2026-10-09, 1633개 중 759개): 743개는 파일 전체에 최상위 `timestamp`가 없었다 (`summary`·`file-history-snapshot` 줄뿐인 파일). `snapshot.timestamp`로 647개가 채워지고, `summary`만 있는 112개는 시각이 없어 null로 남는다.

### filteredNodeCount가 null인 경우

- 아직 인덱싱하지 않은 세션이거나 실패한 세션이다. "N개 노드" 표시를 생략한다.

### 검색 쿼리가 특수문자인 경우

- 리터럴 문자열 비교만 사용 (toLowerCase() 포함)
- 정규식 변환 없음

### 필터링된 노드 수가 0인 경우

- 인덱싱된 세션에서 모든 노드가 도구 호출·결과인 경우
- 메타 정보로 "0개 노드"로 표시 (null과 구분)
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
- [x] isToolResultShape=true OR isSidechain=true 노드가 기본 접힌 상태로 렌더링됨
- [x] 펼치기/접기 토글이 정상 동작 (`aria-expanded` 포함)
- [x] **행 높이는 항상 52px (collapse 토글과 무관, 가상 스크롤 불변성)**

### 세션 목록

- [x] 세션이 firstTimestamp 기준 내림차순 정렬 (null은 맨 뒤)
- [x] 시각 메타 표시 (null이면 생략). 노드 수 표시는 정정에 따라 중단
- [x] 좁은 화면(≤480px)에서 메타가 숨겨지고 가로 스크롤이 생기지 않음
- [ ] 호버(`title`)로 전체 경로 확인 가능
- [x] 파일명 또는 경로로 필터 가능 (대소문자 무시)
- [ ] 실패한 세션이 사유와 함께 목록에 남음

### 콘텐츠 축약 (기존 기능 유지)

- [ ] uuid truncate: wide (전체 32자) vs narrow (앞 8자+…)
- [ ] body truncate: wide (5줄) vs narrow (2줄)
- [ ] 축약된 콘텐츠마다 "전체 보기" 수단 (dialog, 클립보드 복사)

## 참고

- **PRD:** [docs/prd/20260902-0420-serve-command.prd.md](../prd/20260902-0420-serve-command.prd.md) "노드 표시 및 필터링 정책"
- **Design:** [docs/design/20260904-1130-responsive-layout.tdd.md](../design/20260904-1130-responsive-layout.tdd.md)
- **Design:** [docs/design/20260906-1400-segment-branch-view.tdd.md](../design/20260906-1400-segment-branch-view.tdd.md)
- **기존 기능:** [docs/design/20260907-1500-node-body-full-text.tdd.md](../design/20260907-1500-node-body-full-text.tdd.md)
