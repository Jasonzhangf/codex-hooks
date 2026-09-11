import assert from "node:assert/strict";
import test from "node:test";
import { HooksDaemon, MemoryStateStore } from "../src/daemon.js";
import { FrameworkControlPlane } from "../src/control.js";
import { JsonStateStore } from "../src/persistence.js";
import { ManualClock, TimerOperator } from "../src/timer.js";
import { SEND_MODES } from "../src/protocol.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TARGET = {
  namespace: "codex_tui",
  appserver_id: "tui-appserver",
  session_id: "session-1",
  thread_id: "thread-1",
};

function app(state = "idle") {
  return {
    state,
    sends: [],
    async session_status() { return { state: this.state }; },
    async send_message(request) {
      this.sends.push(request);
      return { accepted: true, attempt_id: request.attempt_id };
    },
  };
}

function setup({ state = "idle", store = new MemoryStateStore(), sendMode = SEND_MODES.IDLE_ONLY } = {}) {
  const codexapp = app(state);
  const daemon = new HooksDaemon({ codexapp, store });
  const control = new FrameworkControlPlane({ store });
  control.mutate({ operation: "operator.set_enabled", name: "timer", enabled: true });
  control.mutate({
    operation: "schedule.upsert",
    id: "daily-check",
    at: "2026-09-11T10:00:00.000Z",
    body: "timer wake",
    target: TARGET,
    send_mode: sendMode,
  });
  return { codexapp, daemon, control, store };
}

test("manual clock keeps a timer deterministic and sends exactly once when due", async () => {
  const { codexapp, daemon, store } = setup();
  const clock = new ManualClock("2026-09-11T09:59:00.000Z");
  const timer = new TimerOperator({
    store,
    clock,
    dispatch: (intent) => daemon.dispatchIntent(intent, { kind: "timer" }),
  });

  assert.deepEqual(await timer.tick(), []);
  assert.equal(codexapp.sends.length, 0);
  clock.advance(60_000);
  const fired = await timer.tick();
  assert.equal(fired.length, 1);
  assert.equal(fired[0].result.event, "daemon:timer");
  assert.equal(fired[0].result.kind, "timer");
  assert.equal(codexapp.sends.length, 1);
  assert.equal(store.getControl("schedules")["daily-check"].state, "sent");
  assert.deepEqual(await timer.tick(), []);
  assert.equal(codexapp.sends.length, 1);
});

test("timer due while working is deferred and resumes after idle", async () => {
  const { codexapp, daemon, store } = setup({ state: "working" });
  const clock = new ManualClock("2026-09-11T10:00:00.000Z");
  const timer = new TimerOperator({
    store,
    clock,
    dispatch: (intent) => daemon.dispatchIntent(intent, { kind: "timer" }),
    resume: (target) => daemon.flushPending(target),
  });

  const deferred = await timer.tick();
  assert.equal(deferred[0].result.decision, "deferred");
  assert.equal(store.getControl("schedules")["daily-check"].state, "deferred_while_working");
  assert.equal(codexapp.sends.length, 0);

  codexapp.state = "idle";
  const resumed = await timer.tick();
  assert.equal(resumed[0].result.sent.length, 1);
  assert.equal(store.getControl("schedules")["daily-check"].state, "sent");
  assert.equal(codexapp.sends.length, 1);
});

test("working_allowed timer explicitly sends while working", async () => {
  const { codexapp, daemon, store } = setup({ state: "working", sendMode: SEND_MODES.WORKING_ALLOWED });
  const timer = new TimerOperator({
    store,
    clock: new ManualClock("2026-09-11T10:00:00.000Z"),
    dispatch: (intent) => daemon.dispatchIntent(intent, { kind: "timer" }),
  });

  const result = await timer.tick();
  assert.equal(result[0].result.decision, "sent");
  assert.equal(codexapp.sends.length, 1);
});

test("timer preserves unknown delivery as unresolved and never retries blindly", async () => {
  const { store } = setup();
  const timer = new TimerOperator({
    store,
    clock: new ManualClock("2026-09-11T10:00:00.000Z"),
    dispatch: async () => ({ decision: "unknown_delivery", delivery: { state: "unknown_delivery" } }),
  });
  const result = await timer.tick();
  assert.equal(result[0].result.decision, "unknown_delivery");
  assert.equal(store.getControl("schedules")["daily-check"].state, "unknown_delivery");
  assert.deepEqual(await timer.tick(), []);
});

test("timer deferred state survives daemon restart without duplicate delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-hooks-timer-"));
  const stateFile = join(directory, "state.json");
  try {
    const first = setup({ state: "working", store: new JsonStateStore(stateFile) });
    const clock = new ManualClock("2026-09-11T10:00:00.000Z");
    const firstTimer = new TimerOperator({
      store: first.store,
      clock,
      dispatch: (intent) => first.daemon.dispatchIntent(intent, { kind: "timer" }),
      resume: (target) => first.daemon.flushPending(target),
    });
    await firstTimer.tick();
    assert.equal(first.codexapp.sends.length, 0);

    const secondApp = app("idle");
    const secondStore = new JsonStateStore(stateFile);
    const secondDaemon = new HooksDaemon({ codexapp: secondApp, store: secondStore });
    const secondTimer = new TimerOperator({
      store: secondStore,
      clock,
      dispatch: (intent) => secondDaemon.dispatchIntent(intent, { kind: "timer" }),
      resume: (target) => secondDaemon.flushPending(target),
    });
    const resumed = await secondTimer.tick();
    assert.equal(resumed[0].result.sent.length, 1);
    assert.equal(secondApp.sends.length, 1);
    assert.deepEqual(await secondTimer.tick(), []);
    assert.equal(secondApp.sends.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("disabled timer operator and paused schedule have no side effect", async () => {
  const { codexapp, daemon, control, store } = setup();
  const clock = new ManualClock("2026-09-11T10:00:00.000Z");
  const timer = new TimerOperator({ store, clock, dispatch: (intent) => daemon.dispatchIntent(intent, { kind: "timer" }) });
  control.mutate({ operation: "operator.set_enabled", name: "timer", enabled: false });
  assert.deepEqual(await timer.tick(), []);
  assert.equal(codexapp.sends.length, 0);

  control.mutate({ operation: "operator.set_enabled", name: "timer", enabled: true });
  control.mutate({ operation: "schedule.pause", id: "daily-check" });
  assert.deepEqual(await timer.tick(), []);
  assert.equal(codexapp.sends.length, 0);
  control.mutate({ operation: "schedule.resume", id: "daily-check" });
  assert.equal((await timer.tick())[0].result.decision, "sent");
  assert.equal(codexapp.sends.length, 1);
});

test("timer rejects malformed schedule time and preserves persistence failure", async () => {
  const store = new MemoryStateStore();
  const control = new FrameworkControlPlane({ store });
  assert.throws(
    () => control.mutate({ operation: "schedule.upsert", id: "bad", at: "not-a-time", body: "wake", target: TARGET }),
    /schedule time must be an ISO timestamp/,
  );

  const failingStore = {
    getControl(key) {
      if (key === "operators") return { timer: { enabled: true } };
      return { "bad-persist": { id: "bad-persist", at: "2026-09-11T09:00:00.000Z", body: "wake", target: TARGET, enabled: true } };
    },
    putControl() { throw Object.assign(new Error("state disk is read-only"), { code: "persistence_failure" }); },
  };
  const timer = new TimerOperator({
    store: failingStore,
    clock: new ManualClock("2026-09-11T10:00:00.000Z"),
    dispatch: async () => ({ decision: "sent" }),
  });
  await assert.rejects(timer.tick(), (error) => error.code === "persistence_failure");
});
