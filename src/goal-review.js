import fs from "node:fs";
import {
  assertNonEmpty,
  clone,
  interruptSuppressionKey,
} from "./protocol.js";

const DEFAULT_REVIEW_TIMEOUT_MS = 30_000;
const DEFAULT_REVIEW_POLL_INTERVAL_MS = 250;

export class GoalReviewRunner {
  constructor({
    store,
    daemon,
    control,
    now = () => new Date().toISOString(),
    timeout_ms: timeoutMs = DEFAULT_REVIEW_TIMEOUT_MS,
    poll_interval_ms: pollIntervalMs = DEFAULT_REVIEW_POLL_INTERVAL_MS,
    read_file = (path) => fs.readFileSync(path, "utf8"),
  } = {}) {
    if (!store || typeof store.getControl !== "function" || typeof store.putControl !== "function") {
      throw new Error("goal review runner requires a state store");
    }
    if (!daemon || typeof daemon.createSubagent !== "function" || typeof daemon.readSubagentResult !== "function") {
      throw new Error("goal review runner requires daemon subagent capabilities");
    }
    if (!control || typeof control.registerSubagent !== "function") {
      throw new Error("goal review runner requires the control-plane subagent registry");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("goal review timeout_ms must be a positive integer");
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) throw new Error("goal review poll_interval_ms must be a positive integer");
    this.store = store;
    this.daemon = daemon;
    this.control = control;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.pollIntervalMs = pollIntervalMs;
    this.readFile = read_file;
    this.closed = false;
    this.timers = new Set();
  }

  async onStop(event, kind) {
    if (this.closed || kind !== "stop" || event.hook_event_name !== "Stop" || event.stop_hook_active) return null;
    const operators = this.store.getControl("operators") || {};
    if (operators.stopless?.enabled !== true) return null;
    if (this.isReviewerStop(event)) return null;
    if (this.isSuppressed(event)) return null;
    const goal = this.findGoal(event);
    if (!goal) return null;

    const reviewId = reviewIdentity(goal, event);
    try {
      const claim = this.claimReview(goal, event, reviewId);
      if (!claim.claimed) return null;
      void this.runReview(goal, event, reviewId).catch(() => {
        // runReview records its own failure. Stop remains non-blocking even if
        // a persistence or reviewer dependency fails after the claim.
      });
    } catch {
      // A policy-store failure must not turn the original Stop into a failed
      // hook. There is no safe review claim to report in that case.
    }
    return null;
  }

  close() {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  findGoal(event) {
    const records = Object.values(this.store.getControl("longhorizon") || {})
      .filter((record) => record?.mode === "goal" && record.enabled === true)
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const matching = records.filter((record) => {
      const target = record.target || {};
      return target.thread_id === event.session_id
        || target.session_id === event.session_id
        || record.owner_session_id === event.session_id;
    });
    return matching.length === 1 ? clone(matching[0]) : null;
  }

  isReviewerStop(event) {
    const subagents = this.store.getControl("subagents") || {};
    return Object.values(subagents).some((subagent) => (
      subagent.thread_id === event.session_id
      && subagent.kind === "goal_reviewer"
    ));
  }

  isSuppressed(event) {
    const suppressions = this.store.getControl("stop_suppression") || {};
    const exact = interruptSuppressionKey(event.session_id, event.turn_id);
    const wildcard = interruptSuppressionKey(event.session_id, null);
    if (!suppressions[exact] && !suppressions[wildcard]) return false;
    delete suppressions[exact];
    delete suppressions[wildcard];
    this.store.putControl("stop_suppression", suppressions);
    return true;
  }

  claimReview(goal, event, reviewId) {
    const reviews = this.store.getControl("goal_reviews") || {};
    if (reviews[reviewId]) return { claimed: false, review: clone(reviews[reviewId]) };

    const reviewCount = Number.isInteger(goal.review_count) ? goal.review_count : 0;
    const reviewBudget = Number.isInteger(goal.review_budget) ? goal.review_budget : 1;
    if (reviewCount >= reviewBudget) {
      reviews[reviewId] = {
        review_id: reviewId,
        goal_id: goal.id,
        state: "suppressed",
        reason: "review_budget_exhausted",
        source_session_id: event.session_id,
        source_turn_id: event.turn_id || null,
        claimed_at: this.now(),
      };
      this.store.putControl("goal_reviews", reviews);
      return { claimed: false, review: clone(reviews[reviewId]) };
    }

    const review = {
      review_id: reviewId,
      goal_id: goal.id,
      state: "claimed",
      source_session_id: event.session_id,
      source_turn_id: event.turn_id || null,
      source_cwd: event.cwd,
      goal_file: goal.goal_file,
      target: clone(goal.target),
      claimed_at: this.now(),
    };
    reviews[reviewId] = review;
    this.store.putControl("goal_reviews", reviews);
    this.updateGoal(goal.id, {
      review_count: reviewCount + 1,
      last_turn_id: event.turn_id || null,
      last_event_key: reviewId,
      last_review_state: "claimed",
      last_review_receipt: clone(review),
    });
    return { claimed: true, review: clone(review) };
  }

  async runReview(goal, event, reviewId) {
    try {
      const goalText = this.readFile(goal.goal_file);
      const prompt = buildReviewerPrompt({
        goal_file: goal.goal_file,
        goal_text: goalText,
        source_turn_id: event.turn_id || null,
        source_summary: event.last_assistant_message || null,
      });
      const target = scopeTarget(goal.target);
      const receipt = await this.daemon.createSubagent({
        target,
        prompt,
        attempt_id: reviewId,
        ephemeral: true,
        ...(goal.cwd == null && event.cwd == null ? {} : { cwd: goal.cwd || event.cwd }),
        ...(goal.model == null ? {} : { model: goal.model }),
        ...(goal.effort == null ? {} : { effort: goal.effort }),
      });
      this.control.registerSubagent({
        thread_id: receipt.thread_id,
        turn_id: receipt.turn_id,
        target,
        prompt,
        ephemeral: true,
        kind: "goal_reviewer",
        review_id: reviewId,
        source_session_id: event.session_id,
        source_turn_id: event.turn_id || null,
        owner_session_id: event.session_id,
        ...(goal.model == null ? {} : { model: goal.model }),
        ...(goal.effort == null ? {} : { effort: goal.effort }),
        create_receipt: receipt,
      });
      this.updateReview(reviewId, {
        state: "reviewing",
        thread_id: receipt.thread_id,
        turn_id: receipt.turn_id,
        create_receipt: clone(receipt),
      });
      this.updateGoal(goal.id, {
        last_review_state: "reviewing",
        last_review_receipt: clone(receipt),
      });

      const result = await this.waitForResult({
        target: goal.target,
        thread_id: receipt.thread_id,
        turn_id: receipt.turn_id,
      });
      if (result.state !== "completed") {
        throw Object.assign(new Error(`goal reviewer ended in state: ${result.state}`), {
          code: "reviewer_not_completed",
        });
      }
      const report = parseReviewerReport(result.finalMessage);
      this.updateReview(reviewId, {
        state: "completed",
        report,
        result_receipt: clone(result),
        completed_at: this.now(),
      });
      this.updateGoal(goal.id, {
        last_review_state: "completed",
        last_review_receipt: clone(result),
      });

      if (report.gap.trim() === "" || report.next_action.trim() === "") return;
      if (!this.isGoalActive(goal.id)) {
        this.updateReview(reviewId, {
          state: "cancelled",
          reason: "goal_inactive",
          cancelled_at: this.now(),
        });
        return;
      }
      const feedback = await this.daemon.dispatchIntent({
        intent_id: `goal-feedback:${reviewId}`,
        source: "longhorizon",
        target: clone(goal.target),
        body: feedbackBody(report),
        send_mode: "idle_only",
        busy_policy: "defer",
        operation: "queue",
        event_key: `goal-feedback:${reviewId}`,
      }, { kind: "goal_review" });
      this.updateReview(reviewId, {
        feedback_intent_id: `goal-feedback:${reviewId}`,
        feedback_decision: feedback.decision,
        feedback_delivery: clone(feedback.delivery || null),
        feedback_at: this.now(),
      });
    } catch (error) {
      this.updateReview(reviewId, {
        state: error?.code === "reviewer_result_unavailable" || error?.code === "reviewer_result_timeout"
          ? "unresolved"
          : "failed",
        error: {
          code: error?.code || "goal_review_failed",
          message: error?.message || String(error),
        },
        failed_at: this.now(),
      });
      this.updateGoal(goal.id, {
        last_review_state: error?.code === "reviewer_result_unavailable" || error?.code === "reviewer_result_timeout"
          ? "unresolved"
          : "failed",
      });
    }
  }

  async waitForResult({ target, thread_id, turn_id }) {
    const deadline = Date.now() + this.timeoutMs;
    while (!this.closed && Date.now() <= deadline) {
      const result = await this.daemon.readSubagentResult({ target, thread_id, turn_id });
      if (["completed", "failed", "interrupted"].includes(result.state)) return result;
      await this.sleep(this.pollIntervalMs);
    }
    if (this.closed) {
      throw Object.assign(new Error("goal reviewer stopped with the daemon"), { code: "reviewer_result_unavailable" });
    }
    throw Object.assign(new Error("goal reviewer result timed out"), { code: "reviewer_result_timeout" });
  }

  sleep(milliseconds) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        resolve();
      }, milliseconds);
      this.timers.add(timer);
    });
  }

  updateReview(reviewId, patch) {
    const reviews = this.store.getControl("goal_reviews") || {};
    if (!reviews[reviewId]) throw new Error(`goal review disappeared: ${reviewId}`);
    reviews[reviewId] = { ...reviews[reviewId], ...clone(patch) };
    this.store.putControl("goal_reviews", reviews);
    return clone(reviews[reviewId]);
  }

  updateGoal(goalId, patch) {
    const records = this.store.getControl("longhorizon") || {};
    if (!records[goalId]) throw new Error(`longhorizon goal disappeared: ${goalId}`);
    records[goalId] = { ...records[goalId], ...clone(patch) };
    this.store.putControl("longhorizon", records);
    return clone(records[goalId]);
  }

  isGoalActive(goalId) {
    const record = (this.store.getControl("longhorizon") || {})[goalId];
    return record?.mode === "goal" && record.enabled === true;
  }
}

export function parseReviewerReport(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw Object.assign(new Error("goal reviewer returned no final message"), {
      code: "reviewer_report_missing",
    });
  }
  let report;
  try {
    report = JSON.parse(value);
  } catch (error) {
    throw Object.assign(new Error(`goal reviewer returned malformed JSON: ${error.message}`), {
      code: "reviewer_report_malformed",
    });
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw Object.assign(new Error("goal reviewer report must be a JSON object"), {
      code: "reviewer_report_invalid",
    });
  }
  for (const field of ["goal", "observed", "gap", "next_action"]) {
    if (typeof report[field] !== "string") {
      throw Object.assign(new Error(`goal reviewer report field must be a string: ${field}`), {
        code: "reviewer_report_invalid",
      });
    }
  }
  if (typeof report.completion_claim !== "boolean") {
    throw Object.assign(new Error("goal reviewer report field must be boolean: completion_claim"), {
      code: "reviewer_report_invalid",
    });
  }
  if (!Array.isArray(report.evidence_refs) || report.evidence_refs.some((entry) => typeof entry !== "string")) {
    throw Object.assign(new Error("goal reviewer report field must be a string array: evidence_refs"), {
      code: "reviewer_report_invalid",
    });
  }
  if (report.blocked_reason !== null && typeof report.blocked_reason !== "string") {
    throw Object.assign(new Error("goal reviewer report field must be null or a string: blocked_reason"), {
      code: "reviewer_report_invalid",
    });
  }
  return report;
}

export function buildReviewerPrompt({ goal_file, goal_text, source_turn_id, source_summary }) {
  return [
    "You are an isolated goal reviewer. Do not modify files.",
    "Compare the source turn with the goal document. Identify only a concrete remaining gap.",
    "Return exactly one JSON object and no prose or markdown.",
    "Required fields: goal, observed, gap, next_action, completion_claim, evidence_refs, blocked_reason.",
    "Types: string, string, string, string, boolean, string array, null or string.",
    "If the task is complete, use an empty gap and explain why the evidence is sufficient.",
    `Goal file: ${goal_file}`,
    "Goal document:",
    goal_text,
    `Source turn: ${source_turn_id || "unknown"}`,
    "Source turn summary:",
    source_summary || "(not provided)",
  ].join("\n");
}

function reviewIdentity(goal, event) {
  return `goal-review:${goal.id}:${event.session_id}:${event.turn_id || "no-turn"}`;
}

function scopeTarget(target) {
  return {
    namespace: assertNonEmpty(target?.namespace, "goal target.namespace"),
    appserver_id: assertNonEmpty(target?.appserver_id, "goal target.appserver_id"),
    ...(target?.scope_id == null ? {} : { scope_id: assertNonEmpty(target.scope_id, "goal target.scope_id") }),
  };
}

function feedbackBody(report) {
  return [
    "Goal review found a gap.",
    `Goal: ${report.goal}`,
    `Observed: ${report.observed}`,
    `Gap: ${report.gap}`,
    `Next action: ${report.next_action}`,
    ...(report.blocked_reason ? [`Blocked: ${report.blocked_reason}`] : []),
  ].join("\n");
}
