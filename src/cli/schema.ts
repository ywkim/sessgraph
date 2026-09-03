import type { CliSchema } from "../core/types.js";
import { okEnvelope, printEnvelope } from "./envelope.js";
import {
  COMMANDS,
  ERROR_CODES,
  EXIT_CODES,
  WARNING_CODES,
} from "./registry.js";

/**
 * 인자 없음, 파일을 읽지 않는다, 항상 종료 코드 0 — `--json` 지정 여부와
 * 무관하게 항상 봉투를 출력한다
 * (docs/spec/20260903-1218-machine-readable-output.spec.md "schema 명령").
 */
export function runSchema(): number {
  const schema: CliSchema = {
    tool: "sessgraph",
    schemaVersion: 1,
    commands: COMMANDS,
    exitCodes: EXIT_CODES,
    errorCodes: ERROR_CODES,
    warningCodes: WARNING_CODES,
  };
  printEnvelope(okEnvelope("schema", schema));
  return 0;
}
