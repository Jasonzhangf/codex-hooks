#!/usr/bin/env node

import fs from "node:fs";
import { McpStateClient } from "./mcp.js";
import { readInstallRecord, setStopHookEnabled, writeInstallRecord } from "./install.js";
import { normalizeLoopbackEndpoint } from "./endpoint.js";

const endpoint = process.env.ROUTECODEX_HOOKS_ENDPOINT || null;
const [operation, ...args] = process.argv.slice(2);

if (operation === "config-show") {
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
} else if (operation === "status") {
  const record = readInstallRecord();
  print(await new McpStateClient(normalizeEndpoint(endpoint || record.endpoint)).queryStatus());
} else if (operation === "operator-enable" || operation === "operator-disable") {
  const name = required(args[0], "operator name");
  await mutate({ operation: "operator.set_enabled", name, enabled: operation === "operator-enable" });
} else if (operation === "schedule-upsert") {
  await mutate({ operation: "schedule.upsert", id: required(args[0], "schedule id"), at: required(args[1], "schedule time"), body: required(args[2], "schedule body"), target: parseTarget(args[3]), ...(args[4] ? { send_mode: args[4] } : {}) });
} else if (operation === "schedule-remove") {
  await mutate({ operation: "schedule.remove", id: required(args[0], "schedule id") });
} else if (operation === "schedule-pause" || operation === "schedule-resume") {
  await mutate({ operation: operation === "schedule-pause" ? "schedule.pause" : "schedule.resume", id: required(args[0], "schedule id") });
} else {
  throw new Error("usage: config-show | config-set <endpoint|codexapp_socket|source_scope|source_session|target_scope|target> <value> | hook-enable|hook-disable stop | supervisor-enable|supervisor-disable | status | operator-enable|operator-disable <name> | schedule-upsert <id> <at> <body> <target-json> [idle_only|working_allowed] | schedule-pause|schedule-resume|schedule-remove <id>");
}

async function mutate(value) {
  const record = tryReadInstallRecord();
  const targetEndpoint = normalizeEndpoint(endpoint || record?.endpoint || "http://127.0.0.1:8787");
  const response = await fetch(`${targetEndpoint}/v1/control/mutate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `daemon mutation failed: ${response.status}`);
  print(body.result);
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

function parseTargetConfig(value) {
  let target;
  try { target = JSON.parse(value); } catch (error) { throw new Error(`target config is invalid: ${error.message}`); }
  if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error("target config must be an object");
  for (const key of ["namespace", "appserver_id", "scope_id", "endpoint"]) required(target[key], `target.${key}`);
  if (!["codex_tui", "codex_app"].includes(target.namespace)) throw new Error("target.namespace must be codex_tui or codex_app");
  if (!target.endpoint.startsWith("unix://")) throw new Error("target.endpoint must use unix://");
  return { namespace: target.namespace, appserver_id: target.appserver_id, scope_id: target.scope_id, endpoint: target.endpoint };
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
