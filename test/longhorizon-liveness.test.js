import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HooksDaemon, MemoryStateStore } from "../src/daemon.js";
import { FrameworkControlPlane } from "../src/control.js";
import { JsonStateStore } from "../src/persistence.js";
import { ManualClock, TimerOperator } from "../src/timer.js";

const TARGET = {
  namespace: "codex_tui",
  appserver_id: "tui-appserver",
  session_id: "thread-1",
  thread_id: "thread-1",
};

function makeCodexapp(state, { statusError = null, sendError = null } = {}) {
  return {
    state,
    sends: [],
    steers: [],
    sendError,
    async session_status() {
      if (statusError) throw statusError;
      return { state: this.state };
    },
    async send_message(request) {
      if (this.sendError) {
        const error = this.sendError;
        this.sendError = null;
        throw error;
      }
      this.sends.push(request);
      return { accepted: true, attempt_id: request.attempt_id };
    },
    async steer_message(request) {
      this.steers.push(request);
      return { accepted: true, attempt_id: request.attempt_id };
    },
    async delivery_evidence({ attempt_id }) {
      return { attempt_id, target_receipt: { clientId: attempt_id }, source: "test" };
    },
  };
}

function setup({ store = new MemoryStateStore(), state = "idle", statusError = null, sendError = null, now = "2026-09-18T12:00:00.000Z" } = {}) {
  const codexapp = makeCodexapp(state, { statusError, sendError });
  const daemon = new HooksDaemon({ codexapp, store });
  let nowValue = now;
  const control = new FrameworkControlPlane({ store, now: () => nowValue });
  control.mutate({ operation: "session.bind", alias: "goal-session", target: TARGET });
  const registered = control.mutate({
    operation: "longhorizon.register",
    id: "goal-1",
    mode: "goal",
    goal_file: "/tmp/goal.md",
    session: "goal-session",
  });
  const intents = [];
  const timer = new TimerOperator({
    store,
    clock: new ManualClock(nowValue),
    dispatch: (intent) => {
      intents.push(intent);
      return daemon.dispatchIntent(intent, { kind: "longhorizon" });
    },
    resume: (target) => daemon.flushPending(target),
    sessionStatus: (target) => daemon.sessionStatus(target),
  });
  return {
    codexapp,
    daemon,
    control,
    store,
    timer,
    registered,
    intents,
    setNow: (value) => { nowValue = value; },
  };
}

test("longhorizon liveness waits 60 seconds before the first wake", async () => {
  const { codexapp, timer } = setup({ state: "idle" });
  assert.deepEqual(await timer.tick(), []);
  assert.equal(codexapp.sends.length, 0);
  timer.clock.advance(30_000);
  assert.deepEqual(await timer.tick(), []);
  timer.clock.advance(30_000);
  const fired = await timer.tick();
  assert.equal(fired.length, 1);
  assert.equal(fired[0].result.decision, "sent");
  assert.equal(codexapp.sends.length, 1);
  assert.deepEqual(await timer.tick(), []);
  assert.equal(codexapp.sends.length, 1);
});

test("longhorizon liveness wakes an idle target through queue", async () => {
  const { codexapp, timer, intents, store, registered } = setup({ state: "idle" });
  timer.clock.advance(60_000);
  const fired = await timer.tick();
  assert.equal(fired[0].result.decision, "sent");
  assert.equal(codexapp.sends.length, 1);
  assert.equal(intents[0].source, "longhorizon");
  assert.equal(intents[0].operation, "queue");
  assert.match(intents[0].body, /\/tmp\/goal\.md/);
  assert.match(intents[0].body, /continue executing the goal/);
  assert.equal(codexapp.steers.length, 0);
  assert.equal(Object.hasOwn(intents[0], "turn_id"), false);
  const schedule = store.getControl("schedules")[registered.liveness_schedule_id];
  assert.equal(schedule.state, "enabled");
  assert.equal(schedule.enabled, true);
  assert.equal(schedule.last_decision, "sent");
  assert.equal(schedule.next_at, "2026-09-18T12:02:00.000Z");
});

test("longhorizon liveness skips a working target without queueing", async () => {
  const { codexapp, timer, intents, store, registered } = setup({ state: "working" });
  timer.clock.advance(60_000);
  const fired = await timer.tick();
  assert.equal(fired[0].result.decision, "skipped");
  assert.equal(codexapp.sends.length, 0);
  assert.equal(codexapp.steers.length, 0);
  assert.equal(intents.length, 0);
  assert.equal(store.getControl("schedules")[registered.liveness_schedule_id].state, "enabled");
  assert.equal(store.getControl("schedules")[registered.liveness_schedule_id].enabled, true);
  assert.deepEqual(await timer.tick(), []);
});

test("longhorizon liveness keeps probing after a working target becomes idle", async () => {
  const { codexapp, timer, intents, store, registered } = setup({ state: "working" });
  timer.clock.advance(60_000);
  const skipped = await timer.tick();
  assert.equal(skipped[0].result.decision, "skipped");
  assert.equal(codexapp.sends.length, 0);
  assert.equal(store.getControl("schedules")[registered.liveness_schedule_id].enabled, true);

  codexapp.state = "idle";
  timer.clock.advance(60_000);
  const fired = await timer.tick();
  assert.equal(fired[0].result.decision, "sent");
  assert.equal(codexapp.sends.length, 1);
  assert.equal(codexapp.steers.length, 0);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].operation, "queue");
  assert.match(intents[0].body, /\/tmp\/goal\.md/);
});

test("longhorizon liveness wakes an interrupted target through queue", async () => {
  const { codexapp, timer, intents, store, registered } = setup({ state: "interrupted" });
  timer.clock.advance(60_000);
  const fired = await timer.tick();
  assert.equal(fired[0].result.decision, "sent");
  assert.equal(codexapp.sends.length, 1);
  assert.equal(intents[0].source, "longhorizon");
  assert.equal(intents[0].operation, "queue");
  assert.match(intents[0].body, /\/tmp\/goal\.md/);
  assert.match(intents[0].body, /continue executing the goal/);
  assert.equal(codexapp.steers.length, 0);
  assert.equal(store.getControl("schedules")[registered.liveness_schedule_id].state, "enabled");
  assert.equal(store.getControl("schedules")[registered.liveness_schedule_id].enabled, true);
});

test("longhorizon liveness applies the active idle interrupted state matrix through queue wake", async () => {
  const working = setup({ state: "working" });
  working.timer.clock.advance(60_000);
  const skipped = await working.timer.tick();
  assert.equal(skipped[0].result.decision, "skipped");
  assert.equal(working.codexapp.sends.length, 0);
  assert.equal(working.codexapp.steers.length, 0);
  assert.equal(working.intents.length, 0);

  for (const state of ["idle", "interrupted"]) {
    const target = setup({ state });
    target.timer.clock.advance(60_000);
    const fired = await target.timer.tick();
    assert.equal(fired[0].result.decision, "sent");
    assert.equal(target.codexapp.sends.length, 1);
    assert.equal(target.codexapp.steers.length, 0);
    assert.equal(target.intents.length, 1);
    assert.equal(target.intents[0].operation, "queue");
    assert.match(target.intents[0].body, /\/tmp\/goal\.md/);
    assert.match(target.intents[0].body, /continue executing the goal/);
  }
});

test("longhorizon liveness defers while starting or stopping and resumes on idle", async () => {
  for (const state of ["starting", "stopping"]) {
    const { codexapp, timer, store, registered } = setup({ state });
    timer.clock.advance(60_000);
    const deferred = await timer.tick();
    assert.equal(deferred[0].result.decision, "deferred");
    assert.equal(store.getControl("schedules")[registered.liveness_schedule_id].state, "deferred_while_working");
    assert.equal(codexapp.sends.length, 0);
    codexapp.state = "idle";
    const resumed = await timer.tick();
    assert.equal(resumed[0].result.sent.length, 1);
    assert.equal(codexapp.sends.length, 1);
    assert.equal(store.getControl("schedules")[registered.liveness_schedule_id].state, "enabled");
    assert.deepEqual(await timer.tick(), []);
  }
});

test("longhorizon liveness fails closed for unknown disconnected failed", async () => {
  for (const state of ["unknown", "disconnected", "failed"]) {
    const { codexapp, timer, store, registered } = setup({ state });
    timer.clock.advance(60_000);
    const fired = await timer.tick();
    assert.equal(fired[0].result.decision, "fail_closed");
    assert.equal(codexapp.sends.length, 0);
    assert.equal(store.getControl("schedules")[registered.liveness_schedule_id].state, "enabled");
    assert.equal(store.getControl("schedules")[registered.liveness_schedule_id].enabled, true);
    assert.equal(store.getControl("schedules")[registered.liveness_schedule_id].last_decision, "fail_closed");
    assert.equal(store.getControl("schedules")[registered.liveness_schedule_id].failure.code, `${state}_session`);
    assert.deepEqual(await timer.tick(), []);
  }
});

test("longhorizon liveness records a missing session as terminal", async () => {
  const statusError = Object.assign(new Error("session not found"), { code: "session_not_found" });
  const { codexapp, timer, store, registered } = setup({ statusError });
  timer.clock.advance(60_000);
  const fired = await timer.tick();
  assert.equal(fired[0].error.code, "session_not_found");
  assert.equal(store.getControl("schedules")[registered.liveness_schedule_id].state, "session_missing");
  assert.equal(store.getControl("schedules")[registered.liveness_schedule_id].enabled, false);
  assert.deepEqual(await timer.tick(), []);
});

test("longhorizon liveness pause stop and reactivate update the owned schedule", async () => {
  const handle = setup({ state: "idle" });
  handle.timer.clock.advance(60_000);
  await handle.timer.tick();
  assert.equal(handle.codexapp.sends.length, 1);
  handle.control.mutate({ operation: "longhorizon.pause", id: "goal-1" });
  assert.deepEqual(await handle.timer.tick(), []);
  assert.equal(handle.codexapp.sends.length, 1);
  handle.setNow("2026-09-18T13:00:00.000Z");
  handle.control.mutate({ operation: "longhorizon.activate", id: "goal-1" });
  const schedule = handle.store.getControl("schedules")[handle.registered.liveness_schedule_id];
  assert.equal(schedule.at, "2026-09-18T13:01:00.000Z");
  assert.equal(schedule.next_at, undefined);
  assert.equal(schedule.next_occurrence_at, undefined);
  assert.deepEqual(await handle.timer.tick(), []);
  handle.timer.clock.advance(59_999);
  assert.deepEqual(await handle.timer.tick(), []);
  assert.equal(handle.codexapp.sends.length, 1);
  handle.timer.clock.advance(1);
  handle.timer.clock.set("2026-09-18T13:01:00.000Z");
  const fired = await handle.timer.tick();
  assert.equal(fired[0].result.decision, "sent");
  assert.equal(handle.codexapp.sends.length, 2);
  handle.control.mutate({ operation: "longhorizon.stop", id: "goal-1" });
  assert.deepEqual(await handle.timer.tick(), []);
  assert.equal(handle.codexapp.sends.length, 2);
});

test("longhorizon liveness restart does not duplicate a terminal occurrence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rccs-liveness-restart-"));
  try {
    const stateFile = join(dir, "state.json");
    const first = setup({ store: new JsonStateStore(stateFile), state: "idle" });
    first.timer.clock.advance(60_000);
    const fired = await first.timer.tick();
    assert.equal(fired[0].result.decision, "sent");
    assert.equal(first.codexapp.sends.length, 1);
    const second = setup({ store: new JsonStateStore(stateFile), state: "idle" });
    assert.deepEqual(await second.timer.tick(), []);
    assert.equal(second.codexapp.sends.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("longhorizon liveness reconciles active goals with missing or terminal schedules", async () => {
  const store = new MemoryStateStore();
  let now = "2026-09-18T14:00:00.000Z";
  const control = new FrameworkControlPlane({ store, now: () => now });
  control.mutate({ operation: "session.bind", alias: "goal-session", target: TARGET });
  const missing = control.mutate({
    operation: "longhorizon.register",
    id: "missing-schedule",
    mode: "goal",
    goal_file: "/tmp/missing.md",
    session: "goal-session",
  });
  const terminal = control.mutate({
    operation: "longhorizon.register",
    id: "terminal-schedule",
    mode: "goal",
    goal_file: "/tmp/terminal.md",
    session: "goal-session",
  });
  const stopped = control.mutate({
    operation: "longhorizon.register",
    id: "stopped-schedule",
    mode: "goal",
    goal_file: "/tmp/stopped.md",
    session: "goal-session",
  });
  control.mutate({ operation: "longhorizon.stop", id: stopped.id });

  const records = store.getControl("longhorizon");
  delete records[missing.id].liveness_schedule_id;
  delete records[missing.id].liveness_check_due_at;
  delete records[missing.id].liveness_state;
  const schedules = store.getControl("schedules");
  delete schedules[missing.liveness_schedule_id];
  for (const state of ["stopped", "disabled", "failed", "sent", "completed", "unknown_delivery", "skipped", "session_missing"]) {
    const id = state === "stopped" ? terminal.id : `${terminal.id}-${state}`;
    const livenessScheduleId = state === "stopped"
      ? terminal.liveness_schedule_id
      : `longhorizon-liveness:${id}`;
    records[id] = {
      ...records[terminal.id],
      id,
      liveness_schedule_id: livenessScheduleId,
    };
    schedules[livenessScheduleId] = {
      ...schedules[terminal.liveness_schedule_id],
      id: livenessScheduleId,
      state,
      enabled: false,
    };
  }
  schedules[terminal.liveness_schedule_id] = {
    ...schedules[terminal.liveness_schedule_id],
    state: "stopped",
    enabled: false,
  };
  store.putControl("longhorizon", records);
  store.putControl("schedules", schedules);

  now = "2026-09-18T15:00:00.000Z";
  const reconciled = control.reconcileLongHorizon();
  assert.deepEqual(
    reconciled.map((entry) => entry.id).sort(),
    [missing.id, terminal.id, ...["disabled", "failed", "sent", "completed", "unknown_delivery", "skipped", "session_missing"].map((state) => `${terminal.id}-${state}`)].sort(),
  );
  const nextRecords = store.getControl("longhorizon");
  const nextSchedules = store.getControl("schedules");
  for (const id of [missing.id, terminal.id, ...["disabled", "failed", "sent", "completed", "unknown_delivery", "skipped", "session_missing"].map((state) => `${terminal.id}-${state}`)]) {
    const record = nextRecords[id];
    const schedule = nextSchedules[record.liveness_schedule_id];
    assert.equal(
      record.liveness_schedule_id.startsWith(`longhorizon-liveness:${id}`),
      true,
    );
    assert.equal(record.liveness_state, "scheduled");
    assert.equal(record.liveness_check_due_at, "2026-09-18T15:01:00.000Z");
    assert.equal(schedule.state, "configured");
    assert.equal(schedule.enabled, true);
    assert.equal(schedule.mode, "interval");
    assert.equal(schedule.interval_ms, 60_000);
    assert.equal(schedule.source, "longhorizon");
  }
  assert.equal(nextRecords[stopped.id].enabled, false);
  assert.equal(nextRecords[stopped.id].state, "stopped");
  const before = nextRecords[terminal.id].liveness_schedule_id;
  const second = control.reconcileLongHorizon();
  assert.deepEqual(
    second.map((entry) => entry.id).sort(),
    [missing.id, terminal.id, ...["disabled", "failed", "sent", "completed", "unknown_delivery", "skipped", "session_missing"].map((state) => `${terminal.id}-${state}`)].sort(),
  );
  assert.equal(store.getControl("longhorizon")[terminal.id].liveness_schedule_id, before);
});

test("longhorizon liveness accepted evidence is not promoted to executed without matching receipt", async () => {
  const { codexapp, daemon, timer } = setup({ state: "idle" });
  timer.clock.advance(60_000);
  const fired = await timer.tick();
  const intentId = fired[0].result.delivery.intent_id;
  assert.equal(daemon.store.getIntent(intentId).state, "accepted");
  const delivered = await daemon.reconcileDeliveryEvidence(intentId);
  assert.equal(delivered.state, "delivered");
  assert.equal(daemon.store.getIntent(intentId).state, "delivered");
  assert.equal(codexapp.sends.length, 1);
});

test("longhorizon liveness uncertain delivery reconciles without blind retry", async () => {
  const sendError = Object.assign(new Error("transport timeout"), { code: "transport_timeout" });
  const { codexapp, daemon, timer, store, registered } = setup({ state: "idle", sendError });
  timer.clock.advance(60_000);
  const fired = await timer.tick();
  assert.equal(fired[0].result.decision, "unknown_delivery");
  const schedule = store.getControl("schedules")[registered.liveness_schedule_id];
  assert.equal(schedule.state, "enabled");
  assert.equal(schedule.enabled, true);
  assert.equal(schedule.last_decision, "unknown_delivery");
  assert.equal(schedule.failure.code, "transport_timeout");
  assert.deepEqual(await timer.tick(), []);
  assert.equal(codexapp.sends.length, 0);
  timer.clock.advance(60_000);
  assert.deepEqual(await timer.tick(), []);
  assert.equal(codexapp.sends.length, 0);
  const intentId = fired[0].result.delivery.intent_id;
  const delivered = await daemon.reconcileDeliveryEvidence(intentId);
  assert.equal(delivered.state, "delivered");
  timer.clock.advance(60_000);
  const next = await timer.tick();
  assert.equal(next[0].result.decision, "sent");
  assert.equal(codexapp.sends.length, 1);
});

test("longhorizon liveness uses queue and never steers", async () => {
  const { codexapp, timer, intents } = setup({ state: "idle" });
  timer.clock.advance(60_000);
  await timer.tick();
  assert.equal(intents[0].source, "longhorizon");
  assert.equal(intents[0].operation, "queue");
  assert.equal(Object.hasOwn(intents[0], "turn_id"), false);
  assert.equal(codexapp.steers.length, 0);
});
