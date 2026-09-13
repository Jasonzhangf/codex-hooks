import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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

async function startBridgeFixture(socketPath) {
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
        } else {
          result = {};
        }
        socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
      }
    });
  });
  await new Promise((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
  return server;
}
