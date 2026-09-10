import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { HOOK_EVENTS, SESSION_STATES, SEND_MODES } from "../src/protocol.js";

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

test("resource map has one owner for every framework state resource", async () => {
  const map = await readJson("../contracts/resource-map.json");
  const resources = new Map(map.resources.map((resource) => [resource.id, resource.owner]));
  assert.equal(resources.size, map.resources.length);
  for (const resource of ["official_hook_event", "message_intent", "session_status", "delivery_receipt", "stopless_state", "update_goal_state", "schedule_state", "longhorizon_state"]) {
    assert.ok(resources.has(resource), `missing resource owner: ${resource}`);
  }
  assert.ok(map.forbidden.some((edge) => edge.owner === "mcp" && edge.operation === "send or mutate"));
  assert.ok(map.forbidden.some((edge) => edge.owner === "codexapp" && edge.operation.includes("timer")));
});

test("state machine covers every session state and send mode", async () => {
  const machine = await readJson("../contracts/state-machine.json");
  assert.deepEqual(machine.machines.session.states, SESSION_STATES);
  assert.deepEqual(Object.keys(machine.machines.session.gate).sort(), [...Object.values(SEND_MODES)].sort());
  for (const state of SESSION_STATES) {
    for (const mode of Object.values(SEND_MODES)) {
      assert.ok(machine.machines.session.gate[mode][state], `missing gate: ${mode}/${state}`);
    }
  }
  assert.ok(machine.machines.message.states.includes("unknown_delivery"));
});

test("manifest reaches every protocol hook event", async () => {
  const manifest = await readJson("../hooks/hooks.json");
  for (const event of HOOK_EVENTS) assert.ok(manifest.hooks[event], `missing adapter: ${event}`);
});
