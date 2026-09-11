import assert from "node:assert/strict";
import test from "node:test";
import { HooksSupervisor } from "../src/supervisor.js";

test("supervisor starts codexapp before hooksd and drains in reverse order", async () => {
  const events = [];
  const supervisor = new HooksSupervisor({
    startCodexapp: async () => {
      events.push("codexapp.start");
      return { ready: true, capabilities: async () => ["session_status", "send_message_to_thread"], session_status: async () => ({ state: "idle" }), send_message: async ({ attempt_id }) => ({ accepted: true, attempt_id }), stop: async () => events.push("codexapp.stop") };
    },
    startHooksd: async ({ codexapp }) => {
      assert.equal(codexapp.ready, true);
      events.push("hooksd.start");
      return { ready: true, stop: async () => events.push("hooksd.stop") };
    },
  });

  await supervisor.start();
  assert.equal(supervisor.status().state, "ready");
  await supervisor.stop();
  assert.equal(supervisor.status().state, "stopped");
  assert.deepEqual(events, ["codexapp.start", "hooksd.start", "hooksd.stop", "codexapp.stop"]);
});

test("supervisor can restart from stopped and exposes degraded/crashed lifecycle states", async () => {
  let starts = 0;
  const supervisor = new HooksSupervisor({
    startCodexapp: async () => ({ ready: true, capabilities: async () => ["session_status", "send_message_to_thread"], session_status: async () => ({ state: "idle" }), send_message: async ({ attempt_id }) => ({ accepted: true, attempt_id }), stop: async () => {} }),
    startHooksd: async () => ({ ready: true, stop: async () => {} }),
  });
  supervisor.startCodexapp = async () => {
    starts += 1;
    return { ready: true, capabilities: async () => ["session_status", "send_message_to_thread"], session_status: async () => ({ state: "idle" }), send_message: async ({ attempt_id }) => ({ accepted: true, attempt_id }), stop: async () => {} };
  };
  await supervisor.start();
  await supervisor.stop();
  await supervisor.start();
  assert.equal(starts, 2);
  assert.equal(supervisor.markDegraded().state, "degraded");
  assert.equal(supervisor.restore().state, "ready");
  assert.equal(supervisor.markCrashed().state, "crashed");
});

test("supervisor cleans crashed children before restarting", async () => {
  const events = [];
  let generation = 0;
  const supervisor = new HooksSupervisor({
    startCodexapp: async () => {
      const current = ++generation;
      events.push(`codexapp.start.${current}`);
      return { ready: true, capabilities: async () => ["session_status", "send_message_to_thread"], session_status: async () => ({ state: "idle" }), send_message: async ({ attempt_id }) => ({ accepted: true, attempt_id }), stop: async () => events.push(`codexapp.stop.${current}`) };
    },
    startHooksd: async () => {
      const current = generation;
      events.push(`hooksd.start.${current}`);
      return { ready: true, stop: async () => events.push(`hooksd.stop.${current}`) };
    },
  });

  await supervisor.start();
  supervisor.markCrashed();
  await supervisor.start();
  assert.deepEqual(events, [
    "codexapp.start.1",
    "hooksd.start.1",
    "hooksd.stop.1",
    "codexapp.stop.1",
    "codexapp.start.2",
    "hooksd.start.2",
  ]);
  assert.equal(supervisor.status().state, "ready");
});

test("supervisor fails closed when crashed child cleanup fails", async () => {
  const cleanupError = new Error("codexapp cleanup failed");
  const supervisor = new HooksSupervisor({
    startCodexapp: async () => ({ ready: true, capabilities: async () => ["session_status", "send_message_to_thread"], session_status: async () => ({ state: "idle" }), send_message: async ({ attempt_id }) => ({ accepted: true, attempt_id }), stop: async () => { throw cleanupError; } }),
    startHooksd: async () => ({ ready: true, stop: async () => {} }),
  });

  await supervisor.start();
  supervisor.markCrashed();
  await assert.rejects(() => supervisor.start(), (error) => error === cleanupError);
  assert.equal(supervisor.status().state, "failed");
});

test("supervisor fails closed and stops codexapp when hooksd cannot become ready", async () => {
  const events = [];
  const supervisor = new HooksSupervisor({
    startCodexapp: async () => ({ ready: true, capabilities: async () => ["session_status", "send_message_to_thread"], session_status: async () => ({ state: "idle" }), send_message: async ({ attempt_id }) => ({ accepted: true, attempt_id }), stop: async () => events.push("codexapp.stop") }),
    startHooksd: async () => {
      events.push("hooksd.start");
      return { ready: false };
    },
  });

  await assert.rejects(() => supervisor.start(), /hooksd did not become ready/);
  assert.equal(supervisor.status().state, "failed");
  assert.deepEqual(events, ["hooksd.start", "codexapp.stop"]);
});

test("supervisor attempts codexapp cleanup when hooksd stop fails", async () => {
  const events = [];
  const hooksdError = new Error("hooksd stop failed");
  const supervisor = new HooksSupervisor({
    startCodexapp: async () => ({ ready: true, capabilities: async () => ["session_status", "send_message_to_thread"], session_status: async () => ({ state: "idle" }), send_message: async ({ attempt_id }) => ({ accepted: true, attempt_id }), stop: async () => events.push("codexapp.stop") }),
    startHooksd: async () => ({ ready: true, stop: async () => { events.push("hooksd.stop"); throw hooksdError; } }),
  });

  await supervisor.start();
  await assert.rejects(() => supervisor.stop(), (error) => error === hooksdError);
  assert.equal(supervisor.status().state, "failed");
  assert.deepEqual(events, ["hooksd.stop", "codexapp.stop"]);
});
