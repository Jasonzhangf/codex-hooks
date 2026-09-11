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
