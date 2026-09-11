import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installFromSource, readInstallRecord, setStopHookEnabled } from "../src/install.js";
import { loadDaemonConfig } from "../src/config.js";

test("init installs local source, skills, wrappers, and one managed Stop hook idempotently", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "routecodex-hooks-home-"));
  const binDir = join(codexHome, "bin");
  const unrelated = { hooks: { Stop: [{ hooks: [{ type: "command", command: "unrelated-stop" }] }] } };
  await writeFile(join(codexHome, "hooks.json"), `${JSON.stringify(unrelated)}\n`, "utf8");
  try {
    assert.throws(() => installFromSource({ sourceRoot: process.cwd(), codexHome, binDir, endpoint: "https://127.0.0.1:9876" }), /daemon endpoint must be an http origin/);
    const first = installFromSource({ sourceRoot: process.cwd(), codexHome, binDir, endpoint: "http://127.0.0.1:9876" });
    assert.equal(first.stop_hook_enabled, true);
    assert.equal(first.source_root, process.cwd());
    assert.equal(fs.existsSync(join(first.source_directory, "hook-entry.js")), true);
    assert.equal(fs.existsSync(join(first.skills_directory, "routecodex-hooks", "SKILL.md")), true);
    assert.equal(fs.statSync(first.cli_wrapper).mode & 0o111, 0o111);
    assert.equal(fs.statSync(first.mcp_wrapper).mode & 0o111, 0o111);
    assert.equal(fs.statSync(first.daemon_wrapper).mode & 0o111, 0o111);
    assert.equal(
      await readFile(join(first.skills_directory, "routecodex-hooks", "SKILL.md"), "utf8"),
      await readFile(join(process.cwd(), "skills", "routecodex-hooks", "SKILL.md"), "utf8"),
    );
    assert.equal((await readFile(first.cli_wrapper, "utf8")).includes(first.source_directory), true);

    const hooksAfterFirst = JSON.parse(await readFile(first.hooks_file, "utf8"));
    assert.equal(hooksAfterFirst.hooks.Stop.length, 2);
    assert.equal(hooksAfterFirst.hooks.Stop[0].hooks[0].command, "unrelated-stop");
    const second = installFromSource({ sourceRoot: process.cwd(), codexHome, binDir, endpoint: "http://127.0.0.1:9876" });
    const hooksAfterSecond = JSON.parse(await readFile(second.hooks_file, "utf8"));
    assert.equal(hooksAfterSecond.hooks.Stop.length, 2);
    assert.equal(hooksAfterSecond.hooks.Stop.filter((entry) => entry.hooks[0].command === second.managed_hook_commands[0]).length, 1);

    const disabled = setStopHookEnabled(readInstallRecord({ installRecord: second.install_root + "/install.json" }), false);
    assert.equal(disabled.stop_hook_enabled, false);
    const hooksDisabled = JSON.parse(await readFile(second.hooks_file, "utf8"));
    assert.equal(hooksDisabled.hooks.Stop.length, 1);
    const enabled = setStopHookEnabled(disabled, true);
    assert.equal(enabled.stop_hook_enabled, true);
    const hooksEnabled = JSON.parse(await readFile(second.hooks_file, "utf8"));
    assert.equal(hooksEnabled.hooks.Stop.length, 2);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("init canonicalizes IPv6 loopback endpoint before daemon config validation", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "routecodex-hooks-ipv6-"));
  try {
    const record = installFromSource({ sourceRoot: process.cwd(), codexHome, binDir: join(codexHome, "bin"), endpoint: "http://[::1]:8787" });
    const config = loadDaemonConfig(record.daemon_config);
    assert.equal(config.runtime.host, "::1");
    assert.equal(config.runtime.port, 8787);
    const configured = await run(record.cli_wrapper, ["config-set", "endpoint", "http://[::1]:8787"]);
    assert.equal(configured.code, 0, configured.stderr);
    assert.equal(loadDaemonConfig(record.daemon_config).runtime.host, "::1");
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("init receipt is executable on a clean host through the installed Stop command and MCP wrapper", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "routecodex-hooks-clean-host-"));
  const binDir = join(codexHome, "bin");
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") response.end(JSON.stringify({ protocol: "routecodex-hooks/v1", ready: true }));
    else if (request.url === "/v1/control/state") response.end(JSON.stringify({ protocol: "routecodex-hooks/v1", state: { operators: {}, schedules: {} } }));
    else if (request.url === "/v1/hooks/dispatch") response.end(JSON.stringify({ protocol: "routecodex-hooks/v1", decision: "observed", hook_output: {} }));
    else { response.statusCode = 404; response.end(JSON.stringify({ error: "not_found" })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const init = await run(process.execPath, ["scripts/init.mjs", "--codex-home", codexHome, "--bin-dir", binDir, "--endpoint", `http://127.0.0.1:${address.port}`]);
    assert.equal(init.code, 0, init.stderr);
    const receipt = JSON.parse(init.stdout);
    const hooks = JSON.parse(await readFile(receipt.hooks_file, "utf8"));
    const command = hooks.hooks.Stop[0].hooks[0].command;
    const hook = await run("/bin/sh", ["-c", command], { input: JSON.stringify({ hook_event_name: "Stop", session_id: "s1", turn_id: "t1", cwd: "/tmp" }) });
    assert.equal(hook.code, 0, hook.stderr);
    assert.deepEqual(JSON.parse(hook.stdout), {});

    const cli = await run(receipt.cli_wrapper, ["hook-disable", "stop"]);
    assert.equal(cli.code, 0, cli.stderr);
    const disabledHooks = JSON.parse(await readFile(receipt.hooks_file, "utf8"));
    assert.equal(disabledHooks.hooks?.Stop, undefined);
    const enabled = await run(receipt.cli_wrapper, ["hook-enable", "stop"]);
    assert.equal(enabled.code, 0, enabled.stderr);
    const configured = await run(receipt.cli_wrapper, ["config-set", "source_scope", "local:test"]);
    assert.equal(configured.code, 0, configured.stderr);
    const shown = await run(receipt.cli_wrapper, ["config-show"]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(JSON.parse(shown.stdout).daemon.codexapp.source_address.scopeId, "local:test");
    const mcp = spawn(receipt.mcp_wrapper, [], { env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    const initialized = JSON.parse(await readLine(mcp.stdout));
    assert.equal(initialized.result.serverInfo.name, "routecodex-hooks");
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    const listed = JSON.parse(await readLine(mcp.stdout));
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["routecodex_hooks_status"]);
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "routecodex_hooks_status", arguments: {} } })}\n`);
    const status = JSON.parse(await readLine(mcp.stdout));
    assert.equal(status.result.structuredContent.health.ready, true);
    assert.equal(status.result.structuredContent.installation.stop_hook_enabled, true);
    mcp.stdin.end();
    await once(mcp, "close");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("installed Stop command reaches a real hooksd process on a clean host", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "routecodex-hooks-real-host-"));
  const binDir = join(codexHome, "bin");
  const modulePath = join(codexHome, "codexapp-port.mjs");
  await writeFile(modulePath, "export function createCodexAppPort() { return { capabilities: async () => ['session_status', 'send_message_to_thread'], session_status: async () => ({ state: 'idle' }), send_message: async ({ attempt_id }) => ({ accepted: true, attempt_id }) }; }\n", "utf8");
  const port = await freePort();
  let daemon = null;
  try {
    const init = await run(process.execPath, ["scripts/init.mjs", "--codex-home", codexHome, "--bin-dir", binDir, "--endpoint", `http://127.0.0.1:${port}`]);
    assert.equal(init.code, 0, init.stderr);
    const receipt = JSON.parse(init.stdout);
    daemon = spawn(receipt.daemon_wrapper, ["--config", receipt.daemon_config, "--codexapp-module", modulePath], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ready = JSON.parse(await readLine(daemon.stdout));
    assert.equal(ready.ready, true);
    assert.equal(ready.endpoint, `http://127.0.0.1:${port}`);

    const hooks = JSON.parse(await readFile(receipt.hooks_file, "utf8"));
    const command = hooks.hooks.Stop[0].hooks[0].command;
    const hook = await run("/bin/sh", ["-c", command], {
      input: JSON.stringify({ hook_event_name: "Stop", session_id: "s1", turn_id: "t1", cwd: "/tmp" }),
    });
    assert.equal(hook.code, 0, hook.stderr);
    assert.deepEqual(JSON.parse(hook.stdout), {});

    const status = await run(receipt.cli_wrapper, ["status"]);
    assert.equal(status.code, 0, status.stderr);
    const statusBody = JSON.parse(status.stdout);
    assert.equal(statusBody.health.ready, true);
    assert.equal(statusBody.control.protocol, "routecodex-hooks/v1");
  } finally {
    if (daemon) {
      daemon.kill("SIGTERM");
      await once(daemon, "exit");
    }
    await rm(codexHome, { recursive: true, force: true });
  }
});

function run(command, args, { input = null, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
  });
}

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

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
