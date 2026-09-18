import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonStateStore } from "../src/persistence.js";

test("daemon entry requires and loads the internal codexapp bridge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-hooks-entry-"));
  const socketPath = join(directory, "codexapp.sock");
  const statePath = join(directory, "state.json");
  const configPath = join(directory, "hooksd.json");
  const bridge = await startBridgeFixture(socketPath);
  await writeFile(configPath, JSON.stringify({
    runtime: { host: "127.0.0.1", port: 0, state_directory: directory },
    codexapp: {
      socket: socketPath,
      required_capabilities: ["session_status", "send_message_to_thread"],
      source_kind: "service",
      source_address: { scopeId: "local:hooks", sessionId: "hooksd" },
      target_scopes: { "codex_tui/tui-appserver": "local:tui" },
    },
    policies: [],
  }), "utf8");
  const child = spawn(process.execPath, ["src/daemon-entry.js", "--config", configPath, "--state-file", statePath], {
    cwd: new URL("..", import.meta.url),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const line = await readLine(child.stdout).catch((error) => { throw new Error(`${error.message}; stderr=${stderr}`); });
    const ready = JSON.parse(line);
    assert.equal(ready.ready, true);
    assert.equal(ready.recovered_outbox, 0);
    const health = await fetch(`${ready.endpoint}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { protocol: "routecodex-hooks/v1", ready: true });
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    await new Promise((resolve) => bridge.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("daemon entry rejects a non-loopback host override", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-hooks-host-"));
  const socketPath = join(directory, "codexapp.sock");
  const configPath = join(directory, "hooksd.json");
  const bridge = await startBridgeFixture(socketPath);
  await writeFile(configPath, JSON.stringify({
    runtime: { host: "127.0.0.1", port: 0, state_directory: directory },
    codexapp: { socket: socketPath, required_capabilities: ["session_status", "send_message_to_thread"], source_address: { scopeId: "local:hooks", sessionId: "hooksd" }, source_kind: "service", target_scopes: {} },
    policies: [],
  }), "utf8");
  const child = spawn(process.execPath, ["src/daemon-entry.js", "--config", configPath, "--host", "0.0.0.0"], { cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [exitCode] = await once(child, "close");
  await new Promise((resolve) => bridge.close(resolve));
  await rm(directory, { recursive: true, force: true });
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /runtime\.host must be loopback-only/);
});

test("daemon entry drives a due timer through codexapp", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-hooks-entry-timer-"));
  const socketPath = join(directory, "codexapp.sock");
  const statePath = join(directory, "state.json");
  const configPath = join(directory, "hooksd.json");
  const bridge = await startBridgeFixture(socketPath, { sendToIdle: true });
  const store = new JsonStateStore(statePath);
  store.putControl("operators", { timer: { enabled: true } });
  store.putControl("schedules", {
    "due-1": {
      id: "due-1",
      at: new Date(Date.now() - 1000).toISOString(),
      target: {
        namespace: "codex_tui",
        appserver_id: "tui-appserver",
        scope_id: "local:tui",
        session_id: "thread-1",
        thread_id: "thread-1",
      },
      body: "timer wake",
      send_mode: "idle_only",
      state: "configured",
      enabled: true,
    },
  });
  await writeFile(configPath, JSON.stringify({
    runtime: { host: "127.0.0.1", port: 0, state_directory: directory },
    codexapp: {
      socket: socketPath,
      required_capabilities: ["session_status", "send_message_to_thread"],
      source_kind: "service",
      source_address: { scopeId: "local:hooks", sessionId: "hooksd" },
      target_scopes: { "codex_tui/tui-appserver": "local:tui" },
    },
    policies: [],
  }), "utf8");
  const child = spawn(process.execPath, ["src/daemon-entry.js", "--config", configPath, "--state-file", statePath], {
    cwd: new URL("..", import.meta.url),
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const ready = JSON.parse(await readLine(child.stdout));
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const persisted = new JsonStateStore(statePath).getControl("schedules")["due-1"];
      if (persisted.state === "sent") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(new JsonStateStore(statePath).getControl("schedules")["due-1"].state, "sent");
    assert.equal(bridge.sends.length, 1);
    assert.equal(bridge.sends[0].body, "timer wake");
    assert.equal(bridge.sends[0].attemptId.startsWith("timer:due-1:"), true);
    const health = await fetch(`${ready.endpoint}/health`);
    assert.equal(health.status, 200);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    await new Promise((resolve) => bridge.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("daemon entry reconciles an active goal with no live liveness schedule", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-hooks-entry-longhorizon-"));
  const socketPath = join(directory, "codexapp.sock");
  const statePath = join(directory, "state.json");
  const configPath = join(directory, "hooksd.json");
  const bridge = await startBridgeFixture(socketPath, { sendToIdle: true });
  const store = new JsonStateStore(statePath);
  const target = {
    namespace: "codex_tui",
    appserver_id: "tui-appserver",
    scope_id: "local:tui",
    session_id: "thread-1",
    thread_id: "thread-1",
  };
  store.putControl("operators", { longhorizon: { enabled: true }, timer: { enabled: true } });
  store.putControl("session_bindings", {
    "goal-session": { alias: "goal-session", target, bound_at: "2026-09-18T12:00:00.000Z" },
  });
  store.putControl("longhorizon", {
    "legacy-goal": {
      id: "legacy-goal",
      mode: "goal",
      enabled: true,
      state: "active",
      goal_file: "/tmp/legacy-goal.md",
      session: "goal-session",
      target,
      registered_at: "2026-09-18T12:00:00.000Z",
      activated_at: "2026-09-18T12:00:00.000Z",
    },
  });
  await writeFile(configPath, JSON.stringify({
    runtime: { host: "127.0.0.1", port: 0, state_directory: directory },
    codexapp: {
      socket: socketPath,
      required_capabilities: ["session_status", "send_message_to_thread"],
      source_kind: "service",
      source_address: { scopeId: "local:hooks", sessionId: "hooksd" },
      target_scopes: { "codex_tui/tui-appserver": "local:tui" },
    },
    policies: [],
  }), "utf8");
  const child = spawn(process.execPath, ["src/daemon-entry.js", "--config", configPath, "--state-file", statePath], {
    cwd: new URL("..", import.meta.url),
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const ready = JSON.parse(await readLine(child.stdout));
    assert.equal(ready.reconciled_longhorizon, 1);
    const record = new JsonStateStore(statePath).getControl("longhorizon")["legacy-goal"];
    const schedule = new JsonStateStore(statePath).getControl("schedules")[record.liveness_schedule_id];
    assert.equal(record.liveness_state, "scheduled");
    assert.equal(schedule.mode, "interval");
    assert.equal(schedule.interval_ms, 60_000);
    assert.equal(schedule.enabled, true);
    assert.equal(schedule.source, "longhorizon");
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    await new Promise((resolve) => bridge.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

function readLine(stream) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString();
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      stream.off("data", onData);
      resolve(buffer.slice(0, index));
    };
    stream.on("data", onData);
    stream.once("error", reject);
    stream.once("close", () => reject(new Error("stream closed before a line was received")));
  });
}

async function startBridgeFixture(socketPath, { sendToIdle = false } = {}) {
  const fixture = { sends: [] };
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const request = JSON.parse(line);
        let result;
        if (request.method === "capabilities") {
          result = { protocol: "codex-comm/v1", query: ["session_status"], execution: ["send"], namespaces: ["codex_tui", "codex_app"] };
        } else if (request.method === "status") {
          result = { protocol: "codex-comm/v1", bridge: "up", service_identities: [{ scopeId: "local:hooks", sessionId: "hooksd", kind: "service", live: true }], scopes: [{ scopeId: "local:tui", appserverId: "tui-appserver", namespace: "codex_tui", capabilities: ["send_message_to_thread"] }] };
        } else if (request.method === "session_status") {
          result = {
            address: request.params.address,
            scopeId: "local:tui",
            appserverId: "tui-appserver",
            namespace: "codex_tui",
            status: { state: sendToIdle ? "idle" : "unknown" },
          };
        } else if (request.method === "send") {
          fixture.sends.push(request.params);
          result = {
            messageId: request.params.messageId,
            attemptId: request.params.attemptId,
            from: request.params.from,
            to: request.params.to,
            routing: { requestedTo: request.params.to, routedTo: request.params.to },
            state: "accepted",
          };
        } else {
          result = {};
        }
        socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
      }
    });
  });
  await new Promise((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
  return Object.assign(server, fixture);
}
