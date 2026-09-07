---
slug: 20260907-1500-node-body-full-text
status: Current
superseded_reason:
related:
  prd: docs/prd/20260907-1500-node-body-full-text.prd.md
  design: docs/design/20260907-1500-node-body-full-text.tdd.md
updated: 2026-09-07
---

# Spec: 노드 본문 미리보기 전체 보기

## Interface

### 마크업 (`src/web/app.ts`)

페이지에 dialog 하나를 두고 (기존 `renderNode()`가 만드는 각 `.node`와 별개로, 최상위에 1개만 존재):

```html
<dialog id="body-dialog" class="body-dialog">
  <pre class="body-dialog-text"></pre>
  <button class="body-dialog-close" autofocus>닫기</button>
</dialog>
```

`renderNode()`가 만드는 `.node-body` 뒤에, 잘림 판정 후에만 클래스/속성을 추가한다 (마크업 자체는 그대로 `<div class="node-body">…</div>`):

```ts
// renderNode() 반환 직후, 호출부(paint())가 DOM에 붙인 뒤 1 프레임 뒤에 판정
requestAnimationFrame(() => {
  if (bodyEl.scrollHeight > bodyEl.clientHeight) {
    bodyEl.classList.add("truncated");
    bodyEl.setAttribute("role", "button");
    bodyEl.setAttribute("tabindex", "0");
    bodyEl.setAttribute("aria-label", "본문 전체 보기");
  }
});
```

### 함수 (`src/web/app.ts`)

```ts
/** 공용 dialog에 전체 텍스트를 채우고 연다. dialog는 모듈 스코프에 1개만 존재. */
function openBodyDialog(fullText: string): void;
```

`.node-body.truncated`의 `click`과 `keydown`(Enter/Space) 이벤트에서 호출한다. 전체 텍스트는 새 API 호출 없이 이미 렌더 시점에 받은 `bodyCache`(기존 `app.ts:555` `bodyCache.get(cacheKey)`)의 값을 그대로 쓴다 — 이 스펙은 새 데이터 소스를 만들지 않는다.

## 데이터 모델

새 타입 없음. 기존 `bodyCache: Map<string, string>` (세션ID:uuid → 본문 전체 텍스트)을 그대로 읽기만 한다. `.truncated` 판정은 DOM 측정값(`scrollHeight`/`clientHeight`)에서만 나오며 서버로 왕복하지 않는다.

## 엣지 케이스 & 에러 처리

- 본문이 짧아 잘리지 않은 노드: `.truncated` 클래스도, 클릭 핸들러도 붙지 않는다 — 기존 동작과 동일하게 클릭해도 아무 일도 없다
- 본문이 아직 로딩 중(`"불러오는 중…"` placeholder, `app.ts:549`)인 상태에서 사용자가 클릭: placeholder 텍스트는 `scrollHeight <= clientHeight`이므로 애초에 `.truncated`가 붙지 않아 클릭할 수 없다. 로딩 완료 후 뒤늦게 길다고 판명되면, 본문 교체 시점(`bodyEl.textContent = fetched`)에도 같은 잘림 판정을 다시 실행한다
- 세그먼트가 접혔다가 다시 펼쳐져 `.node`가 DOM에서 제거·재생성될 때: 공용 `<dialog>`는 모듈 스코프에 남아있으므로 다시 만들지 않는다. 열려 있던 dialog가 있다면 그 시점에 원본 `.node-body`가 사라지는 것이므로 `close()`로 닫는다(참조가 끊긴 채로 열려있는 dialog를 남기지 않는다)
- 두 `.node-body.truncated`를 연달아 빠르게 클릭: 공용 dialog이므로 나중 클릭의 내용으로 교체된다. 동시에 두 개가 열리는 상태는 만들지 않는다(네이티브 `<dialog>`가 `showModal()` 재호출 시 이미 열려있으면 예외를 던지므로, `openBodyDialog`는 호출 전에 `if (dialog.open) dialog.close()`로 정리한다)
- 텍스트에 HTML 특수문자 포함: `<pre>`에 `textContent`로 대입한다(`innerHTML` 아님) — 이스케이프 없이도 안전하고, 기존 렌더 경로의 `escapeHtml` 관례와 다른 이유로 안전한 것이므로 혼동하지 않는다

## 성능 요구사항

- 잘림 판정(`scrollHeight`/`clientHeight` 비교)은 가상 스크롤이 새로 그리는 행 수(뷰포트에 보이는 행, 수십 개 규모)에 비례한다 — 세션 전체 노드 수와 무관하다. 목록을 빠르게 스크롤해도 판정이 프레임을 밀리지 않아야 한다(레이아웃을 강제로 읽는 연산이므로 쓰기와 섞이지 않게 `requestAnimationFrame` 한 번으로 배치한다 — layout thrashing 방지)

## Out of Scope

- 리사이즈 시 `.truncated` 판정을 다시 계산하는 것 — [Design](../design/20260907-1500-node-body-full-text.tdd.md) "잘렸는지 판정은 렌더 후 1회"에서 밝힌 대로, 현재 가상 스크롤에 리사이즈 리스너 자체가 없는 기존 한계를 이 스펙이 새로 해결하지 않는다
- 세그먼트 펼침 목록 밖(검색 결과 등)의 잘린 텍스트 처리 — [PRD](../prd/20260907-1500-node-body-full-text.prd.md) Non-Goals
- dialog 안에서 텍스트를 검색·복사 버튼 등으로 가공하는 것 — 브라우저 기본 텍스트 선택/복사로 충분하다고 보고 별도 UI를 추가하지 않는다
