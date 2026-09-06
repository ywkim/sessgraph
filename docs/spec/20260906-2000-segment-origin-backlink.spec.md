---
slug: 20260906-2000-segment-origin-backlink
status: Current
related:
  prd: docs/prd/20260906-2000-segment-origin-backlink.prd.md
  design: docs/design/20260906-2000-segment-origin-backlink.tdd.md
updated: 2026-09-06
---

# Spec: 조각 출처 백링크

## Interface

### 코어 함수

`src/core/segment-origin.ts`에 둔다. 파일을 읽지 않고 이미 만들어진 인덱스만 보는 순수 함수다.

```ts
/** 조각마다 "어디서 이어져 오는가"를 해소한다. index.segments와 같은 길이·같은 순서. */
export function resolveSegmentOrigins(
  index: IndexResult,
  nodes: ReadonlyMap<string, NodeIndex>,
): readonly SegmentOrigin[];
```

`buildSegmentDetail`(`src/core/serve.ts`)은 `recorded ?? 직전 leaf` 규칙을 자체적으로 계산하지 않고 **이 함수의 결과를 소비하도록 바꾼다.** 구현이 둘로 갈리면 목록과 펼친 화면이 서로 다른 부모를 가리킨다 ([Design](../design/20260906-2000-segment-origin-backlink.tdd.md) 대안1).

### HTTP 엔드포인트

`/api/session/:id/index`의 응답 형태를 바꾼다. 경로·메서드 규약은 [`serve` Spec](20260902-0420-serve-command.spec.md#http-엔드포인트) 그대로다.

| 경로                     | 이전 응답     | 새 응답            |
| ------------------------ | ------------- | ------------------ |
| `/api/session/:id/index` | `IndexResult` | `SessionIndexView` |

새 엔드포인트를 추가하지 않는다 ([Design](../design/20260906-2000-segment-origin-backlink.tdd.md) 대안3).

## 데이터 모델

`IndexResult`, `Segment`, `NodeIndex`, `SegmentDetail`은 [`src/core/types.ts`](../../src/core/types.ts)를 그대로 쓴다. **`Segment`에는 필드를 추가하지 않는다.** 아래 타입을 그 파일에 추가한다.

```ts
/**
 * 한 조각이 어디서 이어져 오는가.
 *
 * `missing`이 이 타입의 존재 이유다 — 기록된 값이 파일 안에 없는 상태를
 * `inferred`로 조용히 대체하면, 스키마가 바뀐 사실이 추정값으로 위장된다
 * (ADR-0004, 루트 CLAUDE.md "외부 스키마 의존").
 */
export type SegmentOrigin =
  /** 조각의 root가 컴팩트 경계가 아니다 — 기록의 진짜 시작점이라 이을 대상이 아니다 */
  | { readonly kind: "start" }
  /** 경계 레코드에 기록된 부모가 있고, 그 uuid가 파일 안에 있다 */
  | {
      readonly kind: "recorded";
      readonly parentUuid: string;
      /** 그 uuid가 속한 조각의 root. 어떤 조각에도 속하지 않으면 null */
      readonly parentSegmentRootUuid: string | null;
    }
  /** 기록된 부모가 없어 직전 조각의 마지막 항목으로 추정했다 (ADR-0005) */
  | {
      readonly kind: "inferred";
      readonly parentUuid: string;
      readonly parentSegmentRootUuid: string | null;
    }
  /** 기록된 부모가 있으나 그 uuid가 파일에 없다 */
  | { readonly kind: "missing"; readonly parentUuid: string }
  /** 경계인데 기록된 부모도 없고 직전 조각도 없다 — 채울 값이 없다 */
  | { readonly kind: "unresolved" };

/** `/api/session/:id/index`의 응답. origins는 index.segments와 같은 길이·같은 순서다. */
export interface SessionIndexView {
  readonly index: IndexResult;
  readonly origins: readonly SegmentOrigin[];
}
```

### 불변식

- `origins.length === index.segments.length`이고 **같은 순서**다. 같은 첨자가 같은 조각을 가리킨다
- `kind === "start"` ⟺ `segments[i].rootSubtype !== "compact_boundary"`
- `kind === "recorded"` ⟺ `rootLogicalParentUuid !== null` **그리고** 그 uuid가 `nodes`에 있다
- `kind === "missing"` ⟺ `rootLogicalParentUuid !== null` **그리고** 그 uuid가 `nodes`에 없다
- `kind === "inferred"` ⟹ `parentUuid === segments[i - 1].leafUuid`. leaf는 인덱스가 만든 값이므로 항상 `nodes`에 있다 — `inferred`에서 `missing`은 성립하지 않는다
- `kind === "unresolved"` ⟹ `i === 0` (직전 조각이 없는 첫 조각)
- `parentSegmentRootUuid`는 [`tryFindSegmentForUuid`](20260906-0900-body-search.spec.md)의 결과다. 어떤 조각에도 닿지 않으면(orphan 하위) `null`

### `SegmentDetail`의 기존 동작 변경

`buildSegmentDetail`이 같은 함수를 쓰게 되면서 **한 가지 동작이 바뀐다.**

| `SegmentOrigin.kind` | `suggestedParentSource` | `suggestedReattachCommand` |
| -------------------- | ----------------------- | -------------------------- |
| `start`              | `null`                  | `null` (변경 없음)         |
| `recorded`           | `"recorded"`            | 생성 (변경 없음)           |
| `inferred`           | `"inferred"`            | 생성 (변경 없음)           |
| `unresolved`         | `null`                  | `null` (변경 없음)         |
| `missing`            | `null`                  | **`null` — 변경됨**        |

이전 구현은 기록된 uuid가 파일에 있는지 확인하지 않고 그대로 `--parent`에 넣어 `recorded`로 표시했다(`src/core/serve.ts`). 존재하지 않는 지점을 "기록된 부모"라고 단정해 복사시키는 것은 이 리포의 정확성 원칙에 어긋난다.

이 경로는 **관측된 적이 없다** — ADR-0005가 실측한 두 파일에서 `logicalParentUuid`는 항상 파일 안의 실존 uuid를 가리켰다. 즉 이 변경은 관측된 회귀를 고치는 것이 아니라, 읽는 필드가 사라지거나 의미가 바뀌었을 때의 동작을 정의하는 것이다(루트 CLAUDE.md "외부 스키마 의존").

## 엣지 케이스 & 에러 처리

**해소**

- 첫 조각이 컴팩트 경계이고 기록된 부모가 있음 → `recorded`. 직전 조각이 없다는 것은 `inferred`에만 걸리는 제약이다
- 첫 조각이 컴팩트 경계이고 기록된 부모가 없음 → `unresolved`
- 기록된 부모가 자기 자신 또는 뒤쪽 조각을 가리킴 → 그대로 해소해 표시한다. 시간을 거스르는 참조인지 판정하지 않는다 — ADR-0005가 관측한 대로 같은 값이 반복 등장하며 갈수록 먼 과거를 가리키는 것이 정상 범위이고, 어디까지가 비정상인지 기준이 없다. 없는 기준으로 경고를 만들지 않는다
- 여러 조각이 **같은** `parentUuid`를 가리킴 → 각각 독립적으로 해소한다. 중복을 오류로 보지 않는다 (ADR-0005 관측)
- 대상 uuid가 `nodes`에는 있으나 어떤 조각에도 속하지 않음(orphan 하위) → `parentSegmentRootUuid: null`. 항목을 버리지 않는다
- 조각이 0개 → `origins`는 빈 배열

**화면**

- `recorded` → 기본 색으로 "이전: {대상 표시}" + 기록됨 표시
- `inferred` → 기존 `.inferred` 스타일(붉은색, `src/web/app.css`)을 재사용해 확인이 필요한 값임을 드러낸다. **목록에서 이 구분이 보이는 것이 이 기능의 핵심 성공 기준이다** (PRD)
- `missing` → "기록된 이전 지점을 파일에서 찾지 못함"을 표시하고 **이동 불가**로 둔다. 목록에서 빼지 않는다
- `unresolved` → "이어질 곳을 찾지 못함"을 표시한다. 빈 줄로 두지 않는다 — 빈 줄은 "출처 없음"과 "아직 안 그림"을 구분하지 못한다
- `start` → "기록의 시작"으로 표시한다. 이 줄을 생략하지 않는다. 생략하면 사용자가 "이 조각만 백링크를 못 그렸나"와 구분할 수 없다
- `parentSegmentRootUuid === null` → 링크를 표시하되 클릭 불가. 검색 결과의 `unindexed` 매치와 같은 처리다 (`.search-match.unindexed`)

**대상 표시 형식**

대상 조각을 부르는 이름은 `{조각 시작 시각} · {parentUuid 앞 8자}`로 한다. 시각만으로는 같은 시각의 조각을 구분하지 못하고, uuid만으로는 사람이 위치를 가늠하지 못한다. 시각이 `null`인 조각은 uuid만 표시한다.

**이동**

- 같은 세션 안이므로 재조회하지 않는다. 기존 `expandSegment(rootUuid)`(`src/web/app.ts`)를 그대로 호출해 대상 조각을 펼치고 스크롤한다
- 대상 조각이 이미 펼쳐져 있으면 접지 않는다 — `expandSegment`의 기존 동작(`aria-expanded`가 `true`가 아닐 때만 클릭)을 그대로 따른다
- 대상 **항목**(parentUuid) 위치까지 스크롤하는 것은 이번 범위가 아니다. 조각을 펼치는 데까지만 이동한다

**응답**

- 인덱싱 실패 세션 → 기존대로 목록에서 `failed`. 이 엔드포인트에 도달하지 않는다
- 파일이 바뀜 → 기존 `ensureFresh`가 재인덱싱하고, `origins`는 새 인덱스로 다시 계산된다. 별도 처리를 두지 않는다

## 성능 요구사항

- `resolveSegmentOrigins`는 조각마다 `tryFindSegmentForUuid`를 한 번 호출한다. 각 호출은 부모 체인을 거슬러 오르므로 상한은 `조각 수 × 체인 최대 길이`다. 실측 기준선(조각 39개, 항목 10,726개)에서 상한 약 40만 스텝이며, 이 규모에서는 전용 역방향 색인을 만들지 않는다 — 색인을 두면 인덱스 구축 비용과 상주 메모리가 늘고, 그만한 이득이 있는지 **측정하지 않았다**
- `/api/session/:id/index` 응답 시간 증가분 목표: **50ms 이내** (측정값이 아닌 목표치. 구현 후 실측해 이 값을 갱신한다)
- 응답 크기 증가분은 조각 수에 비례한다. 항목 수와 무관하다
- `serve` 전체 메모리 기준선(300MB, [`serve` Spec](20260902-0420-serve-command.spec.md#성능-요구사항)) 안에서 소화되어야 한다

## Out of Scope

- **팬아웃(한 지점에서 갈라져 나간 조각들)** — 반대 방향 색인이 필요하다 (PRD Non-Goals, [Design](../design/20260906-2000-segment-origin-backlink.tdd.md) "향후 확장")
- **세션을 넘는 출처** — `resolveSegmentOrigins`는 단일 인덱스만 본다. 다른 파일로 이어지는 경우가 실재하는지 확인하지 않았다
- 대상 항목(parentUuid) 위치까지의 정밀 스크롤 — 조각을 펼치는 데까지만 한다
- 시간을 거스르는 참조에 대한 경고 — 판정 기준이 없다 (위 "엣지 케이스")
- 추정 규칙 자체의 개선 — 이번 범위는 이미 계산된 값을 드러내는 것이다 (PRD Non-Goals)
- 배치 변경(들여쓰기·자유 배치) — [Design](../design/20260906-2000-segment-origin-backlink.tdd.md) 대안4·5
- `inspect`/`verify` 출력에 출처를 추가하는 것 — PRD의 요구는 모두 화면 위에서 성립한다. 코어 함수를 `src/core/`에 두므로 나중에 추가할 때 규칙을 다시 만들 필요는 없다
