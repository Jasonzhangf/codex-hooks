import {
  assertNonEmpty,
  clone,
  normalizeTarget,
  normalizeTargetScope,
  SCHEDULE_ACTIONS,
  SCHEDULE_MODES,
  SEND_MODES,
} from "./protocol.js";

export const OPERATOR_REGISTRY = Object.freeze([
  { name: "stopless", hook_kinds: ["stop"], state_resource: "stopless_state", status: "contract-only" },
  { name: "update-goal", hook_kinds: ["update-goal"], state_resource: "update_goal_state", status: "contract-only" },
  { name: "timer", hook_kinds: [], triggers: ["daemon_clock"], state_resource: "schedule_state", status: "implemented" },
  { name: "longhorizon", hook_kinds: [], triggers: ["daemon_checkpoint"], state_resource: "longhorizon_state", status: "contract-only" },
  { name: "memory", hook_kinds: ["input", "tool-call"], state_resource: "memory_state", status: "out-of-scope" },
]);
const OPERATORS = Object.freeze(OPERATOR_REGISTRY.map((entry) => entry.name));

export class FrameworkControlPlane {
  constructor({ store }) {
    if (!store || typeof store.getControl !== "function" || typeof store.putControl !== "function") {
      throw new Error("control plane requires a state store");
    }
    this.store = store;
  }

  query() {
    return {
      operators: this.store.getControl("operators") || Object.fromEntries(OPERATORS.map((name) => [name, { enabled: false }])),
      operator_registry: clone(OPERATOR_REGISTRY),
      session_bindings: this.store.getControl("session_bindings") || {},
      schedules: this.store.getControl("schedules") || {},
    };
  }

  mutate(request) {
    if (!request || typeof request !== "object") throw new Error("control mutation is required");
    const operation = assertNonEmpty(request.operation, "operation");
    if (operation === "operator.set_enabled") return this.setOperator(request);
    if (operation === "session.bind") return this.bindSession(request);
    if (operation === "session.unbind") return this.unbindSession(request);
    if (operation === "schedule.add") return this.addSchedule(request);
    if (operation === "schedule.upsert") return this.upsertSchedule(request);
    if (operation === "schedule.remove") return this.removeSchedule(request);
    if (operation === "schedule.pause") return this.pauseSchedule(request);
    if (operation === "schedule.resume") return this.resumeSchedule(request);
    throw new Error(`unsupported control operation: ${operation}`);
  }

  setOperator(request) {
    const name = assertNonEmpty(request.name, "name");
    const definition = OPERATOR_REGISTRY.find((entry) => entry.name === name);
    if (!definition) throw new Error(`unsupported operator: ${name}`);
    if (typeof request.enabled !== "boolean") throw new Error("enabled must be boolean");
    if (request.enabled && !["skeleton", "implemented"].includes(definition.status)) throw new Error(`operator is not implemented: ${name}`);
    const operators = this.store.getControl("operators") || {};
    operators[name] = { enabled: request.enabled };
    this.store.putControl("operators", operators);
    return { operation: "operator.set_enabled", name, enabled: request.enabled };
  }

  bindSession(request) {
    const alias = assertNonEmpty(request.alias, "alias");
    const target = normalizeTarget(request.target);
    const bindings = this.store.getControl("session_bindings") || {};
    const existing = bindings[alias];
    if (existing && JSON.stringify(existing.target) !== JSON.stringify(target) && request.replace !== true) {
      throw new Error(`session alias is already bound: ${alias}; use replace to rebind it`);
    }
    bindings[alias] = { alias, target, bound_at: new Date().toISOString() };
    this.store.putControl("session_bindings", bindings);
    return clone(bindings[alias]);
  }

  unbindSession(request) {
    const alias = assertNonEmpty(request.alias, "alias");
    const bindings = this.store.getControl("session_bindings") || {};
    const removed = bindings[alias] || null;
    delete bindings[alias];
    this.store.putControl("session_bindings", bindings);
    return { alias, removed: clone(removed) };
  }

  addSchedule(request) {
    const action = request.action || SCHEDULE_ACTIONS.NOTIFY;
    let alias = null;
    let target = request.target;
    if (action === SCHEDULE_ACTIONS.NOTIFY) {
      alias = assertNonEmpty(request.session, "session");
      const bindings = this.store.getControl("session_bindings") || {};
      const binding = bindings[alias];
      if (!binding) throw new Error(`session alias is not bound: ${alias}`);
      target = binding.target;
    } else if (action !== SCHEDULE_ACTIONS.SUBAGENT) {
      throw new Error(`unsupported schedule action: ${action}`);
    }
    const schedule = this.upsertSchedule({ ...request, action, target });
    const operators = this.store.getControl("operators") || {};
    operators.timer = { enabled: true };
    this.store.putControl("operators", operators);
    return { ...schedule, ...(alias == null ? {} : { session: alias }), timer_enabled: true };
  }

  upsertSchedule(request) {
    const id = assertNonEmpty(request.id, "id");
    const action = request.action || SCHEDULE_ACTIONS.NOTIFY;
    if (!Object.values(SCHEDULE_ACTIONS).includes(action)) throw new Error(`unsupported schedule action: ${action}`);
    const mode = request.mode || SCHEDULE_MODES.ONCE;
    if (!Object.values(SCHEDULE_MODES).includes(mode)) throw new Error(`unsupported schedule mode: ${mode}`);
    const at = assertNonEmpty(request.at, "at");
    const body = assertNonEmpty(request.body, "body");
    const sendMode = request.send_mode || SEND_MODES.IDLE_ONLY;
    if (!Object.values(SEND_MODES).includes(sendMode)) throw new Error(`unsupported send mode: ${sendMode}`);
    if (Number.isNaN(Date.parse(at))) throw new Error("schedule time must be an ISO timestamp");
    if (mode === SCHEDULE_MODES.INTERVAL) {
      if (!Number.isInteger(request.interval_ms) || request.interval_ms < 1) {
        throw new Error("schedule interval_ms must be a positive integer");
      }
    } else if (request.interval_ms != null) {
      throw new Error("schedule interval_ms is only valid for interval mode");
    }
    if (action === SCHEDULE_ACTIONS.SUBAGENT && mode === SCHEDULE_MODES.INTERVAL && request.allow_concurrent !== true) {
      throw new Error("recurring subagent schedules require allow_concurrent: true");
    }
    const target = action === SCHEDULE_ACTIONS.SUBAGENT
      ? normalizeTargetScope(request.target)
      : normalizeTarget(request.target);
    const schedules = this.store.getControl("schedules") || {};
    schedules[id] = {
      id,
      action,
      mode,
      at,
      ...(mode === SCHEDULE_MODES.INTERVAL ? { interval_ms: request.interval_ms } : {}),
      target,
      body,
      send_mode: sendMode,
      ...(action === SCHEDULE_ACTIONS.SUBAGENT ? {
        ...(request.cwd == null ? {} : { cwd: assertNonEmpty(request.cwd, "cwd") }),
        ...(request.model == null ? {} : { model: assertNonEmpty(request.model, "model") }),
        ...(request.allow_concurrent === true ? { allow_concurrent: true } : {}),
      } : {}),
      state: "configured",
      enabled: true,
    };
    this.store.putControl("schedules", schedules);
    return clone(schedules[id]);
  }

  removeSchedule(request) {
    const id = assertNonEmpty(request.id, "id");
    const schedules = this.store.getControl("schedules") || {};
    if (!Object.hasOwn(schedules, id)) throw new Error(`schedule not found: ${id}`);
    const removed = schedules[id];
    schedules[id] = { ...removed, enabled: false, state: "cancelled", cancelled_at: new Date().toISOString() };
    this.store.putControl("schedules", schedules);
    return { operation: "schedule.remove", removed: clone(schedules[id]) };
  }

  pauseSchedule(request) {
    const id = assertNonEmpty(request.id, "id");
    const schedules = this.store.getControl("schedules") || {};
    if (!Object.hasOwn(schedules, id)) throw new Error(`schedule not found: ${id}`);
    if (schedules[id].state === "cancelled") throw new Error(`schedule is terminal: ${id}`);
    schedules[id] = { ...schedules[id], enabled: false, state: "disabled" };
    this.store.putControl("schedules", schedules);
    return clone(schedules[id]);
  }

  resumeSchedule(request) {
    const id = assertNonEmpty(request.id, "id");
    const schedules = this.store.getControl("schedules") || {};
    if (!Object.hasOwn(schedules, id)) throw new Error(`schedule not found: ${id}`);
    if (schedules[id].state === "cancelled") throw new Error(`schedule is terminal: ${id}`);
    schedules[id] = { ...schedules[id], enabled: true, state: "enabled" };
    this.store.putControl("schedules", schedules);
    return clone(schedules[id]);
  }
}
