---
slug: 20260902-0411-verify-command
status: Current
related:
  prd: docs/prd/20260902-0411-verify-command.prd.md
updated: 2026-09-02
---

# Technical Design: `verify` 명령

## Context

> 📋 출처: [docs/prd/20260902-0411-verify-command.prd.md](../prd/20260902-0411-verify-command.prd.md)
>
> 목표: 대화를 실제로 재개하지 않고도, 특정 지점에서 거슬러 올라갔을 때 몇 개의 조각까지 연결되어 있는지 몇 초 안에 확인할 수 있게 한다. 이었던 결과가 지금도 유지되는지, 되돌린 결과가 정확히 복원됐는지 같은 계산으로 확인한다.

## 적용하는 기존 ADR

- [ADR-0001: TypeScript 단일 스택](../adr/ADR-0001-typescript-single-language.md) — `verify`가 계산하는 체인 길이는 `inspect`가 세그먼트를 나누는 것과 같은 그래프 순회다. `src/core`에 단 하나의 순회 함수만 두고, `inspect`·`reattach`·`revert`·`verify`가 모두 이를 재사용한다
- [ADR-0002: 연결과 회상은 다른 질문](../adr/ADR-0002-record-preserving-reattach.md) — `verify`가 보고하는 것은 구조적 사실(체인 길이)뿐이다. "정말 기억하는가"는 이 명령의 범위 밖이며, 출력 문구 자체가 이 구분을 명시해야 한다
- [ADR-0004: 시끄러운 실패, 같은 계산은 한 곳에서만](../adr/ADR-0004-schema-drift-defense.md) — `reattach`가 dry-run에서 예측한 "적용 후 체인 길이"와 `verify`가 실제로 측정한 체인 길이가 다른 구현으로 계산되면, 두 값이 갈리는 정책 불일치가 재현된다. 반드시 같은 함수를 호출한다

## 아키텍처 (How)

```
sessgraph verify <file> --uuid <uuid>
  → src/core: buildIndex()로 현재 상태 파악 (inspect·reattach와 동일 함수)
    → uuid가 속한 세그먼트를 조회 (Segment.leafUuid 또는 내부 노드 어디서 지정해도 같은 세그먼트로 귀결)
    → 그 세그먼트의 nodeCount, rootUuid, rootSubtype을 그대로 반환
  → src/cli: 결과를 사람이 읽는 형식으로 출력
```

`verify`는 `inspect`가 이미 계산한 `IndexResult.segments`에서 대상 uuid가 속한 항목 하나를 찾아 그대로 보여주는 것 이상을 하지 않는다. **새로운 그래프 순회 로직을 추가하지 않는다** — `IndexResult`가 이미 모든 세그먼트의 root/leaf/nodeCount를 갖고 있으므로, `verify`는 인덱스 전체를 다시 계산한 뒤 조회만 수행하는 얇은 명령이다.

`reattach`·`revert`가 "적용 후 예상 체인 길이"를 계산할 때도 이 조회 경로를 그대로 쓴다: 계획을 세울 때는 가상의 재연결을 반영한 `IndexResult`를 다시 빌드해 같은 조회 함수로 읽는다. 별도의 "체인 길이 계산 함수"를 새로 만들지 않는 이유가 여기 있다 — 존재하는 것은 `buildIndex()`와 그 결과에서 세그먼트를 찾는 조회뿐이다.

## 데이터 흐름

1. 사용자가 `sessgraph verify <file> --uuid <uuid>` 실행
2. `buildIndex()`로 전체 인덱스 구축 (`inspect`와 동일 비용 — 별도 캐시 없음, 매 실행이 파일을 다시 읽는다)
3. `--uuid`가 인덱스에 존재하는지 확인. 없으면 오류(종료 코드 2)
4. 인덱스의 `segments` 중 해당 uuid를 포함하는 세그먼트 하나를 찾는다 (한 uuid는 정확히 하나의 세그먼트에만 속한다 — 그래프가 트리이므로 노드는 정확히 하나의 root로 귀결됨)
5. 결과 출력: "이 지점은 root {rootUuid}({rootSubtype})까지 {nodeCount}개 노드로 연결되어 있습니다"
6. `rootSubtype === "compact_boundary"`면 추가 경고: "이 root는 컴팩트 경계입니다 — 아직 그 이전과 끊겨 있습니다" (아직 잇지 않은 상태임을 명시)
7. 항상 다음 문구를 덧붙인다: "연결 여부와 실제 회상 여부는 다릅니다. 재개해서 직접 확인하세요" (ADR-0002, `src/cli/CLAUDE.md` "보고 규칙")

에러 처리 경로: 파일 없음 → 종료 코드 2. `--uuid` 인덱스에 없음 → 종료 코드 2. `--uuid`가 그래프에 참여하지 않는 레코드(메타데이터성) → 종료 코드 2, "이 uuid는 연결 여부를 확인할 수 있는 대상이 아닙니다" (`reattach`가 재연결 대상에서 같은 유형을 배제하는 것과 동일 기준).

## 고려한 대안 & 기각 이유

**대안1: `verify`가 별도의 leaf→root 역추적 알고리즘을 직접 구현**

- 기각 이유: `inspect`가 이미 세그먼트 단위로 root/leaf/nodeCount를 계산해 `IndexResult`에 담아 두는데, 이를 무시하고 새 순회를 짜면 ADR-0004가 경고한 정책 불일치(같은 계산을 두 곳에서 따로 하면 답이 갈림)가 세 번째로 재현된다. `verify`는 계산이 아니라 **조회**로 구현한다

**대안2: 인덱스를 파일이나 메모리에 캐시해 반복 `verify` 호출을 빠르게 함**

- 기각 이유: PRD Non-Goals에는 없지만 범위를 넘는 최적화다. 세션 파일은 외부(Claude Code)가 언제든 다시 쓸 수 있으므로, 캐시가 있으면 "지금 이 순간의 상태"가 아니라 "마지막으로 인덱싱했을 때의 상태"를 보고할 위험이 생긴다. `inspect`의 실측 인덱싱 시간(2.14초, ADR-0001)이 이미 PRD 성공 기준("몇 초 안에")을 만족하므로 캐시 없이 매번 새로 읽는다

**대안3: `verify`가 uuid 없이 파일 전체의 요약(orphan 수 등)을 보여줌**

- 기각 이유: 그건 `inspect`의 책임이다. PRD가 요구하는 것은 "특정 지점을 지정했을 때"의 연결 길이이지 전체 요약이 아니다. 두 명령의 책임을 겹치게 만들면 사용자가 어느 명령을 써야 할지 헷갈리고, 출력 형식을 두 곳에서 유지해야 한다

**대안4: `--uuid` 대신 세그먼트 인덱스(번호)로 지정**

- 기각 이유: `inspect --json` 출력의 세그먼트 순서는 인덱싱마다 안정적이라는 보장이 없다(중복 정책이나 파일 변경에 따라 달라질 수 있음). uuid는 레코드 고유 식별자이므로 `reattach --uuid`와 동일한 인자 규약을 유지하는 편이 일관적이다

## 향후 확장 고려사항

- `reattach`는 dry-run에서 "적용 후 예상 체인 길이"를 계산해야 한다 — 이는 가상의 재연결을 반영한 인덱스를 만들어 `verify`와 동일한 조회 경로로 읽는 방식으로 구현한다. `reattach` 구현 시 이 조회 함수를 `src/core`의 export로 노출해 재사용한다
- `revert`는 복원 후 `verify`와 동일한 방식으로 체인 길이를 재계산해 `RevertPlan.expectedChainLength`와 비교한다([revert Spec](20260902-0411-revert-command.spec.md#엣지-케이스--에러-처리) 참고) — 같은 조회 함수를 그대로 호출한다
- `serve`(웹 뷰어)가 특정 노드를 클릭했을 때 "여기서부터 몇 개 연결"을 보여주려면 이 명령과 같은 조회를 재사용할 수 있다. 다만 `serve`는 별도 Design에서 다룬다
