import { clone, normalizeTarget, SEND_MODES } from "./protocol.js";

export class SystemClock {
  now() {
    return new Date().toISOString();
  }
}

export class ManualClock {
  constructor(initial = new Date().toISOString()) {
    this.set(initial);
  }

  now() {
    return new Date(this.epochMs).toISOString();
  }

  set(value) {
    const epochMs = Date.parse(value);
    if (Number.isNaN(epochMs)) throw new Error(`clock value must be an ISO timestamp: ${value}`);
    this.epochMs = epochMs;
    return this.now();
  }

  advance(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("clock advance must be a non-negative number");
    this.epochMs += milliseconds;
    return this.now();
  }
}

const TERMINAL_SCHEDULE_STATES = new Set(["cancelled", "disabled", "failed", "sent", "completed"]);

export class TimerOperator {
  constructor({ store, dispatch, resume = null, clock = new SystemClock() }) {
    if (!store || typeof store.getControl !== "function" || typeof store.putControl !== "function") {
      throw new Error("timer operator requires a control state store");
    }
    if (typeof dispatch !== "function") throw new Error("timer operator requires a daemon dispatch function");
    if (!clock || typeof clock.now !== "function") throw new Error("timer operator requires a clock");
    this.store = store;
    this.dispatch = dispatch;
    this.resume = resume;
    this.clock = clock;
  }

  async tick() {
    const operators = this.store.getControl("operators") || {};
    if (operators.timer?.enabled !== true) return [];
    const schedules = this.store.getControl("schedules") || {};
    const results = [];
    for (const schedule of Object.values(schedules).sort((left, right) => left.id.localeCompare(right.id))) {
      if (!this.isDue(schedule) || TERMINAL_SCHEDULE_STATES.has(schedule.state)) continue;
      const target = normalizeTarget(schedule.target);
      const occurrenceId = `timer:${schedule.id}:${schedule.at}`;

      if (schedule.state === "deferred_while_working" && typeof this.resume === "function") {
        const resumed = await this.resume(target);
        const sent = resumed.sent?.find((delivery) => delivery.intent_id === occurrenceId);
        const failed = resumed.failed?.find((delivery) => delivery.intent_id === occurrenceId);
        if (sent) this.updateSchedule(schedules, schedule, { state: "completed", completed_at: this.clock.now() });
        else if (failed) this.updateSchedule(schedules, schedule, { state: "failed", failure: clone(failed.evidence || failed) });
        results.push({ schedule_id: schedule.id, occurrence_id: occurrenceId, result: resumed });
        continue;
      }

      this.updateSchedule(schedules, schedule, { state: "claimed", claimed_at: this.clock.now() });
      const intent = {
        intent_id: occurrenceId,
        source: "timer",
        target,
        body: schedule.body,
        send_mode: schedule.send_mode || SEND_MODES.IDLE_ONLY,
        event_key: occurrenceId,
        expires_at: schedule.expires_at || null,
      };
      try {
        const result = await this.dispatch(intent);
        const state = result.decision === "sent"
          ? "completed"
          : result.decision === "deferred"
            ? "deferred_while_working"
            : "failed";
        this.updateSchedule(schedules, schedule, {
          state,
          last_decision: result.decision,
          last_delivery: result.delivery || null,
          ...(state === "completed" ? { completed_at: this.clock.now() } : {}),
        });
        results.push({ schedule_id: schedule.id, occurrence_id: occurrenceId, result });
      } catch (error) {
        this.updateSchedule(schedules, schedule, { state: "failed", failure: { code: error.code || "timer_dispatch_failed", message: error.message } });
        results.push({ schedule_id: schedule.id, occurrence_id: occurrenceId, error: { code: error.code || "timer_dispatch_failed", message: error.message } });
      }
    }
    return results;
  }

  isDue(schedule) {
    if (!schedule || !schedule.id || !schedule.at || schedule.enabled === false) return false;
    const at = Date.parse(schedule.at);
    if (Number.isNaN(at)) throw new Error(`schedule ${schedule.id} has an invalid timestamp`);
    return at <= Date.parse(this.clock.now());
  }

  updateSchedule(schedules, current, patch) {
    schedules[current.id] = { ...current, ...clone(patch) };
    this.store.putControl("schedules", schedules);
  }
}
