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

function fakeCodexapp(report, { createError = null, readError = null, readStates = [] } = {}) {
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
      const state = readStates[this.reads.length - 1] || "completed";
      if (state !== "completed") {
        return {
          thread_id: "reviewer-thread",
          turn_id: "reviewer-turn",
          state,
        };
      }
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

function setup({
  report = validReport(),
  createError = null,
  readError = null,
  readStates = [],
  reviewBudget = 1,
  timeoutMs = 50,
} = {}) {
  const store = new MemoryStateStore();
  const codexapp = fakeCodexapp(report, { createError, readError, readStates });
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
    evidence_refs: ["test output"],
    functional: {
      status: "incomplete",
      gap: "Verification evidence is missing.",
      next_action: "Run the mapped tests and record the result.",
    },
    architecture: {
      status: "compliant",
      findings: [],
    },
    blocked_review: null,
    ...overrides,
  };
}

function completeReport() {
  return validReport({
    functional: {
      status: "complete",
      gap: "",
      next_action: "No further action.",
    },
  });
}

function blockedReport({
  reasonable = true,
  solvable = false,
  attemptsSufficient = true,
} = {}) {
  return validReport({
    functional: {
      status: "blocked",
      gap: "",
      next_action: "",
    },
    blocked_review: {
      reason: "The required production credential is unavailable.",
      reasonable,
      solvable,
      attempts_sufficient: attemptsSufficient,
      attempts_expected: ["Check the configured credential source."],
      attempts_observed: ["Checked the configured credential source; it is absent."],
      next_action: solvable
        ? "Provision the credential and rerun the live request."
        : "Wait for the credential owner to provide access.",
    },
  });
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
  assert.equal(codexapp.sends[0].body.includes("Functional next action: Run the mapped tests"), true);
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

test("reviewer polling waits through pending reads before completing", async () => {
  const { store, codexapp, runner } = setup({
    readStates: ["in_progress", "in_progress"],
    timeoutMs: 100,
  });
  await runner.onStop(stopEvent(), "stop");
  const review = await waitFor(() => {
    const entry = store.getControl("goal_reviews")["goal-review:goal-1:thread-1:turn-1"];
    return entry?.state === "completed" ? entry : null;
  });
  assert.equal(review.state, "completed");
  assert.equal(codexapp.reads.length, 3);
});

test("parseReviewerReport rejects missing fields and accepts the exact schema", () => {
  assert.deepEqual(parseReviewerReport(JSON.stringify(validReport())), validReport());
  assert.throws(() => parseReviewerReport(""), /no final message/);
  assert.throws(() => parseReviewerReport("[]"), /JSON object/);
  assert.throws(() => parseReviewerReport(JSON.stringify(validReport({ evidence_refs: [1] }))), /evidence_refs/);
  assert.throws(() => parseReviewerReport(JSON.stringify(validReport({ functional: { status: "done", gap: "", next_action: "" } }))), /functional.status/);
  assert.throws(() => parseReviewerReport(JSON.stringify(validReport({ architecture: { status: "compliant", findings: [{ severity: "P3", summary: "x", evidence: [], next_action: "y" }] } }))), /severity/);
  assert.throws(() => parseReviewerReport(JSON.stringify(validReport({ blocked_review: { reason: "x" } }))), /blocked_review must be null/);
});

test("a complete functional review with no P0/P1 architecture finding creates no feedback", async () => {
  const { store, codexapp, runner } = setup({
    report: completeReport(),
  });
  await runner.onStop(stopEvent(), "stop");
  await waitFor(() => store.getControl("goal_reviews")["goal-review:goal-1:thread-1:turn-1"]?.state === "completed");
  assert.equal(codexapp.sends.length, 0);
  assert.equal(store.getControl("goal_reviews")["goal-review:goal-1:thread-1:turn-1"].review_decision, "pass");
});

test("P2-only architecture findings do not block a complete review", async () => {
  const { store, codexapp, runner } = setup({
    report: validReport({
      functional: { status: "complete", gap: "", next_action: "" },
      architecture: {
        status: "compliant",
        findings: [{
          severity: "P2",
          summary: "The helper name could be clearer.",
          evidence: ["src/example.js:1"],
          next_action: "Rename it in a follow-up.",
        }],
      },
    }),
  });
  await runner.onStop(stopEvent(), "stop");
  await waitFor(() => store.getControl("goal_reviews")["goal-review:goal-1:thread-1:turn-1"]?.state === "completed");
  assert.equal(codexapp.sends.length, 0);
});

test("architecture P0/P1 findings create one feedback intent", async () => {
  const { store, codexapp, runner } = setup({
    report: validReport({
      functional: { status: "complete", gap: "", next_action: "" },
      architecture: {
        status: "non_compliant",
        findings: [{
          severity: "P1",
          summary: "The new path bypasses the declared owner.",
          evidence: ["src/example.js:10"],
          next_action: "Route the call through the declared owner.",
        }],
      },
    }),
  });
  await runner.onStop(stopEvent(), "stop");
  await waitFor(() => codexapp.sends.length === 1);
  const review = store.getControl("goal_reviews")["goal-review:goal-1:thread-1:turn-1"];
  assert.equal(review.review_decision, "feedback_required");
  assert.equal(codexapp.sends[0].body.includes("Architecture P1"), true);
  assert.equal(codexapp.sends[0].body.includes("Architecture evidence: src/example.js:10"), true);
});

test("non-compliant or uncertain architecture status cannot pass without blocking findings", async () => {
  for (const report of [
    validReport({
      functional: { status: "complete", gap: "", next_action: "" },
      architecture: { status: "non_compliant", findings: [] },
    }),
    validReport({
      functional: { status: "complete", gap: "", next_action: "" },
      architecture: {
        status: "uncertain",
        findings: [{
          severity: "P2",
          summary: "The ownership boundary could not be established.",
          evidence: ["src/example.js:20"],
          next_action: "Confirm the owner before changing the path.",
        }],
      },
    }),
  ]) {
    const { store, codexapp, runner } = setup({ report });
    await runner.onStop(stopEvent(), "stop");
    await waitFor(() => codexapp.sends.length === 1);
    const review = store.getControl("goal_reviews")["goal-review:goal-1:thread-1:turn-1"];
    assert.equal(review.review_decision, "feedback_required");
    assert.equal(codexapp.sends[0].body.includes("Architecture status:"), true);
  }
});

test("a reasonable unsolvable blocked review with sufficient attempts passes", async () => {
  const { store, codexapp, runner } = setup({ report: blockedReport() });
  await runner.onStop(stopEvent(), "stop");
  await waitFor(() => store.getControl("goal_reviews")["goal-review:goal-1:thread-1:turn-1"]?.state === "completed");
  assert.equal(codexapp.sends.length, 0);
});

test("an unreasonable or solvable blocked review creates feedback", async () => {
  for (const report of [
    blockedReport({ reasonable: false }),
    blockedReport({ solvable: true }),
    blockedReport({ attemptsSufficient: false }),
  ]) {
    const { store, codexapp, runner } = setup({ report });
    await runner.onStop(stopEvent(), "stop");
    await waitFor(() => codexapp.sends.length === 1);
    assert.equal(store.getControl("goal_reviews")["goal-review:goal-1:thread-1:turn-1"].review_decision, "feedback_required");
    assert.equal(codexapp.sends[0].body.includes("Blocked review:"), true);
  }
});

test("blocked reports with empty evidence create feedback instead of passing", async () => {
  const report = blockedReport();
  report.blocked_review.reason = "";
  report.blocked_review.next_action = "";
  report.blocked_review.attempts_expected = [];
  report.blocked_review.attempts_observed = [];

  const { store, codexapp, runner } = setup({ report });
  await runner.onStop(stopEvent(), "stop");
  await waitFor(() => codexapp.sends.length === 1);

  const review = store.getControl("goal_reviews")["goal-review:goal-1:thread-1:turn-1"];
  assert.equal(review.review_decision, "feedback_required");
  assert.equal(codexapp.sends[0].body.includes("evidence_incomplete=true"), true);
});

test("goal review runs on every Stop when no review budget is configured", async () => {
  const { store, codexapp, runner } = setup({ reviewBudget: null });
  await runner.onStop(stopEvent(), "stop");
  await waitFor(() => store.getControl("goal_reviews")["goal-review:goal-1:thread-1:turn-1"]?.state === "completed");
  await runner.onStop(stopEvent({ turn_id: "turn-2" }), "stop");
  await waitFor(() => store.getControl("goal_reviews")["goal-review:goal-1:thread-1:turn-2"]?.state === "completed");
  assert.equal(codexapp.creates.length, 2);
});
