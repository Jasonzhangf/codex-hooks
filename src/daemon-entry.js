#!/usr/bin/env node

import { homedir } from "node:os";
import { join } from "node:path";
import { HooksDaemon } from "./daemon.js";
import { FrameworkControlPlane } from "./control.js";
import { JsonStateStore } from "./persistence.js";
import { DaemonHttpServer } from "./server.js";
import { loadDaemonConfig } from "./config.js";
import { CodexAppBridgePort, verifyCodexAppPort } from "./codexapp-port.js";
import { normalizeLoopbackHost } from "./endpoint.js";
import { TimerOperator } from "./timer.js";

const TIMER_TICK_INTERVAL_MS = 1000;

const options = parseArgs(process.argv.slice(2));
const config = options.configPath ? loadDaemonConfig(options.configPath) : null;
const codexapp = config?.codexapp ? new CodexAppBridgePort(config.codexapp) : null;
if (!codexapp) throw new Error("a configured codexapp bridge socket is required; refusing to start without the internal codexapp service");
await verifyCodexAppPort(codexapp, config?.codexapp?.required_capabilities);
const stateFile = expandHome(options.stateFile || (config ? join(config.runtime.state_directory, "state.json") : join(homedir(), ".codex", "routecodex-hooks", "state", "state.json")));
const daemon = new HooksDaemon({ codexapp, store: new JsonStateStore(stateFile) });
const recovered = daemon.recoverOutbox();
const timer = new TimerOperator({
  store: daemon.store,
  dispatch: (intent) => daemon.dispatchIntent(intent, { kind: "timer" }),
  resume: (target) => daemon.flushPending(target),
  createSubagent: (request) => daemon.createSubagent(request),
  registerSubagent: (request) => control.registerSubagent(request),
});
const control = new FrameworkControlPlane({ store: daemon.store, subagents: daemon });
const server = new DaemonHttpServer(daemon, { control });
const host = normalizeLoopbackHost(options.host || config?.runtime.host || "127.0.0.1");
const endpoint = await server.listen(host, options.port ?? config?.runtime.port ?? 8787);

let timerRunning = false;
let timerInterval = null;
let timerTick = Promise.resolve();
timerInterval = setInterval(() => {
  if (timerRunning) return;
  timerRunning = true;
  timerTick = timer.tick()
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({
        protocol: "routecodex-hooks/v1",
        component: "timer",
        error: { code: error.code || "timer_tick_failed", message: error.message },
      })}\n`);
    })
    .finally(() => {
      timerRunning = false;
    });
}, TIMER_TICK_INTERVAL_MS);

process.stdout.write(`${JSON.stringify({ protocol: "routecodex-hooks/v1", ready: true, endpoint, state_file: stateFile, recovered_outbox: recovered.length })}\n`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  await timerTick;
  await server.close();
  if (typeof codexapp.close === "function") await codexapp.close();
}

process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--host" || value === "--port" || value === "--state-file" || value === "--config") {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${value} requires a value`);
      const key = value.slice(2).replaceAll("-", "_");
      options[key === "state_file" ? "stateFile" : key === "config" ? "configPath" : key] = value === "--port" ? parsePort(next) : next;
      index += 1;
      continue;
    }
    throw new Error(`unsupported argument: ${value}`);
  }
  return options;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`invalid port: ${value}`);
  return port;
}

function expandHome(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}
