import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
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
    assert.throws(() => installFromSource({ sourceRoot: process.cwd(), codexHome, binDir, agentHome: join(codexHome, "agent"), endpoint: "https://127.0.0.1:9876" }), /daemon endpoint must be an http origin/);
    const first = installFromSource({ sourceRoot: process.cwd(), codexHome, binDir, agentHome: join(codexHome, "agent"), endpoint: "http://127.0.0.1:9876" });
    assert.equal(first.stop_hook_enabled, true);
    assert.equal(first.source_root, process.cwd());
    assert.equal(fs.existsSync(join(first.source_directory, "hook-entry.js")), true);
    assert.equal(fs.existsSync(join(first.skills_directory, "routecodex-hooks", "SKILL.md")), true);
    assert.equal(fs.existsSync(join(first.agent_skills_directory, "rccs", "SKILL.md")), true);
    assert.equal(fs.statSync(first.rccs_wrapper).mode & 0o111, 0o111);
    assert.equal(fs.statSync(first.cli_wrapper).mode & 0o111, 0o111);
    assert.equal(fs.statSync(first.mcp_wrapper).mode & 0o111, 0o111);
    assert.equal(fs.statSync(first.daemon_wrapper).mode & 0o111, 0o111);
    assert.equal(fs.statSync(first.supervisor_wrapper).mode & 0o111, 0o111);
    assert.equal(fs.statSync(first.codexapp_wrapper).mode & 0o111, 0o111);
    assert.equal(
      await readFile(join(first.skills_directory, "routecodex-hooks", "SKILL.md"), "utf8"),
      await readFile(join(process.cwd(), "skills", "routecodex-hooks", "SKILL.md"), "utf8"),
    );
    assert.equal((await readFile(first.cli_wrapper, "utf8")).includes(first.source_directory), true);
    assert.equal((await readFile(first.rccs_wrapper, "utf8")).includes(first.source_directory), true);
    const daemonConfig = loadDaemonConfig(first.daemon_config);
    assert.equal(daemonConfig.supervisor.enabled, false);
    assert.equal(daemonConfig.supervisor.codexapp.command, first.codexapp_wrapper);
    assert.deepEqual(daemonConfig.supervisor.codexapp.args, ["--socket", daemonConfig.codexapp.socket, "--targets-file", first.codexapp_targets]);
    assert.equal(daemonConfig.codexapp.source_kind, "service");

    const hooksAfterFirst = JSON.parse(await readFile(first.hooks_file, "utf8"));
    assert.equal(hooksAfterFirst.hooks.Stop.length, 2);
    assert.equal(hooksAfterFirst.hooks.Stop[0].hooks[0].command, "unrelated-stop");
    const second = installFromSource({ sourceRoot: process.cwd(), codexHome, binDir, agentHome: join(codexHome, "agent"), endpoint: "http://127.0.0.1:9876" });
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
    const record = installFromSource({ sourceRoot: process.cwd(), codexHome, binDir: join(codexHome, "bin"), agentHome: join(codexHome, "agent"), endpoint: "http://[::1]:8787" });
    const config = loadDaemonConfig(record.daemon_config);
    assert.equal(config.runtime.host, "::1");
    assert.equal(config.runtime.port, 8787);
    const configured = await run(record.cli_wrapper, ["config-set", "endpoint", "http://[::1]:8787"]);
    assert.equal(configured.code, 0, configured.stderr);
    assert.equal(loadDaemonConfig(record.daemon_config).runtime.host, "::1");
    const target = JSON.stringify({ namespace: "codex_tui", appserver_id: "tui-appserver", scope_id: "local:tui", endpoint: "unix:///tmp/tui-appserver.sock" });
    const targetConfigured = await run(record.cli_wrapper, ["config-set", "target", target]);
    assert.equal(targetConfigured.code, 0, targetConfigured.stderr);
    assert.deepEqual(JSON.parse(await readFile(record.codexapp_targets, "utf8")), [JSON.parse(target)]);
    assert.equal(loadDaemonConfig(record.daemon_config).codexapp.target_scopes["codex_tui/tui-appserver"], "local:tui");
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("rccs init reinstalls the bundled source and skills idempotently", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "rccs-init-"));
  const binDir = join(codexHome, "bin");
  const agentHome = join(codexHome, "agent");
  try {
    const first = await run(process.execPath, [
      "src/cli.js",
      "init",
      "--codex-home", codexHome,
      "--bin-dir", binDir,
      "--agent-home", agentHome,
      "--endpoint", "http://127.0.0.1:9876",
    ]);
    assert.equal(first.code, 0, first.stderr);
    const firstReceipt = JSON.parse(first.stdout);
    assert.equal(firstReceipt.initialized, true);
    assert.equal(fs.existsSync(join(firstReceipt.agent_skills_directory, "rccs", "SKILL.md")), true);
    assert.equal(fs.existsSync(join(firstReceipt.bundled_skills_directory, "scheduling", "SKILL.md")), true);

    const second = await run(firstReceipt.rccs_wrapper, ["init"]);
    assert.equal(second.code, 0, second.stderr);
    const secondReceipt = JSON.parse(second.stdout);
    assert.equal(secondReceipt.install_root, firstReceipt.install_root);
    assert.equal(secondReceipt.agent_skills_directory, firstReceipt.agent_skills_directory);
    assert.equal(secondReceipt.bin_directory, firstReceipt.bin_directory);
    assert.equal(secondReceipt.endpoint, firstReceipt.endpoint);
    assert.equal(secondReceipt.stop_hook_enabled, true);
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
    const init = await run(process.execPath, ["scripts/init.mjs", "--codex-home", codexHome, "--bin-dir", binDir, "--agent-home", join(codexHome, "agent"), "--endpoint", `http://127.0.0.1:${address.port}`]);
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
  const port = await freePort();
  let daemon = null;
  let bridge = null;
  try {
    const init = await run(process.execPath, ["scripts/init.mjs", "--codex-home", codexHome, "--bin-dir", binDir, "--agent-home", join(codexHome, "agent"), "--endpoint", `http://127.0.0.1:${port}`]);
    assert.equal(init.code, 0, init.stderr);
    const receipt = JSON.parse(init.stdout);
    bridge = await startBridgeFixture(loadDaemonConfig(receipt.daemon_config).codexapp.socket);
    daemon = spawn(receipt.daemon_wrapper, ["--config", receipt.daemon_config], {
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
    if (bridge) await new Promise((resolve) => bridge.close(resolve));
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("installed CLI binds a session and schedules a timer through the live daemon", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "routecodex-hooks-timer-cli-"));
  const binDir = join(codexHome, "bin");
  const port = await freePort();
  let daemon = null;
  let bridge = null;
  try {
    const init = await run(process.execPath, ["scripts/init.mjs", "--codex-home", codexHome, "--bin-dir", binDir, "--agent-home", join(codexHome, "agent"), "--endpoint", `http://127.0.0.1:${port}`]);
    assert.equal(init.code, 0, init.stderr);
    const receipt = JSON.parse(init.stdout);
    const target = {
      namespace: "codex_tui",
      appserver_id: "tui-appserver",
      scope_id: "local:tui",
      endpoint: "unix:///tmp/tui-appserver.sock",
    };
    const configured = await run(receipt.cli_wrapper, ["config-set", "target", JSON.stringify(target)]);
    assert.equal(configured.code, 0, configured.stderr);

    bridge = await startBridgeFixture(loadDaemonConfig(receipt.daemon_config).codexapp.socket, { sendToIdle: true });
    daemon = spawn(receipt.daemon_wrapper, ["--config", receipt.daemon_config], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ready = JSON.parse(await readLine(daemon.stdout));
    assert.equal(ready.ready, true);

    const threadId = "01a0acc8-e48a-71d1-bcd7-7427e67252a5";
    const bound = await run(receipt.rccs_wrapper, ["session", "bind", "timer-tui", threadId]);
    assert.equal(bound.code, 0, bound.stderr);
    assert.equal(JSON.parse(bound.stdout).target.thread_id, threadId);

    const at = new Date(Date.now() - 1000).toISOString();
    const scheduled = await run(receipt.rccs_wrapper, ["schedule", "add", "cli-timer", at, "timer wake", "--session", "timer-tui"]);
    assert.equal(scheduled.code, 0, scheduled.stderr);
    assert.equal(JSON.parse(scheduled.stdout).session, "timer-tui");

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && bridge.sends.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(bridge.sends.length, 1);
    assert.deepEqual(bridge.sends[0].to, { scopeId: "local:tui", sessionId: threadId });
    assert.deepEqual(bridge.sends[0].body, "timer wake");
    assert.equal(bridge.sends[0].attemptId.startsWith("timer:cli-timer:"), true);

    const status = await run(receipt.rccs_wrapper, ["status"]);
    assert.equal(status.code, 0, status.stderr);
    const state = JSON.parse(status.stdout).control.state;
    assert.equal(state.session_bindings["timer-tui"].target.thread_id, threadId);
    assert.equal(state.schedules["cli-timer"].state, "sent");
  } finally {
    if (daemon) {
      daemon.kill("SIGTERM");
      await once(daemon, "exit");
    }
    if (bridge) await new Promise((resolve) => bridge.close(resolve));
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("rccs installs and creates a recurring notification schedule through the live daemon", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "rccs-recurring-cli-"));
  const binDir = join(codexHome, "bin");
  const port = await freePort();
  let daemon = null;
  let bridge = null;
  try {
    const init = await run(process.execPath, ["scripts/init.mjs", "--codex-home", codexHome, "--bin-dir", binDir, "--agent-home", join(codexHome, "agent"), "--endpoint", `http://127.0.0.1:${port}`]);
    assert.equal(init.code, 0, init.stderr);
    const receipt = JSON.parse(init.stdout);
    const target = {
      namespace: "codex_tui",
      appserver_id: "tui-appserver",
      scope_id: "local:tui",
      endpoint: "unix:///tmp/tui-appserver.sock",
    };
    assert.equal((await run(receipt.rccs_wrapper, ["config", "set", "target", JSON.stringify(target)])).code, 0);
    bridge = await startBridgeFixture(loadDaemonConfig(receipt.daemon_config).codexapp.socket, { sendToIdle: true });
    daemon = spawn(receipt.daemon_wrapper, ["--config", receipt.daemon_config], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(JSON.parse(await readLine(daemon.stdout)).ready, true);

    const threadId = "01a0acc8-e48a-71d1-bcd7-7427e67252a5";
    assert.equal((await run(receipt.rccs_wrapper, ["session", "bind", "recurring", threadId])).code, 0);
    const at = new Date(Date.now() - 3000).toISOString();
    const scheduled = await run(receipt.rccs_wrapper, [
      "schedule",
      "add",
      "recurring-wake",
      at,
      "recurring body",
      "--session", "recurring",
      "--every", "1s",
    ]);
    assert.equal(scheduled.code, 0, scheduled.stderr);
    assert.equal(JSON.parse(scheduled.stdout).mode, "interval");
    assert.equal(JSON.parse(scheduled.stdout).interval_ms, 1000);

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && bridge.sends.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(bridge.sends.length, 2);
    const listed = await run(receipt.rccs_wrapper, ["schedule", "list"]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(Array.isArray(JSON.parse(listed.stdout)), true);
    assert.equal(JSON.parse(listed.stdout)[0].id, "recurring-wake");
    const shown = await run(receipt.rccs_wrapper, ["schedule", "show", "recurring-wake"]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(JSON.parse(shown.stdout).id, "recurring-wake");
    const updated = await run(receipt.rccs_wrapper, ["schedule", "update", "recurring-wake", "--body", "updated body"]);
    assert.equal(updated.code, 0, updated.stderr);
    assert.equal(JSON.parse(updated.stdout).body, "updated body");
    assert.equal(JSON.parse(updated.stdout).state, "enabled");
    const stopDeadline = Date.now() + 5000;
    let stopped = null;
    while (Date.now() < stopDeadline) {
      const current = JSON.parse((await run(receipt.rccs_wrapper, ["status"])).stdout).control.state.schedules["recurring-wake"];
      if (current.state !== "send_pending") {
        stopped = await run(receipt.rccs_wrapper, ["schedule", "stop", "recurring-wake"]);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(stopped, "recurring schedule stayed send_pending too long");
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.equal(JSON.parse(stopped.stdout).state, "stopped");
    assert.equal(JSON.parse(stopped.stdout).enabled, false);
    const state = JSON.parse((await run(receipt.rccs_wrapper, ["status"])).stdout).control.state.schedules["recurring-wake"];
    assert.equal(state.enabled, false);
    assert.equal(state.state, "stopped");
    assert.equal(state.mode, "interval");
  } finally {
    if (daemon) {
      daemon.kill("SIGTERM");
      await once(daemon, "exit");
    }
    if (bridge) await new Promise((resolve) => bridge.close(resolve));
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("rccs accepts namespace/appserver target syntax for subagent schedules", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "rccs-subagent-cli-"));
  const binDir = join(codexHome, "bin");
  const port = await freePort();
  let daemon = null;
  let bridge = null;
  try {
    const init = await run(process.execPath, ["scripts/init.mjs", "--codex-home", codexHome, "--bin-dir", binDir, "--agent-home", join(codexHome, "agent"), "--endpoint", `http://127.0.0.1:${port}`]);
    assert.equal(init.code, 0, init.stderr);
    const receipt = JSON.parse(init.stdout);
    const target = {
      namespace: "codex_tui",
      appserver_id: "tui-appserver",
      scope_id: "local:tui",
      endpoint: "unix:///tmp/tui-appserver.sock",
    };
    assert.equal((await run(receipt.rccs_wrapper, ["config", "set", "target", JSON.stringify(target)])).code, 0);
    bridge = await startBridgeFixture(loadDaemonConfig(receipt.daemon_config).codexapp.socket, { sendToIdle: true });
    daemon = spawn(receipt.daemon_wrapper, ["--config", receipt.daemon_config], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(JSON.parse(await readLine(daemon.stdout)).ready, true);

    const at = new Date(Date.now() - 1000).toISOString();
    const scheduled = await run(receipt.rccs_wrapper, [
      "schedule",
      "add",
      "subagent-once",
      at,
      "run task",
      "--action", "subagent",
      "--target", "codex_tui/tui-appserver",
    ]);
    assert.equal(scheduled.code, 0, scheduled.stderr);
    const body = JSON.parse(scheduled.stdout);
    assert.equal(body.action, "subagent");
    assert.deepEqual(body.target, { namespace: "codex_tui", appserver_id: "tui-appserver" });
  } finally {
    if (daemon) {
      daemon.kill("SIGTERM");
      await once(daemon, "exit");
    }
    if (bridge) await new Promise((resolve) => bridge.close(resolve));
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("rccs lists schedules by current session and exposes global schedules on request", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "rccs-session-list-"));
  const binDir = join(codexHome, "bin");
  const port = await freePort();
  let daemon = null;
  let bridge = null;
  try {
    const init = await run(process.execPath, ["scripts/init.mjs", "--codex-home", codexHome, "--bin-dir", binDir, "--agent-home", join(codexHome, "agent"), "--endpoint", `http://127.0.0.1:${port}`]);
    assert.equal(init.code, 0, init.stderr);
    const receipt = JSON.parse(init.stdout);
    const target = {
      namespace: "codex_tui",
      appserver_id: "tui-appserver",
      scope_id: "local:tui",
      endpoint: "unix:///tmp/tui-appserver.sock",
    };
    assert.equal((await run(receipt.rccs_wrapper, ["config", "set", "target", JSON.stringify(target)])).code, 0);
    bridge = await startBridgeFixture(loadDaemonConfig(receipt.daemon_config).codexapp.socket, { sendToIdle: true });
    daemon = spawn(receipt.daemon_wrapper, ["--config", receipt.daemon_config], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(JSON.parse(await readLine(daemon.stdout)).ready, true);

    const ownThread = "thread-own";
    const otherThread = "thread-other";
    assert.equal((await run(receipt.rccs_wrapper, ["session", "bind", "own", ownThread])).code, 0);
    assert.equal((await run(receipt.rccs_wrapper, ["session", "bind", "other", otherThread])).code, 0);
    const at = new Date(Date.now() + 60_000).toISOString();
    assert.equal((await run(receipt.rccs_wrapper, ["schedule", "add", "own-schedule", at, "own", "--session", "own", "--owner-session", ownThread])).code, 0);
    assert.equal((await run(receipt.rccs_wrapper, ["schedule", "add", "other-schedule", at, "other", "--session", "other", "--owner-session", otherThread])).code, 0);

    const ownList = await run(receipt.rccs_wrapper, ["schedule", "list"], {
      env: { ...process.env, CODEX_SESSION_ID: ownThread, CODEX_THREAD_ID: ownThread },
    });
    assert.equal(ownList.code, 0, ownList.stderr);
    assert.deepEqual(JSON.parse(ownList.stdout).map((entry) => entry.id), ["own-schedule"]);

    const globalList = await run(receipt.rccs_wrapper, ["schedule", "list", "--global"]);
    assert.equal(globalList.code, 0, globalList.stderr);
    assert.deepEqual(JSON.parse(globalList.stdout).map((entry) => entry.id), ["other-schedule", "own-schedule"]);
  } finally {
    if (daemon) {
      daemon.kill("SIGTERM");
      await once(daemon, "exit");
    }
    if (bridge) await new Promise((resolve) => bridge.close(resolve));
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("rccs async wait returns immediately and blocks until daemon delivery", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "rccs-wait-"));
  const binDir = join(codexHome, "bin");
  const port = await freePort();
  let daemon = null;
  let bridge = null;
  try {
    const init = await run(process.execPath, ["scripts/init.mjs", "--codex-home", codexHome, "--bin-dir", binDir, "--agent-home", join(codexHome, "agent"), "--endpoint", `http://127.0.0.1:${port}`]);
    assert.equal(init.code, 0, init.stderr);
    const receipt = JSON.parse(init.stdout);
    const target = {
      namespace: "codex_tui",
      appserver_id: "tui-appserver",
      scope_id: "local:tui",
      endpoint: "unix:///tmp/tui-appserver.sock",
    };
    assert.equal((await run(receipt.rccs_wrapper, ["config", "set", "target", JSON.stringify(target)])).code, 0);
    bridge = await startBridgeFixture(loadDaemonConfig(receipt.daemon_config).codexapp.socket, { sendToIdle: true });
    daemon = spawn(receipt.daemon_wrapper, ["--config", receipt.daemon_config], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(JSON.parse(await readLine(daemon.stdout)).ready, true);

    const threadId = "thread-wait";
    assert.equal((await run(receipt.rccs_wrapper, ["session", "bind", "waiter", threadId])).code, 0);
    const asyncWait = await run(receipt.rccs_wrapper, ["wait", "50ms", "async wake", "--session", "waiter", "--async"], {
      env: { ...process.env, CODEX_SESSION_ID: threadId, CODEX_THREAD_ID: threadId },
    });
    assert.equal(asyncWait.code, 0, asyncWait.stderr);
    assert.equal(JSON.parse(asyncWait.stdout).action, "wait");
    assert.equal(JSON.parse(asyncWait.stdout).state, "configured");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && bridge.sends.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(bridge.sends.length, 1);
    assert.equal(bridge.sends[0].body, "async wake");

    const blockWait = await run(receipt.rccs_wrapper, ["wait", "50ms", "block wake", "--session", "waiter", "--timeout", "5s"], {
      env: { ...process.env, CODEX_SESSION_ID: threadId, CODEX_THREAD_ID: threadId },
    });
    assert.equal(blockWait.code, 0, blockWait.stderr);
    assert.equal(JSON.parse(blockWait.stdout).state, "sent");
    assert.equal(bridge.sends.length, 2);
    assert.equal(bridge.sends[1].body, "block wake");
  } finally {
    if (daemon) {
      daemon.kill("SIGTERM");
      await once(daemon, "exit");
    }
    if (bridge) await new Promise((resolve) => bridge.close(resolve));
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("rccs lists and closes registered subagents through the daemon", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "rccs-subagent-list-"));
  const binDir = join(codexHome, "bin");
  const port = await freePort();
  let daemon = null;
  let bridge = null;
  try {
    const init = await run(process.execPath, ["scripts/init.mjs", "--codex-home", codexHome, "--bin-dir", binDir, "--agent-home", join(codexHome, "agent"), "--endpoint", `http://127.0.0.1:${port}`]);
    assert.equal(init.code, 0, init.stderr);
    const receipt = JSON.parse(init.stdout);
    const target = {
      namespace: "codex_tui",
      appserver_id: "tui-appserver",
      scope_id: "local:tui",
      endpoint: "unix:///tmp/tui-appserver.sock",
    };
    assert.equal((await run(receipt.rccs_wrapper, ["config", "set", "target", JSON.stringify(target)])).code, 0);
    bridge = await startBridgeFixture(loadDaemonConfig(receipt.daemon_config).codexapp.socket, {
      sendToIdle: true,
      subagentStatus: "working",
      subagentClose: true,
    });
    daemon = spawn(receipt.daemon_wrapper, ["--config", receipt.daemon_config], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(JSON.parse(await readLine(daemon.stdout)).ready, true);

    const threadId = "thread-owner";
    assert.equal((await run(receipt.rccs_wrapper, ["session", "bind", "owner", threadId])).code, 0);
    const at = new Date(Date.now() - 1000).toISOString();
    const scheduled = await run(receipt.rccs_wrapper, [
      "schedule", "add", "spawn-child", at, "review task",
      "--action", "subagent",
      "--target", "codex_tui/tui-appserver",
      "--owner-session", threadId,
    ]);
    assert.equal(scheduled.code, 0, scheduled.stderr);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !bridge.lastCreatedThreadId) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!bridge.lastCreatedThreadId) {
      const state = JSON.parse((await run(receipt.rccs_wrapper, ["status"])).stdout).control.state;
      assert.fail(`subagent was not created; schedule state=${JSON.stringify(state.schedules?.["spawn-child"])}`);
    }
    const childThread = bridge.lastCreatedThreadId;
    assert.equal(typeof childThread, "string");
    const listed = await run(receipt.rccs_wrapper, ["subagent", "list", "--session", threadId]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout).map((entry) => entry.thread_id), [childThread]);
    const closed = await run(receipt.rccs_wrapper, ["subagent", "close", childThread]);
    assert.equal(closed.code, 0, closed.stderr);
    assert.equal(JSON.parse(closed.stdout).state, "closed");
    assert.deepEqual(bridge.subagentCalls.map((entry) => entry.method), ["create_subagent", "session_status", "interrupt_turn", "archive_thread"]);
  } finally {
    if (daemon) {
      daemon.kill("SIGTERM");
      await once(daemon, "exit");
    }
    if (bridge) await new Promise((resolve) => bridge.close(resolve));
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

async function startBridgeFixture(socketPath, { sendToIdle = false, subagentStatus = "idle", subagentClose = false } = {}) {
  const fixture = { sends: [], subagentCalls: [], lastCreatedThreadId: null };
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
          result = {
            protocol: "codex-comm/v1",
            query: ["session_status"],
            execution: ["send", ...(subagentClose ? ["create_subagent", "interrupt_turn", "archive_thread"] : [])],
            namespaces: ["codex_tui", "codex_app"],
          };
        } else if (request.method === "status") {
          result = {
            protocol: "codex-comm/v1",
            bridge: "up",
            service_identities: [{ scopeId: "local:hooks", sessionId: "hooksd", kind: "service", live: true }],
            scopes: [{
              scopeId: "local:tui",
              appserverId: "tui-appserver",
              namespace: "codex_tui",
              sessions: [{ id: "thread-1" }],
              agents: [],
              capabilities: ["send_message_to_thread", ...(subagentClose ? ["create_subagent", "interrupt_turn", "archive_thread"] : [])],
            }],
          };
        } else if (request.method === "session_status") {
          fixture.subagentCalls.push({ method: request.method, params: request.params });
          result = {
            address: request.params.address,
            scopeId: "local:tui",
            appserverId: "tui-appserver",
            namespace: "codex_tui",
            status: { state: request.params.address.sessionId.startsWith("child-") ? subagentStatus : (sendToIdle ? "idle" : "unknown") },
          };
        } else if (request.method === "create_subagent") {
          fixture.subagentCalls.push({ method: request.method, params: request.params });
          fixture.lastCreatedThreadId = `child-${fixture.subagentCalls.length}`;
          result = {
            protocol: "codex-comm/v1",
            attemptId: request.params.attemptId,
            scopeId: request.params.address.scopeId,
            appserverId: request.params.address.appserverId,
            namespace: request.params.address.namespace,
            threadId: fixture.lastCreatedThreadId,
            turnId: `turn-${fixture.subagentCalls.length}`,
          };
        } else if (request.method === "interrupt_turn") {
          fixture.subagentCalls.push({ method: request.method, params: request.params });
          result = {
            protocol: "codex-comm/v1",
            scopeId: request.params.address.scopeId,
            appserverId: "tui-appserver",
            namespace: "codex_tui",
            threadId: request.params.threadId,
            turnId: request.params.turnId,
            state: "interrupted",
          };
        } else if (request.method === "archive_thread") {
          fixture.subagentCalls.push({ method: request.method, params: request.params });
          result = {
            protocol: "codex-comm/v1",
            scopeId: request.params.address.scopeId,
            appserverId: "tui-appserver",
            namespace: "codex_tui",
            threadId: request.params.threadId,
            state: "archived",
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
  server.fixture = fixture;
  Object.defineProperties(server, {
    sends: { get: () => fixture.sends },
    subagentCalls: { get: () => fixture.subagentCalls },
    lastCreatedThreadId: { get: () => fixture.lastCreatedThreadId },
  });
  return server;
}
