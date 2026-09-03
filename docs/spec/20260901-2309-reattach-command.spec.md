---
slug: 20260901-2309-reattach-command
status: Current
related:
  prd: docs/prd/20260901-2309-reattach-command.prd.md
  design: docs/design/20260901-2309-reattach-command.tdd.md
updated: 2026-09-03
---

# Spec: `reattach` 명령

## Interface

```
sessgraph reattach <file> --uuid <uuid> --parent <uuid> --reason <text> [--commit] [--json]
```

- `<file>`: 필수. 세션 JSONL 파일 경로
- `--uuid`: 필수. `parentUuid`를 바꿀 대상 레코드의 uuid
- `--parent`: 필수. 새로 지정할 부모 레코드의 uuid
- `--reason`: 필수. 이 재연결을 하는 이유 (자유 텍스트, 수술 로그에 그대로 기록)
- `--commit`: 선택. 없으면 dry-run — 계획만 출력하고 파일은 건드리지 않는다
- `--json`: 선택. 출력 형태는 [기계 판독 출력 규약 Spec](20260903-1218-machine-readable-output.spec.md)이 정의한다. 쓰기 여부에는 영향을 주지 않는다 (쓰기는 `--commit`만이 결정한다)

종료 코드:

- `0`: 정상 실행 (dry-run 출력 또는 `--commit` 적용 모두 성공 시)
- `2`: 도구 오류 — 파일 없음, 대상/부모 uuid 없음, 순환 발생, `--reason` 누락, 쓰기 실패

## 데이터 모델

핵심 타입은 [`inspect` 명령 Spec](20260901-1337-inspect-command.spec.md#데이터-모델)이 정의한 `IndexResult`를 그대로 쓴다. ⚠️ 이 문서 작성 시점에 `IndexResult`는 아직 `src/core/types.ts`에 구현되어 있지 않다 — PR #2에서 정의되었고 병합 대기 중이다. `reattach` 구현은 그 병합 이후에 진행한다.

이 문서에서 추가로 정의하는 타입 (구현 시 `src/core/types.ts`에 추가):

```ts
interface ReattachPlan {
  readonly targetUuid: string;
  readonly previousParent: string | null;
  readonly newParent: string;
  readonly reason: string;
  /** 재연결 전, targetUuid가 속한 세그먼트의 노드 수 */
  readonly beforeChainLength: number;
  /** 재연결 후 예상되는 병합 세그먼트의 노드 수 */
  readonly afterChainLength: number;
}

interface ReattachResult {
  readonly plan: ReattachPlan;
  readonly committed: boolean;
  /** committed === true일 때만 존재 */
  readonly backupPath?: string;
  readonly surgeryLogPath?: string;
}
```

`buildReattachPlan(index: IndexResult, uuid: string, parent: string): ReattachPlan`은 `src/core`에 둔다 — 파일을 쓰지 않는 순수 계산이므로 `src/core`의 책임 범위에 들어간다 (`src/core/CLAUDE.md`). 실제 파일 쓰기(`applyReattach()`)는 `src/cli`에 둔다.

## 엣지 케이스 & 에러 처리

- `--uuid`가 가리키는 노드가 인덱스에 없음 → 종료 코드 2, "대상 uuid를 찾을 수 없습니다"
- `--parent`가 가리키는 노드가 인덱스에 없음 → 종료 코드 2, "지정한 부모 uuid를 찾을 수 없습니다"
- `--parent`가 `--uuid` 자신이거나, `--uuid`의 자손(재연결 후 조상을 거슬러 올라가면 다시 `--uuid`에 도달) → 종료 코드 2, "순환이 생겨 적용할 수 없습니다"
- `--uuid`가 가리키는 레코드가 uuid는 있지만 애초에 그래프에 참여하지 않는 유형(메타데이터성 레코드) → 종료 코드 2, "이 레코드는 재연결 대상이 될 수 없습니다"
- `--uuid`의 현재 `parentUuid`가 이미 `--parent`와 같음 (변경할 것이 없음) → 정상 종료(0), "이미 연결되어 있습니다. 변경 사항 없음"
- `--reason`이 빈 문자열이거나 공백만 → 종료 코드 2, "사유를 입력해야 합니다"
- `--commit` 없이 실행 (dry-run) → 계획만 출력, 파일·백업·로그 어느 것도 생성하지 않음
- `--commit`으로 실행했으나 대상 경로에 쓰기 권한이 없음 → 종료 코드 2. 백업 생성 전 단계에서 권한을 먼저 확인해, 백업만 만들고 본 파일 교체에 실패하는 중간 상태를 피한다
- 같은 파일에 대해 백업이 이미 존재하는 타임스탬프로 재시도 (같은 분 안에 두 번 실행) → 파일명에 초 단위까지 포함하거나, 충돌 시 일련번호를 붙여 기존 백업을 덮어쓰지 않는다 (`src/cli/CLAUDE.md` "쓰기 규칙" 3번)
- 정책으로 해소되지 않은 중복(`unresolvedDuplicates`)에 `--uuid`가 포함됨 → 종료 코드 2, "이 레코드는 여러 번 출현하며 어느 것이 최신 상태인지 도구가 판단할 수 없습니다. 먼저 `inspect --json`으로 확인하세요" (ADR-0004: 애매한 상태에서 추측하지 않는다)
- `--commit` 적용 후, 수정한 줄의 원본 키 집합과 재작성 후 키 집합을 비교한다(`parentUuid` 제외). 키가 하나라도 사라졌으면 경고를 출력한다 — `compactMetadata`·`preservedMessages`는 ADR-0002가 보존을 전제하는 필드이고, 그 결정 자체가 "왜 작동하는지는 모르지만 관측된 성공률이 높다"는 불확실성 위에 있으므로(ADR-0002 "Rationale") 최소한 구조적 보존 여부는 확인한다. 경고는 커밋을 막지 않는다 — 회상 성공 여부의 자동 판정은 여전히 Out of Scope(ADR-0002)

## 성능 요구사항

- 사전 검증(대상/부모 존재 확인, 순환 검사)은 이미 메모리에 있는 인덱스를 순회하므로 `inspect`의 인덱싱 시간에 추가 비용이 사실상 없어야 한다 (조상 경로 순회는 세그먼트 깊이에 비례 — 실측 세션에서 세그먼트당 최대 수백 노드 수준)
- `--commit` 적용 시 파일 쓰기는 원본 파일 크기에 비례한다. 829MB 파일 기준 백업 복사 + 재작성이 수십 초를 넘지 않아야 한다 (참고: `inspect`의 인덱싱 자체는 2.5초 이내 — Spec [20260901-1337-inspect-command.spec.md](20260901-1337-inspect-command.spec.md#성능-요구사항))

## Out of Scope

- 여러 지점을 한 번에 잇는 배치 모드 (PRD Non-Goals)
- 재연결 후 실질 회상 여부의 자동 검증 (PRD Non-Goals, ADR-0002)
- 백업으로부터 되돌리는 기능 (`revert` 명령 — 별도 Spec)
- 재연결 결과를 웹에서 확인하는 기능 (`serve`가 읽기 시 반영하지만, 그건 `serve` 자체 Spec의 범위)
- 여러 파일에 걸친 재연결 (예: fork 병합 후 재연결) — `inspect` Spec Out of Scope와 동일 이유로 단일 파일 대상만 다룬다
