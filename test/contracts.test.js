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
  for (const resource of ["official_hook_event", "message_intent", "session_status", "delivery_receipt", "stopless_state", "update_goal_state", "schedule_state", "longhorizon_state", "memory_state"]) {
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
  assert.ok(machine.machines.message.states.includes("retryable"));
  assert.ok(machine.machines.message.states.includes("deduplicated"));
  assert.ok(machine.machines.message.states.includes("consumed"));
  assert.ok(machine.machines.message.transitions.some((transition) => JSON.stringify(transition) === JSON.stringify(["read", "consumed_ack", "consumed"])));
  assert.ok(machine.machines.message.transitions.some((transition) => JSON.stringify(transition) === JSON.stringify(["unknown_delivery", "reconcile_target_receipt", "delivered"])));
  for (const state of ["degraded", "stopping", "stopped", "crashed", "restarting"]) assert.ok(machine.machines.runtime.states.includes(state), `missing runtime state: ${state}`);
  for (const action of ["observe", "allow", "deny", "delay", "inject"]) assert.ok(machine.machines.hook.states.includes(action), `missing hook action: ${action}`);
  assert.ok(machine.machines.schedule.states.includes("session_missing"));
});

test("every declared state-machine edge has declared source and destination states", async () => {
  const machine = await readJson("../contracts/state-machine.json");
  for (const [name, definition] of Object.entries(machine.machines)) {
    const states = new Set(definition.states || []);
    for (const transition of definition.transitions || []) {
      assert.equal(transition.length, 3, `${name} transition must be [from,event,to]`);
      assert.ok(states.has(transition[0]), `${name} transition source is undeclared: ${transition[0]}`);
      assert.ok(states.has(transition[2]), `${name} transition destination is undeclared: ${transition[2]}`);
    }
  }
});

test("manifest reaches every protocol hook event", async () => {
  const manifest = await readJson("../hooks/hooks.json");
  for (const event of HOOK_EVENTS) assert.ok(manifest.hooks[event], `missing adapter: ${event}`);
});
