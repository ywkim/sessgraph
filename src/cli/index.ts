#!/usr/bin/env node
import { errorEnvelope, printEnvelope } from "./envelope.js";
import { runInspect } from "./inspect.js";
import { runReattach } from "./reattach.js";
import { runSchema } from "./schema.js";
import { runVerify } from "./verify.js";

const [, , command, ...rest] = process.argv;

switch (command) {
  case "inspect": {
    process.exit(runInspect(rest));
    break;
  }
  case "reattach": {
    const exitCode = await runReattach(rest);
    process.exit(exitCode);
    break;
  }
  case "verify": {
    process.exit(runVerify(rest));
    break;
  }
  case "schema": {
    process.exit(runSchema());
    break;
  }
  default: {
    process.exit(failUnknownCommand(command, rest));
  }
}

/**
 * 알 수 없는 명령(또는 명령 없음) → 종료 코드 2. `--json`이면 봉투
 * (command: null, code: UNKNOWN_COMMAND, nextActions: ["sessgraph schema"])
 * (docs/spec/20260903-1218-machine-readable-output.spec.md "엣지 케이스").
 */
function failUnknownCommand(
  command: string | undefined,
  rest: readonly string[],
): number {
  if (rest.includes("--json")) {
    printEnvelope(
      errorEnvelope(
        null,
        "UNKNOWN_COMMAND",
        `알 수 없는 명령: ${command ?? "(없음)"}`,
        ["sessgraph schema"],
      ),
    );
  } else {
    console.error(`알 수 없는 명령: ${command ?? "(없음)"}`);
    console.error("사용 가능한 명령: inspect, reattach, verify, schema");
  }
  return 2;
}
