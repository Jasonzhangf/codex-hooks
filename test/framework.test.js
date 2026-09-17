import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { HooksDaemon, MemoryStateStore } from "../src/daemon.js";
import { DaemonHttpServer } from "../src/server.js";
import { SEND_MODES, SESSION_STATES, normalizeHookEvent, normalizeIntent, normalizeTarget } from "../src/protocol.js";
import { JsonStateStore } from "../src/persistence.js";
import { verifyCodexAppPort } from "../src/codexapp-port.js";
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
    activeTurnId: null,
    statusCalls: 0,
    sends: [],
    async session_status() {
      this.statusCalls += 1;
      return {
        state: this.state,
        ...(this.activeTurnId == null ? {} : { active_turn_id: this.activeTurnId }),
      };
    },
    async send_message(input) { this.sends.push(input); return { accepted: true, attempt_id: input.attempt_id }; },
    async delivery_evidence({ attempt_id }) { return { attempt_id, target_receipt: { clientId: attempt_id }, source: "test.codexapp" }; },
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

test("official Stop input wakes through codexapp without claiming native continuation", async () => {
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
    assert.deepEqual(result.hook_output, {});
    assert.equal(codexapp.sends.length, 1);
    assert.equal(codexapp.sends[0].body, "wake:stop-1");
  } finally {
    await server.close();
  }
});

test("session status failures fail closed with explicit target/unknown codes", async () => {
  const codexapp = fakeCodexapp("idle");
  codexapp.session_status = async () => {
    const error = Object.assign(new Error("target scope not found: local:missing"), { code: "target_scope_not_found" });
    throw error;
  };
  const daemon = new HooksDaemon({ codexapp });
  const result = await daemon.handleHook(event("Stop", { event_id: "scope-not-found" }), { intent: intent("scope-not-found") });
  assert.equal(result.decision, "fail_closed");
  assert.equal(result.error.code, "target_scope_not_found");

  codexapp.session_status = async () => {
    const error = Object.assign(new Error("invalid thread id: missing"), { code: "-32600" });
    throw error;
  };
  const missing = await daemon.handleHook(event("Stop", { event_id: "session-not-found" }), { intent: intent("session-not-found") });
  assert.equal(missing.decision, "fail_closed");
  assert.equal(missing.error.code, "session_not_found");
});

test("native delivery evidence advances only through the exact receipt chain", async () => {
  const codexapp = fakeCodexapp("idle");
  const daemon = new HooksDaemon({ codexapp });
  const sent = await daemon.handleHook(event("Stop", { event_id: "evidence-chain" }), { intent: intent("evidence-chain") });
  assert.equal(sent.delivery.state, "accepted");
  codexapp.delivery_evidence = async ({ attempt_id, after_state }) => ({
    source: "native-test",
    attempt_id,
    ...(after_state === "accepted" ? { target_receipt: { clientId: attempt_id } } : {}),
    ...(after_state === "delivered" ? { execution_item_id: "item-1" } : {}),
    ...(after_state === "executed" ? { response_turn_id: "turn-2" } : {}),
    ...(after_state === "replied" ? { cursor: "cursor-1", read_item_id: "item-1" } : {}),
    ...(after_state === "read" ? { ack_id: "ack-1" } : {}),
  });

  for (const state of ["delivered", "executed", "replied", "read", "consumed"]) {
    const evidence = await daemon.reconcileDeliveryEvidence("evidence-chain");
    assert.equal(evidence.state, state);
  }
  assert.equal(daemon.store.getIntent("evidence-chain").state, "consumed");
  await assert.rejects(() => daemon.reconcileDeliveryEvidence("evidence-chain"), /not awaiting delivery reconciliation/);
  await assert.rejects(() => new HooksDaemon({ codexapp: fakeCodexapp("idle") }).reconcileDeliveryEvidence("missing"), /intent not found/);
});

test("a native delivered send receipt is preserved as delivered evidence", async () => {
  const codexapp = fakeCodexapp("idle");
  codexapp.send_message = async (input) => ({ accepted: true, state: "delivered", attempt_id: input.attempt_id, target_receipt: { clientId: input.attempt_id } });
  const daemon = new HooksDaemon({ codexapp });
  const result = await daemon.handleHook(event("Stop", { event_id: "native-delivered" }), { intent: intent("native-delivered") });
  assert.equal(result.delivery.state, "delivered");
  assert.equal(daemon.store.getIntent("native-delivered").state, "delivered");
});

test("delivery evidence endpoint records a single explicit next state", async () => {
  const codexapp = fakeCodexapp("idle");
  codexapp.send_message = async () => {
    throw Object.assign(new Error("send timed out"), { code: "transport_timeout" });
  };
  const daemon = new HooksDaemon({ codexapp });
  const server = new DaemonHttpServer(daemon);
  const endpoint = await server.listen();
  try {
    const sent = await fetch(`${endpoint}/v1/hooks/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: event("Stop", { event_id: "evidence-http" }), intent: intent("evidence-http") }),
    });
    assert.equal((await sent.json()).delivery.state, "unknown_delivery");
    const evidence = await fetch(`${endpoint}/v1/delivery/evidence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent_id: "evidence-http", reconcile: true }),
    });
    assert.equal(evidence.status, 200);
    assert.equal((await evidence.json()).result.state, "delivered");
    const forged = await fetch(`${endpoint}/v1/delivery/evidence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent_id: "evidence-http", state: "delivered", evidence: { attempt_id: "evidence-http", target_receipt: { clientId: "evidence-http" } } }),
    });
    assert.equal(forged.status, 400);
    assert.equal((await forged.json()).code, "client_evidence_forbidden");
  } finally {
    await server.close();
  }
});

test("codexapp capability verification is required before daemon readiness", async () => {
  await assert.rejects(
    () => verifyCodexAppPort({ session_status: async () => ({}), send_message: async () => ({}) }),
    /requires capabilities\(\)/,
  );
  const capabilities = await verifyCodexAppPort({
    capabilities: async () => ["session_status", "send_message_to_thread"],
    session_status: async () => ({}),
    send_message: async () => ({}),
  });
  assert.deepEqual(capabilities, ["session_status", "send_message_to_thread"]);
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
    assert.deepEqual(JSON.parse(childResult.stdout), {});
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

test("send operation queue uses queue while steer requires a live matching turn", async () => {
  const codexapp = fakeCodexapp("working");
  codexapp.activeTurnId = "turn-live";
  codexapp.steers = [];
  codexapp.steer_message = async (input) => {
    codexapp.steers.push(input);
    return { accepted: true, attempt_id: input.attempt_id };
  };
  const daemon = new HooksDaemon({ codexapp });
  const queued = await daemon.handleHook(event("Stop", { event_id: "queue-operation" }), {
    intent: { ...intent("queue-operation"), operation: "queue" },
  });
  assert.equal(queued.decision, "sent");
  assert.equal(codexapp.sends.length, 1);
  assert.equal(codexapp.steers.length, 0);

  const steered = await daemon.handleHook(event("Stop", { event_id: "steer-operation", turn_id: "turn-live" }), {
    intent: { ...intent("steer-operation"), operation: "steer", turn_id: "turn-live" },
  });
  assert.equal(steered.decision, "sent");
  assert.equal(codexapp.steers.length, 1);
  assert.equal(codexapp.steers[0].turn_id, "turn-live");

  const stale = await daemon.handleHook(event("Stop", { event_id: "steer-stale", turn_id: "turn-live" }), {
    intent: { ...intent("steer-stale"), operation: "steer", turn_id: "turn-stale" },
  });
  assert.equal(stale.decision, "fail_closed");
  assert.equal(stale.error.code, "steer_requires_live_working_turn");
  assert.equal(codexapp.steers.length, 1);
});

test("interrupt is rejected as an ordinary message operation", async () => {
  const codexapp = fakeCodexapp("working");
  const daemon = new HooksDaemon({ codexapp });
  const result = await daemon.handleHook(event("Stop", { event_id: "interrupt-operation", turn_id: "turn-live" }), {
    intent: { ...intent("interrupt-operation"), operation: "interrupt", turn_id: "turn-live" },
  });
  assert.equal(result.decision, "fail_closed");
  assert.equal(result.error.code, "interrupt_is_explicit_stop_only");
  assert.equal(codexapp.sends.length, 0);
});

test("Interrupt lifecycle records one suppressible source turn without sending", async () => {
  const codexapp = fakeCodexapp("idle");
  const daemon = new HooksDaemon({ codexapp });
  const result = await daemon.handleHook(event("Interrupt", { event_id: "interrupt-1", reason: "user_interrupt" }));
  assert.equal(result.decision, "observed");
  assert.equal(result.delivery, null);
  assert.equal(codexapp.sends.length, 0);
  const suppression = daemon.store.getControl("stop_suppression")["session-1:turn-1"];
  assert.equal(suppression.session_id, "session-1");
  assert.equal(suppression.turn_id, "turn-1");
  assert.equal(suppression.reason, "user_interrupt");
});

test("daemon exposes a typed read_subagent_result capability failure", async () => {
  const daemon = new HooksDaemon({ codexapp: fakeCodexapp("idle") });
  await assert.rejects(
    () => daemon.readSubagentResult({
      target: target(),
      thread_id: "reviewer-thread",
      turn_id: "reviewer-turn",
    }),
    (error) => error.code === "read_subagent_result_capability_missing",
  );
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

test("daemon gate executes every session state and send mode in the graph", async () => {
  const expected = {
    idle: "sent",
    working: { [SEND_MODES.IDLE_ONLY]: "deferred", [SEND_MODES.WORKING_ALLOWED]: "sent" },
    waiting_for_input: "sent",
    stopping: "deferred",
    stopped: "sent",
    starting: "deferred",
    disconnected: "fail_closed",
    failed: "fail_closed",
    unknown: "fail_closed",
  };

  for (const state of SESSION_STATES) {
    for (const mode of Object.values(SEND_MODES)) {
      const codexapp = fakeCodexapp(state);
      const daemon = new HooksDaemon({ codexapp });
      const result = await daemon.handleHook(event("Stop", { event_id: `gate-${state}-${mode}` }), {
        intent: intent(`gate-${state}-${mode}`, mode),
      });
      const expectedDecision = typeof expected[state] === "string" ? expected[state] : expected[state][mode];
      assert.equal(result.decision, expectedDecision, `${state}/${mode}`);
      assert.equal(codexapp.sends.length, expectedDecision === "sent" ? 1 : 0, `${state}/${mode} send count`);
    }
  }
});

test("manual input is an independent suppress gate even for working_allowed", async () => {
  const codexapp = fakeCodexapp("idle");
  codexapp.inputActive = true;
  codexapp.session_status = async () => ({ state: codexapp.state, input_active: codexapp.inputActive });
  const daemon = new HooksDaemon({ codexapp });
  const deferred = await daemon.handleHook(event("Stop", { event_id: "manual-input" }), {
    intent: intent("manual-input", SEND_MODES.WORKING_ALLOWED),
  });
  assert.equal(deferred.decision, "deferred");
  assert.equal(deferred.delivery.evidence.input_active, true);
  assert.equal(codexapp.sends.length, 0);

  codexapp.inputActive = false;
  const resumed = await daemon.flushPending(target());
  assert.equal(resumed.sent.length, 1);
  assert.equal(codexapp.sends.length, 1);
});

test("concurrent pending flushes share one send attempt", async () => {
  const codexapp = fakeCodexapp("working");
  const store = new MemoryStateStore();
  const daemon = new HooksDaemon({ codexapp, store });
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  codexapp.send_message = async (input) => {
    codexapp.sends.push(input);
    await blocked;
    return { accepted: true, attempt_id: input.attempt_id };
  };
  const first = await daemon.handleHook(event("Stop", { event_id: "flush-race" }), { intent: intent("flush-race", SEND_MODES.IDLE_ONLY) });
  assert.equal(first.decision, "deferred");
  codexapp.state = "idle";
  const flushOne = daemon.flushPending(target());
  await new Promise((resolve) => setImmediate(resolve));
  const flushTwo = daemon.flushPending(target());
  release();
  const [one, two] = await Promise.all([flushOne, flushTwo]);
  assert.equal(codexapp.sends.length, 1);
  assert.equal(one.sent.length, 1);
  assert.equal(two.sent.length, 0);
  assert.equal(two.failed.length, 0);
  assert.equal(store.getIntent("flush-race").state, "accepted");
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

test("restart recovery preserves an in-flight outbox as unknown without blind retry", () => {
  const codexapp = fakeCodexapp("idle");
  const store = new MemoryStateStore();
  const daemon = new HooksDaemon({ codexapp, store });
  const pending = intent("outbox-crash");
  store.putIntent(pending.intent_id, { ...pending, state: "emitted", decision: "emitted", evidence: { attempt_id: pending.intent_id }, intent: pending });
  const recovered = new HooksDaemon({ codexapp: fakeCodexapp("idle"), store }).recoverOutbox();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].state, "unknown_delivery");
  assert.equal(recovered[0].evidence.code, "restart_recovery_requires_reconcile");
  assert.equal(store.getIntent("outbox-crash").decision, "unknown_delivery");
  assert.equal(store.getIntent("outbox-crash").evidence.attempt_id, "outbox-crash");
  assert.equal(codexapp.sends.length, 0);
});

test("unknown delivery can advance only through an explicit matching native receipt", async () => {
  const codexapp = fakeCodexapp("idle");
  codexapp.send_message = async () => { throw Object.assign(new Error("send timed out"), { code: "transport_timeout" }); };
  const daemon = new HooksDaemon({ codexapp });
  await daemon.handleHook(event("Stop", { event_id: "reconcile" }), { intent: intent("reconcile") });
  codexapp.delivery_evidence = async ({ attempt_id }) => ({
    attempt_id,
    target_receipt: { clientId: "other-attempt" },
  });
  await assert.rejects(
    () => daemon.reconcileDeliveryEvidence("reconcile"),
    /matching target receipt/,
  );
  codexapp.delivery_evidence = async ({ attempt_id }) => ({
    attempt_id,
    target_receipt: { clientId: attempt_id },
    source: "test.codexapp",
  });
  const reconciled = await daemon.reconcileDeliveryEvidence("reconcile");
  assert.equal(reconciled.state, "delivered");
  assert.equal(daemon.store.getIntent("reconcile").state, "delivered");
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
  assert.equal(store.transitions.length, 3);
});

test("reusing an intent id with different semantics fails explicitly", async () => {
  const daemon = new HooksDaemon({ codexapp: fakeCodexapp("idle") });
  await daemon.handleHook(event("Stop", { event_id: "intent-first" }), { intent: intent("intent-conflict") });
  await assert.rejects(
    () => daemon.handleHook(event("Stop", { event_id: "intent-second" }), { intent: { ...intent("intent-conflict"), body: "different-body" } }),
    (error) => error.code === "intent_id_conflict",
  );
});
