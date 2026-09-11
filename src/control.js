import { assertNonEmpty, clone, normalizeTarget, SEND_MODES } from "./protocol.js";

export const OPERATOR_REGISTRY = Object.freeze([
  { name: "stopless", hook_kinds: ["stop"], state_resource: "stopless_state", status: "contract-only" },
  { name: "update-goal", hook_kinds: ["update-goal"], state_resource: "update_goal_state", status: "contract-only" },
  { name: "timer", hook_kinds: [], triggers: ["daemon_clock"], state_resource: "schedule_state", status: "skeleton" },
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
      schedules: this.store.getControl("schedules") || {},
    };
  }

  mutate(request) {
    if (!request || typeof request !== "object") throw new Error("control mutation is required");
    const operation = assertNonEmpty(request.operation, "operation");
    if (operation === "operator.set_enabled") return this.setOperator(request);
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
    if (request.enabled && definition.status !== "skeleton") throw new Error(`operator is not implemented: ${name}`);
    const operators = this.store.getControl("operators") || {};
    operators[name] = { enabled: request.enabled };
    this.store.putControl("operators", operators);
    return { operation: "operator.set_enabled", name, enabled: request.enabled };
  }

  upsertSchedule(request) {
    const id = assertNonEmpty(request.id, "id");
    const at = assertNonEmpty(request.at, "at");
    const target = normalizeTarget(request.target);
    const body = assertNonEmpty(request.body, "body");
    const sendMode = request.send_mode || SEND_MODES.IDLE_ONLY;
    if (!Object.values(SEND_MODES).includes(sendMode)) throw new Error(`unsupported send mode: ${sendMode}`);
    if (Number.isNaN(Date.parse(at))) throw new Error("schedule time must be an ISO timestamp");
    const schedules = this.store.getControl("schedules") || {};
    schedules[id] = { id, at, target, body, send_mode: sendMode, state: "configured", enabled: true };
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
