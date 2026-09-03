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

/** `--json`일 때 봉투를 stdout에, 아니면 문장을 지정한 스트림에 쓴다. */
export function printEnvelope(envelope: CommandEnvelope<unknown>): void {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}
