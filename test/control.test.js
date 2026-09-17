import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HooksDaemon } from "../src/daemon.js";
import { FrameworkControlPlane } from "../src/control.js";
import { McpStateClient } from "../src/mcp.js";
import { JsonStateStore } from "../src/persistence.js";
import { DaemonHttpServer } from "../src/server.js";

function codexapp() {
  return {
    async session_status() { return { state: "idle" }; },
    async send_message() { return { accepted: true, attempt_id: "unused" }; },
  };
}

test("MCP reads control state and CLI-shaped mutation is visible through the same daemon", async () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const server = new DaemonHttpServer(daemon);
  const endpoint = await server.listen();
  try {
    const mutation = await fetch(`${endpoint}/v1/control/mutate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "operator.set_enabled", name: "timer", enabled: true }),
    });
    assert.equal(mutation.status, 200);
    const state = await new McpStateClient(endpoint).queryState();
    assert.equal(state.state.operators.timer.enabled, true);
    assert.equal(state.state.operator_registry.find((entry) => entry.name === "timer").status, "implemented");
  } finally {
    await server.close();
  }
});

test("control state projects delivery intents without exposing transition history", async () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  daemon.store.putIntent("intent-1", {
    intent_id: "intent-1",
    state: "unknown_delivery",
    target: { session_id: "session-1", thread_id: "thread-1" },
    intent: { intent_id: "intent-1", body: "wake" },
  });
  const control = new FrameworkControlPlane({ store: daemon.store });
  assert.deepEqual(Object.keys(control.query().delivery_intents), ["intent-1"]);
  assert.equal(control.query().delivery_intents["intent-1"].state, "unknown_delivery");
  assert.equal(control.query().transitions, undefined);
});

test("JSON state store survives a new daemon process boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-hooks-"));
  const filePath = join(directory, "state.json");
  try {
    const first = new JsonStateStore(filePath);
    first.putControl("operators", { timer: { enabled: true } });
    first.recordTransition({ state: "scheduled" });
    const second = new JsonStateStore(filePath);
    assert.equal(second.getControl("operators").timer.enabled, true);
    assert.deepEqual(second.snapshot().transitions, [{ state: "scheduled" }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("control plane rejects unknown mutation instead of silently accepting it", () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const control = new FrameworkControlPlane({ store: daemon.store });
  assert.throws(() => control.mutate({ operation: "timer.tick" }), /unsupported control operation/);
});

test("control plane cannot enable an operator outside the implemented registry", () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const control = new FrameworkControlPlane({ store: daemon.store });
  assert.throws(
    () => control.mutate({ operation: "operator.set_enabled", name: "memory", enabled: true }),
    /operator is not implemented: memory/,
  );
  assert.equal(control.mutate({ operation: "operator.set_enabled", name: "stopless", enabled: true }).enabled, true);
});

test("schedule mutation validates its target and send mode at the control boundary", () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const control = new FrameworkControlPlane({ store: daemon.store });
  assert.throws(
    () => control.mutate({ operation: "schedule.upsert", id: "bad-target", at: "2026-09-10T12:00:00Z", body: "wake", target: { session_id: "missing" } }),
    /target\.namespace must be a non-empty string/,
  );
  assert.throws(
    () => control.mutate({ operation: "schedule.upsert", id: "bad-mode", at: "2026-09-10T12:00:00Z", body: "wake", target: { namespace: "codex_tui", appserver_id: "app", session_id: "session", thread_id: "thread" }, send_mode: "always" }),
    /unsupported send mode: always/,
  );
  assert.throws(
    () => control.mutate({ operation: "schedule.upsert", id: "bad-busy", at: "2026-09-10T12:00:00Z", body: "wake", target: { namespace: "codex_tui", appserver_id: "app", session_id: "session", thread_id: "thread" }, busy_policy: "later" }),
    /unsupported busy policy: later/,
  );
});

test("schedule busy policy defaults to defer and is patchable", () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const control = new FrameworkControlPlane({ store: daemon.store });
  const target = { namespace: "codex_tui", appserver_id: "app", session_id: "session", thread_id: "thread" };
  const created = control.mutate({
    operation: "schedule.upsert",
    id: "busy-policy",
    at: "2026-09-10T12:00:00Z",
    body: "wake",
    target,
  });
  assert.equal(created.busy_policy, "defer");
  const updated = control.mutate({ operation: "schedule.update", id: "busy-policy", busy_policy: "skip" });
  assert.equal(updated.busy_policy, "skip");
});

test("session binding resolves a schedule without duplicating session identity", () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const control = new FrameworkControlPlane({ store: daemon.store });
  const target = {
    namespace: "codex_tui",
    appserver_id: "tui-appserver",
    scope_id: "local:tui",
    session_id: "01a0acc8-e48a-71d1-bcd7-7427e67252a5",
    thread_id: "01a0acc8-e48a-71d1-bcd7-7427e67252a5",
  };
  control.mutate({ operation: "session.bind", alias: "timer-tui", target });
  const scheduled = control.mutate({
    operation: "schedule.add",
    id: "session-timer",
    at: "2026-09-16T12:00:00.000Z",
    body: "wake",
    session: "timer-tui",
  });
  assert.equal(scheduled.session, "timer-tui");
  assert.deepEqual(scheduled.target, target);
  assert.equal(control.query().operators.timer.enabled, true);
  assert.equal(control.query().session_bindings["timer-tui"].target.thread_id, target.thread_id);
  assert.throws(
    () => control.mutate({ operation: "schedule.add", id: "missing", at: "2026-09-16T12:00:00.000Z", body: "wake", session: "missing" }),
    /session alias is not bound: missing/,
  );
});

test("schedule removal persists a cancelled terminal state", () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const control = new FrameworkControlPlane({ store: daemon.store });
  control.mutate({
    operation: "schedule.upsert",
    id: "cancel-me",
    at: "2026-09-10T12:00:00Z",
    body: "wake",
    target: { namespace: "codex_tui", appserver_id: "app", session_id: "session", thread_id: "thread" },
  });
  const result = control.mutate({ operation: "schedule.remove", id: "cancel-me" });
  assert.equal(result.removed.state, "cancelled");
  assert.equal(control.query().schedules["cancel-me"].enabled, false);
  assert.throws(() => control.mutate({ operation: "schedule.resume", id: "cancel-me" }), /schedule is terminal/);
});

test("schedule update patches supplied fields and preserves runtime evidence", () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const control = new FrameworkControlPlane({ store: daemon.store });
  const target = { namespace: "codex_tui", appserver_id: "app", session_id: "session", thread_id: "thread" };
  control.mutate({
    operation: "schedule.upsert",
    id: "patch-me",
    at: "2026-09-16T12:00:00.000Z",
    body: "before",
    target,
    mode: "interval",
    interval_ms: 60_000,
  });
  const schedules = daemon.store.getControl("schedules");
  schedules["patch-me"] = {
    ...schedules["patch-me"],
    state: "sent",
    current_occurrence: "timer:patch-me:2026-09-16T12:00:00.000Z",
    last_occurrence: "timer:patch-me:2026-09-16T12:00:00.000Z",
    last_delivery: { intent_id: "timer:patch-me:2026-09-16T12:00:00.000Z" },
  };
  daemon.store.putControl("schedules", schedules);

  const updated = control.mutate({ operation: "schedule.update", id: "patch-me", body: "after" });
  assert.equal(updated.body, "after");
  assert.equal(updated.target.thread_id, "thread");
  assert.equal(updated.state, "sent");
  assert.equal(updated.current_occurrence, "timer:patch-me:2026-09-16T12:00:00.000Z");
  assert.deepEqual(updated.last_delivery, { intent_id: "timer:patch-me:2026-09-16T12:00:00.000Z" });
});

test("schedule update can change timing and target through a bound session alias", () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const control = new FrameworkControlPlane({ store: daemon.store });
  const firstTarget = { namespace: "codex_tui", appserver_id: "app", session_id: "session-1", thread_id: "thread-1" };
  const secondTarget = { namespace: "codex_tui", appserver_id: "app", session_id: "session-2", thread_id: "thread-2" };
  control.mutate({ operation: "session.bind", alias: "second", target: secondTarget });
  control.mutate({
    operation: "schedule.upsert",
    id: "retarget",
    at: "2026-09-16T12:00:00.000Z",
    body: "before",
    target: firstTarget,
  });
  const updated = control.mutate({
    operation: "schedule.update",
    id: "retarget",
    session: "second",
    at: "2026-09-16T13:00:00.000Z",
    interval_ms: 60_000,
    mode: "interval",
  });
  assert.deepEqual(updated.target, secondTarget);
  assert.equal(updated.at, "2026-09-16T13:00:00.000Z");
  assert.equal(updated.state, "configured");
});

test("schedule stop is terminal and preserves the record without claiming delivery", () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const control = new FrameworkControlPlane({ store: daemon.store });
  control.mutate({
    operation: "schedule.upsert",
    id: "stop-me",
    at: "2026-09-16T12:00:00.000Z",
    body: "wake",
    target: { namespace: "codex_tui", appserver_id: "app", session_id: "session", thread_id: "thread" },
  });
  const stopped = control.mutate({ operation: "schedule.stop", id: "stop-me" });
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.enabled, false);
  assert.equal(typeof stopped.stopped_at, "string");
  assert.equal(control.query().schedules["stop-me"].state, "stopped");
  assert.throws(() => control.mutate({ operation: "schedule.resume", id: "stop-me" }), /schedule is terminal/);
  assert.throws(() => control.mutate({ operation: "schedule.update", id: "stop-me", body: "after" }), /schedule is terminal/);
});

test("schedule stop is accepted while an occurrence is being sent", () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const control = new FrameworkControlPlane({ store: daemon.store });
  control.mutate({
    operation: "schedule.upsert",
    id: "stop-inflight",
    at: "2026-09-16T12:00:00.000Z",
    body: "wake",
    target: { namespace: "codex_tui", appserver_id: "app", session_id: "session", thread_id: "thread" },
  });
  const schedules = daemon.store.getControl("schedules");
  schedules["stop-inflight"] = { ...schedules["stop-inflight"], state: "send_pending" };
  daemon.store.putControl("schedules", schedules);
  const stopped = control.mutate({ operation: "schedule.stop", id: "stop-inflight" });
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.enabled, false);
});

test("schedule stop is rejected after delivery evidence exists", () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const control = new FrameworkControlPlane({ store: daemon.store });
  control.mutate({
    operation: "schedule.upsert",
    id: "already-sent",
    at: "2026-09-16T12:00:00.000Z",
    body: "wake",
    target: { namespace: "codex_tui", appserver_id: "app", session_id: "session", thread_id: "thread" },
  });
  const schedules = daemon.store.getControl("schedules");
  schedules["already-sent"] = { ...schedules["already-sent"], state: "sent", enabled: false, completed_at: "2026-09-16T12:00:01.000Z" };
  daemon.store.putControl("schedules", schedules);
  assert.throws(() => control.mutate({ operation: "schedule.stop", id: "already-sent" }), /cannot be stopped from state: sent/);
});

test("schedule remove can cancel a stopped record through an explicit edge", () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const control = new FrameworkControlPlane({ store: daemon.store });
  control.mutate({
    operation: "schedule.upsert",
    id: "stop-then-remove",
    at: "2026-09-16T12:00:00.000Z",
    body: "wake",
    target: { namespace: "codex_tui", appserver_id: "app", session_id: "session", thread_id: "thread" },
  });
  control.mutate({ operation: "schedule.stop", id: "stop-then-remove" });
  const result = control.mutate({ operation: "schedule.remove", id: "stop-then-remove" });
  assert.equal(result.removed.state, "cancelled");
  assert.equal(result.removed.enabled, false);
});

test("schedule update rejects incomplete mode and incompatible action target transitions", () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const control = new FrameworkControlPlane({ store: daemon.store });
  control.mutate({
    operation: "schedule.upsert",
    id: "bad-update",
    at: "2026-09-16T12:00:00.000Z",
    body: "wake",
    target: { namespace: "codex_tui", appserver_id: "app", session_id: "session", thread_id: "thread" },
  });
  assert.throws(
    () => control.mutate({ operation: "schedule.update", id: "bad-update", mode: "interval" }),
    /interval_ms/,
  );

  const daemon2 = new HooksDaemon({ codexapp: codexapp() });
  const control2 = new FrameworkControlPlane({ store: daemon2.store });
  control2.mutate({
    operation: "schedule.upsert",
    id: "bad-action-update",
    action: "subagent",
    at: "2026-09-16T12:00:00.000Z",
    body: "run",
    target: { namespace: "codex_tui", appserver_id: "app", scope_id: "local:tui" },
  });
  assert.throws(
    () => control2.mutate({ operation: "schedule.update", id: "bad-action-update", action: "notify" }),
    /target\.session_id/,
  );
  assert.throws(
    () => control2.mutate({ operation: "schedule.update", id: "bad-action-update", action: "subagent", session: "missing" }),
    /session target requires action notify/,
  );

  const daemon3 = new HooksDaemon({ codexapp: codexapp() });
  const control3 = new FrameworkControlPlane({ store: daemon3.store });
  control3.mutate({
    operation: "schedule.upsert",
    id: "subagent-to-notify",
    action: "subagent",
    at: "2026-09-16T12:00:00.000Z",
    body: "run",
    target: { namespace: "codex_tui", appserver_id: "app", scope_id: "local:tui" },
    cwd: "/tmp",
    model: "test-model",
    allow_concurrent: true,
  });
  control3.mutate({ operation: "session.bind", alias: "notify-alias", target: { namespace: "codex_tui", appserver_id: "app", session_id: "session", thread_id: "thread" } });
  const converted = control3.mutate({
    operation: "schedule.update",
    id: "subagent-to-notify",
    action: "notify",
    session: "notify-alias",
  });
  assert.equal(converted.action, "notify");
  assert.equal(converted.cwd, undefined);
  assert.equal(converted.model, undefined);
  assert.equal(converted.allow_concurrent, undefined);
  assert.equal(converted.target.session_id, "session");
});

test("health endpoint is an explicit daemon readiness probe", async () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const server = new DaemonHttpServer(daemon);
  const endpoint = await server.listen();
  try {
    const response = await fetch(`${endpoint}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { protocol: "routecodex-hooks/v1", ready: true });
  } finally {
    await server.close();
  }
});

test("health endpoint advertises a valid IPv6 loopback URL", async () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const server = new DaemonHttpServer(daemon);
  const endpoint = await server.listen("::1", 0);
  try {
    assert.equal(new URL(endpoint).hostname, "[::1]");
    const response = await fetch(`${endpoint}/health`);
    assert.equal(response.status, 200);
  } finally {
    await server.close();
  }
});

test("control plane validates schedule action, interval, and target shape", () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const control = new FrameworkControlPlane({ store: daemon.store });
  const target = { namespace: "codex_tui", appserver_id: "app", scope_id: "local:tui", session_id: "session", thread_id: "thread" };
  assert.throws(
    () => control.mutate({ operation: "schedule.upsert", id: "bad-action", action: "unknown", at: "2026-09-10T12:00:00Z", body: "wake", target }),
    /unsupported schedule action/,
  );
  assert.throws(
    () => control.mutate({ operation: "schedule.upsert", id: "bad-interval", mode: "interval", at: "2026-09-10T12:00:00Z", body: "wake", target }),
    /interval_ms/,
  );
  assert.throws(
    () => control.mutate({ operation: "schedule.upsert", id: "bad-subagent-target", action: "subagent", at: "2026-09-10T12:00:00Z", body: "run", target: { namespace: "codex_tui" } }),
    /target\.appserver_id/,
  );
  const subagent = control.mutate({
    operation: "schedule.add",
    id: "spawn-target",
    action: "subagent",
    at: "2026-09-10T12:00:00Z",
    body: "run",
    target: { namespace: "codex_tui", appserver_id: "app", scope_id: "local:tui" },
  });
  assert.equal(subagent.action, "subagent");
  assert.equal(subagent.session, undefined);
  assert.deepEqual(subagent.target, { namespace: "codex_tui", appserver_id: "app", scope_id: "local:tui" });
});

test("wait is one-shot, session-bound, and owned by the requesting session", () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const control = new FrameworkControlPlane({ store: daemon.store });
  const target = {
    namespace: "codex_tui",
    appserver_id: "app",
    session_id: "session-1",
    thread_id: "thread-1",
  };
  control.mutate({ operation: "session.bind", alias: "owner", target });
  const wait = control.mutate({
    operation: "wait.create",
    id: "wait-1",
    at: "2026-09-16T12:01:00.000Z",
    body: "continue",
    session: "owner",
    owner_session_id: "session-1",
  });
  assert.equal(wait.action, "wait");
  assert.equal(wait.mode, "once");
  assert.equal(wait.owner_session_id, "session-1");
  assert.equal(control.query().operators.timer.enabled, true);
  assert.throws(
    () => control.mutate({ operation: "wait.create", id: "wait-2", mode: "interval", interval_ms: 1000, at: "2026-09-16T12:01:00.000Z", body: "continue", session: "owner" }),
    /wait schedules must be one-shot/,
  );
});

test("subagent stop interrupts a working turn without archive or close", async () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const calls = [];
  const subagents = {
    async sessionStatus() { calls.push(["status"]); return { state: "working" }; },
    async interruptSubagent(request) { calls.push(["interrupt", request]); return { state: "interrupted", thread_id: request.thread_id, turn_id: request.turn_id }; },
  };
  const control = new FrameworkControlPlane({ store: daemon.store, subagents });
  const target = { namespace: "codex_tui", appserver_id: "app", scope_id: "local:tui" };
  control.registerSubagent({
    thread_id: "thread-child",
    turn_id: "turn-child",
    target,
    prompt: "review",
    ephemeral: true,
    owner_session_id: "session-owner",
  });
  const stopped = await control.mutate({ operation: "subagent.stop", thread_id: "thread-child" });
  assert.equal(stopped.state, "released");
  assert.equal(stopped.stop_evidence.state, "interrupted");
  assert.deepEqual(calls.map(([name]) => name), ["status", "interrupt"]);
  assert.equal(calls[1][1].turn_id, "turn-child");
  assert.equal((await control.mutate({ operation: "subagent.stop", thread_id: "thread-child" })).state, "released");
  assert.equal(calls.length, 2);
});

test("subagent stop records no_active_turn without calling interrupt", async () => {
  for (const nativeState of ["idle", "waiting_for_input", "stopped"]) {
    const daemon = new HooksDaemon({ codexapp: codexapp() });
    const calls = [];
    const subagents = {
      async sessionStatus() { calls.push("status"); return { state: nativeState }; },
      async interruptSubagent() { calls.push("interrupt"); return { state: "interrupted" }; },
    };
    const control = new FrameworkControlPlane({ store: daemon.store, subagents });
    control.registerSubagent({
      thread_id: `thread-${nativeState}`,
      turn_id: `turn-${nativeState}`,
      target: { namespace: "codex_tui", appserver_id: "app", scope_id: "local:tui" },
      prompt: "review",
    });
    const stopped = await control.mutate({ operation: "subagent.stop", thread_id: `thread-${nativeState}` });
    assert.equal(stopped.state, "stopped");
    assert.equal(stopped.stop_evidence.state, "no_active_turn");
    assert.deepEqual(calls, ["status"]);
  }
});

test("subagent stop fails closed when native state cannot prove idle or working", async () => {
  for (const nativeState of ["unknown", "disconnected", "failed", "starting", "stopping"]) {
    const daemon = new HooksDaemon({ codexapp: codexapp() });
    const calls = [];
    const subagents = {
      async sessionStatus() { calls.push("status"); return { state: nativeState }; },
      async interruptSubagent() { calls.push("interrupt"); return { state: "interrupted" }; },
    };
    const control = new FrameworkControlPlane({ store: daemon.store, subagents });
    control.registerSubagent({
      thread_id: `thread-${nativeState}`,
      turn_id: `turn-${nativeState}`,
      target: { namespace: "codex_tui", appserver_id: "app", scope_id: "local:tui" },
      prompt: "review",
      ephemeral: true,
    });
    await assert.rejects(
      () => control.mutate({ operation: "subagent.stop", thread_id: `thread-${nativeState}` }),
      (error) => error.code === "subagent_state_unresolved"
        && error.native_state === nativeState,
    );
    assert.deepEqual(calls, ["status"]);
    const persisted = control.query().subagents[`thread-${nativeState}`];
    assert.equal(persisted.state, "active");
    assert.equal(persisted.stop_evidence, undefined);
    assert.equal(persisted.stopped_at, undefined);
  }
});

test("subagent stop fails explicitly when native stop capability is unavailable", async () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const control = new FrameworkControlPlane({ store: daemon.store });
  control.registerSubagent({
    thread_id: "thread-no-close",
    turn_id: "turn-no-close",
    target: { namespace: "codex_tui", appserver_id: "app", scope_id: "local:tui" },
    prompt: "review",
  });
  await assert.rejects(
    () => control.mutate({ operation: "subagent.stop", thread_id: "thread-no-close" }),
    /requires daemon native stop capabilities/,
  );
});

test("subagent create registers a fresh ephemeral child with a prompt digest", async () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const calls = [];
  const subagents = {
    async createSubagent(request) {
      calls.push(request);
      return { thread_id: "thread-new", turn_id: "turn-new", state: "accepted" };
    },
  };
  const control = new FrameworkControlPlane({ store: daemon.store, subagents });
  const created = await control.mutate({
    operation: "subagent.create",
    prompt: "review the candidate",
    target: { namespace: "codex_tui", appserver_id: "app", scope_id: "local:tui" },
    ephemeral: true,
    owner_session_id: "owner",
    model: "test-model",
    effort: "high",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ephemeral, true);
  assert.equal(calls[0].model, "test-model");
  assert.equal(calls[0].effort, "high");
  assert.equal(created.thread_id, "thread-new");
  assert.equal(created.state, "active");
  assert.equal(created.ephemeral, true);
  assert.match(created.prompt_digest, /^[a-f0-9]{64}$/);
  assert.equal(created.prompt, undefined);
});

test("subagent create defaults to ephemeral without an explicit flag", async () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const calls = [];
  const subagents = {
    async createSubagent(request) {
      calls.push(request);
      return { thread_id: "thread-default-ephemeral", turn_id: "turn-default-ephemeral", state: "accepted" };
    },
  };
  const control = new FrameworkControlPlane({ store: daemon.store, subagents });
  const created = await control.mutate({
    operation: "subagent.create",
    prompt: "review the candidate",
    target: { namespace: "codex_tui", appserver_id: "app", scope_id: "local:tui" },
  });
  assert.equal(calls[0].ephemeral, true);
  assert.equal(created.ephemeral, true);
});

test("subagent create rejects profile at the native create boundary", async () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const control = new FrameworkControlPlane({
    store: daemon.store,
    subagents: { async createSubagent() { throw new Error("must not be called"); } },
  });
  await assert.rejects(
    () => control.mutate({
      operation: "subagent.create",
      prompt: "review",
      target: { namespace: "codex_tui", appserver_id: "app", scope_id: "local:tui" },
      profile: "review",
    }),
    (error) => error.code === "unsupported_profile",
  );
});

test("schedule subagent rejects profile before persistence and keeps effort patchable", () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const control = new FrameworkControlPlane({ store: daemon.store });
  const target = { namespace: "codex_tui", appserver_id: "app", scope_id: "local:tui" };
  assert.throws(
    () => control.mutate({
      operation: "schedule.upsert",
      id: "profile-schedule",
      action: "subagent",
      at: "2026-09-16T12:00:00.000Z",
      body: "run",
      target,
      profile: "review",
    }),
    (error) => error.code === "unsupported_profile",
  );
  assert.equal(control.query().schedules["profile-schedule"], undefined);

  const created = control.mutate({
    operation: "schedule.upsert",
    id: "effort-schedule",
    action: "subagent",
    at: "2026-09-16T12:00:00.000Z",
    body: "run",
    target,
    effort: "high",
  });
  assert.equal(created.effort, "high");
  const updated = control.mutate({ operation: "schedule.update", id: "effort-schedule", effort: "low" });
  assert.equal(updated.effort, "low");
});

test("non-subagent schedules reject subagent-only fields instead of dropping them", () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const control = new FrameworkControlPlane({ store: daemon.store });
  assert.throws(
    () => control.mutate({
      operation: "schedule.upsert",
      id: "notify-with-effort",
      at: "2026-09-16T12:00:00.000Z",
      body: "wake",
      target: { namespace: "codex_tui", appserver_id: "app", session_id: "session", thread_id: "thread" },
      effort: "high",
    }),
    /require action=subagent/,
  );
});

test("session_missing schedules are terminal for resume and update", () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const control = new FrameworkControlPlane({ store: daemon.store });
  control.mutate({
    operation: "schedule.upsert",
    id: "missing-session",
    at: "2026-09-16T12:00:00.000Z",
    body: "wake",
    target: { namespace: "codex_tui", appserver_id: "app", session_id: "session", thread_id: "thread" },
  });
  const schedules = daemon.store.getControl("schedules");
  schedules["missing-session"] = {
    ...schedules["missing-session"],
    state: "session_missing",
    enabled: false,
  };
  daemon.store.putControl("schedules", schedules);

  assert.throws(
    () => control.mutate({ operation: "schedule.resume", id: "missing-session" }),
    /schedule is terminal/,
  );
  assert.throws(
    () => control.mutate({ operation: "schedule.update", id: "missing-session", body: "retry" }),
    /schedule is terminal/,
  );
  assert.equal(control.query().schedules["missing-session"].state, "session_missing");
  assert.equal(control.query().schedules["missing-session"].enabled, false);
});

test("longhorizon registration is paused until explicit activation", () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const control = new FrameworkControlPlane({ store: daemon.store });
  control.mutate({
    operation: "session.bind",
    alias: "goal-session",
    target: { namespace: "codex_tui", appserver_id: "app", scope_id: "local:tui", session_id: "session", thread_id: "thread" },
  });
  const registered = control.mutate({
    operation: "longhorizon.register",
    id: "goal-1",
    mode: "goal",
    goal_file: "/tmp/goal.md",
    session: "goal-session",
    review_budget: 2,
  });
  assert.equal(registered.enabled, false);
  assert.equal(registered.state, "registered");
  assert.equal(registered.review_count, 0);
  assert.equal(control.query().operators.stopless.enabled, false);
  assert.equal(control.query().operators.longhorizon.enabled, false);

  const active = control.mutate({ operation: "longhorizon.activate", id: "goal-1" });
  assert.equal(active.enabled, true);
  assert.equal(active.state, "active");
  assert.equal(control.query().operators.stopless.enabled, true);
  assert.equal(control.query().operators.longhorizon.enabled, true);

  const paused = control.mutate({ operation: "longhorizon.pause", id: "goal-1" });
  assert.equal(paused.enabled, false);
  assert.equal(paused.state, "paused");
  assert.equal(control.query().operators.stopless.enabled, false);

  const stopped = control.mutate({ operation: "longhorizon.stop", id: "goal-1" });
  assert.equal(stopped.state, "stopped");
  assert.throws(
    () => control.mutate({ operation: "longhorizon.activate", id: "goal-1" }),
    /longhorizon is stopped/,
  );
});

test("periodic longhorizon owns a paused skip schedule and stop closes it", () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const control = new FrameworkControlPlane({ store: daemon.store });
  control.mutate({
    operation: "session.bind",
    alias: "periodic-session",
    target: { namespace: "codex_tui", appserver_id: "app", scope_id: "local:tui", session_id: "session", thread_id: "thread" },
  });
  const registered = control.mutate({
    operation: "longhorizon.register",
    id: "periodic-1",
    mode: "periodic",
    prompt: "inspect the goal document",
    session: "periodic-session",
    interval_ms: 1000,
    at: "2026-09-17T00:00:00.000Z",
  });
  assert.equal(registered.enabled, false);
  assert.equal(registered.schedule_state, "disabled");
  const schedule = control.query().schedules[registered.schedule_id];
  assert.equal(schedule.busy_policy, "skip");
  assert.equal(schedule.send_mode, "idle_only");
  assert.equal(schedule.enabled, false);

  control.mutate({ operation: "longhorizon.activate", id: "periodic-1" });
  assert.equal(control.query().schedules[registered.schedule_id].enabled, true);
  const stopped = control.mutate({ operation: "longhorizon.stop", id: "periodic-1" });
  assert.equal(stopped.state, "stopped");
  assert.equal(control.query().schedules[registered.schedule_id].state, "stopped");
  assert.equal(control.query().operators.timer.enabled, false);
});

test("periodic longhorizon activation cannot resurrect a session_missing schedule", () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const control = new FrameworkControlPlane({ store: daemon.store });
  control.mutate({
    operation: "session.bind",
    alias: "periodic-missing",
    target: { namespace: "codex_tui", appserver_id: "app", scope_id: "local:tui", session_id: "session", thread_id: "thread" },
  });
  const registered = control.mutate({
    operation: "longhorizon.register",
    id: "periodic-missing",
    mode: "periodic",
    prompt: "inspect the goal document",
    session: "periodic-missing",
    interval_ms: 1000,
    at: "2026-09-17T00:00:00.000Z",
  });
  const schedules = daemon.store.getControl("schedules");
  schedules[registered.schedule_id] = {
    ...schedules[registered.schedule_id],
    state: "session_missing",
    enabled: false,
  };
  daemon.store.putControl("schedules", schedules);

  assert.throws(
    () => control.mutate({ operation: "longhorizon.activate", id: "periodic-missing" }),
    /longhorizon schedule is terminal/,
  );
  const longhorizon = control.query().longhorizon["periodic-missing"];
  assert.equal(longhorizon.enabled, false);
  assert.equal(longhorizon.state, "registered");
  assert.equal(control.query().schedules[registered.schedule_id].state, "session_missing");
  assert.equal(control.query().schedules[registered.schedule_id].enabled, false);
});

test("subagent stop accepts a working turn with no observed active turn id", async () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const calls = [];
  const subagents = {
    async sessionStatus() { calls.push("status"); return { state: "working" }; },
    async interruptSubagent(request) {
      calls.push("interrupt");
      return { state: "interrupted", thread_id: request.thread_id, turn_id: request.turn_id };
    },
  };
  const control = new FrameworkControlPlane({ store: daemon.store, subagents });
  control.registerSubagent({
    thread_id: "thread-child",
    turn_id: "turn-child",
    target: { namespace: "codex_tui", appserver_id: "app", scope_id: "local:tui" },
    prompt: "review",
    ephemeral: true,
  });
  const stopped = await control.mutate({ operation: "subagent.stop", thread_id: "thread-child" });
  assert.equal(stopped.state, "released");
  assert.deepEqual(calls, ["status", "interrupt"]);
});

test("subagent stop rejects a different observed active turn", async () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const subagents = {
    async sessionStatus() { return { state: "working", active_turn_id: "turn-other" }; },
    async interruptSubagent() { throw new Error("must not interrupt"); },
  };
  const control = new FrameworkControlPlane({ store: daemon.store, subagents });
  control.registerSubagent({
    thread_id: "thread-child",
    turn_id: "turn-child",
    target: { namespace: "codex_tui", appserver_id: "app", scope_id: "local:tui" },
    prompt: "review",
  });
  await assert.rejects(
    () => control.mutate({ operation: "subagent.stop", thread_id: "thread-child" }),
    (error) => error.code === "subagent_active_turn_mismatch"
      && error.expected_turn_id === "turn-child"
      && error.observed_turn_id === "turn-other",
  );
});
