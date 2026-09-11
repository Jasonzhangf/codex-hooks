export const PROTOCOL = "routecodex-hooks/v1";

export const HOOK_EVENTS = Object.freeze([
  "SessionStart",
  "SubagentStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SubagentStop",
  "Stop",
  "Interrupt",
  "SessionEnd",
]);

export const HOOK_KINDS = Object.freeze([
  "input",
  "tool-call",
  "update-goal",
  "stop",
  "lifecycle",
]);

export const SESSION_STATES = Object.freeze([
  "idle",
  "working",
  "waiting_for_input",
  "stopping",
  "stopped",
  "starting",
  "disconnected",
  "failed",
  "unknown",
]);

export const SEND_ELIGIBLE_STATES = Object.freeze([
  "idle",
  "waiting_for_input",
  "stopped",
]);

export const DEFERRED_SESSION_STATES = Object.freeze([
  "working",
  "stopping",
  "starting",
]);

export const FAIL_CLOSED_SESSION_STATES = Object.freeze([
  "disconnected",
  "failed",
  "unknown",
]);

export const SEND_MODES = Object.freeze({
  IDLE_ONLY: "idle_only",
  WORKING_ALLOWED: "working_allowed",
});

export const MESSAGE_SOURCES = Object.freeze([
  "stopless",
  "update-goal",
  "timer",
  "longhorizon",
  "operator",
]);

export const DELIVERY_STATES = Object.freeze([
  "created",
  "suppressed",
  "queued",
  "deferred",
  "emitted",
  "sending",
  "accepted",
  "delivered",
  "executed",
  "replied",
  "read",
  "failed",
  "unknown_delivery",
  "expired",
  "cancelled",
]);

export const HOOK_PROCESSING_STATES = Object.freeze([
  "received",
  "validated",
  "normalized",
  "dispatched",
  "waiting",
  "decided",
  "acknowledged",
  "timed_out",
  "failed",
  "duplicate",
  "stale",
]);

export const OPERATOR_STATES = Object.freeze([
  "inactive",
  "armed",
  "triggered",
  "deferred",
  "eligible",
  "completed",
  "failed",
]);

export function assertNonEmpty(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

export function normalizeTarget(value) {
  if (!value || typeof value !== "object") throw new Error("target is required");
  return {
    namespace: assertNonEmpty(value.namespace, "target.namespace"),
    appserver_id: assertNonEmpty(value.appserver_id, "target.appserver_id"),
    session_id: assertNonEmpty(value.session_id, "target.session_id"),
    thread_id: assertNonEmpty(value.thread_id, "target.thread_id"),
  };
}

export function normalizeSessionState(value) {
  const state = normalizeSessionObservation(value).state;
  return state;
}

export function normalizeSessionObservation(value) {
  const state = typeof value === "string"
    ? value
    : value?.state || value?.status?.type;
  if (!SESSION_STATES.includes(state)) return { state: "unknown", input_active: false };
  return {
    state,
    input_active: typeof value === "object" && value !== null && (
      value.input_active === true || value.status?.input_active === true
    ),
  };
}

export function normalizeHookEvent(value) {
  if (!value || typeof value !== "object") throw new Error("hook event is required");
  const eventName = assertNonEmpty(value.hook_event_name, "hook_event_name");
  if (!HOOK_EVENTS.includes(eventName)) throw new Error(`unsupported hook event: ${eventName}`);
  return {
    session_id: assertNonEmpty(value.session_id, "session_id"),
    turn_id: value.turn_id == null ? null : assertNonEmpty(value.turn_id, "turn_id"),
    hook_event_name: eventName,
    cwd: assertNonEmpty(value.cwd, "cwd"),
    tool_name: value.tool_name || value.tool?.name || null,
    tool_use_id: value.tool_use_id == null ? null : assertNonEmpty(value.tool_use_id, "tool_use_id"),
    event_id: value.event_id == null ? null : assertNonEmpty(value.event_id, "event_id"),
    stop_hook_active: value.stop_hook_active === true,
    permission_mode: value.permission_mode || null,
    transcript_path: value.transcript_path || null,
    model: value.model || null,
    prompt: value.prompt || null,
    tool_input: value.tool_input == null ? null : clone(value.tool_input),
    tool_response: value.tool_response == null ? null : clone(value.tool_response),
    agent_id: value.agent_id || null,
    agent_type: value.agent_type || null,
    agent_transcript_path: value.agent_transcript_path || null,
    last_assistant_message: value.last_assistant_message || null,
    source: value.source || null,
    trigger: value.trigger || null,
    reason: value.reason || null,
    raw: value,
  };
}

export function classifyHook(event, explicitKind = null) {
  if (explicitKind != null) {
    if (!HOOK_KINDS.includes(explicitKind)) throw new Error(`unsupported hook kind: ${explicitKind}`);
    const inferredKind = classifyHook(event);
    if (inferredKind != null && inferredKind !== explicitKind) {
      throw new Error(`hook kind mismatch: expected ${inferredKind}, received ${explicitKind}`);
    }
    return explicitKind;
  }
  if (event.hook_event_name === "Stop" || event.hook_event_name === "SubagentStop") return "stop";
  if (["UserPromptSubmit", "SessionStart", "SubagentStart", "PreCompact", "PostCompact"].includes(event.hook_event_name)) return "input";
  if ((event.hook_event_name === "PreToolUse" || event.hook_event_name === "PostToolUse") && event.tool_name === "update_goal") {
    return "update-goal";
  }
  if (["PreToolUse", "PermissionRequest", "PostToolUse"].includes(event.hook_event_name)) return "tool-call";
  if (["SessionEnd", "Interrupt"].includes(event.hook_event_name)) return "lifecycle";
  throw new Error(`unsupported hook event kind: ${event.hook_event_name}`);
}

export function normalizeIntent(value) {
  if (!value || typeof value !== "object") throw new Error("message intent is required");
  const mode = assertNonEmpty(value.send_mode, "send_mode");
  if (!Object.values(SEND_MODES).includes(mode)) throw new Error(`unsupported send mode: ${mode}`);
  const source = assertNonEmpty(value.source, "source");
  if (!MESSAGE_SOURCES.includes(source)) throw new Error(`unsupported message source: ${source}`);
  const expiresAt = value.expires_at == null ? null : assertNonEmpty(value.expires_at, "expires_at");
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) throw new Error("expires_at must be an ISO timestamp");
  return {
    intent_id: assertNonEmpty(value.intent_id, "intent_id"),
    source,
    target: normalizeTarget(value.target),
    body: assertNonEmpty(value.body, "body"),
    send_mode: mode,
    event_key: assertNonEmpty(value.event_key, "event_key"),
    expires_at: expiresAt,
  };
}

export function eventKey(event, kind) {
  const isToolInvocation = event.hook_event_name === "PreToolUse" || event.hook_event_name === "PostToolUse";
  if (isToolInvocation && !event.tool_use_id) throw new Error(`${event.hook_event_name} requires tool_use_id for idempotency`);
  const invocationId = isToolInvocation
    ? event.tool_use_id
    : (event.event_id || event.agent_id || event.source || event.trigger || event.reason || "no-invocation");
  return [event.session_id, event.turn_id || "no-turn", event.hook_event_name, kind, invocationId].join("/");
}

export function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
