#!/usr/bin/env node

import fs from "node:fs";
import { normalizeLoopbackEndpoint } from "./endpoint.js";

const options = parseArgs(process.argv.slice(2));
const input = await readStdin();
const endpoint = normalizeLoopbackEndpoint(process.env.ROUTECODEX_HOOKS_ENDPOINT || loadEndpoint(options.config)).endpoint;
const kind = options.kind;
const intent = input.intent || null;
const event = { ...input };
delete event.intent;
const response = await fetch(`${endpoint}/v1/hooks/dispatch`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ event, kind, intent }),
});
const body = await response.text();
if (!response.ok) throw new Error(`hooks daemon rejected event: ${response.status} ${body}`);
const result = JSON.parse(body);
if (result.decision === "fail_closed" || result.decision === "unknown_delivery") {
  const error = new Error(result.error?.message || `hooks daemon ${result.decision}`);
  error.code = result.error?.code || result.decision;
  throw error;
}
process.stdout.write(`${JSON.stringify(result.hook_output || {})}\n`);

function readStdin() {
  return new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { text += chunk; });
    process.stdin.on("end", () => {
      try { resolve(JSON.parse(text)); } catch { reject(new Error("hook stdin is not valid JSON")); }
    });
    process.stdin.on("error", reject);
  });
}

function parseArgs(args) {
  const options = { kind: null, config: null };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--kind" || value === "--config") {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${value} requires a value`);
      options[value === "--kind" ? "kind" : "config"] = next;
      index += 1;
    } else {
      throw new Error(`unsupported argument: ${value}`);
    }
  }
  return options;
}

function loadEndpoint(path) {
  if (path) {
    const record = JSON.parse(fs.readFileSync(path, "utf8"));
    if (typeof record.endpoint === "string" && record.endpoint.trim() !== "") return record.endpoint;
    throw new Error("install record endpoint is required");
  }
  return "http://127.0.0.1:8787";
}
