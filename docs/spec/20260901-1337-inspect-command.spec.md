---
slug: 20260901-1337-inspect-command
status: Current
related:
  prd: docs/prd/20260901-1337-inspect-command.prd.md
  design: docs/design/20260901-1337-inspect-command.tdd.md
updated: 2026-09-01
---

# Spec: `inspect` 명령

## Interface

```
sessgraph inspect <file> [--json] [--duplicate-policy=<policy>]
```

- `<file>`: 필수. 세션 JSONL 파일 경로
- `--json`: 선택. 사람이 읽는 표 대신 기계가 읽는 JSON을 stdout에 출력
- `--duplicate-policy`: 선택. `first-wins | last-wins | prefer-parent` 중 하나. 미지정 시 기본값은 `prefer-parent`다 — orphan을 과소보고하지 않는 정책이 가장 안전하다 (근거: [ADR-0004](../adr/ADR-0004-schema-drift-defense.md) 실측표, `last-wins`는 끊긴 노드가 있어도 `orphans: 0`을 보고했다)

종료 코드:

- `0`: 정상 실행 (orphan이 있어도 0 — orphan 발견은 도구 오류가 아니다)
- `1`: 예약 (현재 `inspect`는 사용하지 않음. 향후 `--fail-on-orphan` 같은 플래그가 추가되면 사용)
- `2`: 도구 오류 — 파일 없음, 또는 아래 "엣지 케이스" 불변식 위반

## 데이터 모델

핵심 타입은 `src/core/types.ts`에 정의된 것을 그대로 쓴다: `SessionRecord`, `NodeIndex`, `DuplicatePolicy`, `UnresolvedDuplicate`. 이 문서는 재기술하지 않고 아래 신규 타입만 추가로 정의한다 (구현 시 `src/core/types.ts`에 추가):

```ts
interface Segment {
  readonly rootUuid: string;
  readonly leafUuid: string;
  readonly nodeCount: number;
  readonly startTimestamp: string | null;
  readonly endTimestamp: string | null;
  /** root 레코드의 subtype. compact_boundary가 아니면 세션의 진짜 시작점. */
  readonly rootSubtype: string | null;
}

interface OrphanNode {
  readonly uuid: string;
  readonly missingParentUuid: string;
  readonly lineNo: number;
  readonly type: string;
}

interface IndexResult {
  readonly totalLines: number;
  readonly recordsWithUuid: number;
  readonly nodeCount: number;
  readonly segments: readonly Segment[];
  readonly orphans: readonly OrphanNode[];
  readonly unresolvedDuplicates: readonly UnresolvedDuplicate[];
  readonly malformedLines: readonly number[];
  readonly durationMs: number;
}
```

`inspect`는 `IndexResult`를 받아 그대로 리포트로 옮긴다. 판정 로직을 CLI 쪽에서 새로 계산하지 않는다.

## 엣지 케이스 & 에러 처리

- 파일이 없음 → 종료 코드 2, "파일을 찾을 수 없습니다: {경로}"
- 파일은 있으나 빈 파일(0바이트) → 정상 종료(0), `nodeCount: 0`, 세그먼트·orphan 모두 빈 배열
- uuid를 가진 레코드가 있는데 parentUuid를 가진 레코드가 하나도 없음 → **불변식 위반**, 종료 코드 2, "parentUuid 필드가 전혀 없습니다 — 스키마 변경 의심" (ADR-0004 근거)
- 특정 줄이 올바른 JSON이 아님 → 해당 줄은 건너뛰고 `malformedLines`에 줄 번호 기록. 전체 처리는 중단하지 않음. 최종 리포트에 "N개 줄을 읽지 못함" 명시 (조용히 무시하지 않음)
- 같은 uuid가 여러 번 출현하고 그중 일부만 `parentUuid`가 다름 → `--duplicate-policy`로 지정한 정책에 따라 하나를 채택하되, 채택되지 않은 나머지는 `unresolvedDuplicates`에 포함해 리포트에 노출한다. 정책이 하나를 명확히 고를 수 없는 경우(예: 서로 다른 두 개의 유효한 `parentUuid`가 동시에 나타나고 어느 쪽도 "부모 있음/없음"으로 우열이 없는 경우)는 임의로 고르지 않고 `unresolvedDuplicates`로만 보고한다
- 세션 전체가 하나의 세그먼트로만 이루어짐(끊긴 지점 없음) → 정상 종료, `segments.length === 1`, `orphans: []`
- `compact_boundary`가 아닌데 `parentUuid: null`인 root (즉 진짜 세션 시작점) → orphan이 아니라 정상 root로 분류. `Segment.rootSubtype`으로 구분 가능하게 한다

## 성능 요구사항

실측 기준선 (829MB, 86,668줄, distinct 노드 10,726개 세션 파일):

- 인덱스 구축: 2.5초 이내 (TypeScript/Node 실측 2.14초 + 여유)
- 메모리: 200MB 이내 (본문을 인덱스에 포함하지 않는 설계 — Design 문서 "아키텍처" 참고)
- 이 기준선보다 10배 큰 파일(약 8GB)에서도 선형에 가깝게 스케일해야 한다. 초선형으로 느려지면(예: O(n²) 부모 탐색) 회귀로 간주한다

## Out of Scope

- 끊긴 지점을 실제로 잇는 기능 (`reattach` 명령 — 별도 Spec)
- 세션을 웹에서 시각화하는 기능 (`serve` 명령 — 별도 Spec)
- 재개 후 실질 회상 여부 검증 — 이는 사람이 직접 해야 함 (ADR-0002, `src/cli/CLAUDE.md` "보고 규칙" 참고). `inspect`는 구조적 사실만 보고한다
