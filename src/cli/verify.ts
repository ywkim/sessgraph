import { existsSync } from "node:fs";
import { parseArgs } from "node:util";

import { buildIndexDetailed } from "../core/build-index.js";
import { buildVerifyResult, VerifyValidationError } from "../core/verify.js";
import type { ErrorCode } from "../core/types.js";
import { errorEnvelope, okEnvelope, printEnvelope } from "./envelope.js";

export function runVerify(
  argv: readonly string[],
  write?: (chunk: string) => void,
): number {
  let values: { uuid?: string; json?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        uuid: { type: "string" },
        json: { type: "boolean", default: false },
      },
    }));
  } catch (err) {
    return fail(
      false,
      "UNKNOWN_ARGUMENT",
      `인자 파싱 실패: ${(err as Error).message}`,
      [],
      write,
    );
  }

  const json = Boolean(values.json);

  const file = positionals[0];
  if (!file) {
    return fail(
      json,
      "MISSING_ARGUMENT",
      "세션 파일 경로가 필요합니다",
      [],
      write,
    );
  }
  if (!existsSync(file)) {
    return fail(
      json,
      "FILE_NOT_FOUND",
      `파일을 찾을 수 없습니다: ${file}`,
      [],
      write,
    );
  }
  if (!values.uuid) {
    return fail(json, "MISSING_ARGUMENT", "--uuid는 필수입니다", [], write);
  }

  let index;
  let nodes;
  try {
    ({ index, nodes } = buildIndexDetailed(file));
  } catch (err) {
    return fail(json, "SCHEMA_DRIFT", (err as Error).message, [], write);
  }

  try {
    const result = buildVerifyResult(index, nodes, values.uuid);
    if (json) {
      printEnvelope(okEnvelope("verify", result), write);
    } else {
      console.log(
        `이 지점은 root ${result.segment.rootUuid}(${result.segment.rootSubtype ?? "없음"})까지 ${result.segment.nodeCount}개 노드로 연결되어 있습니다`,
      );
      if (result.stillDisconnectedAtRoot) {
        console.log(
          "이 root는 컴팩트 경계입니다 — 아직 이전 조각과 끊겨 있습니다",
        );
      } else {
        console.log("세션 시작점까지 연결되어 있습니다");
      }
      console.log(
        "연결 여부와 실제 회상 여부는 다릅니다. 재개해서 직접 확인하세요",
      );
    }
    return 0;
  } catch (err) {
    if (err instanceof VerifyValidationError) {
      return fail(json, err.code, err.message, [], write);
    }
    throw err;
  }
}

function fail(
  json: boolean,
  code: ErrorCode,
  message: string,
  nextActions: readonly string[] = [],
  write?: (chunk: string) => void,
): number {
  if (json) {
    printEnvelope(errorEnvelope("verify", code, message, nextActions), write);
  } else {
    console.error(message);
  }
  return 2;
}
