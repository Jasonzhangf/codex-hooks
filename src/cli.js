#!/usr/bin/env node

import fs from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpStateClient } from "./mcp.js";
import {
  installFromSource,
  readInstallRecord,
  setStopHookEnabled,
  writeInstallRecord,
} from "./install.js";
import { normalizeLoopbackEndpoint } from "./endpoint.js";

const endpoint = process.env.ROUTECODEX_HOOKS_ENDPOINT || null;
const argv = process.argv.slice(2);
const [operation, ...args] = argv;

if (operation === "init") {
  print({ initialized: true, ...initCommand(args) });
} else if (operation === "status") {
  const record = readInstallRecord();
  print(await new McpStateClient(normalizeEndpoint(endpoint || record.endpoint)).queryStatus());
} else if (operation === "session") {
  await sessionCommand(args);
} else if (operation === "schedule") {
  await scheduleCommand(args);
} else if (operation === "wait") {
  await waitCommand(args);
} else if (operation === "subagent") {
  await subagentCommand(args);
} else if (operation === "config") {
  configCommand(args);
} else if (operation === "hook") {
  hookCommand(args);
} else if (operation === "supervisor") {
  supervisorCommand(args);
} else if (operation === "operator") {
  await operatorCommand(args);
} else if (operation === "config-show") {
  const record = readInstallRecord();
  const daemon = readJson(record.daemon_config);
  print({ install: record, daemon });
} else if (operation === "config-set") {
  const record = readInstallRecord();
  const key = required(args[0], "config key");
  const value = required(args[1], "config value");
  print(setConfig(record, key, value));
} else if (operation === "hook-enable" || operation === "hook-disable") {
  const hook = required(args[0], "hook name");
  if (hook !== "stop") throw new Error(`unsupported hook: ${hook}`);
  print(setStopHookEnabled(readInstallRecord(), operation === "hook-enable"));
} else if (operation === "supervisor-enable" || operation === "supervisor-disable") {
  print(setSupervisorEnabled(readInstallRecord(), operation === "supervisor-enable"));
} else if (operation === "operator-enable" || operation === "operator-disable") {
  const name = required(args[0], "operator name");
  await mutate({ operation: "operator.set_enabled", name, enabled: operation === "operator-enable" });
} else if (operation === "session-bind") {
  const record = readInstallRecord();
  const daemon = readJson(record.daemon_config);
  const alias = required(args[0], "session alias");
  const sessionId = required(args[1], "session id");
  const options = parseOptions(args.slice(2), ["--target", "--namespace", "--appserver", "--replace"]);
  await mutate({
    operation: "session.bind",
    alias,
    target: resolveSessionTarget(daemon, options, sessionId),
    replace: options.replace === true,
  });
} else if (operation === "session-unbind") {
  await mutate({ operation: "session.unbind", alias: required(args[0], "session alias") });
} else if (operation === "schedule-add") {
  const options = parseOptions(args.slice(3), ["--session", "--send-mode"]);
  await mutate({
    operation: "schedule.add",
    id: required(args[0], "schedule id"),
    at: required(args[1], "schedule time"),
    body: required(args[2], "schedule body"),
    session: required(options.session, "--session"),
    ...(options.send_mode ? { send_mode: options.send_mode } : {}),
  });
} else if (operation === "schedule-upsert") {
  await mutate({ operation: "schedule.upsert", id: required(args[0], "schedule id"), at: required(args[1], "schedule time"), body: required(args[2], "schedule body"), target: parseTarget(args[3]), ...(args[4] ? { send_mode: args[4] } : {}) });
} else if (operation === "schedule-remove") {
  await mutate({ operation: "schedule.remove", id: required(args[0], "schedule id") });
} else if (operation === "schedule-pause" || operation === "schedule-resume") {
  await mutate({ operation: operation === "schedule-pause" ? "schedule.pause" : "schedule.resume", id: required(args[0], "schedule id") });
} else {
  throw new Error(usage());
}

async function sessionCommand(args) {
  const [subcommand, ...rest] = args;
  if (subcommand === "bind") {
    const record = readInstallRecord();
    const daemon = readJson(record.daemon_config);
    const alias = required(rest[0], "session alias");
    const sessionId = required(rest[1], "session id");
    const options = parseOptions(rest.slice(2), ["--target", "--namespace", "--appserver", "--replace"]);
    await mutate({
      operation: "session.bind",
      alias,
      target: resolveSessionTarget(daemon, options, sessionId),
      replace: options.replace === true,
    });
    return;
  }
  if (subcommand === "unbind") {
    await mutate({ operation: "session.unbind", alias: required(rest[0], "session alias") });
    return;
  }
  throw new Error("usage: rccs session bind|unbind ...");
}

async function scheduleCommand(args) {
  const [subcommand, ...rest] = args;
  if (subcommand === "add") {
    const options = parseOptions(rest.slice(3), [
      "--session",
      "--target",
      "--send-mode",
      "--every",
      "--once",
      "--action",
      "--cwd",
      "--model",
      "--allow-concurrent",
      "--owner-session",
    ]);
    if (options.once && options.every) throw new Error("--once and --every cannot be used together");
    const action = options.action || "notify";
    const mode = options.every ? "interval" : "once";
    const at = required(rest[1], "schedule time");
    const body = required(rest[2], "schedule body");
    const request = {
      operation: "schedule.add",
      id: required(rest[0], "schedule id"),
      action,
      mode,
      at,
      body,
      ...(options.send_mode ? { send_mode: options.send_mode } : {}),
      ...(options.every ? { interval_ms: parseDuration(options.every) } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.allow_concurrent === true ? { allow_concurrent: true } : {}),
      ...(ownerSessionId(options) ? { owner_session_id: ownerSessionId(options) } : {}),
    };
    if (options.session) request.session = options.session;
    else if (options.target) request.target = parseTargetIdentity(options.target);
    else throw new Error("--session or --target is required");
    await mutate(request);
    return;
  }
  if (subcommand === "list") {
    const options = parseOptions(rest, ["--global", "--session"]);
    if (options.global && options.session) throw new Error("--global and --session cannot be used together");
    const state = await queryControl();
    const owner = options.global ? null : required(options.session || currentSessionId(), "current session; pass --session or --global");
    const schedules = Object.values(state.state.schedules || {})
      .filter((schedule) => owner == null || schedule.owner_session_id === owner)
      .sort((left, right) => left.id.localeCompare(right.id));
    print(schedules);
    return;
  }
  if (subcommand === "show") {
    const id = required(rest[0], "schedule id");
    const state = await queryControl();
    const schedules = state.state.schedules || {};
    if (!Object.hasOwn(schedules, id)) throw new Error(`schedule not found: ${id}`);
    print(schedules[id]);
    return;
  }
  if (subcommand === "update") {
    const options = parseOptions(rest.slice(1), [
      "--at",
      "--body",
      "--send-mode",
      "--session",
      "--target",
      "--every",
      "--once",
      "--action",
      "--cwd",
      "--model",
      "--allow-concurrent",
      "--owner-session",
    ]);
    if (options.once && options.every) throw new Error("--once and --every cannot be used together");
    const mode = options.once ? "once" : options.every ? "interval" : undefined;
    const request = {
      operation: "schedule.update",
      id: required(rest[0], "schedule id"),
      ...(options.at ? { at: options.at } : {}),
      ...(options.body ? { body: options.body } : {}),
      ...(options.send_mode ? { send_mode: options.send_mode } : {}),
      ...(mode ? { mode } : {}),
      ...(options.every ? { interval_ms: parseDuration(options.every) } : {}),
      ...(options.action ? { action: options.action } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.allow_concurrent === true ? { allow_concurrent: true } : {}),
      ...(options.session ? { session: options.session } : {}),
      ...(options.target ? { target: parseTargetIdentity(options.target) } : {}),
      ...(ownerSessionId(options) ? { owner_session_id: ownerSessionId(options) } : {}),
    };
    await mutate(request);
    return;
  }
  if (["remove", "pause", "resume", "stop"].includes(subcommand)) {
    const operation = { remove: "schedule.remove", pause: "schedule.pause", resume: "schedule.resume", stop: "schedule.stop" }[subcommand];
    await mutate({ operation, id: required(rest[0], "schedule id") });
    return;
  }
  throw new Error("usage: rccs schedule add|list|show|update|remove|pause|resume|stop ...");
}

async function waitCommand(args) {
  const duration = required(args[0], "wait duration");
  const remainder = args.slice(1);
  const body = remainder[0] && !remainder[0].startsWith("--") ? remainder.shift() : "Wait elapsed. Continue the current task.";
  const options = parseOptions(remainder, [
    "--session",
    "--async",
    "--send-mode",
    "--id",
    "--timeout",
    "--owner-session",
  ]);
  const session = options.session || await findCurrentSessionAlias();
  const request = {
    operation: options.async ? "wait.create" : "wait.block",
    id: options.id || `wait-${Date.now()}-${process.pid}`,
    at: parseWaitTime(duration),
    body,
    session: required(session, "current session alias; bind the session or pass --session"),
    send_mode: options.send_mode || (options.async ? "idle_only" : "working_allowed"),
    ...(ownerSessionId(options) ? { owner_session_id: ownerSessionId(options) } : {}),
    ...(options.timeout ? { timeout_ms: parseDuration(options.timeout) } : {}),
  };
  await mutate(request);
}

async function subagentCommand(args) {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") {
    const options = parseOptions(rest, ["--global", "--session"]);
    if (options.global && options.session) throw new Error("--global and --session cannot be used together");
    const owner = options.global ? null : required(options.session || currentSessionId(), "current session; pass --session or --global");
    const state = await queryControl();
    const subagents = Object.values(state.state.subagents || {})
      .filter((subagent) => owner == null || subagent.owner_session_id === owner)
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
    print(subagents);
    return;
  }
  if (subcommand === "close") {
    await mutate({ operation: "subagent.close", thread_id: required(rest[0], "subagent thread id") });
    return;
  }
  throw new Error("usage: rccs subagent list [--global|--session <session-id>] | rccs subagent close <thread-id>");
}

function configCommand(args) {
  const [subcommand, ...rest] = args;
  if (subcommand === "show") {
    const record = readInstallRecord();
    print({ install: record, daemon: readJson(record.daemon_config) });
    return;
  }
  if (subcommand === "set") {
    const record = readInstallRecord();
    print(setConfig(record, required(rest[0], "config key"), required(rest[1], "config value")));
    return;
  }
  throw new Error("usage: rccs config show|set ...");
}

function hookCommand(args) {
  const [subcommand, name] = args;
  if (subcommand !== "enable" && subcommand !== "disable") throw new Error("usage: rccs hook enable|disable stop");
  if (required(name, "hook name") !== "stop") throw new Error(`unsupported hook: ${name}`);
  print(setStopHookEnabled(readInstallRecord(), subcommand === "enable"));
}

function supervisorCommand(args) {
  const [subcommand] = args;
  if (subcommand !== "enable" && subcommand !== "disable") throw new Error("usage: rccs supervisor enable|disable");
  print(setSupervisorEnabled(readInstallRecord(), subcommand === "enable"));
}

async function operatorCommand(args) {
  const [subcommand, name] = args;
  if (subcommand !== "enable" && subcommand !== "disable") throw new Error("usage: rccs operator enable|disable <name>");
  await mutate({ operation: "operator.set_enabled", name: required(name, "operator name"), enabled: subcommand === "enable" });
}

function usage() {
  return "usage: rccs init | rccs status | rccs session bind|unbind ... | rccs schedule add|list|show|update|remove|pause|resume|stop ... | rccs wait <duration> [body] [--async] | rccs subagent list|close ... | rccs config show|set ... | rccs hook enable|disable stop | rccs supervisor enable|disable | rccs operator enable|disable <name>";
}

function initCommand(args) {
  const options = parseInitOptions(args);
  const previous = tryReadInstallRecord();
  const reusePrevious = !options.codexHome && !options.binDir && !options.agentHome;
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return installFromSource({
    sourceRoot,
    codexHome: options.codexHome ?? (reusePrevious && previous?.install_root ? dirname(previous.install_root) : undefined),
    binDir: options.binDir ?? (reusePrevious ? previous?.bin_directory : undefined),
    agentHome: options.agentHome ?? (reusePrevious && previous?.agent_skills_directory ? dirname(previous.agent_skills_directory) : undefined),
    endpoint: options.endpoint ?? (reusePrevious ? previous?.endpoint : undefined) ?? "http://127.0.0.1:8787",
    stopHookEnabled: options.stopHookEnabled ?? (reusePrevious ? previous?.stop_hook_enabled : undefined) ?? true,
    supervisorEnabled: options.supervisorEnabled ?? (reusePrevious ? previous?.supervisor_enabled : undefined),
  });
}

function parseInitOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (["--endpoint", "--codex-home", "--bin-dir", "--agent-home"].includes(key)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
      const option = {
        "--endpoint": "endpoint",
        "--codex-home": "codexHome",
        "--bin-dir": "binDir",
        "--agent-home": "agentHome",
      }[key];
      options[option] = value;
      index += 1;
      continue;
    }
    if (key === "--disable-stop-hook") {
      options.stopHookEnabled = false;
      continue;
    }
    if (key === "--enable-stop-hook") {
      options.stopHookEnabled = true;
      continue;
    }
    if (key === "--enable-supervisor") {
      options.supervisorEnabled = true;
      continue;
    }
    if (key === "--disable-supervisor") {
      options.supervisorEnabled = false;
      continue;
    }
    throw new Error(`unsupported init argument: ${key}`);
  }
  return options;
}

async function mutate(value) {
  const record = tryReadInstallRecord();
  const targetEndpoint = normalizeEndpoint(endpoint || record?.endpoint || "http://127.0.0.1:8787");
  const response = await fetch(`${targetEndpoint}/v1/control/mutate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `daemon mutation failed: ${response.status}`);
  print(body.result);
}

async function queryControl() {
  const record = tryReadInstallRecord();
  const targetEndpoint = normalizeEndpoint(endpoint || record?.endpoint || "http://127.0.0.1:8787");
  return new McpStateClient(targetEndpoint).queryState();
}

function setConfig(record, key, value) {
  const daemon = readJson(record.daemon_config);
  if (key === "endpoint") {
    const parsed = normalizeLoopbackEndpoint(value);
    record.endpoint = parsed.endpoint;
    daemon.runtime.host = parsed.host;
    daemon.runtime.port = parsed.port;
  } else if (key === "codexapp_socket") {
    daemon.codexapp.socket = value;
  } else if (key === "source_scope") {
    daemon.codexapp.source_address.scopeId = value;
  } else if (key === "source_session") {
    daemon.codexapp.source_address.sessionId = value;
  } else if (key === "target_scope") {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) throw new Error("target_scope must be <namespace/appserver>=<scope-id>");
    daemon.codexapp.target_scopes[value.slice(0, separator)] = value.slice(separator + 1);
  } else if (key === "target") {
    const target = parseTargetConfig(value);
    const targetsPath = daemon.codexapp.targets_file;
    if (!targetsPath) throw new Error("codexapp.targets_file is required for target configuration");
    const targets = readJson(targetsPath);
    const index = targets.findIndex((entry) => entry.scope_id === target.scope_id);
    if (index >= 0) targets[index] = target;
    else targets.push(target);
    fs.writeFileSync(targetsPath, `${JSON.stringify(targets, null, 2)}\n`, "utf8");
    daemon.codexapp.target_scopes[`${target.namespace}/${target.appserver_id}`] = target.scope_id;
  } else {
    throw new Error(`unsupported config key: ${key}`);
  }
  fs.writeFileSync(record.daemon_config, `${JSON.stringify(daemon, null, 2)}\n`, "utf8");
  writeInstallRecord(record);
  return { key, value, install: record, daemon };
}

function setSupervisorEnabled(record, enabled) {
  const daemon = readJson(record.daemon_config);
  daemon.supervisor.enabled = enabled;
  fs.writeFileSync(record.daemon_config, `${JSON.stringify(daemon, null, 2)}\n`, "utf8");
  const updated = { ...record, supervisor_enabled: enabled };
  writeInstallRecord(updated);
  return { enabled, install: updated, daemon };
}

function parseTarget(value) {
  try { return JSON.parse(required(value, "target JSON")); } catch (error) { throw new Error(`target JSON is invalid: ${error.message}`); }
}

function parseTargetIdentity(value) {
  const [namespace, appserverId, ...extra] = required(value, "target").split("/");
  if (!namespace || !appserverId || extra.length > 0) throw new Error("--target must be <namespace/appserver>");
  return { namespace, appserver_id: appserverId };
}

function parseTargetConfig(value) {
  let target;
  try { target = JSON.parse(value); } catch (error) { throw new Error(`target config is invalid: ${error.message}`); }
  if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error("target config must be an object");
  for (const key of ["namespace", "appserver_id", "scope_id", "endpoint"]) required(target[key], `target.${key}`);
  if (!["codex_tui", "codex_app"].includes(target.namespace)) throw new Error("target.namespace must be codex_tui or codex_app");
  if (!target.endpoint.startsWith("unix://")) throw new Error("target.endpoint must use unix://");
  return { namespace: target.namespace, appserver_id: target.appserver_id, scope_id: target.scope_id, endpoint: target.endpoint };
}

function resolveSessionTarget(daemon, options, sessionId) {
  const targets = readJson(daemon.codexapp.targets_file);
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error("no codexapp target is configured; run config-set target first");
  }
  let target;
  if (options.target) {
    const [namespace, appserverId, ...extra] = options.target.split("/");
    if (!namespace || !appserverId || extra.length > 0) throw new Error("--target must be <namespace/appserver>");
    target = targets.find((entry) => entry.namespace === namespace && entry.appserver_id === appserverId);
  } else if (options.namespace || options.appserver) {
    target = targets.find((entry) => entry.namespace === options.namespace && entry.appserver_id === options.appserver);
  } else if (targets.length === 1) {
    target = targets[0];
  } else {
    throw new Error("multiple codexapp targets are configured; pass --target <namespace/appserver>");
  }
  if (!target) throw new Error("requested codexapp target is not configured");
  return {
    namespace: target.namespace,
    appserver_id: target.appserver_id,
    scope_id: target.scope_id,
    session_id: sessionId,
    thread_id: sessionId,
  };
}

function parseOptions(args, allowed) {
  const allowedSet = new Set(allowed);
  const booleanOptions = new Set(["--replace", "--once", "--allow-concurrent", "--async", "--global"]);
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!allowedSet.has(key)) throw new Error(`unsupported option: ${key}`);
    if (booleanOptions.has(key)) {
      options[key.slice(2).replaceAll("-", "_")] = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
    options[key.slice(2).replaceAll("-", "_")] = value;
    index += 1;
  }
  return options;
}

function parseDuration(value) {
  const match = /^([1-9]\d*)(ms|s|m|h|d)$/.exec(value);
  if (!match) throw new Error("--every must be a positive duration such as 30s, 5m, 1h, or 1d");
  const multiplier = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
  const milliseconds = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(milliseconds)) throw new Error("--every duration is too large");
  return milliseconds;
}

function parseWaitTime(value) {
  if (!Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return new Date(Date.now() + parseDuration(value)).toISOString();
}

function ownerSessionId(options = {}) {
  return options.owner_session || currentSessionId();
}

function currentSessionId() {
  return process.env.CODEX_SESSION_ID || process.env.CODEX_THREAD_ID || null;
}

async function findCurrentSessionAlias() {
  const sessionId = currentSessionId();
  if (!sessionId) return null;
  const state = await queryControl();
  const bindings = Object.values(state.state.session_bindings || {});
  const match = bindings.find((binding) => binding.target?.thread_id === sessionId || binding.target?.session_id === sessionId);
  return match?.alias || null;
}

function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value;
}

function readJson(path) {
  try { return JSON.parse(fs.readFileSync(path, "utf8")); } catch (error) { throw new Error(`cannot load ${path}: ${error.message}`); }
}

function tryReadInstallRecord() {
  try { return readInstallRecord(); } catch { return null; }
}

function normalizeEndpoint(value) {
  return normalizeLoopbackEndpoint(value).endpoint;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
