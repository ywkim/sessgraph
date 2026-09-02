---
slug: 20260902-0411-revert-command
status: Current
related:
  prd: docs/prd/20260902-0411-revert-command.prd.md
  design: docs/design/20260902-0411-revert-command.tdd.md
updated: 2026-09-02
---

# Spec: `revert` 명령

## Interface

```
sessgraph revert <file> [--last | --to <ISO8601 timestamp>] [--commit]
```

- `<file>`: 필수. 세션 JSONL 파일 경로
- `--last`: 선택. 가장 최근 수술 1건만 되돌린다. `--to`와 동시 지정 불가. 둘 다 생략 시 기본값
- `--to <timestamp>`: 선택. 이 시각(포함) 이후에 발생한 모든 수술을 되돌린다
- `--commit`: 선택. 없으면 dry-run — 계획만 출력하고 파일·백업·로그 어느 것도 생성하지 않는다

종료 코드:

- `0`: 정상 실행 (dry-run 출력 또는 `--commit` 적용 모두 성공 시)
- `2`: 도구 오류 — 파일 없음, 수술 로그 없음, 대상 시점 이후 이력 없음, 백업 파일 소실, `--last`와 `--to` 동시 지정, 쓰기 실패

## 데이터 모델

핵심 타입은 [`inspect` 명령 Spec](20260901-1337-inspect-command.spec.md#데이터-모델)의 `IndexResult`, [`reattach` 명령 Spec](20260901-2309-reattach-command.spec.md#데이터-모델)의 `ReattachResult`를 재사용한다.

이 문서에서 추가로 정의하는 타입 (구현 시 `src/core/types.ts`에 추가):

```ts
/** {file}.surgery.log 한 줄을 파싱한 결과. reattach·revert가 공통으로 남기는 항목. */
interface SurgeryLogEntry {
  readonly timestamp: string;
  readonly kind: "reattach" | "revert";
  /** kind === "reattach"일 때만 존재 */
  readonly targetUuid?: string;
  readonly previousParent?: string | null;
  readonly newParent?: string;
  /** kind === "revert"일 때만 존재 — 되돌린 대상 항목들의 timestamp 목록 */
  readonly revertedEntries?: readonly string[];
  readonly reason: string;
  readonly backupPath: string;
}

interface RevertPlan {
  /** 되돌릴 대상 수술 항목 (시간 역순이 아니라 원본 순서로 보관) */
  readonly targetEntries: readonly SurgeryLogEntry[];
  /** 복원할 백업 파일 — targetEntries 중 가장 이른 시점의 backupPath */
  readonly restoreFromBackup: string;
  /** 복원 후 예상 상태 (verify와 동일한 계산 경로 재사용) */
  readonly expectedChainLength: number;
}

interface RevertResult {
  readonly plan: RevertPlan;
  readonly committed: boolean;
  /** committed === true일 때만 존재. 되돌리기 직전 상태의 자기 백업 */
  readonly preRevertBackupPath?: string;
  readonly surgeryLogPath?: string;
}
```

`buildRevertPlan(surgeryLog: readonly SurgeryLogEntry[], mode: "last" | { to: string }): RevertPlan`은 `src/core`에 둔다 — 파일을 쓰지 않는 순수 계산이다. 수술 로그 파일을 읽어 `SurgeryLogEntry[]`로 파싱하는 것과 실제 파일 복원(`applyRevert()`)은 `src/cli`에 둔다.

## 엣지 케이스 & 에러 처리

- `{file}.surgery.log`가 존재하지 않음 → 종료 코드 2, "되돌릴 수술 이력이 없습니다"
- `--last`와 `--to`를 동시 지정 → 종료 코드 2, "`--last`와 `--to`는 함께 쓸 수 없습니다"
- `--to`로 지정한 시각이 로그의 모든 항목보다 이름 (그 시각 이후 수술이 없음) → 종료 코드 2, "해당 시점 이후 수술 이력이 없습니다"
- `--to`로 지정한 시각이 이미 `revert`로 되돌려진 구간을 다시 가리킴 → `kind: "revert"` 항목은 되돌리기 대상에서 제외한다(되돌리기를 또 되돌리는 재귀는 다루지 않는다). 대상이 0건이 되면 종료 코드 2, "해당 구간은 이미 되돌려졌습니다"
- 대상 항목 중 하나 이상의 `backupPath`가 파일 시스템에 없음 → **부분 복원하지 않고 즉시 중단**, 종료 코드 2, 어느 항목의 백업이 없는지 timestamp와 함께 명시 (ADR-0004: 애매한 상태에서 추측하지 않는다)
- `--commit` 없이 실행 (dry-run) → 계획만 출력. 자기 백업·파일 교체·로그 추가 어느 것도 하지 않음
- `--commit`으로 실행했으나 쓰기 권한 없음 → 종료 코드 2. 자기 백업 생성 전 단계에서 권한을 먼저 확인해, 백업만 만들고 복원에 실패하는 중간 상태를 피한다 (`reattach` Spec과 동일 원칙)
- 되돌리기 직전 자기 백업의 타임스탬프가 기존 백업과 충돌 (같은 초 안에 재시도) → `reattach` Spec의 백업 파일명 충돌 규칙(일련번호 부여, 기존 백업 미덮어씀)을 그대로 따른다
- 복원 후 `verify`와 동일한 방식으로 재계산한 체인 길이가 `RevertPlan.expectedChainLength`와 다름 → 이 경우는 복원 로직 자체의 결함(백업이 손상됐거나 잘못된 파일이 선택됨)을 뜻하므로 조용히 성공으로 보고하지 않고 경고와 함께 종료 코드 2

## 성능 요구사항

- 수술 로그 파싱은 append-only 텍스트 파일을 순차로 읽는 것이므로, 실사용 규모(수십~수백 건)에서 1초 이내에 끝나야 한다
- 백업 파일 복원은 원본 파일 크기에 비례한다. 성능 기준선은 `reattach` Spec의 `--commit` 기준([20260901-2309-reattach-command.spec.md](20260901-2309-reattach-command.spec.md#성능-요구사항))과 동일 — 829MB 파일 기준 수십 초를 넘지 않아야 한다
- 복원 후 검증(`verify`와 동일 경로)은 `inspect`의 인덱싱 시간과 동일 기준을 따른다(2.5초 이내, [20260901-1337-inspect-command.spec.md](20260901-1337-inspect-command.spec.md#성능-요구사항))

## Out of Scope

- 특정 uuid 하나의 재연결만 선택적으로 되돌리기 (PRD Non-Goals, Design "고려한 대안 & 기각 이유" 대안2)
- 되돌린 뒤 다시 잇기를 자동으로 재시도하는 기능 (PRD Non-Goals)
- 기록을 만든 적 없는 임의 지점으로 되돌리기 — 실제로 보관된 백업으로만 복원 가능 (PRD Non-Goals)
- 되돌리기를 다시 되돌리는 재귀적 처리 (`--to`가 이미 되돌려진 구간을 가리킬 때는 대상에서 제외할 뿐, 그 자체를 자동으로 재구성하지 않는다)
- 오래된 백업 파일 자동 정리 (Design "향후 확장 고려사항")
