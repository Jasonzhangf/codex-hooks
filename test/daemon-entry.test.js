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
  await writeFile(modulePath, "export function createCodexAppPort() { return { session_status: async () => ({ state: 'idle' }), send_message: async ({ attempt_id }) => ({ accepted: true, attempt_id }) }; }\n", "utf8");
  const child = spawn(process.execPath, ["src/daemon-entry.js", "--port", "0", "--state-file", statePath, "--codexapp-module", modulePath], {
    cwd: new URL("..", import.meta.url),
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const line = await readLine(child.stdout);
    const ready = JSON.parse(line);
    assert.equal(ready.ready, true);
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
