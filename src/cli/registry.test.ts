import test from "node:test";
import assert from "node:assert/strict";

import { nextActionsFor } from "./reattach.js";
import { COMMANDS, ERROR_CODES, isRegisteredCommand } from "./registry.js";

test("registry: nextActions는 항상 등록된 명령을 가리킨다 (레지스트리 도입 시점에 추가한 검증)", () => {
  for (const code of ERROR_CODES) {
    for (const action of nextActionsFor(code)) {
      const token = action.replace(/^sessgraph\s+/, "").split(/\s+/)[0]!;
      assert.ok(
        isRegisteredCommand(token),
        `${action} → "${token}"은 등록된 명령이 아닙니다`,
      );
    }
  }
});

test("registry: 등록된 명령마다 name·summary·example이 비어있지 않다", () => {
  for (const cmd of COMMANDS) {
    assert.ok(cmd.name.length > 0);
    assert.ok(cmd.summary.length > 0);
    assert.ok(cmd.example.includes(cmd.name));
  }
});

test("registry: isRegisteredCommand는 등록되지 않은 이름을 거짓으로 판정한다", () => {
  assert.equal(isRegisteredCommand("graph"), false);
});

test("registry: isRegisteredCommand는 verify/revert/serve를 참으로 판정한다", () => {
  assert.equal(isRegisteredCommand("verify"), true);
  assert.equal(isRegisteredCommand("revert"), true);
  assert.equal(isRegisteredCommand("serve"), true);
});
