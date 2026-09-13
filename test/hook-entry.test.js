import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import test from "node:test";

test("hook command exposes daemon delivery failures instead of printing success", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      protocol: "routecodex-hooks/v1",
      decision: "fail_closed",
      error: { code: "disconnected_session", message: "session is disconnected" },
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const child = spawn(process.execPath, ["src/hook-entry.js", "--kind", "stop"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, ROUTECODEX_HOOKS_ENDPOINT: `http://127.0.0.1:${address.port}` },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.end(JSON.stringify({ session_id: "session-1", hook_event_name: "Stop", cwd: "/workspace" }));
    const [exitCode] = await once(child, "close");
    assert.notEqual(exitCode, 0);
    assert.equal(stdout, "");
    assert.match(stderr, /session is disconnected/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("hook command forwards an optional internal intent envelope separately from the official event", async () => {
  let captured = null;
  const server = createServer((request, response) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      captured = JSON.parse(text);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ protocol: "routecodex-hooks/v1", decision: "sent", hook_output: { state: "accepted" } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const child = spawn(process.execPath, ["src/hook-entry.js", "--kind", "stop"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, ROUTECODEX_HOOKS_ENDPOINT: `http://127.0.0.1:${address.port}` },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const intent = {
    intent_id: "hook-intent-1",
    source: "operator",
    body: "wake",
    send_mode: "idle_only",
    target: { namespace: "codex_tui", appserver_id: "tui-default", session_id: "thread-1", thread_id: "thread-1" },
    event_key: "hook/intent-1",
  };
  child.stdin.end(JSON.stringify({ session_id: "session-1", hook_event_name: "Stop", cwd: "/workspace", intent }));
  const [exitCode] = await once(child, "close");
  assert.equal(exitCode, 0);
  assert.equal(stdout.trim(), JSON.stringify({ state: "accepted" }));
  assert.equal(stderr, "");
  assert.deepEqual(captured.intent, intent);
  assert.equal(captured.event.intent, undefined);
  assert.equal(captured.event.session_id, "session-1");
  assert.equal(captured.kind, "stop");
  await new Promise((resolve) => server.close(resolve));
});

test("hook command rejects a non-loopback endpoint override before sending hook input", async () => {
  const child = spawn(process.execPath, ["src/hook-entry.js", "--kind", "stop"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, ROUTECODEX_HOOKS_ENDPOINT: "http://198.51.100.1:8787" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify({ session_id: "session-1", hook_event_name: "Stop", cwd: "/workspace" }));
  const [exitCode] = await once(child, "close");
  assert.notEqual(exitCode, 0);
  assert.equal(stdout, "");
  assert.match(stderr, /daemon endpoint must be loopback-only/);
});
