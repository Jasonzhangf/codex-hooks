import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("daemon entry requires and loads a real typed codexapp module", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-hooks-entry-"));
  const modulePath = join(directory, "codexapp.mjs");
  const statePath = join(directory, "state.json");
  const configPath = join(directory, "hooksd.json");
  await writeFile(modulePath, "export function createCodexAppPort() { return { capabilities: async () => ['session_status', 'send_message_to_thread'], session_status: async () => ({ state: 'idle' }), send_message: async ({ attempt_id }) => ({ accepted: true, attempt_id }) }; }\n", "utf8");
  await writeFile(configPath, JSON.stringify({
    runtime: { host: "127.0.0.1", port: 0, state_directory: directory },
    codexapp: {
      socket: join(directory, "codexapp.sock"),
      required_capabilities: ["session_status", "send_message_to_thread"],
      source_address: { scopeId: "hooks", sessionId: "hooksd" },
      target_scopes: { "codex_tui/tui-appserver": "local:tui" },
    },
    policies: [],
  }), "utf8");
  const child = spawn(process.execPath, ["src/daemon-entry.js", "--config", configPath, "--state-file", statePath, "--codexapp-module", modulePath], {
    cwd: new URL("..", import.meta.url),
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const line = await readLine(child.stdout);
    const ready = JSON.parse(line);
    assert.equal(ready.ready, true);
    assert.equal(ready.recovered_outbox, 0);
    const health = await fetch(`${ready.endpoint}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { protocol: "routecodex-hooks/v1", ready: true });
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
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
  });
}
