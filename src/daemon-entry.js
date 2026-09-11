#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { HooksDaemon } from "./daemon.js";
import { JsonStateStore } from "./persistence.js";
import { DaemonHttpServer } from "./server.js";

const options = parseArgs(process.argv.slice(2));
const modulePath = options.codexappModule || process.env.ROUTECODEX_CODEXAPP_MODULE;
if (!modulePath) {
  throw new Error("--codexapp-module or ROUTECODEX_CODEXAPP_MODULE is required; refusing to start without a real codexapp port");
}

const codexapp = await loadCodexApp(modulePath);
const stateFile = expandHome(options.stateFile || join(homedir(), ".codex", "routecodex-hooks", "state", "state.json"));
const daemon = new HooksDaemon({ codexapp, store: new JsonStateStore(stateFile) });
const server = new DaemonHttpServer(daemon);
const endpoint = await server.listen(options.host || "127.0.0.1", options.port ?? 8787);

process.stdout.write(`${JSON.stringify({ protocol: "routecodex-hooks/v1", ready: true, endpoint, state_file: stateFile })}\n`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await server.close();
  if (typeof codexapp.close === "function") await codexapp.close();
}

process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));

async function loadCodexApp(value) {
  const absolute = isAbsolute(value) ? value : resolve(value);
  const loaded = await import(pathToFileURL(absolute).href);
  const factory = loaded.createCodexAppPort || loaded.default;
  if (typeof factory !== "function") throw new Error(`codexapp module must export createCodexAppPort(): ${absolute}`);
  const port = await factory();
  return port;
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--host" || value === "--port" || value === "--state-file" || value === "--codexapp-module") {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${value} requires a value`);
      const key = value.slice(2).replaceAll("-", "_");
      options[key === "codexapp_module" ? "codexappModule" : key === "state_file" ? "stateFile" : key] = value === "--port" ? parsePort(next) : next;
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
