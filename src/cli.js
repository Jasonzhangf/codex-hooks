#!/usr/bin/env node

const endpoint = process.env.ROUTECODEX_HOOKS_ENDPOINT || "http://127.0.0.1:8787";
const [operation, ...args] = process.argv.slice(2);

if (operation === "operator-enable" || operation === "operator-disable") {
  const name = required(args[0], "operator name");
  await mutate({ operation: "operator.set_enabled", name, enabled: operation === "operator-enable" });
} else if (operation === "schedule-upsert") {
  await mutate({ operation: "schedule.upsert", id: required(args[0], "schedule id"), at: required(args[1], "schedule time"), body: required(args[2], "schedule body"), target: parseTarget(args[3]), ...(args[4] ? { send_mode: args[4] } : {}) });
} else if (operation === "schedule-remove") {
  await mutate({ operation: "schedule.remove", id: required(args[0], "schedule id") });
} else if (operation === "schedule-pause" || operation === "schedule-resume") {
  await mutate({ operation: operation === "schedule-pause" ? "schedule.pause" : "schedule.resume", id: required(args[0], "schedule id") });
} else {
  throw new Error("usage: cli.js operator-enable|operator-disable <name> | schedule-upsert <id> <at> <body> <target-json> [idle_only|working_allowed] | schedule-pause|schedule-resume|schedule-remove <id>");
}

async function mutate(value) {
  const response = await fetch(`${endpoint}/v1/control/mutate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `daemon mutation failed: ${response.status}`);
  process.stdout.write(`${JSON.stringify(body.result)}\n`);
}

function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value;
}

function parseTarget(value) {
  try { return JSON.parse(required(value, "target JSON")); } catch (error) { throw new Error(`target JSON is invalid: ${error.message}`); }
}
