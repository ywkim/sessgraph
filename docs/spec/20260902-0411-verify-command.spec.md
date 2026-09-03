---
slug: 20260902-0411-verify-command
status: Current
related:
  prd: docs/prd/20260902-0411-verify-command.prd.md
  design: docs/design/20260902-0411-verify-command.tdd.md
updated: 2026-09-03
---

# Spec: `verify` 명령

## Interface

```
sessgraph verify <file> --uuid <uuid> [--json]
```

- `<file>`: 필수. 세션 JSONL 파일 경로
- `--uuid`: 필수. 연결 상태를 확인할 대상 레코드의 uuid (세그먼트 내 어떤 노드를 지정해도 같은 세그먼트로 귀결)
- `--json`: 선택. 사람이 읽는 문장 대신 기계가 읽는 JSON을 stdout에 출력

종료 코드:

- `0`: 정상 실행 (대상이 아직 끊긴 상태여도 0 — 끊김 자체는 도구 오류가 아니다)
- `2`: 도구 오류 — 파일 없음, `--uuid` 인덱스에 없음, `--uuid`가 그래프에 참여하지 않는 레코드

## 데이터 모델

핵심 타입은 [`inspect` 명령 Spec](20260901-1337-inspect-command.spec.md#데이터-모델)의 `IndexResult`, `Segment`를 그대로 쓴다. 이 문서는 재기술하지 않는다.

이 문서에서 추가로 정의하는 타입 (구현 시 `src/core/types.ts`에 추가):

```ts
interface VerifyResult {
  readonly targetUuid: string;
  readonly segment: Segment;
  /** segment.rootSubtype === "compact_boundary"일 때 true — 아직 그 이전과 끊긴 상태 */
  readonly stillDisconnectedAtRoot: boolean;
}
```

`findSegmentForUuid(index: IndexResult, uuid: string): Segment`는 `src/core`에 둔다. 이 함수는 새 순회를 하지 않고 `index.segments`를 조회만 한다 (Design "아키텍처" 참고). `reattach`가 dry-run에서 "적용 후 예상 체인 길이"를 계산할 때, `revert`가 복원 후 상태를 검증할 때 모두 이 함수를 재사용한다.

## 엣지 케이스 & 에러 처리

- 파일이 없음 → 종료 코드 2, "파일을 찾을 수 없습니다: {경로}"
- `--uuid`가 인덱스에 없음 → 종료 코드 2, "해당 uuid를 찾을 수 없습니다"
- `--uuid`가 가리키는 레코드가 uuid는 있지만 그래프에 참여하지 않는 유형(메타데이터성 레코드, `reattach` Spec의 동일 케이스와 같은 기준) → 종료 코드 2, "이 레코드는 연결 여부를 확인할 수 있는 대상이 아닙니다"
- `--uuid`가 정책으로 해소되지 않은 중복(`unresolvedDuplicates`)에 포함됨 → 종료 코드 2, "이 레코드는 여러 번 출현하며 어느 것이 최신 상태인지 도구가 판단할 수 없습니다. 먼저 `inspect --json`으로 확인하세요" (`reattach` Spec과 동일 원칙, ADR-0004)
- `--uuid`가 속한 세그먼트의 root가 `compact_boundary`인 경우 → 정상 종료(0), `stillDisconnectedAtRoot: true`와 함께 "아직 이전 조각과 끊겨 있습니다" 안내. 실패가 아니라 사실 보고다
- `--uuid`가 속한 세그먼트의 root가 진짜 세션 시작점(컴팩트 경계가 아님)인 경우 → 정상 종료(0), `stillDisconnectedAtRoot: false`, "세션 시작점까지 연결되어 있습니다"
- 매 실행마다 파일을 새로 인덱싱하므로, 실행 사이에 파일이 외부에서 변경됐어도 항상 최신 상태를 반영한다 (캐시 없음 — Design "고려한 대안" 대안2)

## 성능 요구사항

- 인덱스 구축 비용은 `inspect`와 동일 기준선을 따른다: 2.5초 이내 (829MB, 86,668줄 세션, [20260901-1337-inspect-command.spec.md](20260901-1337-inspect-command.spec.md#성능-요구사항))
- 세그먼트 조회 자체(`findSegmentForUuid`)는 이미 구축된 `segments` 배열을 순회하는 것이므로 세그먼트 수(실측 세션에서 39개)에 비례 — 무시할 수 있는 수준
- `reattach`/`revert`가 dry-run 계획 계산에 이 함수를 재사용할 때도 추가 인덱싱 없이(이미 메모리에 있는 `IndexResult` 재사용) 호출해야 한다 — 매 호출마다 파일을 다시 읽지 않는다

## Out of Scope

- 재개 후 실질 회상 여부의 자동 검증 (PRD Non-Goals, ADR-0002) — `verify`는 구조적 사실만 보고한다
- 여러 기록을 한 번에 비교하는 기능 (PRD Non-Goals)
- 연결 상태를 자동으로 고치는 기능 (PRD Non-Goals — `reattach`의 역할)
- `--uuid` 생략 시 파일 전체 요약을 보여주는 기능 (Design "고려한 대안" 대안3 — `inspect`의 역할)
- 여러 파일에 걸친 연결 상태 확인 — `inspect` Spec Out of Scope와 동일 이유로 단일 파일 대상만 다룬다
