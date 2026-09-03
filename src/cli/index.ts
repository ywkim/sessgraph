#!/usr/bin/env node
import { runReattach } from "./reattach.js";

const [, , command, ...rest] = process.argv;

switch (command) {
  case "reattach": {
    const exitCode = await runReattach(rest);
    process.exit(exitCode);
    break;
  }
  default: {
    console.error(`알 수 없는 명령: ${command ?? "(없음)"}`);
    console.error("사용 가능한 명령: reattach");
    process.exit(2);
  }
}
