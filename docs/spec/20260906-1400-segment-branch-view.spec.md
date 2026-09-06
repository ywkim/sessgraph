---
slug: 20260906-1400-segment-branch-view
status: Current
related:
  prd: docs/prd/20260906-1400-segment-branch-view.prd.md
  design: docs/design/20260906-1400-segment-branch-view.tdd.md
updated: 2026-09-06
---

# Spec: 세그먼트 내부 분기 표시

## Interface

### 인덱싱 (파싱 단계 확장)

`src/core/build-index.ts`의 `IndexAccumulator.addLine`이 이미 파싱한 `parsed` 객체에서 두 필드를 추가로 뽑는다. 새 파일 읽기·재파싱 없음.

```ts
// RawOccurrence, NodeIndex 양쪽에 추가
readonly isSidechain: boolean;
readonly isToolResultShape: boolean;
```

`isSidechain`은 레코드의 `isSidechain` 필드를 그대로 쓴다(없으면 `false`). `isToolResultShape`는 `Array.isArray(parsed.message?.content) && parsed.message.content[0]?.type === "tool_result"`일 때 `true`.

### 코어 함수

`src/core/segment-branch.ts`에 둔다. 파일을 읽지 않고 이미 만들어진 인덱스와 `buildSegmentDetail`이 만드는 `childrenByParent`만 본다.

```ts
export interface BranchPoint {
  readonly parentUuid: string;
  /** DFS가 실제로 따라간 자식 — childrenByParent 배열의 마지막 원소 */
  readonly adoptedUuid: string;
  /** 채택되지 않은 나머지 자식 uuid들. 길이 ≥ 1 */
  readonly discardedUuids: readonly string[];
}

/**
 * 한 조각 안에서 "사용자 재실행/수정으로 갈라진" 지점만 골라낸다.
 * 자식이 전부 isSidechain이거나 isToolResultShape인 부모는 포함하지 않는다.
 */
export function resolveSegmentBranches(
  childrenByParent: ReadonlyMap<string, NodeIndex[]>,
): readonly BranchPoint[];
```

### HTTP 엔드포인트

기존 `GET /api/session/:id/segment/:rootUuid`([`serve` Spec](20260902-0420-serve-command.spec.md#http-엔드포인트))의 응답(`SegmentDetail`)에 필드를 하나 추가한다. 새 엔드포인트를 만들지 않는다.

```ts
export interface SegmentDetail {
  // ...기존 필드 그대로...
  readonly branches: readonly BranchPoint[]; // 신규
}
```

## 데이터 모델

`NodeIndex`, `SegmentDetail`은 [`src/core/types.ts`](../../src/core/types.ts)를 그대로 쓰되 위 두 곳을 확장한다. `Segment`, `IndexResult`는 건드리지 않는다 — 분기는 조각 하나에 대한 파생값이지 인덱스 전체가 들고 다닐 값이 아니다([Design](../design/20260906-1400-segment-branch-view.tdd.md) "`Segment`가 아니라 별도 함수로 분리한다").

### 불변식

- `resolveSegmentBranches`가 반환하는 각 `BranchPoint`에서 `discardedUuids.length >= 1`이다 — 자식이 2개 미만인 부모는 애초에 포함되지 않는다
- 한 부모의 자식이 전부 `isSidechain === true` 또는 전부 `isToolResultShape === true`이면 `BranchPoint`를 만들지 않는다 (도구 병렬 호출 노이즈)
- 자식 중 `isSidechain`도 `isToolResultShape`도 아닌 것이 2개 이상이면 `BranchPoint`를 만든다. 나머지(사이드체인/도구 결과인 자식)는 `discardedUuids`에 포함하지 않는다 — 애초에 "재실행/수정 갈래"가 아니므로 곁가지로 취급하지 않는다
- `adoptedUuid`는 `childrenByParent.get(parentUuid)` 배열의 **마지막 원소**다 (`buildSegmentDetail`의 DFS가 실제로 따라가는 자식, [Design](../design/20260906-1400-segment-branch-view.tdd.md) "채택 경로는 새로 정의하지 않는다")
- `BranchPoint[]`의 순서는 정의하지 않는다 — 화면은 이 배열을 부모 위치(`lineNo`) 기준으로 다시 정렬해 쓴다

## 엣지 케이스 & 에러 처리

**판정**

- 자식이 2개고 하나는 진짜 사용자 메시지, 하나는 tool_result → `BranchPoint` 생성. tool_result 쪽은 애초에 DFS가 순회하는 대상(`collected`)에서 제외되지는 않는다 — 노드 자체는 그대로 트리에 남고, "분기 표시" 대상에서만 빠진다
- 부모 자식이 3개 이상이고 그중 2개만 진짜 사용자 메시지 → `discardedUuids`에는 그 2개 중 채택되지 않은 것만 들어간다. tool_result/sidechain 자식은 넣지 않는다
- `isSidechain`/`isToolResultShape` 판정 근거가 되는 필드가 레코드에 아예 없는 스키마(구버전 세션 파일) → 둘 다 `false`로 처리되어 "진짜 분기"로 간주된다. 과거 세션에서 이 필드가 없던 사례가 실측되지 않아, 있다고 가정하고 없으면 안전한 기본값(과다 표시 쪽)으로 둔다 — 조용히 숨기는 쪽보다 낫다(ADR-0004)

**화면**

- 곁가지가 있는 부모 노드 아래에 "곁가지 {discardedUuids.length}개(재실행/수정)"를 표시한다. 클릭 동작은 이번 범위에 없다(PRD Non-Goals) — 존재를 알리는 것까지다
- 곁가지 표시는 세그먼트를 펼쳤을 때만 계산·렌더한다. 조각 목록(펼치기 전)에는 표시하지 않는다 — 목록 단위 표시는 [조각 출처 백링크](20260906-2000-segment-origin-backlink.spec.md)의 범위이지 이 기능의 범위가 아니다
- `branches`가 빈 배열이면 아무것도 표시하지 않는다. 빈 상태를 알리는 문구를 넣지 않는다 — 대부분의 세그먼트는 분기가 없는 게 정상이라, 매번 "분기 없음"을 보여주면 노이즈다

## 성능 요구사항

- 인덱싱 시 필드 2개 추가 파싱은 이미 파싱된 객체에서 속성 접근만 하므로 측정 가능한 지연을 추가하지 않는다
- `resolveSegmentBranches`는 그 조각의 `childrenByParent` 크기에 비례한다 — 세그먼트 하나를 펼칠 때만 호출되므로 목록 화면(`/api/session/:id/index`) 응답 시간에는 영향이 없다

## Out of Scope

- **세그먼트 사이 출처** — [조각 출처 백링크](20260906-2000-segment-origin-backlink.spec.md)의 범위다
- 곁가지 내용을 펼쳐 보여주는 것 — 존재와 개수만 표시한다
- 도구 병렬 호출 분기의 별도 표시 — 완전히 숨긴다([Design](../design/20260906-1400-segment-branch-view.tdd.md) "향후 확장")
- 더 나은 "채택 경로" 판정 기준을 만드는 것 — 지금 DFS 순서를 그대로 채택 경로로 삼는다
- 구버전 스키마(`isSidechain`/`content` 형태가 다른 세션)에 대한 별도 마이그레이션 — 필드 부재 시 기본값(과다 표시)으로만 대응한다
