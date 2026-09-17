import {
  clone,
  normalizeTarget,
  normalizeTargetScope,
  SCHEDULE_ACTIONS,
  SCHEDULE_MODES,
  SEND_MODES,
} from "./protocol.js";

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

const TERMINAL_SCHEDULE_STATES = new Set(["cancelled", "stopped", "disabled", "failed", "sent", "completed", "unknown_delivery"]);
const OCCURRENCE_TERMINAL_STATES = new Set(["sent", "completed", "unknown_delivery", "failed"]);

export class TimerOperator {
  constructor({ store, dispatch, resume = null, createSubagent = null, registerSubagent = null, clock = new SystemClock() }) {
    if (!store || typeof store.getControl !== "function" || typeof store.putControl !== "function") {
      throw new Error("timer operator requires a control state store");
    }
    if (typeof dispatch !== "function") throw new Error("timer operator requires a daemon dispatch function");
    if (!clock || typeof clock.now !== "function") throw new Error("timer operator requires a clock");
    this.store = store;
    this.dispatch = dispatch;
    this.resume = resume;
    this.createSubagent = createSubagent;
    this.registerSubagent = registerSubagent;
    this.clock = clock;
  }

  async tick() {
    const operators = this.store.getControl("operators") || {};
    if (operators.timer?.enabled !== true) return [];
    const schedules = this.store.getControl("schedules") || {};
    const results = [];
    for (const schedule of Object.values(schedules).sort((left, right) => left.id.localeCompare(right.id))) {
      if (schedule.enabled === false || TERMINAL_SCHEDULE_STATES.has(schedule.state)) continue;
      const occurrence = this.claimOccurrence(schedule);
      if (!occurrence) continue;
      const { at, occurrenceId } = occurrence;
      const action = schedule.action || SCHEDULE_ACTIONS.NOTIFY;

      if ([SCHEDULE_ACTIONS.NOTIFY, SCHEDULE_ACTIONS.WAIT].includes(action) && schedule.state === "deferred_while_working" && typeof this.resume === "function") {
        const target = normalizeTarget(schedule.target);
        const resumed = await this.resume(target);
        const sent = resumed.sent?.find((delivery) => delivery.intent_id === occurrenceId);
        const failed = resumed.failed?.find((delivery) => delivery.intent_id === occurrenceId);
        if (sent) this.finishOccurrence(schedules, schedule, occurrence, { state: "sent", sent_at: this.clock.now() });
        else if (failed) this.finishOccurrence(schedules, schedule, occurrence, {
          state: failed.state === "unknown_delivery" ? "unknown_delivery" : "failed",
          failure: clone(failed.evidence || failed),
        });
        results.push({ schedule_id: schedule.id, occurrence_id: occurrenceId, action, at, result: resumed });
        continue;
      }

      this.updateSchedule(schedules, schedule, { state: "due", due_at: this.clock.now(), current_occurrence: occurrenceId });
      this.updateSchedule(schedules, schedule, { state: "claimed", claimed_at: this.clock.now(), current_occurrence: occurrenceId });
      try {
        this.updateSchedule(schedules, schedule, { state: "send_pending", send_pending_at: this.clock.now() });
        const result = action === SCHEDULE_ACTIONS.SUBAGENT
          ? await this.dispatchSubagent(schedule, occurrenceId, at)
          : await this.dispatchNotify(schedule, occurrenceId);
        const state = result.decision === "sent"
          ? "sent"
          : result.decision === "deferred"
            ? "deferred_while_working"
            : result.decision === "unknown_delivery"
              ? "unknown_delivery"
              : "failed";
        this.finishOccurrence(schedules, schedule, occurrence, {
          state,
          last_decision: result.decision,
          last_delivery: result.delivery || null,
        });
        results.push({ schedule_id: schedule.id, occurrence_id: occurrenceId, action, at, result });
      } catch (error) {
        this.finishOccurrence(schedules, schedule, occurrence, {
          state: "failed",
          failure: { code: error.code || "timer_dispatch_failed", message: error.message },
          ...(error.subagent_receipt == null ? {} : { last_delivery: clone(error.subagent_receipt) }),
        });
        results.push({
          schedule_id: schedule.id,
          occurrence_id: occurrenceId,
          action,
          at,
          error: { code: error.code || "timer_dispatch_failed", message: error.message },
        });
      }
    }
    return results;
  }

  claimOccurrence(schedule) {
    if (!schedule || !schedule.id || !schedule.at) return null;
    if (!this.isDue(schedule)) return null;
    const mode = schedule.mode || SCHEDULE_MODES.ONCE;
    const at = mode === SCHEDULE_MODES.INTERVAL
      ? schedule.next_at || schedule.at
      : schedule.at;
    const occurrenceId = `timer:${schedule.id}:${at}`;
    if (schedule.current_occurrence === occurrenceId && OCCURRENCE_TERMINAL_STATES.has(schedule.state)) return null;
    return { at, occurrenceId };
  }

  dispatchNotify(schedule, occurrenceId) {
    const target = normalizeTarget(schedule.target);
    return this.dispatch({
      intent_id: occurrenceId,
      source: "timer",
      target,
      body: schedule.body,
      send_mode: schedule.send_mode || SEND_MODES.IDLE_ONLY,
      event_key: occurrenceId,
      expires_at: schedule.expires_at || null,
    });
  }

  async dispatchSubagent(schedule, occurrenceId, at) {
    const target = normalizeTargetScope(schedule.target);
    const create = this.createSubagent;
    if (typeof create !== "function") {
      throw Object.assign(new Error("timer subagent action requires a codexapp create_subagent function"), {
        code: "subagent_capability_missing",
      });
    }
    const receipt = await create({
      target,
      prompt: schedule.body,
      attempt_id: occurrenceId,
      scheduled_at: at,
      ...(schedule.cwd == null ? {} : { cwd: schedule.cwd }),
      ...(schedule.model == null ? {} : { model: schedule.model }),
    });
    if (typeof this.registerSubagent === "function") {
      try {
        await this.registerSubagent({
          thread_id: receipt.thread_id,
          turn_id: receipt.turn_id,
          target,
          prompt: schedule.body,
          ...(schedule.owner_session_id == null ? {} : { owner_session_id: schedule.owner_session_id }),
          schedule_id: schedule.id,
          occurrence_id: occurrenceId,
          created_at: at,
        });
      } catch (error) {
        error.subagent_receipt = {
          intent_id: occurrenceId,
          state: "accepted",
          attempt_id: occurrenceId,
          thread_id: receipt.thread_id,
          turn_id: receipt.turn_id,
          receipt,
        };
        throw error;
      }
    }
    return {
      decision: "sent",
      delivery: {
        intent_id: occurrenceId,
        state: "accepted",
        attempt_id: occurrenceId,
        thread_id: receipt.thread_id,
        turn_id: receipt.turn_id,
        receipt,
      },
    };
  }

  finishOccurrence(schedules, schedule, occurrence, patch) {
    const latestSchedules = this.store.getControl("schedules") || schedules;
    const latest = latestSchedules[schedule.id];
    if (latest && ["cancelled", "stopped", "disabled"].includes(latest.state)) {
      this.updateSchedule(latestSchedules, latest, {
        current_occurrence: occurrence.occurrenceId,
        last_occurrence: occurrence.occurrenceId,
        ...(patch.last_decision == null ? {} : { last_decision: patch.last_decision }),
        ...(patch.last_delivery == null ? {} : { last_delivery: patch.last_delivery }),
        ...(patch.failure == null ? {} : { failure: patch.failure }),
      });
      return;
    }
    const mode = schedule.mode || SCHEDULE_MODES.ONCE;
    const terminal = patch.state === "sent" || patch.state === "unknown_delivery" || patch.state === "failed";
    if (mode === SCHEDULE_MODES.INTERVAL && terminal) {
      const intervalMs = schedule.interval_ms;
      const base = Date.parse(occurrence.at);
      const now = Date.parse(this.clock.now());
      const missed = Math.max(1, Math.floor((now - base) / intervalMs) + 1);
      const next = base + missed * intervalMs;
      this.updateSchedule(schedules, schedule, {
        ...patch,
        state: "enabled",
        enabled: true,
        current_occurrence: occurrence.occurrenceId,
        last_occurrence: occurrence.occurrenceId,
        next_at: new Date(next).toISOString(),
        next_occurrence_at: new Date(next).toISOString(),
      });
      return;
    }
    this.updateSchedule(schedules, schedule, {
      ...patch,
      current_occurrence: occurrence.occurrenceId,
      last_occurrence: occurrence.occurrenceId,
      ...(mode === SCHEDULE_MODES.ONCE && terminal ? { enabled: false } : {}),
      ...(patch.state === "sent" ? { completed_at: this.clock.now() } : {}),
    });
  }

  isDue(schedule) {
    if (!schedule || !schedule.id || !schedule.at || schedule.enabled === false) return false;
    const at = Date.parse((schedule.mode || SCHEDULE_MODES.ONCE) === SCHEDULE_MODES.INTERVAL
      ? schedule.next_at || schedule.at
      : schedule.at);
    if (Number.isNaN(at)) throw new Error(`schedule ${schedule.id} has an invalid timestamp`);
    return at <= Date.parse(this.clock.now());
  }

  updateSchedule(schedules, current, patch) {
    schedules[current.id] = { ...current, ...clone(patch) };
    this.store.putControl("schedules", schedules);
  }
}
