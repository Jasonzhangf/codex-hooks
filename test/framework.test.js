import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { HooksDaemon, MemoryStateStore } from "../src/daemon.js";
import { DaemonHttpServer } from "../src/server.js";
import { SEND_MODES, normalizeHookEvent, normalizeIntent, normalizeTarget } from "../src/protocol.js";
import { JsonStateStore } from "../src/persistence.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function target() {
  return { namespace: "codex_tui", appserver_id: "tui-appserver", session_id: "session-1", thread_id: "thread-1" };
}

function event(name = "Stop", extra = {}) {
  return { session_id: "session-1", turn_id: "turn-1", hook_event_name: name, cwd: "/workspace", ...extra };
}

function intent(id, mode = SEND_MODES.WORKING_ALLOWED) {
  return { intent_id: id, source: "operator", target: target(), body: `wake:${id}`, send_mode: mode };
}

function fakeCodexapp(state = "idle") {
  return {
    state,
    statusCalls: 0,
    sends: [],
    async session_status() { this.statusCalls += 1; return { state: this.state }; },
    async send_message(input) { this.sends.push(input); return { accepted: true, attempt_id: input.attempt_id }; },
  };
}

test("target normalization requires an explicit thread identity", () => {
  assert.throws(
    () => normalizeTarget({ namespace: "codex_tui", appserver_id: "app", session_id: "session" }),
    /target\.thread_id must be a non-empty string/,
  );
});

test("message intent source is restricted to registered operators", () => {
  assert.throws(
    () => normalizeIntent({ ...intent("unsupported-source"), source: "forged" }),
    /unsupported message source: forged/,
  );
});

test("official Stop input reaches the daemon and wakes through codexapp sendmessage", async () => {
  const codexapp = fakeCodexapp("idle");
  const daemon = new HooksDaemon({ codexapp });
  const server = new DaemonHttpServer(daemon);
  const endpoint = await server.listen();
  try {
    const response = await fetch(`${endpoint}/v1/hooks/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: event(), intent: intent("stop-1") }),
    });
    const result = await response.json();
    assert.equal(result.decision, "sent");
    assert.deepEqual(result.hook_output, { continue: false });
    assert.equal(codexapp.sends.length, 1);
    assert.equal(codexapp.sends[0].body, "wake:stop-1");
  } finally {
    await server.close();
  }
});

test("the installed command adapter preserves the official stdin/stdout boundary", async () => {
  const codexapp = fakeCodexapp("idle");
  const daemon = new HooksDaemon({
    codexapp,
    intentFactory: async (_event, kind) => kind === "stop" ? intent("command-1") : null,
  });
  const server = new DaemonHttpServer(daemon);
  const endpoint = await server.listen();
  try {
    const child = spawn(process.execPath, ["src/hook-entry.js", "--kind", "stop"], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, ROUTECODEX_HOOKS_ENDPOINT: endpoint },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(JSON.stringify(event()));
    const childResult = await new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    });
    assert.equal(childResult.exitCode, 0, childResult.stderr);
    assert.deepEqual(JSON.parse(childResult.stdout), { continue: false });
    assert.equal(codexapp.sends.length, 1);
  } finally {
    await server.close();
  }
});

test("official stop_hook_active guard prevents intent creation and sending", async () => {
  let factoryCalls = 0;
  const codexapp = fakeCodexapp("idle");
  const daemon = new HooksDaemon({
    codexapp,
    intentFactory: async () => {
      factoryCalls += 1;
      return intent("must-not-be-created");
    },
  });
  const result = await daemon.handleHook(event("Stop", { event_id: "already-continued", stop_hook_active: true }));
  assert.equal(result.decision, "guarded");
  assert.equal(factoryCalls, 0);
  assert.equal(codexapp.sends.length, 0);
});

test("idle_only does not disturb a working session and flushes after idle", async () => {
  const codexapp = fakeCodexapp("working");
  const daemon = new HooksDaemon({ codexapp });
  const result = await daemon.handleHook(event(), { intent: intent("idle-only-1", SEND_MODES.IDLE_ONLY) });
  assert.equal(result.decision, "deferred");
  assert.equal(codexapp.sends.length, 0);

  codexapp.state = "idle";
  const resumed = await daemon.flushPending(target());
  assert.equal(resumed.sent.length, 1);
  assert.equal(codexapp.sends[0].attempt_id, "idle-only-1:resume");
});

test("working_allowed sends while working, while unknown and disconnected fail closed", async () => {
  const codexapp = fakeCodexapp("working");
  const daemon = new HooksDaemon({ codexapp });
  const sent = await daemon.handleHook(event(), { intent: intent("working-1") });
  assert.equal(sent.decision, "sent");
  assert.equal(codexapp.sends.length, 1);

  codexapp.state = "unknown";
  const unknown = await daemon.handleHook(event("PostToolUse", { turn_id: "turn-2", tool_use_id: "tool-2" }), { intent: intent("unknown-1") });
  assert.equal(unknown.decision, "fail_closed");
  assert.equal(codexapp.sends.length, 1);

  codexapp.state = "disconnected";
  const disconnected = await daemon.handleHook(event("PostToolUse", { turn_id: "turn-3", tool_use_id: "tool-3" }), { intent: intent("disconnected-1") });
  assert.equal(disconnected.decision, "fail_closed");
  assert.equal(codexapp.sends.length, 1);
});

test("waiting_for_input and stopped are send-eligible while starting remains deferred", async () => {
  const codexapp = fakeCodexapp("waiting_for_input");
  const daemon = new HooksDaemon({ codexapp });
  const waiting = await daemon.handleHook(event("Stop", { event_id: "waiting" }), { intent: intent("waiting") });
  assert.equal(waiting.decision, "sent");

  codexapp.state = "stopped";
  const stopped = await daemon.handleHook(event("Stop", { event_id: "stopped" }), { intent: intent("stopped") });
  assert.equal(stopped.decision, "sent");

  codexapp.state = "starting";
  const starting = await daemon.handleHook(event("Stop", { event_id: "starting" }), { intent: intent("starting") });
  assert.equal(starting.decision, "deferred");
  assert.equal(codexapp.sends.length, 2);
});

test("expired intent is recorded without reading status or sending", async () => {
  const codexapp = fakeCodexapp("idle");
  const daemon = new HooksDaemon({ codexapp, now: () => "2026-09-10T12:00:00.000Z" });
  const result = await daemon.handleHook(event("Stop", { event_id: "expired" }), {
    intent: { ...intent("expired"), expires_at: "2026-09-10T11:59:59.000Z" },
  });
  assert.equal(result.decision, "expired");
  assert.equal(codexapp.statusCalls, 0);
  assert.equal(codexapp.sends.length, 0);
});

test("JSON persistence restores deferred intents and does not resend after acceptance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-hooks-framework-"));
  const stateFile = join(directory, "state.json");
  try {
    const codexapp = fakeCodexapp("working");
    const first = new HooksDaemon({ codexapp, store: new JsonStateStore(stateFile) });
    const deferred = await first.handleHook(event("Stop", { event_id: "persisted" }), {
      intent: intent("persisted", SEND_MODES.IDLE_ONLY),
    });
    assert.equal(deferred.decision, "deferred");

    codexapp.state = "idle";
    const second = new HooksDaemon({ codexapp, store: new JsonStateStore(stateFile) });
    const resumed = await second.flushPending(target());
    assert.equal(resumed.sent.length, 1);
    assert.equal(codexapp.sends.length, 1);

    const third = new HooksDaemon({ codexapp, store: new JsonStateStore(stateFile) });
    const replay = await third.flushPending(target());
    assert.equal(replay.sent.length, 0);
    assert.equal(codexapp.sends.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deferred resume records unknown status and send failures without claiming delivery", async () => {
  const codexapp = fakeCodexapp("working");
  const store = new MemoryStateStore();
  const daemon = new HooksDaemon({ codexapp, store });
  await daemon.handleHook(event(), { intent: intent("resume-failure", SEND_MODES.IDLE_ONLY) });

  codexapp.state = "unknown";
  const unknown = await daemon.flushPending(target());
  assert.equal(unknown.decision, "fail_closed");
  assert.equal(unknown.failed[0].state, "failed");

  const secondStore = new MemoryStateStore();
  const failingApp = fakeCodexapp("working");
  failingApp.send_message = async () => { throw Object.assign(new Error("transport down"), { code: "transport_down" }); };
  const failingDaemon = new HooksDaemon({ codexapp: failingApp, store: secondStore });
  await failingDaemon.handleHook(event("Stop", { turn_id: "turn-failure" }), { intent: intent("send-failure", SEND_MODES.IDLE_ONLY) });
  failingApp.state = "idle";
  const failed = await failingDaemon.flushPending(target());
  assert.equal(failed.sent.length, 0);
  assert.equal(failed.failed[0].state, "failed");
  assert.equal(failed.failed[0].evidence.code, "transport_down");
});

test("uncertain send timeout remains unknown_delivery during initial send and resume", async () => {
  const codexapp = fakeCodexapp("idle");
  codexapp.send_message = async () => { throw Object.assign(new Error("send timed out"), { code: "transport_timeout" }); };
  const daemon = new HooksDaemon({ codexapp });
  const initial = await daemon.handleHook(event("Stop", { event_id: "timeout-initial" }), { intent: intent("timeout-initial") });
  assert.equal(initial.decision, "unknown_delivery");
  assert.equal(initial.delivery.state, "unknown_delivery");

  const deferredApp = fakeCodexapp("working");
  deferredApp.send_message = async () => { throw Object.assign(new Error("resume timed out"), { code: "timeout" }); };
  const deferredDaemon = new HooksDaemon({ codexapp: deferredApp });
  await deferredDaemon.handleHook(event("Stop", { event_id: "timeout-resume" }), { intent: intent("timeout-resume", SEND_MODES.IDLE_ONLY) });
  deferredApp.state = "idle";
  const resumed = await deferredDaemon.flushPending(target());
  assert.equal(resumed.failed[0].state, "unknown_delivery");
});

test("a malformed native send receipt is rejected", async () => {
  const codexapp = fakeCodexapp("idle");
  codexapp.send_message = async () => ({ accepted: false });
  const daemon = new HooksDaemon({ codexapp });
  const result = await daemon.handleHook(event(), { intent: intent("invalid-receipt") });
  assert.equal(result.decision, "fail_closed");
  assert.equal(result.error.code, "invalid_send_receipt");
});

test("tool events without the official tool_use_id are rejected instead of deduplicated", async () => {
  const daemon = new HooksDaemon({ codexapp: fakeCodexapp("idle") });
  await assert.rejects(
    () => daemon.handleHook(event("PostToolUse", { tool_name: "Bash", turn_id: "tool-turn" })),
    /requires tool_use_id for idempotency/,
  );
});

test("explicit hook kinds cannot relabel update-goal as a tool-call", async () => {
  const daemon = new HooksDaemon({ codexapp: fakeCodexapp("idle") });
  await assert.rejects(
    () => daemon.handleHook(event("PostToolUse", { tool_name: "update_goal", tool_use_id: "goal-tool" }), { kind: "tool-call" }),
    /hook kind mismatch/,
  );
});

test("tool_use_id is required even when a generic event_id is present", async () => {
  const daemon = new HooksDaemon({ codexapp: fakeCodexapp("idle") });
  await assert.rejects(
    () => daemon.handleHook(event("PostToolUse", { tool_name: "Bash", event_id: "generic-event" })),
    /requires tool_use_id for idempotency/,
  );
});

test("concurrent delivery reserves the event and intent before awaiting status or send", async () => {
  let releaseStatus;
  const statusGate = new Promise((resolve) => { releaseStatus = resolve; });
  const codexapp = fakeCodexapp("idle");
  codexapp.session_status = async () => { await statusGate; return { state: "idle" }; };
  const daemon = new HooksDaemon({ codexapp });
  const first = daemon.handleHook(event("Stop", { event_id: "same-event" }), { intent: intent("concurrent") });
  const second = daemon.handleHook(event("Stop", { event_id: "same-event" }), { intent: intent("concurrent") });
  releaseStatus();
  const results = await Promise.all([first, second]);
  assert.equal(codexapp.sends.length, 1);
  assert.equal(results.filter((result) => result.idempotent).length, 1);
});

test("event handling is idempotent and Stopless/update-goal remain separate kinds", async () => {
  const codexapp = fakeCodexapp("idle");
  const store = new MemoryStateStore();
  const daemon = new HooksDaemon({ codexapp, store });
  const first = await daemon.handleHook(event(), { intent: intent("once") });
  const second = await daemon.handleHook(event(), { intent: intent("once") });
  assert.equal(first.decision, "sent");
  assert.equal(second.idempotent, true);
  assert.equal(codexapp.sends.length, 1);

  const goal = await daemon.handleHook(event("PostToolUse", { tool_name: "update_goal", turn_id: "goal-turn", tool_use_id: "goal-tool" }));
  assert.equal(goal.kind, "update-goal");
  const stop = await daemon.handleHook(event("Stop", { turn_id: "stop-turn" }));
  assert.equal(stop.kind, "stop");
  assert.equal(store.transitions.length, 2);
});

test("reusing an intent id with different semantics fails explicitly", async () => {
  const daemon = new HooksDaemon({ codexapp: fakeCodexapp("idle") });
  await daemon.handleHook(event("Stop", { event_id: "intent-first" }), { intent: intent("intent-conflict") });
  await assert.rejects(
    () => daemon.handleHook(event("Stop", { event_id: "intent-second" }), { intent: { ...intent("intent-conflict"), body: "different-body" } }),
    (error) => error.code === "intent_id_conflict",
  );
});
