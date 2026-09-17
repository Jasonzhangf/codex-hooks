import assert from "node:assert/strict";
import test from "node:test";
import { FrameworkControlPlane } from "../src/control.js";
import { HooksDaemon, MemoryStateStore } from "../src/daemon.js";
import { GoalReviewRunner, parseReviewerReport } from "../src/goal-review.js";
import { interruptSuppressionKey } from "../src/protocol.js";

const TARGET = {
  namespace: "codex_tui",
  appserver_id: "tui-appserver",
  scope_id: "local:tui",
  session_id: "session-1",
  thread_id: "thread-1",
};

function stopEvent(extra = {}) {
  return {
    session_id: "thread-1",
    turn_id: "turn-1",
    hook_event_name: "Stop",
    cwd: "/workspace",
    last_assistant_message: "Implemented the first slice.",
    ...extra,
  };
}

function fakeCodexapp(report, { createError = null, readError = null } = {}) {
  return {
    reads: [],
    creates: [],
    sends: [],
    async session_status() { return { state: "idle" }; },
    async create_subagent(request) {
      if (createError) throw createError;
      this.creates.push(request);
      return { thread_id: "reviewer-thread", turn_id: "reviewer-turn", state: "accepted" };
    },
    async read_subagent_result(request) {
      if (readError) throw readError;
      this.reads.push(request);
      return {
        thread_id: "reviewer-thread",
        turn_id: "reviewer-turn",
        state: "completed",
        finalMessage: typeof report === "string" ? report : JSON.stringify(report),
      };
    },
    async send_message(request) {
      this.sends.push(request);
      return { accepted: true, attempt_id: request.attempt_id };
    },
    async delivery_evidence({ attempt_id }) {
      return { attempt_id, target_receipt: { clientId: attempt_id }, source: "test" };
    },
  };
}

function setup({ report = validReport(), createError = null, readError = null, reviewBudget = 1, timeoutMs = 50 } = {}) {
  const store = new MemoryStateStore();
  const codexapp = fakeCodexapp(report, { createError, readError });
  const daemon = new HooksDaemon({ codexapp, store });
  const control = new FrameworkControlPlane({ store, subagents: daemon });
  control.mutate({
    operation: "session.bind",
    alias: "goal-session",
    target: TARGET,
  });
  control.mutate({
    operation: "longhorizon.register",
    id: "goal-1",
    mode: "goal",
    goal_file: "/tmp/goal.md",
    session: "goal-session",
    review_budget: reviewBudget,
  });
  control.mutate({ operation: "longhorizon.activate", id: "goal-1" });
  const runner = new GoalReviewRunner({
    store,
    daemon,
    control,
    timeout_ms: timeoutMs,
    poll_interval_ms: 1,
    read_file: () => "# Goal\n\nFinish the implementation and verify it.",
  });
  return { store, codexapp, daemon, control, runner };
}

function validReport(overrides = {}) {
  return {
    goal: "Finish the implementation and verify it.",
    observed: "The first slice is implemented.",
    gap: "Verification evidence is missing.",
    next_action: "Run the mapped tests and record the result.",
    completion_claim: false,
    evidence_refs: ["test output"],
    blocked_reason: null,
    ...overrides,
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition timed out");
}

test("ordinary Stop claims one isolated reviewer and sends one validated feedback intent", async () => {
  const { store, codexapp, daemon, runner } = setup();
  const result = await runner.onStop(stopEvent(), "stop");
  assert.equal(result, null);
  assert.equal(codexapp.creates.length, 1);
  assert.equal(codexapp.creates[0].ephemeral, true);
  assert.equal(codexapp.creates[0].prompt.includes("isolated goal reviewer"), true);
  await waitFor(() => store.getControl("goal_reviews")["goal-review:goal-1:thread-1:turn-1"]?.state === "completed");
  await waitFor(() => codexapp.sends.length === 1);

  const review = store.getControl("goal_reviews")["goal-review:goal-1:thread-1:turn-1"];
  assert.equal(review.state, "completed");
  assert.equal(review.feedback_decision, "sent");
  assert.equal(codexapp.sends[0].body.includes("Next action: Run the mapped tests"), true);
  assert.equal((await runner.onStop(stopEvent(), "stop")), null);
  assert.equal(codexapp.creates.length, 1);
  assert.equal(codexapp.sends.length, 1);

  const replay = await daemon.handleHook(stopEvent(), { kind: "stop" });
  assert.equal(replay.decision, "observed");
});

test("review_budget suppresses a new source turn before reviewer creation", async () => {
  const { store, codexapp, runner } = setup({ reviewBudget: 1 });
  await runner.onStop(stopEvent(), "stop");
  await waitFor(() => store.getControl("goal_reviews")["goal-review:goal-1:thread-1:turn-1"]?.state === "completed");
  await runner.onStop(stopEvent({ turn_id: "turn-2" }), "stop");
  await waitFor(() => store.getControl("goal_reviews")["goal-review:goal-1:thread-1:turn-2"]);

  const review = store.getControl("goal_reviews")["goal-review:goal-1:thread-1:turn-2"];
  assert.equal(review.state, "suppressed");
  assert.equal(review.reason, "review_budget_exhausted");
  assert.equal(codexapp.creates.length, 1);
});

test("Interrupt suppression is consumed once and prevents reviewer creation", async () => {
  const { store, codexapp, daemon, runner } = setup();
  store.putControl("stop_suppression", {
    [interruptSuppressionKey("thread-1", "turn-1")]: {
      session_id: "thread-1",
      turn_id: "turn-1",
      observed_at: "2026-09-17T00:00:00.000Z",
    },
  });
  assert.equal(await runner.onStop(stopEvent(), "stop"), null);
  assert.equal(codexapp.creates.length, 0);
  assert.deepEqual(store.getControl("stop_suppression"), {});

  await daemon.handleHook(stopEvent({ turn_id: "turn-2" }), { kind: "stop" });
  assert.equal(codexapp.creates.length, 0);
});

test("a reviewer Stop cannot recursively create another reviewer", async () => {
  const { store, codexapp, control, runner } = setup();
  control.registerSubagent({
    thread_id: "reviewer-thread",
    turn_id: "reviewer-turn",
    target: { namespace: "codex_tui", appserver_id: "tui-appserver", scope_id: "local:tui" },
    prompt: "review",
    kind: "goal_reviewer",
    review_id: "review-1",
    source_session_id: "thread-1",
    source_turn_id: "turn-1",
  });
  assert.equal(await runner.onStop(stopEvent({ session_id: "reviewer-thread" }), "stop"), null);
  assert.equal(codexapp.creates.length, 0);
  assert.equal(store.getControl("goal_reviews"), undefined);
});

test("stop_hook_active and non-Stop stop kinds do not create a reviewer", async () => {
  const { codexapp, runner } = setup();
  assert.equal(await runner.onStop(stopEvent({ stop_hook_active: true }), "stop"), null);
  assert.equal(await runner.onStop(stopEvent({ hook_event_name: "SubagentStop" }), "stop"), null);
  assert.equal(codexapp.creates.length, 0);
});

test("reviewer creation, read, and malformed report failures remain non-blocking", async () => {
  const cases = [
    { createError: Object.assign(new Error("bridge down"), { code: "transport_down" }), expected: "failed" },
    { readError: Object.assign(new Error("result unavailable"), { code: "reviewer_result_unavailable" }), expected: "unresolved" },
    { report: "not json", expected: "failed" },
  ];
  for (const current of cases) {
    const { store, runner } = setup(current);
    assert.equal(await runner.onStop(stopEvent(), "stop"), null);
    const review = await waitFor(() => Object.values(store.getControl("goal_reviews") || {}).find((entry) => entry.state === current.expected));
    assert.equal(review.state, current.expected);
  }
});

test("parseReviewerReport rejects missing fields and accepts the exact schema", () => {
  assert.deepEqual(parseReviewerReport(JSON.stringify(validReport())), validReport());
  assert.throws(() => parseReviewerReport(""), /no final message/);
  assert.throws(() => parseReviewerReport("[]"), /JSON object/);
  assert.throws(() => parseReviewerReport(JSON.stringify(validReport({ completion_claim: "false" }))), /completion_claim/);
  assert.throws(() => parseReviewerReport(JSON.stringify(validReport({ evidence_refs: [1] }))), /evidence_refs/);
});

test("a completed reviewer with an empty gap creates no feedback", async () => {
  const { store, codexapp, runner } = setup({
    report: validReport({ gap: "", next_action: "No action." }),
  });
  await runner.onStop(stopEvent(), "stop");
  await waitFor(() => store.getControl("goal_reviews")["goal-review:goal-1:thread-1:turn-1"]?.state === "completed");
  assert.equal(codexapp.sends.length, 0);
});
