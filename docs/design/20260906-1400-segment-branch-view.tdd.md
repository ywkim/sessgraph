---
slug: 20260906-1400-segment-branch-view
status: Current
related:
  prd: docs/prd/20260906-1400-segment-branch-view.prd.md
updated: 2026-09-07
---

# Technical Design: 세그먼트 내부 분기 표시

## Context

> 📋 출처: [docs/prd/20260906-1400-segment-branch-view.prd.md](../prd/20260906-1400-segment-branch-view.prd.md)
>
> 목표: 한 세그먼트 안에서 사용자 재실행/수정으로 갈라진 지점(진짜 분기)을 도구 병렬 호출로 생긴 분기(노이즈)와 구분해 화면에 드러낸다.

## 적용하는 기존 ADR

- [ADR-0001: TypeScript 단일 스택](../adr/ADR-0001-typescript-single-language.md) — 분기 판정은 `src/core/`의 순수 함수로 만들고 `src/web/`에서 다시 구현하지 않는다
- [ADR-0003: 웹 읽기 전용, CLI 단독 쓰기](../adr/ADR-0003-cli-writes-web-reads.md) — 곁가지 표시는 조회만 한다. 어느 갈래를 "정본"으로 삼을지 파일에 기록하는 동작은 이번 범위에 없다
- [ADR-0004: 시끄러운 실패](../adr/ADR-0004-schema-drift-defense.md) — 곁가지를 목록에서 조용히 빼지 않는다. 폐기된 갈래도 "존재했다"는 사실은 남는다

## 아키텍처 (How)

```
build-index.ts (파싱 단계, 기존 JSON.parse 재사용 — 추가 I/O 없음)
  → NodeIndex에 isSidechain, isToolResultShape 두 필드 추가

src/core/segment-branch.ts (신규)
  resolveSegmentBranches(index, nodes, segmentRootUuid): BranchPoint[]
  → buildSegmentDetail이 만드는 childrenByParent를 재사용

src/web: 조각을 펼쳤을 때, 진짜 분기가 있는 부모 노드 아래에
  "곁가지 N개(재실행/수정)" 배지를 표시. 노이즈 분기는 아무 표시도 하지 않는다
  + 레인 거터(아래 "레인 기반 표시" 참고) — 배지만으로는 갈래 자체(소속·
    중첩·시작/끝 범위)가 안 보인다는 재피드백(2026-09-07)으로 추가
```

### 레인 기반 표시 (2026-09-07 재피드백 반영)

배지 "곁가지 N개"는 분기점의 **존재**는 알리지만, 곁가지가 어느 분기점 소속인지·몇 겹 중첩됐는지·어디서 시작해 어디서 끝나는지는 알려주지 않는다. `git log --graph`가 브랜치를 컬럼(레인)으로 그리는 것과 같은 방식으로, 세로 타임라인 고정 배치(Non-Goals가 지킨 제약) **안에서** 각 행 왼쪽에 레인 거터를 추가한다.

```
src/core/segment-branch.ts
  computeBranchLanes(nodes, childrenByParent, branches): ReadonlyMap<uuid, BranchLane>
```

세 단계로 계산한다:

1. **갈래(subtree) 식별** — 루트에서 DFS. 채택 경로(`BranchPoint.adoptedUuid`)와 노이즈 자식은 부모의 갈래를 그대로 물려받고, `discardedUuids`에 속한 자식만 새 갈래(`subtreeId`)로 갈라진다. 중첩된 분기점은 그 갈래 안에서 또 새 갈래를 만들어 `depth`가 늘어난다
2. **갈래별 lineNo 범위** — 그 갈래에 속한 노드들의 최소/최대 `lineNo`가 "이 갈래의 시작과 끝"이다
3. **레인 배정 (interval graph coloring)** — trunk(채택 경로)는 항상 레인 0. 나머지는 lineNo 구간이 겹치지 않는 갈래끼리 레인 번호를 재사용한다(`git log --graph`의 컬럼 재사용과 같은 원리). 실측한 "동시 open 브랜치 수"(중앙값 3, p90 10, p99 21)가 그대로 이 레인 개수가 된다 — 원시 트리 깊이가 아니라 겹치는 구간 개수만큼만 늘어난다

`src/web`은 레인 개수 상한(`LANE_CAP = 5`, 실측 laneDepth 기준)을 두어 폭 폭발을 막는다. 상한을 넘는 레인은 `lane % 6` 색상 로테이션이 겹칠 수 있지만, 배지 텍스트의 곁가지 개수는 항상 정확하다. 가상 스크롤을 지탱하는 고정 `--row-height`는 변경하지 않는다 — 레인 거터는 각 행 안에 절대 위치로 그려질 뿐이다. 폭이 좁은 화면(`@container node-list (max-width: 480px)`)에서는 레인 하나의 픽셀 폭(`--lane-width`)만 줄여 대응한다 — 폭 자체를 JS가 인라인으로 계산해 넣으면 컨테이너 쿼리가 그 값을 못 이기는 문제가 있어(2026-09-07 실제로 겪음), JS는 레인 "개수"(`--lane-count`)만 인라인으로 넘기고 실제 px 계산은 CSS `calc()`에 맡긴다.

## 데이터 흐름

1. **인덱싱**: `build-index.ts`가 각 JSONL 줄을 파싱하며 `isSidechain`, `isToolResultShape`를 `NodeIndex`에 함께 싣는다 — 추가 파일 읽기 없음
2. **조각 펼치기 요청**: `GET /api/session/:id/segment/:rootUuid` 호출 시 `buildSegmentDetail`이 `childrenByParent` 맵을 만든다(기존 동작, 변경 없음)
3. **분기 판정**: `resolveSegmentBranches(childrenByParent)`가 자식이 둘 이상인 부모를 순회해, `isSidechain`/`isToolResultShape`가 모두 `false`인 자식이 2개 이상인 경우에만 `BranchPoint`를 만든다
4. **응답**: `SegmentDetail.branches`에 실어 반환한다. 에러 처리 경로 없음 — 필드 부재는 `false` 기본값으로 흡수되어 예외를 던지지 않는다(ADR-0004)
5. **화면**: 조각을 펼친 상태에서만 해당 부모 노드 아래에 "곁가지 N개(재실행/수정)" 표시

### 진짜 분기와 노이즈를 가르는 기준을 어디서 계산하는가

실측(1,633세션, uuid 중복 제거 후)에서 자식이 둘 이상인 부모 32,935개 중 27,239개는 자식이 전부 tool_use/tool_result인 구조적 산물이었고, 5,696개만 사용자 메시지가 둘 이상 갈라진 진짜 재실행/수정이었다. 이 구분에는 **레코드의 `type`만으로는 부족하다** — Claude Code JSONL에서 tool_result도 `type: "user"`로 기록되기 때문에, `content` 배열 안에 `tool_result` 블록이 있는지까지 봐야 한다.

세 가지 선택지:

1. **`src/web`이 화면에 그릴 때 본문을 seek해 판정한다** — `buildSegmentDetail`이 이미 "본문은 서버 계층이 읽는다"는 경계를 정해뒀다(`src/core/serve.ts` 주석). 이 경계를 지키려면 판정도 `src/cli`나 그 위에서 해야 하는데, 그러면 목록 화면과 펼친 화면이 각자 본문을 다시 읽어 판정이 두 곳으로 갈리는 길이 열린다 — 조각 출처 백링크 Design이 경계한 것과 같은 위험이다
2. **인덱싱 시점에 판정해 `NodeIndex`에 싣는다.** `build-index.ts`는 각 줄을 이미 `JSON.parse`하고 있다(`logicalParentUuid`를 뽑아내는 것과 같은 자리). `content` 배열의 첫 블록 타입과 `isSidechain` 필드를 같이 뽑아내는 것은 **추가 파일 I/O가 없다** — 이미 메모리에 올라온 객체에서 필드 하나 더 읽는 것뿐이다
3. **판정 규칙 자체를 `src/core`의 파생 함수로 유지하되 입력은 2번의 필드를 쓴다.**

**2 + 3을 택한다.** 본문을 다시 열어 읽는 비용도, 판정이 두 곳으로 갈리는 위험도 없다. `NodeIndex`에 필드가 늘어나지만, `rootLogicalParentUuid`를 추가했을 때와 같은 성격의 확장이다 — 이미 파싱한 값을 버리지 않고 실어 나르는 것뿐, 새로운 읽기 경로를 만들지 않는다.

### 고려한 대안 & 기각 이유

**대안1: `buildSegmentDetail` 안에 분기 계산을 함께 둔다**

- 기각: 목록 화면과 펼친 화면이 서로 다른 시점에 각자 계산하게 되면 판정이 갈릴 수 있다. 별도 함수로 분리해 한 곳에서만 계산한다

**대안2: `Segment` 타입에 `branches` 필드를 추가한다**

- 기각: 분기는 조각 하나가 아니라 그 조각에 속한 개별 부모 노드에 대한 사실이라, `IndexResult`가 항상 들고 다닐 값이 아니다 (본문 "`Segment`가 아니라 별도 함수로 분리한다" 참조)

**선택**: 별도 함수 `resolveSegmentBranches`로 분리하고, 조각을 펼칠 때만 호출한다.

```ts
// src/core/types.ts — NodeIndex에 추가
readonly isSidechain: boolean;
/** content[0]이 tool_result 블록이면 true. 도구 병렬 호출로 생긴 분기를
 *  걸러내는 데만 쓴다 — 본문 내용 자체는 여전히 core가 보관하지 않는다. */
readonly isToolResultShape: boolean;
```

### `Segment`가 아니라 별도 함수로 분리한다

조각 출처 백링크 Design과 같은 이유다. 분기는 조각 하나가 아니라 **그 조각에 속한 개별 부모 노드**에 대한 사실이고, 조각을 열 때만 필요하다 — `IndexResult`가 항상 들고 다닐 값이 아니다. `resolveSegmentBranches(index, nodes, rootUuid)`는 그 조각을 펼칠 때만 호출되고, `buildSegmentDetail`이 이미 만드는 `childrenByParent`(`src/core/serve.ts:30-37`)를 그대로 받아써 트리 순회를 두 번 하지 않는다.

### 채택 경로는 새로 정의하지 않는다

`buildSegmentDetail`의 DFS는 `childrenByParent.get(current.uuid)`가 반환한 배열을 스택에 그대로 push한다 — 즉 **가장 마지막에 등장한 자식이 스택 맨 위**라 먼저 pop되어 앞쪽에 나열된다(자바스크립트 배열 push/pop 순서. lineNo 정렬 전 임시 순서일 뿐이지만, 실질적으로는 파일에 나중에 쓰인 자식이 우선). 이 순서를 "채택 경로"로 그대로 인정한다 — PRD Non-Goals가 명시했듯 더 나은 채택 기준이 필요한지는 확인되지 않았다. 나머지 자식은 전부 "곁가지"로 묶는다.

다만 `resolveSegmentBranches`가 실제로 "채택"으로 표시하는 `adoptedUuid`는 `children`(전체) 배열이 아니라 `real`(노이즈 제외) 배열의 마지막 원소다 — `children`의 마지막이 도구 호출/사이드체인이면 어떤 real 자식도 `adoptedUuid`와 일치하지 않아 전부 곁가지로 잘못 분류되는 버그가 있었다(2026-09-07 PR #53 리뷰에서 확인, 수정). 노이즈 자식은 애초에 `discardedUuids`(재실행/수정 갈래)에도 포함되지 않으므로, 이 정정이 노이즈 판정 자체에는 영향을 주지 않는다.

### 성능/리스크

- `NodeIndex` 필드 추가는 인덱스 하나당 boolean 두 개(≈2바이트) 증가 — 실측 기준선(항목 10,726개)에서 무시할 수 있는 크기다
- `resolveSegmentBranches`는 조각 하나의 `childrenByParent`만 순회한다 — 세션 전체를 다시 훑지 않는다

## 향후 확장 고려사항

- 곁가지를 펼쳐 내용을 보여주는 것 — 이번 설계는 존재/개수만 다루므로, 나중에 추가해도 `BranchPoint`에 `discardedUuids`가 이미 있어 확장 지점을 새로 만들 필요가 없다
- 도구 병렬 호출 분기를 별도로(예: "도구 N개 동시 호출") 표시하는 것 — 지금은 `isToolResultShape`로 완전히 걸러내지만, 필드 자체는 이미 `NodeIndex`에 있으므로 별도 인덱싱 변경 없이 화면 로직만 추가하면 된다
