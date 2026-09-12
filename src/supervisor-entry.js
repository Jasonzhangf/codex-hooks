#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { loadDaemonConfig } from "./config.js";
import { CodexAppBridgePort, verifyCodexAppPort } from "./codexapp-port.js";
import { HooksSupervisor } from "./supervisor.js";
import { readInstallRecord } from "./install.js";

const options = parseArgs(process.argv.slice(2));
const configPath = options.configPath || readInstallRecord().daemon_config;
const config = loadDaemonConfig(configPath);
if (!config.supervisor?.enabled) throw new Error("hooks supervisor is disabled; enable it with routecodex-hooks supervisor-enable");

const timeoutMs = config.supervisor.startup_timeout_ms;
const supervisor = new HooksSupervisor({
  startCodexapp: () => startCodexapp(config),
  startHooksd: () => startProcess(config.supervisor.hooksd, "hooksd", timeoutMs),
});

try {
  await supervisor.start();
  process.stdout.write(`${JSON.stringify({ protocol: "routecodex-hooks-supervisor/v1", ready: true, state: supervisor.status().state })}\n`);
} catch (error) {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
}

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    await supervisor.stop();
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
  }
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

async function startCodexapp(currentConfig) {
  const internalCommand = process.env.ROUTECODEX_V3_CODEXAPP_BINARY;
  if (!internalCommand) throw new Error("RouteCodex internal codexapp executable is required");
  if (!isAbsolute(internalCommand) || basename(internalCommand) !== "rccv3-codexapp") {
    throw new Error(`RouteCodex internal codexapp executable is invalid: ${internalCommand}`);
  }
  let executable;
  try {
    executable = fs.realpathSync(internalCommand);
    const stat = fs.statSync(executable);
    if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new Error("not executable");
  } catch (error) {
    throw new Error(`RouteCodex internal codexapp executable is unavailable: ${internalCommand}: ${error.message}`);
  }
  const spec = { ...currentConfig.supervisor.codexapp, command: internalCommand };
  const processHandle = await startProcess(
    spec,
    "codexapp",
    timeoutMs,
    isCodexAppReady,
  );
  const port = new CodexAppBridgePort(currentConfig.codexapp);
  try {
    await verifyCodexAppPort(port, currentConfig.codexapp.required_capabilities);
  } catch (error) {
    await processHandle.stop().catch((cleanupError) => { error.cleanupError = cleanupError; });
    throw error;
  }
  return Object.assign(port, processHandle);
}

async function startProcess(spec, name, timeout, readiness = (record) => record?.ready === true) {
  if (!spec?.command) throw new Error(`${name} process command is required`);
  const child = spawn(spec.command, spec.args || [], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const ready = await readReadyLine(child, name, timeout);
    if (!readiness(ready)) throw new Error(`${name} did not become ready`);
    return {
      ready: true,
      pid: child.pid,
      stop: () => stopProcess(child, name, timeout),
    };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        await stopProcess(child, name, timeout);
      } catch (cleanupError) {
        error.cleanupError = cleanupError;
      }
    }
    throw error;
  }
}

function isCodexAppReady(record) {
  return record?.ready === true || (
    record?.bridge === "up" &&
    typeof record.socket === "string" &&
    record.socket.trim() !== ""
  );
}

function readReadyLine(child, name, timeout) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => finish(reject, new Error(`${name} readiness timed out`)), timeout);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.once("exit", onExit);
      callback(value);
    };
    const onData = (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let parsed;
      try { parsed = JSON.parse(buffer.slice(0, newline)); } catch (error) { finish(reject, new Error(`${name} readiness is not JSON: ${error.message}`)); return; }
      finish(resolve, parsed);
    };
    const onExit = (code, signal) => finish(reject, new Error(`${name} exited before readiness code=${code} signal=${signal || "none"}`));
    child.stdout?.setEncoding("utf8");
    child.stderr?.resume();
    child.stdout?.on("data", onData);
    child.once("error", (error) => finish(reject, new Error(`${name} failed to start: ${error.message}`)));
    child.once("exit", onExit);
  });
}

async function stopProcess(child, name, timeout) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await Promise.race([once(child, "exit"), new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} graceful stop timed out`)), timeout))]);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    throw error;
  }
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--config") {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) throw new Error("--config requires a value");
      options.configPath = next;
      index += 1;
    } else {
      throw new Error(`unsupported argument: ${value}`);
    }
  }
  return options;
}
