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

test("control plane cannot enable an operator without an implementation", () => {
  const daemon = new HooksDaemon({ codexapp: codexapp() });
  const control = new FrameworkControlPlane({ store: daemon.store });
  assert.throws(
    () => control.mutate({ operation: "operator.set_enabled", name: "stopless", enabled: true }),
    /operator is not implemented: stopless/,
  );
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
