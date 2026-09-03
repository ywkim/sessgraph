---
slug: 20260903-1218-machine-readable-output
status: Current
related:
  prd: docs/prd/20260903-1218-machine-readable-output.prd.md
  design: docs/design/20260903-1218-machine-readable-output.tdd.md
updated: 2026-09-03
---

# Spec: 기계 판독 출력 규약과 `schema` 명령

## Interface

### 공통 플래그

모든 명령이 `--json`을 받는다.

```
sessgraph <command> [...] [--json]
```

- `--json`: 선택. 사람이 읽는 문장 대신 봉투(envelope) JSON **한 줄**을 stdout에 출력한다
- `--json`이 없으면 출력은 지금과 동일하다 (사람용 문장, 경고는 stderr)
- `--json`은 어떤 명령의 쓰기 여부도 바꾸지 않는다. 쓰기는 `--commit`만이 결정한다

각 명령의 Spec에 이미 적힌 `--json`(`inspect`, `verify`)은 이 문서가 정의하는 형태를 따른다. 각 Spec은 형태를 재기술하지 않고 이 문서를 링크한다.

### `schema` 명령

```
sessgraph schema
```

- 인자 없음. 파일을 읽지 않는다
- 출력은 항상 봉투 JSON 한 줄 (`--json` 불필요, 지정해도 동일)
- 종료 코드: 항상 `0`

### 출력 스트림 규약

`--json`일 때:

- 성공·실패 응답 모두 **stdout에 한 줄**
- stderr는 비운다 (사람용 경고를 포함해 아무것도 쓰지 않는다)
- 종료 코드는 `--json` 여부와 무관하게 동일하다 ([src/cli/CLAUDE.md](../../src/cli/CLAUDE.md#종료-코드))

## 데이터 모델

아래 타입은 구현 시 [`src/core/types.ts`](../../src/core/types.ts)에 추가한다. 명령 고유 결과 타입(`IndexResult`, `VerifyResult`, `ReattachPlan`, `ReattachResult`)은 이미 정의된 것을 그대로 쓰며 이 문서는 재기술하지 않는다.

### 봉투

```ts
interface CommandEnvelope<T> {
  /** true면 성공. 종료 코드를 잃는 호출 경로에서도 판정 가능해야 한다 */
  readonly ok: boolean;
  /** 실행된 명령 이름. 알 수 없는 명령이면 null */
  readonly command: string | null;
  /** 성공 시 명령 고유 결과. 실패 시 null */
  readonly result: T | null;
  /** 실패 시에만 non-null */
  readonly error: CommandError | null;
  /** 성공·실패 모두에서 채워질 수 있다. 없으면 빈 배열 */
  readonly warnings: readonly CommandWarning[];
}

interface CommandError {
  readonly code: ErrorCode;
  /** 사람용 한국어 메시지. 분기 근거로 쓰지 않는다 */
  readonly message: string;
  /** 실행 가능한 명령 문자열. 없으면 빈 배열 */
  readonly nextActions: readonly string[];
}

interface CommandWarning {
  readonly code: WarningCode;
  readonly message: string;
}
```

**불변식**:

- `ok === true` ⟺ `error === null` ⟺ `result !== null`
- `ok === true` ⟺ 종료 코드 `0`
- `warnings`와 `ok`는 독립이다. 경고가 있어도 성공일 수 있다
- `error.nextActions`의 각 문자열은 `schema`가 광고하는 명령 이름으로 시작해야 한다 (아래 "엣지 케이스" 참고)

### 오류 코드

```ts
type ErrorCode =
  | "UNKNOWN_COMMAND"
  | "MISSING_ARGUMENT"
  | "UNKNOWN_ARGUMENT"
  | "FILE_NOT_FOUND"
  | "FILE_NOT_WRITABLE"
  | "TARGET_NOT_FOUND"
  | "PARENT_NOT_FOUND"
  | "AMBIGUOUS_DUPLICATE"
  | "CYCLE_DETECTED"
  | "NOT_REATTACHABLE"
  | "EMPTY_REASON"
  | "SCHEMA_DRIFT";

type WarningCode = "KEYS_DROPPED";
```

기존 `reattach` 구현이 내는 메시지와의 대응 (메시지 문구는 [`reattach` Spec](20260901-2309-reattach-command.spec.md#엣지-케이스--에러-처리)이 계속 소유한다):

| 코드                  | 대응하는 기존 실패                                |
| --------------------- | ------------------------------------------------- |
| `EMPTY_REASON`        | 사유를 입력해야 합니다                            |
| `TARGET_NOT_FOUND`    | 대상 uuid를 찾을 수 없습니다                      |
| `PARENT_NOT_FOUND`    | 지정한 부모 uuid를 찾을 수 없습니다               |
| `AMBIGUOUS_DUPLICATE` | 여러 번 출현하며 … 판단할 수 없습니다             |
| `CYCLE_DETECTED`      | 순환이 생겨 적용할 수 없습니다                    |
| `NOT_REATTACHABLE`    | 이 레코드는 재연결 대상이 될 수 없습니다          |
| `FILE_NOT_WRITABLE`   | 쓰기 권한이 없습니다                              |
| `KEYS_DROPPED` (경고) | 키 집합 비교 경고 (ADR-0002, 현재 `console.warn`) |

`SCHEMA_DRIFT`는 필수 필드가 통째로 사라져 인덱싱을 중단한 경우에 쓴다 (루트 CLAUDE.md "정확성 원칙": 0을 반환하지 않고 중단한다).

### `schema` 결과

```ts
interface CliSchema {
  readonly tool: "sessgraph";
  /** 이 규약 자체의 판 번호. 봉투나 코드 열거가 비호환으로 바뀌면 올린다 */
  readonly schemaVersion: 1;
  readonly commands: readonly CommandDescriptor[];
  readonly exitCodes: readonly { code: 0 | 1 | 2; meaning: string }[];
  readonly errorCodes: readonly ErrorCode[];
  readonly warningCodes: readonly WarningCode[];
}

interface CommandDescriptor {
  readonly name: string;
  readonly summary: string;
  /** true면 세션 파일을 수정할 수 있다 (--commit 동반 시) */
  readonly writes: boolean;
  readonly positionals: readonly PositionalDescriptor[];
  readonly options: readonly OptionDescriptor[];
  readonly example: string;
}

interface PositionalDescriptor {
  readonly name: string;
  readonly required: boolean;
  readonly description: string;
}

interface OptionDescriptor {
  readonly name: string;
  readonly type: "string" | "boolean";
  readonly required: boolean;
  readonly default: string | boolean | null;
  readonly description: string;
}
```

`CommandDescriptor` 배열은 [`src/cli/registry.ts`](../../src/cli/)의 단일 정의에서 나온다. 같은 정의가 인자 파싱 설정과 디스패치에도 쓰인다 (Design "아키텍처" 1항). 설명 문자열을 파싱 설정과 따로 두지 않는다.

## 엣지 케이스 & 에러 처리

- **알 수 없는 명령** → 종료 코드 2. `--json`이면 봉투(`command: null`, `code: "UNKNOWN_COMMAND"`, `nextActions: ["sessgraph schema"]`). `--json`이 없으면 현재와 같이 stderr 사람용 두 줄
- **명령을 아예 주지 않음** → 알 수 없는 명령과 동일 처리 (`command: null`)
- **`--json`과 `--commit` 동시 사용** → 정상. 쓰기를 수행하고 `ReattachResult`를 봉투에 담는다. `--json`은 쓰기 여부에 영향을 주지 않는다
- **정의되지 않은 플래그** → `UNKNOWN_ARGUMENT`, 종료 코드 2. `parseArgs`가 던지는 예외를 그대로 흘리지 않고 봉투로 변환한다
- **필수 인자 누락** → `MISSING_ARGUMENT`, 종료 코드 2. `error.message`에 누락된 인자 이름을 포함한다
- **경고가 있는 성공** → `ok: true`, `warnings` 채움, 종료 코드 0. 경고를 이유로 실패로 격상하지 않는다 (현재 키 집합 경고의 동작을 유지)
- **`nextActions`가 실재하지 않는 명령을 가리킴** → 테스트 실패로 막는다. `nextActions`의 각 문자열에서 `sessgraph ` 다음 토큰을 뽑아 레지스트리에 존재하는지 검사하는 테스트를 둔다. 문서로 지키지 않고 기계로 막는다 (Design "아키텍처" 4항)
- **아직 구현되지 않은 명령** → 레지스트리에 등록하지 않는다. `schema`는 실행 가능한 명령만 광고한다. `inspect`가 구현된 이후 `AMBIGUOUS_DUPLICATE`의 `nextActions`는 `["sessgraph inspect --json"]`을 채운다 — 레지스트리 자체가 아직 없어 이 값을 자동 검증하는 테스트는 레지스트리 도입 시점에 추가한다 (Design "향후 확장 고려사항"). `verify`/`revert`/`serve`처럼 여전히 구현되지 않은 명령을 가리켜야 하는 실패는 계속 빈 배열이다
- **JSON 직렬화 실패** → 발생하면 안 되는 상태다. 봉투에 담기는 값은 전부 평문 데이터이며 순환 참조를 갖지 않는다. 만약 던져지면 삼키지 않고 그대로 전파해 종료 코드 2로 끝낸다
- **stdout 파이프가 닫힘(EPIPE)** → 이 규약의 범위 밖이다. Node 기본 동작을 따른다

## 성능 요구사항

- `schema`는 파일 입출력을 하지 않는다. 상수 시간이며 기준선을 두지 않는다
- `--json`이 추가하는 비용은 이미 메모리에 있는 결과 객체 하나의 직렬화뿐이다. 인덱싱 비용([`inspect` Spec](20260901-1337-inspect-command.spec.md#성능-요구사항)의 기준선)이 지배적이며 이 규약은 그 기준선을 바꾸지 않는다
- `--json`이 인덱싱을 추가로 유발하지 않는다 — 사람용 출력과 동일한 단일 인덱스 결과를 형태만 달리해 내보낸다

## Out of Scope

- `--help` 사람용 텍스트 생성 (Design "고려한 대안" 대안3 — 같은 레지스트리에서 파생 가능하나 이번 범위 밖)
- 미구현 명령(`inspect`, `verify`, `revert`, `serve`)의 구현. 이 문서는 그 명령들이 구현될 때 따라야 할 출력 규약만 정의한다
- 각 명령의 동작·결과 내용 변경. 이 문서는 **내보내는 형태**만 다룬다 (PRD Non-Goals)
- 대화 도우미용 별도 연결 계층 (PRD Non-Goals, Design "고려한 대안" 대안5)
- `serve`의 HTTP 응답에 봉투를 적용할지 여부 — `serve` 구현 시점에 판단한다 (Design "향후 확장 고려사항")
- `schemaVersion` 상향 시의 하위 호환 정책. 판 번호를 낼 실제 사유가 생겼을 때 정한다
