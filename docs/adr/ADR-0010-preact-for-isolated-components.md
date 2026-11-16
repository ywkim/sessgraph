---
status: Accepted
date: 2026-11-16
---

# ADR-0010: 화면의 독립 영역은 Preact 컴포넌트로 만들고 번들러 없이 전달한다

## Status

Accepted

## Context

웹 화면(`src/web/app.ts`, 1,100여 줄)은 DOM을 직접 만들고 모듈 변수로 상태를 나눠 쓴다. 검색 입력줄이 그 예다: 입력칸·체크박스·선택칸의 값을 `app.ts`가 DOM에서 읽고(`readFilterInput`), "함께 보기" 버튼은 체크박스를 직접 눌러 `change` 이벤트를 흉내 낸다. 영역의 상태와 DOM 소유권이 `app.ts` 전체에 퍼져 있어, 한 영역을 바꾸면 다른 영역의 코드까지 읽어야 한다.

필요한 것은 영역마다 상태와 DOM을 닫아 두는 수단이다. [ADR-0007](ADR-0007-hand-roll-vs-existing-solution.md)의 기준을 적용한다. 선언적 렌더링과 갱신 범위 계산은 직접 만들면 조용히 틀리는 종류의 코드다(입력 중인 값의 보존, 이벤트 해제, 목록 갱신). 도입 쪽으로 결정한다.

이 저장소의 웹은 `tsc`가 만든 ES 모듈을 `serve`가 정적으로 응답하고 번들러가 없다([ADR-0009](ADR-0009-markdown-view-marked-lexer.md)).

## 후보 기술 & 각 선택지

**후보1: Preact (JSX를 `tsc`가 컴파일, importmap으로 전달)**

- 장점: 패키지가 ESM 파일을 제공하고 JSX 변환은 `tsc`(`jsxImportSource`)가 한다. 번들러가 필요 없다. 런타임이 작고(`preact.mjs` 약 12KB) 자체 의존성이 없다. 텍스트를 기본으로 이스케이프하므로 `innerHTML` 금지([ADR-0009](ADR-0009-markdown-view-marked-lexer.md))를 지킨다
- 단점: 런타임 의존성이 하나 늘어난다. 패키지의 파일 확장자가 `.mjs`라 `serve`의 MIME 표와 맞지 않는다

**후보2: 웹 컴포넌트(`customElements`, Shadow DOM)**

- 장점: 의존성이 없고 CSS까지 닫힌다
- 단점: 상태가 바뀔 때의 DOM 갱신을 직접 짜야 한다. 지금 문제(수동 DOM 갱신)가 그대로 남는다

**후보3: lit**

- 장점: 웹 컴포넌트 위에 선언적 렌더링을 준다
- 단점: 데코레이터와 템플릿 리터럴 중심이라 `tsc`만으로는 다루기 번거롭다. Shadow DOM 때문에 기존 `app.css`(전역)를 영역마다 다시 나눠야 한다

**후보4: 번들러 + React/Svelte**

- 장점: 생태계가 가장 크다
- 단점: 번들러가 이 저장소의 전달 구조를 바꾼다. 영역 하나를 닫는 데 비해 비용이 크다([ADR-0007](ADR-0007-hand-roll-vs-existing-solution.md))

## Decision

`preact`를 `dependencies`에 정확한 버전(`11.1.1`)으로 고정해 넣는다. 버전은 배포 후 2주 이상 지난 것을 고른다(2026-10-31 배포, 결정 시점에 16일 경과).

- 컴포넌트는 `src/web/*.tsx`에 둔다. `tsconfig.web.json`이 `jsx: react-jsx`, `jsxImportSource: preact`를 쓴다
- 전달: 빌드(`copy-web-assets.js`)가 `preact.mjs`와 `jsxRuntime.mjs`를 `dist/web/vendor/`에 `.js` 이름으로 복사하고, `index.html`의 `importmap`이 `preact`·`preact/jsx-runtime`을 그 경로로 잇는다. `.js`로 바꾸는 이유는 `serve`의 MIME 표를 건드리지 않기 위해서다
- 영역 하나는 `render(<Component/>, 루트)`로 붙이고, 그 루트 안의 DOM은 Preact만 만진다. 바깥(`app.ts`)은 콜백을 넘기고 핸들(`enableTiers` 같은 함수)로만 영역을 바꾼다
- 상태 전이는 DOM과 컴포넌트에서 떨어진 순수 함수(`search-form-state.ts`)로 둔다. 컴포넌트는 그 상태를 그리기만 한다
- 가상 스크롤 행(`renderNode`)과 타임라인은 옮기지 않는다. 행 높이 `ROW_HEIGHT`가 위치 계산의 전제라, 이 영역은 DOM을 직접 다루는 지금 구조를 유지한다
- 첫 영역은 검색 입력줄(검색어·종류·기간)이다

`preact/hooks`는 아직 복사하지 않는다. 컴포넌트 안쪽에 상태가 필요해지는 영역이 생기면 복사 목록과 `importmap`에 한 줄씩 더한다.

## Rationale (선택 이유)

닫아야 하는 것은 상태와 DOM 소유권이고, 그 비용이 가장 낮은 도구는 후보1이다. 후보2는 소유권은 닫아도 갱신 코드가 남아 문제의 절반만 푼다. 후보3·4는 도구의 질이 아니라 전달 구조를 바꾸는 비용 때문에 밀린다. ADR-0009가 `marked`를 번들러 없이 전달한 방식(복사 + `importmap`)을 그대로 재사용하므로 새 전달 규칙이 생기지 않는다.

영역 단위로 붙이는 이유는 `app.ts`를 한 번에 옮기면 가상 스크롤처럼 직접 DOM을 다뤄야 하는 부분까지 위험에 들어오기 때문이다. 영역 하나가 닫히면 그 영역의 테스트는 DOM 없이 상태 함수와 컴포넌트의 vnode를 대상으로 쓸 수 있다.

## Consequences

### 장점

- 검색 입력줄의 상태가 한 곳에 있고, `app.ts`는 DOM을 읽지 않는다(`readFilterInput`, 체크박스 직접 조작이 사라졌다)
- 상태 전이와 컴포넌트가 DOM 없이 노드 테스트로 확인된다
- 새 전달 규칙이 없다(ADR-0009와 같은 방식)

### 단점 & 트레이드오프

- 런타임 의존성이 1개에서 2개가 된다. 공급망 위험은 정확한 버전 고정과 배포 후 2주 대기로 줄이지만 없애지는 못한다
- CSS는 닫히지 않는다. 전역 `app.css`의 `.search-` 접두어 규칙에 기댄다
- 화면이 JS를 받기 전까지 그 영역은 비어 있다(검색 입력줄이 `index.html`의 정적 마크업이 아니게 됐다)
- 한 화면에 직접 DOM 코드와 Preact 영역이 함께 있다. 경계는 루트 요소와 핸들이다
