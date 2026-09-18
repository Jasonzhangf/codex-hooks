import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BUSY_POLICIES, HOOK_EVENTS, SEND_MODES, SEND_OPERATIONS, SESSION_STATES } from "../src/protocol.js";

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

test("resource map has one owner for every framework state resource", async () => {
  const map = await readJson("../contracts/resource-map.json");
  const resources = new Map(map.resources.map((resource) => [resource.id, resource.owner]));
  assert.equal(resources.size, map.resources.length);
  for (const resource of ["official_hook_event", "message_intent", "session_status", "delivery_receipt", "stopless_state", "update_goal_state", "schedule_state", "subagent_registry", "longhorizon_state", "memory_state"]) {
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
  assert.ok(machine.machines.schedule.states.includes("unknown_delivery"));
  assert.ok(machine.machines.schedule.states.includes("stopped"));
  assert.ok(machine.machines.schedule.states.includes("skipped"));
  assert.ok(machine.machines.schedule.transitions.some((transition) => JSON.stringify(transition) === JSON.stringify(["send_pending", "uncertain_transport", "unknown_delivery"])));
  assert.ok(machine.machines.schedule.transitions.some((transition) => JSON.stringify(transition) === JSON.stringify(["enabled", "stop", "stopped"])));
  assert.ok(machine.machines.subagent.states.includes("stopped"));
  assert.ok(machine.machines.subagent.states.includes("released"));
  assert.ok(machine.machines.subagent.transitions.some((transition) => JSON.stringify(transition) === JSON.stringify(["working", "stop", "stopping"])));
  assert.deepEqual(Object.values(BUSY_POLICIES).sort(), ["defer", "skip"]);
  assert.deepEqual(Object.values(SEND_OPERATIONS).sort(), ["interrupt", "queue", "steer"]);
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
  for (const entries of Object.values(manifest.hooks)) {
    for (const entry of entries) {
      for (const hook of entry.hooks) assert.match(hook.command, /--config \"\$HOME\/\.codex\/routecodex-hooks\/install\.json\"/);
    }
  }
});

test("snapshot recovery DAG binds every edge, resource, and evidence case", async () => {
  const dag = await readJson("../contracts/snapshot-recovery-dag.json");
  const map = await readJson("../contracts/resource-map.json");
  const source = await readFile(new URL("../src/rccs-recover.sh", import.meta.url), "utf8");
  const resourceOwners = new Map(map.resources.map((resource) => [resource.id, resource.owner]));
  const nodeIds = new Set(dag.nodes.map((node) => node.id));
  const edgeKeys = new Set(dag.edges.map((edge) => `${edge.from}->${edge.to}:${edge.event}`));
  const eventNames = new Set(dag.edges.map((edge) => edge.event));
  const requiredEvents = new Set(dag.required_evidence_events);
  const evidenceEvents = new Set(dag.evidence.map((evidence) => evidence.event));
  const resourceIds = new Set(dag.resources.map((resource) => resource.id));

  assert.equal(dag.source, "src/rccs-recover.sh");
  assert.deepEqual(dag.cli.standalone, ["backup", "list", "restore"]);
  assert.equal(dag.cli.wrapper, "rccs snapshot");
  assert.equal(nodeIds.size, dag.nodes.length);
  assert.equal(edgeKeys.size, dag.edges.length);
  for (const edge of dag.edges) {
    assert.ok(nodeIds.has(edge.from), `unknown DAG source node: ${edge.from}`);
    assert.ok(nodeIds.has(edge.to), `unknown DAG destination node: ${edge.to}`);
    assert.ok(edge.event, `missing DAG edge event: ${edge.from}->${edge.to}`);
  }
  const incoming = new Map([...nodeIds].map((id) => [id, 0]));
  const outgoing = new Map([...nodeIds].map((id) => [id, []]));
  for (const edge of dag.edges) {
    incoming.set(edge.to, incoming.get(edge.to) + 1);
    outgoing.get(edge.from).push(edge.to);
  }
  const queue = [...nodeIds].filter((id) => incoming.get(id) === 0);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    visited += 1;
    for (const next of outgoing.get(id)) {
      incoming.set(next, incoming.get(next) - 1);
      if (incoming.get(next) === 0) queue.push(next);
    }
  }
  assert.equal(visited, nodeIds.size, "snapshot recovery graph must be acyclic");
  for (const resource of dag.resources) {
    assert.equal(resourceOwners.get(resource.id), resource.owner, `resource owner mismatch: ${resource.id}`);
  }
  for (const binding of dag.implementation_bindings) {
    assert.ok(nodeIds.has(binding.node), `implementation binding has unknown node: ${binding.node}`);
    assert.match(source, new RegExp(`^${binding.symbol}\\(\\) \\{`, "m"), `missing source symbol: ${binding.symbol}`);
    for (const resource of binding.resources) {
      assert.ok(resourceIds.has(resource), `implementation binding has unknown resource: ${resource}`);
    }
  }
  for (const evidence of dag.evidence) {
    assert.ok(eventNames.has(evidence.event) || requiredEvents.has(evidence.event), `evidence is not bound to a DAG or required event: ${evidence.event}`);
    assert.match(evidence.test, /^test\/.+\.test\.js$/);
    assert.ok(evidence.case.length > 0, `missing evidence case for event: ${evidence.event}`);
    const evidenceSource = await readFile(new URL(`../${evidence.test}`, import.meta.url), "utf8");
    assert.ok(evidenceSource.includes(`test(${JSON.stringify(evidence.case)},`), `evidence case not found: ${evidence.test} :: ${evidence.case}`);
    if (evidence.event === "backup") {
      assert.match(evidence.case, /backs up binaries, config, provider, secrets, and aliases/);
    }
    if (evidence.event === "list") {
      assert.equal(evidence.test, "test/snapshot-recover.test.js");
      assert.match(evidence.case, /lists snapshots with a latest marker/);
      assert.match(evidence.assertion, /listed\.stdout/);
    }
    if (evidence.event === "restore") {
      assert.match(evidence.case, /restores files and invokes only managed rccv3 lifecycle commands/);
    }
    if (evidence.event === "cli_help") {
      assert.equal(evidence.test, "test/cli-help.test.js");
      assert.match(evidence.assertion, /snapshot help/);
    }
    if (evidence.event === "cli_delegation") {
      assert.equal(evidence.test, "test/init.test.js");
      assert.match(evidence.assertion, /forwards list stdout/);
    }
  }
  for (const event of requiredEvents) {
    assert.ok(evidenceEvents.has(event), `required evidence event is missing: ${event}`);
  }
  assert.ok(dag.invariants.some((invariant) => invariant.includes("rollback failure")));
  assert.ok(map.forbidden.some((edge) => edge.owner === "rccs-recover" && edge.operation.includes("unverified")));
});

test("notification liveness DAG binds every gate, resource, and evidence case", async () => {
  const dag = await readJson("../contracts/rccs-notification-dag.json");
  const map = await readJson("../contracts/resource-map.json");
  const controlSource = await readFile(new URL("../src/control.js", import.meta.url), "utf8");
  const timerSource = await readFile(new URL("../src/timer.js", import.meta.url), "utf8");
  const daemonSource = await readFile(new URL("../src/daemon.js", import.meta.url), "utf8");
  const resourceOwners = new Map(map.resources.map((resource) => [resource.id, resource.owner]));
  const nodeIds = new Set(dag.nodes.map((node) => node.id));
  const edgeKeys = new Set(dag.edges.map((edge) => `${edge.from}->${edge.to}:${edge.event}`));
  const eventNames = new Set(dag.edges.map((edge) => edge.event));
  const requiredEvents = new Set(dag.required_evidence_events);
  const evidenceEvents = new Set(dag.evidence.map((evidence) => evidence.event));
  const resourceIds = new Set(dag.resources.map((resource) => resource.id));

  assert.equal(nodeIds.size, dag.nodes.length);
  assert.equal(edgeKeys.size, dag.edges.length);
  for (const edge of dag.edges) {
    assert.ok(nodeIds.has(edge.from), `unknown notification DAG source node: ${edge.from}`);
    assert.ok(nodeIds.has(edge.to), `unknown notification DAG destination node: ${edge.to}`);
    assert.ok(edge.event, `missing notification DAG edge event: ${edge.from}->${edge.to}`);
  }
  const incoming = new Map([...nodeIds].map((id) => [id, 0]));
  const outgoing = new Map([...nodeIds].map((id) => [id, []]));
  for (const edge of dag.edges) {
    incoming.set(edge.to, incoming.get(edge.to) + 1);
    outgoing.get(edge.from).push(edge.to);
  }
  const queue = [...nodeIds].filter((id) => incoming.get(id) === 0);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    visited += 1;
    for (const next of outgoing.get(id)) {
      incoming.set(next, incoming.get(next) - 1);
      if (incoming.get(next) === 0) queue.push(next);
    }
  }
  assert.equal(visited, nodeIds.size, "notification liveness graph must be acyclic");
  for (const resource of dag.resources) {
    assert.equal(resourceOwners.get(resource.id), resource.owner, `resource owner mismatch: ${resource.id}`);
  }
  for (const binding of dag.implementation_bindings) {
    assert.ok(nodeIds.has(binding.node), `implementation binding has unknown node: ${binding.node}`);
    const source = binding.symbol === "tick" || binding.symbol === "dispatchNotify"
      ? timerSource
      : binding.symbol === "registerLongHorizon" || binding.symbol === "upsertSchedule"
        ? controlSource
        : daemonSource;
    assert.match(source, new RegExp(`${binding.symbol}\\(`), `missing source symbol: ${binding.symbol}`);
    for (const resource of binding.resources) {
      assert.ok(resourceIds.has(resource), `implementation binding has unknown resource: ${resource}`);
    }
  }
  for (const evidence of dag.evidence) {
    assert.ok(eventNames.has(evidence.event) || requiredEvents.has(evidence.event), `evidence is not bound to a DAG or required event: ${evidence.event}`);
    assert.match(evidence.test, /^test\/.+\.test\.js$/);
    assert.ok(evidence.case.length > 0, `missing evidence case for event: ${evidence.event}`);
    const evidenceSource = await readFile(new URL(`../${evidence.test}`, import.meta.url), "utf8");
    assert.ok(evidenceSource.includes(`test(${JSON.stringify(evidence.case)},`), `evidence case not found: ${evidence.test} :: ${evidence.case}`);
  }
  for (const event of requiredEvents) {
    assert.ok(evidenceEvents.has(event), `required evidence event is missing: ${event}`);
  }
  assert.ok(dag.invariants.some((invariant) => invariant.includes("never steer")));
  assert.ok(dag.invariants.some((invariant) => invariant.includes("never blindly retried")));
});
