export const STOP_DECISIONS = Object.freeze(["allow", "block", "inject"]);
export const TOOL_CALL_DECISIONS = Object.freeze([
  "observe",
  "allow",
  "deny",
  "delay",
  "retryable_failure",
  "terminal_failure",
]);

export function normalizePolicyDecision(value, kind) {
  if (!value || typeof value !== "object") throw new Error("policy decision is required");
  const actions = kind === "stop" ? STOP_DECISIONS : kind === "tool-call" || kind === "update-goal" ? TOOL_CALL_DECISIONS : ["observe", "inject"];
  if (!actions.includes(value.action)) throw new Error(`unsupported ${kind} decision: ${value.action}`);
  return {
    action: value.action,
    reason: value.reason == null ? null : String(value.reason),
    operator_id: value.operator_id == null ? null : String(value.operator_id),
    intent_id: value.intent_id == null ? null : String(value.intent_id),
  };
}

export function projectStopDecision(value, { externalWakeAccepted = false } = {}) {
  const decision = normalizePolicyDecision(value, "stop");
  if (decision.action === "allow") return {};
  if (decision.action === "block") {
    if (!decision.reason) throw new Error("Stop block decision requires a reason");
    return { decision: "block", reason: decision.reason };
  }
  if (!externalWakeAccepted) throw new Error("Stop inject decision requires an accepted external wake");
  // External sendmessage is a separate input path. No official Stop output
  // field is used as an injection receipt.
  return {};
}
