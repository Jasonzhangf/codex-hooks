import assert from "node:assert/strict";
import test from "node:test";
import { projectStopDecision, normalizePolicyDecision, STOP_DECISIONS, TOOL_CALL_DECISIONS } from "../src/decision.js";

test("Stop contract has mutually exclusive allow, block, and external inject projections", () => {
  assert.deepEqual(STOP_DECISIONS, ["allow", "block", "inject"]);
  assert.deepEqual(projectStopDecision({ action: "allow" }), {});
  assert.deepEqual(projectStopDecision({ action: "block", reason: "run one more pass" }), {
    decision: "block",
    reason: "run one more pass",
  });
  assert.deepEqual(projectStopDecision({ action: "inject" }, { externalWakeAccepted: true }), {});
  assert.throws(() => projectStopDecision({ action: "inject" }), /accepted external wake/);
  assert.throws(() => projectStopDecision({ action: "block" }), /requires a reason/);
});

test("tool-call contract exposes observation and policy outcomes without sharing Stop state", () => {
  assert.deepEqual(TOOL_CALL_DECISIONS, ["observe", "allow", "deny", "delay", "retryable_failure", "terminal_failure"]);
  assert.deepEqual(normalizePolicyDecision({ action: "observe", operator_id: "tool" }, "tool-call"), {
    action: "observe",
    reason: null,
    operator_id: "tool",
    intent_id: null,
  });
  assert.throws(() => normalizePolicyDecision({ action: "block" }, "tool-call"), /unsupported tool-call decision/);
  assert.throws(() => normalizePolicyDecision({ action: "observe" }, "stop"), /unsupported stop decision/);
});
