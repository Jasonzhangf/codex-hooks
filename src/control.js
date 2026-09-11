import { assertNonEmpty, clone, normalizeTarget, SEND_MODES } from "./protocol.js";

const OPERATORS = Object.freeze(["stopless", "update-goal", "timer", "longhorizon", "memory"]);

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
      schedules: this.store.getControl("schedules") || {},
    };
  }

  mutate(request) {
    if (!request || typeof request !== "object") throw new Error("control mutation is required");
    const operation = assertNonEmpty(request.operation, "operation");
    if (operation === "operator.set_enabled") return this.setOperator(request);
    if (operation === "schedule.upsert") return this.upsertSchedule(request);
    if (operation === "schedule.remove") return this.removeSchedule(request);
    throw new Error(`unsupported control operation: ${operation}`);
  }

  setOperator(request) {
    const name = assertNonEmpty(request.name, "name");
    if (!OPERATORS.includes(name)) throw new Error(`unsupported operator: ${name}`);
    if (typeof request.enabled !== "boolean") throw new Error("enabled must be boolean");
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
    const schedules = this.store.getControl("schedules") || {};
    schedules[id] = { id, at, target, body, send_mode: sendMode, state: "scheduled" };
    this.store.putControl("schedules", schedules);
    return clone(schedules[id]);
  }

  removeSchedule(request) {
    const id = assertNonEmpty(request.id, "id");
    const schedules = this.store.getControl("schedules") || {};
    if (!Object.hasOwn(schedules, id)) throw new Error(`schedule not found: ${id}`);
    const removed = schedules[id];
    delete schedules[id];
    this.store.putControl("schedules", schedules);
    return { operation: "schedule.remove", removed: clone(removed) };
  }
}
