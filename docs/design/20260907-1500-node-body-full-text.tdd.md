---
slug: 20260907-1500-node-body-full-text
status: Current
related:
  prd: docs/prd/20260907-1500-node-body-full-text.prd.md
updated: 2026-09-07
---

# Technical Design: 노드 본문 미리보기 전체 보기

## Context

> 📋 출처: [docs/prd/20260907-1500-node-body-full-text.prd.md](../prd/20260907-1500-node-body-full-text.prd.md)
>
> 목표: 잘린 본문 미리보기의 전체 텍스트를, 행 높이를 바꾸지 않고, 모바일에서도 확인할 수 있게 한다.

`.node-body`는 [좁은 화면 레이아웃 설계](20260904-1130-responsive-layout.tdd.md)가 명시한 대로 `max-height: 2.6em; overflow: hidden`으로 미리보기 줄 수를 고정한다. 이 설계는 "줄인 값은 전체를 확인할 방법이 있어야 한다"는 조건을 이미 달았지만 구현되지 않았다. `uuid`는 같은 조건을 `overflow-x: auto`(가로 스크롤)로 충족하고 있으므로, 본문에도 상응하는 — 그러나 세로로 여러 줄인 본문에는 가로 스크롤이 맞지 않는다 — 수단이 필요하다.

핵심 제약은 그대로 유지된다: `ROW_HEIGHT`는 가상 스크롤이 각 행의 절대 위치(`top`)를 계산하는 상수이므로, 전체 텍스트를 보여주는 동작이 그 행 자체의 높이를 바꾸면 가상 스크롤 위치 계산이 깨진다.

## 적용하는 기존 ADR

- [ADR-0007: 직접 구현과 기존 도구 도입을 "다져진 엣지 케이스"로 판별한다](../adr/ADR-0007-hand-roll-vs-existing-solution.md) — 이 설계는 네이티브 `<dialog>` 엘리먼트를 쓴다. 포커스 트랩, `Esc` 닫기, 배경 스크롤 차단, 접근성(스크린 리더가 modal로 인식)을 브라우저가 이미 구현한 "다져진 엣지 케이스"이므로 직접 구현하지 않는다
- [ADR-0001: TypeScript 단일 스택](../adr/ADR-0001-typescript-single-language.md) — 새 의존성 없이 `src/web/app.ts`/`app.css`에 추가한다

## 아키텍처 (How)

```
renderNode()
  본문 렌더 후 requestAnimationFrame에서 scrollHeight > clientHeight 판정
    → 잘렸으면 .node-body에 .truncated 클래스 부여 (시각 표시: "…" 뒤에 흐림 그라디언트)
    → .node-body에 클릭 핸들러: <dialog>를 열고 전체 textContent를 채운다

<dialog class="body-dialog">  ← DOM에 하나만 두고 재사용 (노드마다 새로 만들지 않는다)
  내용은 클릭 시점에 채워 넣는다 — 렌더 시점에 노드마다 dialog를 만들면
  가상 스크롤이 뷰포트 밖으로 나간 행의 dialog도 계속 DOM에 남아 누적된다
```

**행 높이를 건드리지 않는다.** `<dialog>`는 top layer에 렌더되는 오버레이이므로 문서 흐름(row 높이)에 전혀 영향을 주지 않는다 — [행 높이 불변](20260904-1130-responsive-layout.tdd.md#아키텍처-how) 제약을 그대로 지킨다. 대안으로 검토했던 "클릭 시 그 행만 `max-height` 해제"는 이 제약을 정면으로 깨므로 채택하지 않는다(아래 "고려한 대안").

**잘렸는지 판정은 렌더 후 1회.** `scrollHeight`와 `clientHeight`는 레이아웃 계산이 끝난 뒤에만 정확하므로, `innerHTML` 대입 직후가 아니라 브라우저가 레이아웃을 확정한 다음 프레임(`requestAnimationFrame`)에서 비교한다. 컨테이너 쿼리가 폭에 따라 `--node-body-indent` 등을 바꾸면 잘림 여부도 폭에 따라 달라진다 — 하지만 현재 `src/web/app.ts`에는 리사이즈 리스너가 없다(스크롤 리스너와 최초 1회 `requestAnimationFrame`뿐). 리사이즈 중 `.truncated` 판정이 정확히 갱신되지 않는 것은 이 설계가 새로 만드는 문제가 아니라 가상 스크롤 자체가 이미 갖고 있는 기존 한계이므로, 이 설계 범위에서 리사이즈 리스너를 새로 추가하지 않는다(Out of Scope로 명시).

**dialog는 하나만 두고 내용만 교체한다.** 가상 스크롤은 화면에 보이는 행만 DOM에 유지하므로, 노드마다 `<dialog>`를 만들면 스크롤이 지나간 뒤에도 dialog 엘리먼트가 남아 누적된다(가상 스크롤이 지키려는 DOM 크기 상한을 깨는 것과 같은 종류의 문제). 대신 페이지에 `<dialog id="body-dialog">` 하나를 두고, 클릭한 노드의 uuid와 전체 텍스트만 그때그때 채워 넣는다.

## 데이터 흐름

1. `renderNode()`가 `.node-body`에 미리보기 텍스트를 채운다 (기존 동작 그대로)
2. 다음 프레임에서 `scrollHeight > clientHeight`면 `.truncated` 클래스를 붙이고 `role="button"` + `tabindex="0"`을 부여한다 (클릭 가능함을 스크린 리더와 키보드 사용자에게도 알린다)
3. 잘리지 않은 노드는 아무 것도 하지 않는다 — 클릭 핸들러도 붙이지 않는다 (불필요한 상호작용 표면을 늘리지 않는다)
4. 사용자가 `.truncated`인 `.node-body`를 클릭(또는 Enter)하면 공용 `<dialog>`의 내용을 그 노드의 전체 텍스트로 채우고 `showModal()`을 호출한다
5. `Esc` 또는 배경 클릭으로 닫힌다 — `<dialog>` 네이티브 동작, 별도 구현 없음

에러 처리 경로: 이 설계에는 실패할 수 있는 실행 경로가 없다 — `scrollHeight`/`clientHeight` 비교와 `<dialog>` 표시는 둘 다 동기적이고 예외를 던지지 않는다. `<dialog>`를 지원하지 않는 브라우저(이 프로젝트의 실행 환경인 로컬 최신 브라우저에는 해당 없음)에서는 `.truncated` 클래스만 보이고 클릭이 조용히 아무 동작도 하지 않는다 — 이 경우도 예외가 아니라 미리보기가 그대로 보이는 현재 동작으로 안전하게 후퇴한다.

## 고려한 대안 & 기각 이유

**대안1: 클릭 시 그 행의 `max-height`를 해제해 그 자리에서 펼친다**

- 기각 이유: [행 높이 불변](20260904-1130-responsive-layout.tdd.md#아키텍처-how)이 명시적으로 막아둔 것 — `ROW_HEIGHT`가 가상 스크롤 위치 계산의 유일한 전제인데, 한 행이라도 높이가 바뀌면 그 아래 모든 행의 `top` 계산이 틀어진다. 그 설계 문서가 "행마다 높이가 달라야 하는 요구가 생기면 이 기각이 뒤집힌다"고 이미 밝혔는데, 이번 요구는 "행 높이를 바꾸지 않고 전체를 본다"는 요구이지 "행 높이가 달라져야 한다"는 요구가 아니므로 뒤집을 이유가 없다

**대안2: `title` 속성 네이티브 툴팁**

- 기각 이유: PRD 성공 기준이 "좁은 화면(모바일)에서도 동일하게 도달 가능"을 명시한다. `title` 툴팁은 마우스 hover 전용이라 터치 기기에서 도달할 방법이 없다

**대안3: 커스텀 팝오버(직접 포지셔닝한 `<div>`)**

- 기각 이유: 포커스 트랩, 외부 클릭 감지, `Esc` 닫기, 스크린 리더 announce를 전부 직접 구현해야 한다 — [ADR-0007](../adr/ADR-0007-hand-roll-vs-existing-solution.md)이 말하는 "다져진 엣지 케이스"를 네이티브 `<dialog>`가 이미 제공하는데 다시 만드는 것

**대안4: 클릭 시 별도 URL/라우트로 이동해 전체 내용을 보여주는 페이지를 연다**

- 기각 이유: 목록을 보며 여러 노드를 빠르게 훑어보는 흐름을 끊는다. 이 화면(세그먼트 펼침 목록)의 맥락 안에서 바로 확인하는 것이 사용자가 원하는 동작이다

## 향후 확장 고려사항

- 검색 결과 화면(`docs/spec/20260906-0900-body-search.spec.md`)도 매치된 본문을 잘라서 보여준다면 같은 `.truncated`/`<dialog>` 패턴을 재사용할 수 있다 — 지금은 세그먼트 펼침 목록의 `.node-body`만 다룬다(PRD Non-Goals)
