---
slug: 20260906-2000-segment-origin-backlink
status: Current
related:
  prd: docs/prd/20260906-2000-segment-origin-backlink.prd.md
updated: 2026-09-06
---

# Technical Design: 조각 출처 백링크

## Context

> 📋 출처: [docs/prd/20260906-2000-segment-origin-backlink.prd.md](../prd/20260906-2000-segment-origin-backlink.prd.md)
>
> 목표: 조각을 펼치지 않고도 각 조각이 어느 조각의 어느 지점에서 이어져 오는지, 그 값이 기록된 것인지 추정된 것인지를 목록에서 바로 알 수 있게 한다.

## 적용하는 기존 ADR

- [ADR-0001: TypeScript 단일 스택](../adr/ADR-0001-typescript-single-language.md) — 이을 지점을 고르는 규칙은 이미 `src/core/`에 있다. 목록 화면을 위해 그 규칙을 `src/web/`에 다시 구현하지 않는다
- [ADR-0003: 웹 읽기 전용, CLI 단독 쓰기](../adr/ADR-0003-cli-writes-web-reads.md) — 백링크는 조회·이동만 한다. 클릭해서 재연결이 실행되지 않는다
- [ADR-0004: 시끄러운 실패](../adr/ADR-0004-schema-drift-defense.md) — 이을 곳을 찾지 못했거나 찾은 uuid가 파일에 없으면 그 항목을 목록에서 빼지 않고 그대로 표시한다. 조용히 빠지면 사용자가 그 조각의 출처가 불명이라는 사실 자체를 모른다
- [ADR-0005: 기록된 논리적 부모 > 직전 leaf 추정](../adr/ADR-0005-logical-parent-over-leaf-heuristic.md) — `recorded`/`inferred` 구분이 이 기능의 핵심 표시 대상이다. 이 구분을 목록으로 끌어올리는 것이 PRD가 말한 "확인이 필요한 자리를 펼치기 전에 고른다"의 실체다

## 아키텍처 (How)

배치는 바꾸지 않는다. 세로 타임라인 고정 배치를 그대로 두고, 각 조각 헤드에 **출처를 가리키는 역방향 링크 한 줄**을 얹는다.

```
GET /api/session/:id/index
  → { index: IndexResult, origins: SegmentOrigin[] }   ← 응답 형태 변경
                                   ▲
                                   └ src/core/segment-origin.ts
                                       resolveSegmentOrigins(index, nodes)

src/web: 조각 목록 렌더 시 조각마다 백링크 한 줄
  → 클릭 → 대상 조각으로 스크롤 + 펼침 (기존 expandSegment 재사용)
```

### 이을 지점 계산은 한 곳에만 둔다

지금 `recorded ?? 직전 조각의 leaf` 규칙은 `buildSegmentDetail`(`src/core/serve.ts:69-83`) 안에 있고, **조각을 하나 열 때만** 실행된다. 목록 화면이 같은 값을 필요로 하므로 선택지는 둘이다:

1. 프런트엔드가 `IndexResult`로 직접 계산한다 — `Segment`에 `rootLogicalParentUuid`와 `leafUuid`가 이미 있어 기술적으로는 가능하다
2. 코어가 계산해 응답에 담는다

**2를 택한다.** 1은 같은 판정이 두 벌이 되는 경로이고, 정책이 갈리는 순간 펼친 화면과 목록 화면이 서로 다른 부모를 가리키게 된다 — ADR-0004가 실측으로 확인한 실패 유형 그대로다. 화면 두 곳이 **같은 사실을 다르게 말하는** 것은 이 도구에서 가장 비싼 종류의 버그다.

따라서 규칙을 `src/core/segment-origin.ts`의 순수 함수로 추출하고, `buildSegmentDetail`이 그 함수를 호출하도록 바꾼다. 구현이 하나뿐이므로 두 화면이 갈릴 자리가 없다.

### `Segment`에 필드를 더하지 않는다

`Segment`는 **한 조각에 대해 파일에서 직접 읽은 사실**만 담는다(`rootUuid`, `leafUuid`, `rootLogicalParentUuid` 등). 출처는 그와 성격이 다르다 — `inferred` 경로는 **직전 조각**을 봐야 정해지는 값이라 조각 하나만으로는 결정되지 않고, 조각 목록의 순서에 의존한다.

이 값을 `Segment`에 넣으면 `inspect`·`verify`가 소비하는 인덱스 타입이 `serve` 화면 사정으로 넓어진다. 파생값은 별도 배열로 분리하고, `IndexResult`는 건드리지 않는다.

### 응답 형태 변경 (인터페이스 변경 게이트)

`/api/session/:id/index`는 지금 `IndexResult`를 그대로 돌려준다(`src/cli/serve.ts:345`). 이를 `{ index, origins }` 봉투로 바꾼다. 루트 CLAUDE.md "인터페이스 변경 게이트" 절차에 따라 `src/core/`를 먼저 고치고, `src/cli/`와 `src/web/`을 같은 PR에서 함께 고친다.

구버전 호환은 고려하지 않는다 — 정적 자산과 서버가 같은 빌드에서 함께 나가므로 둘이 어긋난 조합이 성립하지 않는다. `/api/index` → `/api/session/:id/index` 변경 때와 같은 판단이다([다중 세션 Design](20260905-0641-multi-session-serve.tdd.md)).

## 데이터 흐름

1. 브라우저가 `/api/session/:id/index` 요청
2. 서버가 상주 인덱스로 `resolveSegmentOrigins(index, nodes)` 호출 — 조각 수만큼의 순수 계산
3. 응답을 조각 목록 렌더에 사용. 조각마다 헤드 아래에 한 줄:
   - `recorded` → "이전: {대상 조각 표시} · 기록됨"
   - `inferred` → 같은 형태에 추정 표시(`.inferred` 스타일 재사용, 붉은색)
   - `none` → "이어질 곳 없음 — 기록의 시작"
   - `missing` → "기록된 이전 지점을 파일에서 찾지 못함" (이동 불가)
4. 클릭 → 대상 uuid가 속한 조각을 펼치고 그 위치로 스크롤. 조각 판정은 [`tryFindSegmentForUuid`](../spec/20260906-0900-body-search.spec.md)(본문 검색에서 도입한 비throw 변형)를 그대로 쓴다
5. 대상이 어떤 조각에도 속하지 않으면(orphan 하위) 링크를 **표시하되 클릭 불가**로 둔다 — 검색 결과의 `unindexed` 매치와 같은 처리다

에러 처리 경로: `origins` 계산은 파일을 읽지 않고 이미 만들어진 인덱스만 보므로 I/O 실패 경로가 없다. 인덱싱 자체가 실패한 세션은 기존대로 목록에서 `failed`로 남는다.

## 고려한 대안 & 기각 이유

**대안1: 프런트엔드가 `IndexResult`에서 직접 백링크를 계산**

- 기각 이유: 위 "이을 지점 계산은 한 곳에만" 참고. 서버 변경 없이 당장 만들 수 있다는 것이 유일한 장점이고, 대가로 같은 판정이 두 벌이 된다. 펼친 화면과 목록이 다른 부모를 가리키는 순간 사용자는 어느 쪽을 믿어야 할지 알 수 없다

**대안2: `Segment` 타입에 출처 필드를 추가**

- 기각 이유: 위 "`Segment`에 필드를 더하지 않는다" 참고. 조각 하나로 결정되지 않는 파생값을 조각의 사실 옆에 두면, `inspect`가 쓰는 타입이 화면 요구에 끌려다닌다

**대안3: 백링크 전용 엔드포인트(`/api/session/:id/origins`)를 새로 추가**

- 기각 이유: 목록을 그릴 때 **항상 함께** 필요한 값이라 분리해서 얻는 이득이 없고, 화면 하나에 왕복이 하나 늘어난다. 두 응답 사이에 파일이 바뀌면 인덱스와 출처가 어긋난 조합을 화면이 합성할 수 있다는 문제도 생긴다

**대안4: 조각을 부모 아래로 들여쓰기(트리 배치)**

- 기각 이유: 실제 기록은 대부분 한 줄로 이어지는 사슬이라 들여쓰기 깊이가 조각 수만큼 계속 깊어져, 조각이 수십 개면 화면 오른쪽 끝으로 밀려난다. 또한 들여쓰기는 시간 순서와 경쟁하는 두 번째 배치 축을 도입한다 — 시간 순서를 배치의 유일한 축으로 두는 것이 이 화면의 기존 결정이다([serve Design](20260902-0420-serve-command.tdd.md) 대안4)

**대안5: 자유 배치 그림(force-directed)으로 구조 전체를 그린다**

- 기각 이유: [serve Design](20260902-0420-serve-command.tdd.md) 대안4에서 이미 기각했다. 여기서 다시 확인해 둘 것은, **그 기각 사유가 "출처를 보여주는 것" 자체가 아니라 "배치 방식"이었다**는 점이다. 배치를 고정한 채 링크만 겹쳐 그리는 본 설계는 그 기각 사유에 저촉되지 않는다. 같은 접근(고정 배치 + 분기 지점 백링크)을 택한 선행 도구가 실재하며 실제 산출물에서 동작을 확인했다(`claude-code-log`, 관측)

## 향후 확장 고려사항

- **팬아웃(한 지점에서 갈라져 나간 여러 조각)** — 반대 방향 조회에는 uuid → 그 uuid를 가리키는 조각들의 역방향 색인이 필요하다. 이번 설계는 부모 방향 단방향만 계산하므로 그 색인을 만들지 않는다. PRD Non-Goals
- **세션을 넘는 출처** — 현재 계산은 같은 파일 안만 본다. 다른 파일에서 이어져 온 경우가 실제로 있는지는 **확인하지 않았다.** `resolveSegmentOrigins`가 단일 인덱스만 받는 형태이므로, 필요해지면 시그니처를 넓히는 것이 아니라 세션 간 조회를 담당하는 별도 계층을 두는 편이 낫다
- **대소문자·표시 형식** — 대상 조각을 어떻게 부를지(시작 시각, 조각 번호, uuid 앞자리)는 Spec에서 정한다. 여기서는 "무엇을 가리키는가"만 정한다
