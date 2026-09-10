export const PROTOCOL = "routecodex-hooks/v1";

export const HOOK_EVENTS = Object.freeze([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionEnd",
]);

export const HOOK_KINDS = Object.freeze([
  "input",
  "tool-call",
  "update-goal",
  "stop",
]);

export const SESSION_STATES = Object.freeze([
  "idle",
  "working",
  "stopping",
  "disconnected",
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
  "deferred",
  "emitted",
  "accepted",
  "failed",
  "unknown_delivery",
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
  if (event.hook_event_name === "Stop") return "stop";
  if (event.hook_event_name === "UserPromptSubmit" || event.hook_event_name === "SessionStart") return "input";
  if ((event.hook_event_name === "PreToolUse" || event.hook_event_name === "PostToolUse") && event.tool_name === "update_goal") {
    return "update-goal";
  }
  if (event.hook_event_name === "PreToolUse" || event.hook_event_name === "PostToolUse") return "tool-call";
  return null;
}

export function normalizeIntent(value) {
  if (!value || typeof value !== "object") throw new Error("message intent is required");
  const mode = assertNonEmpty(value.send_mode, "send_mode");
  if (!Object.values(SEND_MODES).includes(mode)) throw new Error(`unsupported send mode: ${mode}`);
  const source = assertNonEmpty(value.source, "source");
  if (!MESSAGE_SOURCES.includes(source)) throw new Error(`unsupported message source: ${source}`);
  return {
    intent_id: assertNonEmpty(value.intent_id, "intent_id"),
    source,
    target: normalizeTarget(value.target),
    body: assertNonEmpty(value.body, "body"),
    send_mode: mode,
    event_key: assertNonEmpty(value.event_key, "event_key"),
  };
}

export function eventKey(event, kind) {
  const isToolEvent = event.hook_event_name === "PreToolUse" || event.hook_event_name === "PostToolUse";
  const invocationId = isToolEvent ? event.tool_use_id : (event.event_id || "no-invocation");
  if (!invocationId) throw new Error(`${event.hook_event_name} requires tool_use_id for idempotency`);
  return [event.session_id, event.turn_id || "no-turn", event.hook_event_name, kind, invocationId].join("/");
}

export function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
