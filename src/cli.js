#!/usr/bin/env node

import fs from "node:fs";
import { McpStateClient } from "./mcp.js";
import { readInstallRecord, setStopHookEnabled, writeInstallRecord } from "./install.js";

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
} else if (operation === "status") {
  const record = readInstallRecord();
  print(await new McpStateClient(endpoint || record.endpoint).queryStatus());
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
  throw new Error("usage: config-show | config-set <endpoint|codexapp_socket|source_scope|source_session|target_scope> <value> | hook-enable|hook-disable stop | status | operator-enable|operator-disable <name> | schedule-upsert <id> <at> <body> <target-json> [idle_only|working_allowed] | schedule-pause|schedule-resume|schedule-remove <id>");
}

async function mutate(value) {
  const record = tryReadInstallRecord();
  const targetEndpoint = endpoint || record?.endpoint || "http://127.0.0.1:8787";
  const response = await fetch(`${targetEndpoint}/v1/control/mutate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `daemon mutation failed: ${response.status}`);
  print(body.result);
}

function setConfig(record, key, value) {
  const daemon = readJson(record.daemon_config);
  if (key === "endpoint") {
    const url = normalizeEndpoint(value);
    record.endpoint = url;
    const parsed = new URL(url);
    daemon.runtime.host = parsed.hostname;
    daemon.runtime.port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
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
  } else {
    throw new Error(`unsupported config key: ${key}`);
  }
  fs.writeFileSync(record.daemon_config, `${JSON.stringify(daemon, null, 2)}\n`, "utf8");
  writeInstallRecord(record);
  return { key, value, install: record, daemon };
}

function parseTarget(value) {
  try { return JSON.parse(required(value, "target JSON")); } catch (error) { throw new Error(`target JSON is invalid: ${error.message}`); }
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
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash) throw new Error("daemon endpoint must be an http(s) origin");
  return value.replace(/\/$/, "");
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
