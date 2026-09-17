import crypto from "node:crypto";
import {
  assertNonEmpty,
  clone,
  normalizeTarget,
  normalizeTargetScope,
  BUSY_POLICIES,
  SCHEDULE_ACTIONS,
  SCHEDULE_MODES,
  SEND_MODES,
} from "./protocol.js";

export const OPERATOR_REGISTRY = Object.freeze([
  { name: "stopless", hook_kinds: ["stop"], state_resource: "stopless_state", status: "implemented" },
  { name: "update-goal", hook_kinds: ["update-goal"], state_resource: "update_goal_state", status: "contract-only" },
  { name: "timer", hook_kinds: [], triggers: ["daemon_clock"], state_resource: "schedule_state", status: "implemented" },
  { name: "longhorizon", hook_kinds: ["stop"], triggers: ["daemon_clock"], state_resource: "longhorizon_state", status: "implemented" },
  { name: "memory", hook_kinds: ["input", "tool-call"], state_resource: "memory_state", status: "out-of-scope" },
]);
const OPERATORS = Object.freeze(OPERATOR_REGISTRY.map((entry) => entry.name));

export class FrameworkControlPlane {
  constructor({ store, subagents = null }) {
    if (!store || typeof store.getControl !== "function" || typeof store.putControl !== "function") {
      throw new Error("control plane requires a state store");
    }
    this.store = store;
    this.subagents = subagents;
  }

  query() {
    return {
      operators: this.store.getControl("operators") || Object.fromEntries(OPERATORS.map((name) => [name, { enabled: false }])),
      operator_registry: clone(OPERATOR_REGISTRY),
      session_bindings: this.store.getControl("session_bindings") || {},
      schedules: this.store.getControl("schedules") || {},
      subagents: this.store.getControl("subagents") || {},
      longhorizon: this.store.getControl("longhorizon") || {},
      goal_reviews: this.store.getControl("goal_reviews") || {},
      stop_suppression: this.store.getControl("stop_suppression") || {},
      delivery_intents: this.listDeliveryIntents(),
    };
  }

  listDeliveryIntents() {
    if (!this.store.listIntents) return {};
    return Object.fromEntries(this.store.listIntents().map((record) => [record.intent_id, clone(record)]));
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
    if (operation === "schedule.update") return this.updateSchedule(request);
    if (operation === "schedule.stop") return this.stopSchedule(request);
    if (operation === "wait.create" || operation === "wait.block") return this.addWait(request);
    if (operation === "longhorizon.register") return this.registerLongHorizon(request);
    if (operation === "longhorizon.activate") return this.setLongHorizonEnabled(request, true);
    if (operation === "longhorizon.pause") return this.setLongHorizonEnabled(request, false);
    if (operation === "longhorizon.stop") return this.stopLongHorizon(request);
    if (operation === "longhorizon.remove") return this.removeLongHorizon(request);
    if (operation === "subagent.create") return this.createSubagent(request);
    if (operation === "subagent.stop") return this.stopSubagent(request);
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
    if (action === SCHEDULE_ACTIONS.NOTIFY || action === SCHEDULE_ACTIONS.WAIT) {
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

  addWait(request) {
    if (request.mode != null && request.mode !== SCHEDULE_MODES.ONCE) {
      throw new Error("wait schedules must be one-shot");
    }
    return this.addSchedule({ ...request, action: SCHEDULE_ACTIONS.WAIT, mode: SCHEDULE_MODES.ONCE });
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
    const busyPolicy = request.busy_policy || BUSY_POLICIES.DEFER;
    if (!Object.values(BUSY_POLICIES).includes(busyPolicy)) throw new Error(`unsupported busy policy: ${busyPolicy}`);
    if (Number.isNaN(Date.parse(at))) throw new Error("schedule time must be an ISO timestamp");
    if (action === SCHEDULE_ACTIONS.WAIT && mode !== SCHEDULE_MODES.ONCE) {
      throw new Error("wait schedules must be one-shot");
    }
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
    const ownerSessionId = request.owner_session_id
      ?? (([SCHEDULE_ACTIONS.NOTIFY, SCHEDULE_ACTIONS.WAIT].includes(action) && target.thread_id) ? target.thread_id : null);
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
      busy_policy: busyPolicy,
      ...(ownerSessionId == null ? {} : { owner_session_id: assertNonEmpty(ownerSessionId, "owner_session_id") }),
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
    const removed = requireSchedule(schedules, id);
    schedules[id] = { ...removed, enabled: false, state: "cancelled", cancelled_at: new Date().toISOString() };
    this.store.putControl("schedules", schedules);
    return { operation: "schedule.remove", removed: clone(schedules[id]) };
  }

  pauseSchedule(request) {
    const id = assertNonEmpty(request.id, "id");
    const schedules = this.store.getControl("schedules") || {};
    const schedule = requireSchedule(schedules, id);
    if (isTerminalSchedule(schedule)) throw new Error(`schedule is terminal: ${id}`);
    schedules[id] = { ...schedule, enabled: false, state: "disabled" };
    this.store.putControl("schedules", schedules);
    return clone(schedules[id]);
  }

  resumeSchedule(request) {
    const id = assertNonEmpty(request.id, "id");
    const schedules = this.store.getControl("schedules") || {};
    const schedule = requireSchedule(schedules, id);
    if (isTerminalSchedule(schedule)) throw new Error(`schedule is terminal: ${id}`);
    schedules[id] = { ...schedule, enabled: true, state: "enabled" };
    this.store.putControl("schedules", schedules);
    return clone(schedules[id]);
  }

  updateSchedule(request) {
    const id = assertNonEmpty(request.id, "id");
    const schedules = this.store.getControl("schedules") || {};
    const current = requireSchedule(schedules, id);
    if (isTerminalSchedule(current)) throw new Error(`schedule is terminal: ${id}`);
    const patchRequest = { ...request };
    if (request.session != null) {
      if (request.target != null) throw new Error("pass either session or target, not both");
      if (request.action != null && ![SCHEDULE_ACTIONS.NOTIFY, SCHEDULE_ACTIONS.WAIT].includes(request.action)) {
        throw new Error("session target requires action notify or wait");
      }
      if (![SCHEDULE_ACTIONS.NOTIFY, SCHEDULE_ACTIONS.WAIT].includes(current.action) && request.action == null) {
        throw new Error("session target requires action notify or wait for subagent schedules");
      }
      patchRequest.target = this.resolveSessionTarget(request.session);
      patchRequest.action = request.action || SCHEDULE_ACTIONS.NOTIFY;
    }
    if (patchRequest.target != null) {
      patchRequest.action ??= current.action;
    }
    const patch = normalizeSchedulePatch(patchRequest, current);
    const updated = { ...current, ...patch };
    if (updated.action === SCHEDULE_ACTIONS.NOTIFY) {
      delete updated.cwd;
      delete updated.model;
      delete updated.allow_concurrent;
    }
    const scheduleFieldsChanged = patch.at != null
      || patch.mode != null
      || patch.interval_ms != null
      || patch.target != null
      || patch.action != null;
    if (scheduleFieldsChanged) {
      updated.state = "configured";
      updated.enabled = true;
      delete updated.next_at;
      delete updated.next_occurrence_at;
      delete updated.current_occurrence;
    }
    if (updated.mode === SCHEDULE_MODES.ONCE) delete updated.interval_ms;
    schedules[id] = updated;
    this.store.putControl("schedules", schedules);
    return clone(updated);
  }

  stopSchedule(request) {
    const id = assertNonEmpty(request.id, "id");
    const schedules = this.store.getControl("schedules") || {};
    const schedule = requireSchedule(schedules, id);
    if (!STOPPABLE_SCHEDULE_STATES.has(schedule.state)) {
      throw new Error(`schedule cannot be stopped from state: ${schedule.state}`);
    }
    schedules[id] = {
      ...schedule,
      enabled: false,
      state: "stopped",
      stopped_at: new Date().toISOString(),
    };
    this.store.putControl("schedules", schedules);
    return clone(schedules[id]);
  }

  registerSubagent(request) {
    const threadId = assertNonEmpty(request.thread_id, "thread_id");
    const turnId = assertNonEmpty(request.turn_id, "turn_id");
    const target = normalizeTargetScope(request.target);
    const subagents = this.store.getControl("subagents") || {};
    const existing = subagents[threadId];
    if (existing) {
      if (existing.turn_id !== turnId || JSON.stringify(existing.target) !== JSON.stringify(target)) {
        throw new Error(`subagent thread is already registered with different identity: ${threadId}`);
      }
      return clone(existing);
    }
    subagents[threadId] = {
      thread_id: threadId,
      turn_id: turnId,
      target,
      prompt_digest: request.prompt_digest || digestPrompt(assertNonEmpty(request.prompt, "prompt")),
      state: "active",
      created_at: request.created_at || new Date().toISOString(),
      last_seen_at: request.created_at || new Date().toISOString(),
      ephemeral: request.ephemeral === true,
      ...(request.profile == null ? {} : { profile: assertNonEmpty(request.profile, "profile") }),
      ...(request.model == null ? {} : { model: assertNonEmpty(request.model, "model") }),
      ...(request.effort == null ? {} : { effort: assertNonEmpty(request.effort, "effort") }),
      ...(request.owner_session_id == null ? {} : { owner_session_id: assertNonEmpty(request.owner_session_id, "owner_session_id") }),
      ...(request.schedule_id == null ? {} : { schedule_id: assertNonEmpty(request.schedule_id, "schedule_id") }),
      ...(request.occurrence_id == null ? {} : { occurrence_id: assertNonEmpty(request.occurrence_id, "occurrence_id") }),
      ...(request.kind == null ? {} : { kind: assertNonEmpty(request.kind, "kind") }),
      ...(request.review_id == null ? {} : { review_id: assertNonEmpty(request.review_id, "review_id") }),
      ...(request.source_session_id == null ? {} : { source_session_id: assertNonEmpty(request.source_session_id, "source_session_id") }),
      ...(request.source_turn_id == null ? {} : { source_turn_id: assertNonEmpty(request.source_turn_id, "source_turn_id") }),
      ...(request.create_receipt == null ? {} : { create_receipt: clone(request.create_receipt) }),
    };
    this.store.putControl("subagents", subagents);
    return clone(subagents[threadId]);
  }

  async createSubagent(request) {
    if (!this.subagents || typeof this.subagents.createSubagent !== "function") {
      throw new Error("subagent create requires daemon native create capability");
    }
    const target = normalizeTargetScope(request.target);
    const prompt = assertNonEmpty(request.prompt, "prompt");
    const attemptId = assertNonEmpty(request.attempt_id || `subagent:${Date.now()}:${process.pid}`, "attempt_id");
    if (request.profile != null) {
      throw Object.assign(new Error("subagent profile is not supported by the native App Server create boundary"), {
        code: "unsupported_profile",
      });
    }
    const receipt = await this.subagents.createSubagent({
      target,
      prompt,
      attempt_id: attemptId,
      ...(request.cwd == null ? {} : { cwd: assertNonEmpty(request.cwd, "cwd") }),
      ...(request.model == null ? {} : { model: assertNonEmpty(request.model, "model") }),
      ...(request.effort == null ? {} : { effort: assertNonEmpty(request.effort, "effort") }),
      ...(request.ephemeral === true ? { ephemeral: true } : {}),
    });
    return this.registerSubagent({
      thread_id: receipt.thread_id,
      turn_id: receipt.turn_id,
      target,
      prompt,
      ephemeral: request.ephemeral === true,
      ...(request.model == null ? {} : { model: request.model }),
      ...(request.effort == null ? {} : { effort: request.effort }),
      ...(request.owner_session_id == null ? {} : { owner_session_id: request.owner_session_id }),
      create_receipt: receipt,
    });
  }

  async stopSubagent(request) {
    const threadId = assertNonEmpty(request.thread_id, "thread_id");
    const subagents = this.store.getControl("subagents") || {};
    const subagent = subagents[threadId];
    if (!subagent) throw new Error(`subagent not found: ${threadId}`);
    if (["stopped", "released"].includes(subagent.state)) return clone(subagent);
    if (!this.subagents
      || typeof this.subagents.sessionStatus !== "function"
      || typeof this.subagents.interruptSubagent !== "function") {
      throw new Error("subagent stop requires daemon native stop capabilities");
    }
    const target = {
      ...subagent.target,
      session_id: threadId,
      thread_id: threadId,
    };
    const status = await this.subagents.sessionStatus(target);
    const nativeState = status?.state;
    if (nativeState !== "working") {
      subagents[threadId] = {
        ...subagent,
        state: subagent.ephemeral ? "released" : "stopped",
        stopped_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        stop_evidence: { state: "no_active_turn", native_state: nativeState },
      };
      this.store.putControl("subagents", subagents);
      return clone(subagents[threadId]);
    }
    if (status.active_turn_id != null && status.active_turn_id !== subagent.turn_id) {
      throw Object.assign(new Error("subagent stop requires the registered live turn"), {
        code: "subagent_active_turn_mismatch",
        expected_turn_id: subagent.turn_id,
        observed_turn_id: status.active_turn_id,
      });
    }
    const receipt = await this.subagents.interruptSubagent({ target, thread_id: threadId, turn_id: subagent.turn_id });
    subagents[threadId] = {
      ...subagent,
      state: subagent.ephemeral ? "released" : "stopped",
      stopped_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      stop_evidence: receipt,
    };
    this.store.putControl("subagents", subagents);
    return clone(subagents[threadId]);
  }

  registerLongHorizon(request) {
    const id = assertNonEmpty(request.id, "id");
    const mode = assertNonEmpty(request.mode, "mode");
    if (!["periodic", "goal"].includes(mode)) throw new Error(`unsupported longhorizon mode: ${mode}`);
    const records = this.store.getControl("longhorizon") || {};
    const existing = records[id];
    if (existing) {
      if (existing.mode !== mode) throw new Error(`longhorizon id is already registered with different mode: ${id}`);
      return clone(existing);
    }
    const record = {
      id,
      mode,
      enabled: false,
      state: "registered",
      registered_at: new Date().toISOString(),
      ...(request.goal_file == null ? {} : { goal_file: assertNonEmpty(request.goal_file, "goal_file") }),
      ...(request.prompt == null ? {} : { prompt: assertNonEmpty(request.prompt, "prompt") }),
      ...(request.session == null ? {} : { session: assertNonEmpty(request.session, "session") }),
      ...(request.interval_ms == null ? {} : { interval_ms: positiveInteger(request.interval_ms, "interval_ms") }),
      ...(request.owner_session_id == null ? {} : { owner_session_id: assertNonEmpty(request.owner_session_id, "owner_session_id") }),
      ...(request.review_budget == null ? {} : { review_budget: positiveInteger(request.review_budget, "review_budget") }),
    };
    if (mode === "periodic") {
      if (!record.prompt || !record.session || !record.interval_ms) {
        throw new Error("periodic longhorizon requires prompt, session, and interval_ms");
      }
      const target = this.resolveSessionTarget(record.session);
      record.target = target;
      record.owner_session_id = record.owner_session_id || target.thread_id;
      const schedule = this.upsertSchedule({
        operation: "schedule.upsert",
        id: `longhorizon:${id}`,
        action: SCHEDULE_ACTIONS.NOTIFY,
        mode: SCHEDULE_MODES.INTERVAL,
        at: request.at || new Date().toISOString(),
        interval_ms: record.interval_ms,
        body: record.prompt,
        target,
        send_mode: SEND_MODES.IDLE_ONLY,
        busy_policy: BUSY_POLICIES.SKIP,
        owner_session_id: record.owner_session_id || target.thread_id,
      });
      this.pauseSchedule({ id: schedule.id });
      record.schedule_id = schedule.id;
      record.schedule_state = "disabled";
    } else {
      if (!record.goal_file || !record.session) throw new Error("goal longhorizon requires goal_file and session");
      const target = this.resolveSessionTarget(record.session);
      record.target = target;
      record.owner_session_id = record.owner_session_id || target.thread_id;
      record.review_budget ??= 1;
      record.review_count ??= 0;
    }
    records[id] = record;
    this.store.putControl("longhorizon", records);
    this.syncOperatorState(records);
    return clone(record);
  }

  setLongHorizonEnabled(request, enabled) {
    const id = assertNonEmpty(request.id, "id");
    const records = this.store.getControl("longhorizon") || {};
    const record = records[id];
    if (!record) throw new Error(`longhorizon not found: ${id}`);
    if (record.state === "removed") throw new Error(`longhorizon is removed: ${id}; register it again before activation`);
    if (record.state === "stopped") throw new Error(`longhorizon is stopped: ${id}; register it again before activation`);
    records[id] = {
      ...record,
      enabled,
      state: enabled ? "active" : "paused",
      ...(enabled ? { activated_at: new Date().toISOString() } : { paused_at: new Date().toISOString() }),
    };
    this.store.putControl("longhorizon", records);
    if (record.mode === "periodic" && record.schedule_id) {
      this.mutate({
        operation: enabled ? "schedule.resume" : "schedule.pause",
        id: record.schedule_id,
      });
      records[id] = {
        ...records[id],
        schedule_state: enabled ? "enabled" : "disabled",
      };
      this.store.putControl("longhorizon", records);
    }
    this.syncOperatorState(records);
    return clone(records[id]);
  }

  stopLongHorizon(request) {
    const id = assertNonEmpty(request.id, "id");
    const records = this.store.getControl("longhorizon") || {};
    const record = records[id];
    if (!record) throw new Error(`longhorizon not found: ${id}`);
    records[id] = {
      ...record,
      enabled: false,
      state: "stopped",
      stopped_at: new Date().toISOString(),
    };
    this.store.putControl("longhorizon", records);
    if (record.mode === "periodic" && record.schedule_id) {
      const schedules = this.store.getControl("schedules") || {};
      const schedule = schedules[record.schedule_id];
      if (schedule && !isTerminalSchedule(schedule)) {
        this.mutate({ operation: "schedule.stop", id: record.schedule_id });
      }
    }
    this.syncOperatorState(records);
    return clone(records[id]);
  }

  removeLongHorizon(request) {
    const stopped = this.stopLongHorizon(request);
    const records = this.store.getControl("longhorizon") || {};
    records[stopped.id] = {
      ...records[stopped.id],
      state: "removed",
      removed_at: new Date().toISOString(),
    };
    this.store.putControl("longhorizon", records);
    return clone(records[stopped.id]);
  }

  resolveSessionTarget(alias) {
    assertNonEmpty(alias, "session");
    const bindings = this.store.getControl("session_bindings") || {};
    if (!bindings[alias]) throw new Error(`session alias is not bound: ${alias}`);
    return bindings[alias].target;
  }

  syncOperatorState(records = this.store.getControl("longhorizon") || {}) {
    const active = Object.values(records).filter((record) => record?.enabled === true);
    const schedules = this.store.getControl("schedules") || {};
    const enabledSchedule = Object.values(schedules).some((schedule) => schedule?.enabled === true);
    const operators = this.store.getControl("operators") || {};
    operators.longhorizon = { enabled: active.length > 0 };
    operators.stopless = { enabled: active.some((record) => record.mode === "goal") };
    operators.timer = { enabled: active.some((record) => record.mode === "periodic") || enabledSchedule };
    this.store.putControl("operators", operators);
  }
}

function digestPrompt(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

const TERMINAL_SCHEDULE_STATES = new Set(["cancelled", "stopped"]);
const STOPPABLE_SCHEDULE_STATES = new Set([
  "configured",
  "enabled",
  "disabled",
  "deferred_while_working",
  "send_pending",
]);

function isTerminalSchedule(schedule) {
  return TERMINAL_SCHEDULE_STATES.has(schedule.state);
}

function requireSchedule(schedules, id) {
  if (!Object.hasOwn(schedules, id)) throw new Error(`schedule not found: ${id}`);
  return schedules[id];
}

function normalizeSchedulePatch(request, current) {
  const patch = {};
  const action = request.action ?? current.action ?? SCHEDULE_ACTIONS.NOTIFY;
  if (!Object.values(SCHEDULE_ACTIONS).includes(action)) throw new Error(`unsupported schedule action: ${action}`);
  if (request.action != null) patch.action = action;

  const mode = request.mode ?? current.mode ?? SCHEDULE_MODES.ONCE;
  if (!Object.values(SCHEDULE_MODES).includes(mode)) throw new Error(`unsupported schedule mode: ${mode}`);
  if (request.mode != null) patch.mode = mode;
  if (action === SCHEDULE_ACTIONS.WAIT && mode !== SCHEDULE_MODES.ONCE) {
    throw new Error("wait schedules must be one-shot");
  }

  if (request.at != null) {
    assertNonEmpty(request.at, "at");
    if (Number.isNaN(Date.parse(request.at))) throw new Error("schedule time must be an ISO timestamp");
    patch.at = request.at;
  }
  if (request.body != null) patch.body = assertNonEmpty(request.body, "body");
  if (request.owner_session_id != null) {
    patch.owner_session_id = assertNonEmpty(request.owner_session_id, "owner_session_id");
  }
  if (request.send_mode != null) {
    if (!Object.values(SEND_MODES).includes(request.send_mode)) throw new Error(`unsupported send mode: ${request.send_mode}`);
    patch.send_mode = request.send_mode;
  }
  if (request.busy_policy != null) {
    if (!Object.values(BUSY_POLICIES).includes(request.busy_policy)) throw new Error(`unsupported busy policy: ${request.busy_policy}`);
    patch.busy_policy = request.busy_policy;
  }
  if (request.target != null || request.action != null) {
    const target = request.target ?? current.target;
    patch.target = action === SCHEDULE_ACTIONS.SUBAGENT
      ? normalizeTargetScope(target)
      : normalizeTarget(target);
  }
  if (request.cwd != null) patch.cwd = assertNonEmpty(request.cwd, "cwd");
  if (request.model != null) patch.model = assertNonEmpty(request.model, "model");
  if (request.allow_concurrent != null) {
    if (typeof request.allow_concurrent !== "boolean") throw new Error("allow_concurrent must be boolean");
    patch.allow_concurrent = request.allow_concurrent;
  }
  const intervalMs = request.interval_ms ?? current.interval_ms;
  if (mode === SCHEDULE_MODES.INTERVAL) {
    if (!Number.isInteger(intervalMs) || intervalMs < 1) {
      throw new Error("schedule interval_ms must be a positive integer");
    }
  } else if (request.interval_ms != null) {
    throw new Error("schedule interval_ms is only valid for interval mode");
  }
  if (request.interval_ms != null) {
    patch.interval_ms = request.interval_ms;
  }
  if (action === SCHEDULE_ACTIONS.SUBAGENT && mode === SCHEDULE_MODES.INTERVAL && (request.allow_concurrent ?? current.allow_concurrent) !== true) {
    throw new Error("recurring subagent schedules require allow_concurrent: true");
  }
  return patch;
}
