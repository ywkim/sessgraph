import type {
  CommandEnvelope,
  CommandWarning,
  ErrorCode,
} from "../core/types.js";

/**
 * 성공 봉투를 만든다. `--json`일 때만 이 값을 stdout에 한 줄로 쓴다
 * (docs/spec/20260903-1218-machine-readable-output.spec.md).
 */
export function okEnvelope<T>(
  command: string,
  result: T,
  warnings: readonly CommandWarning[] = [],
): CommandEnvelope<T> {
  return { ok: true, command, result, error: null, warnings };
}

/**
 * 실패 봉투를 만든다. `nextActions`는 실행 가능한 명령 문자열만 담아야
 * 한다 — 존재하지 않는 명령을 가리키면 안 된다 (Spec "엣지 케이스").
 * 아직 구현되지 않은 명령을 가리켜야 하는 호출부는 빈 배열을 넘긴다.
 */
export function errorEnvelope(
  command: string | null,
  code: ErrorCode,
  message: string,
  nextActions: readonly string[] = [],
): CommandEnvelope<never> {
  return {
    ok: false,
    command,
    result: null,
    error: { code, message, nextActions },
    warnings: [],
  };
}

/**
 * `--json`일 때 봉투를 stdout에, 아니면 문장을 지정한 스트림에 쓴다.
 *
 * `write`는 기본값이 `process.stdout.write`지만 테스트가 주입할 수 있다.
 * 전역 `process.stdout.write`를 monkey-patch하는 대신 이 자리에 콜백을
 * 넘기는 이유: `runReattach`/`runRevert`는 `await`로 실제 비동기 I/O
 * 경계를 넘는데, 그 경계를 넘는 동안 전역 `process.stdout.write`를
 * 바꿔둔 상태로 두면 Node v26 test runner의 내부 리포터가 깨져 형제
 * 테스트가 등록 자체에서 조용히 사라진다(재현: 매크로태스크 경계 없이
 * 동기 실행되거나 `console.log`만 patch하면 문제없음 — 실제 원인은
 * 전역 `stdout.write` patch가 `await`를 넘어 살아있는 것 자체). 주입식
 * writer는 전역 상태를 건드리지 않아 이 문제를 원천적으로 피한다.
 */
export function printEnvelope(
  envelope: CommandEnvelope<unknown>,
  write: (chunk: string) => void = (chunk) => {
    process.stdout.write(chunk);
  },
): void {
  write(`${JSON.stringify(envelope)}\n`);
}
