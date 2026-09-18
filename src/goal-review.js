import fs from "node:fs";
import {
  assertNonEmpty,
  clone,
  interruptSuppressionKey,
} from "./protocol.js";

const DEFAULT_REVIEW_TIMEOUT_MS = 300_000;
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
    const reviewBudget = Number.isInteger(goal.review_budget) ? goal.review_budget : null;
    if (reviewBudget != null && reviewCount >= reviewBudget) {
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
      const decision = evaluateReviewerReport(report);
      this.updateReview(reviewId, {
        state: "completed",
        report,
        review_decision: decision.action,
        feedback_required: decision.feedback_required,
        result_receipt: clone(result),
        completed_at: this.now(),
      });
      this.updateGoal(goal.id, {
        last_review_state: "completed",
        last_review_receipt: clone(result),
      });

      if (!decision.feedback_required) return;
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
        body: feedbackBody(report, decision),
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
  assertStringField(report, "goal");
  assertStringField(report, "observed");
  assertStringArrayField(report, "evidence_refs");
  assertObjectField(report, "functional");
  assertObjectField(report, "architecture");
  const functional = report.functional;
  if (!["complete", "incomplete", "blocked"].includes(functional.status)) {
    throw invalidReport("functional.status must be complete, incomplete, or blocked");
  }
  assertStringField(functional, "gap");
  assertStringField(functional, "next_action");
  if (functional.status === "incomplete" && (functional.gap.trim() === "" || functional.next_action.trim() === "")) {
    throw invalidReport("incomplete functional review requires gap and next_action");
  }
  const architecture = report.architecture;
  if (!["compliant", "non_compliant", "uncertain"].includes(architecture.status)) {
    throw invalidReport("architecture.status must be compliant, non_compliant, or uncertain");
  }
  if (!Array.isArray(architecture.findings)) throw invalidReport("architecture.findings must be an array");
  for (const finding of architecture.findings) {
    assertObjectValue(finding, "architecture finding");
    if (!["P0", "P1", "P2"].includes(finding.severity)) {
      throw invalidReport("architecture finding severity must be P0, P1, or P2");
    }
    assertStringField(finding, "summary");
    assertStringArrayField(finding, "evidence");
    assertStringField(finding, "next_action");
  }
  if (functional.status === "blocked") {
    assertObjectField(report, "blocked_review");
    const blocked = report.blocked_review;
    assertStringField(blocked, "reason");
    for (const field of ["reasonable", "solvable", "attempts_sufficient"]) {
      if (typeof blocked[field] !== "boolean") throw invalidReport(`blocked_review.${field} must be boolean`);
    }
    assertStringArrayField(blocked, "attempts_expected");
    assertStringArrayField(blocked, "attempts_observed");
    assertStringField(blocked, "next_action");
  } else if (report.blocked_review !== null) {
    throw invalidReport("blocked_review must be null unless functional.status is blocked");
  }
  return report;
}

export function buildReviewerPrompt({ goal_file, goal_text, source_turn_id, source_summary }) {
  return [
    "You are an isolated goal reviewer. Do not modify files or implement the task.",
    "Review the source turn against the goal document and the current repository.",
    "Evaluate functional completion, architecture compliance, and any claimed blocker.",
    "Do not be overly strict: P2 suggestions do not block completion.",
    "A review passes when the function is complete or legitimately blocked and architecture has no P0/P1 finding.",
    "For a claimed blocker, judge whether the reason is reasonable, whether it is solvable now, and whether the expected attempts were actually made.",
    "Return exactly one JSON object and no prose or markdown.",
    "Required fields: goal, observed, evidence_refs, functional, architecture, blocked_review.",
    "functional: {status: complete|incomplete|blocked, gap: string, next_action: string}.",
    "architecture: {status: compliant|non_compliant|uncertain, findings: [{severity: P0|P1|P2, summary, evidence: string[], next_action}]}.",
    "blocked_review: null unless functional.status is blocked; otherwise {reason, reasonable, solvable, attempts_sufficient, attempts_expected: string[], attempts_observed: string[], next_action}.",
    "Use an empty gap when complete. For blocked, describe the blocker and why it is or is not acceptable.",
    "Architecture findings must cite concrete files, behavior, or verification evidence.",
    `Goal file: ${goal_file}`,
    "Goal document:",
    goal_text,
    `Source turn: ${source_turn_id || "unknown"}`,
    "Source turn summary:",
    source_summary || "(not provided)",
  ].join("\n");
}

export function evaluateReviewerReport(report) {
  const feedbacks = [];
  if (report.functional.status === "incomplete") {
    feedbacks.push({
      kind: "functional",
      gap: report.functional.gap,
      next_action: report.functional.next_action,
    });
  } else if (report.functional.status === "blocked") {
    const blocked = report.blocked_review;
    const evidence_incomplete = (
      blocked.reason.trim() === ""
      || blocked.next_action.trim() === ""
      || blocked.attempts_expected.length === 0
      || blocked.attempts_observed.length === 0
    );
    if (!blocked.reasonable || blocked.solvable || !blocked.attempts_sufficient || evidence_incomplete) {
      feedbacks.push({
        kind: "blocked",
        reason: blocked.reason,
        reasonable: blocked.reasonable,
        solvable: blocked.solvable,
        attempts_sufficient: blocked.attempts_sufficient,
        evidence_incomplete,
        attempts_expected: blocked.attempts_expected,
        attempts_observed: blocked.attempts_observed,
        next_action: blocked.next_action,
      });
    }
  }
  const blockingFindings = report.architecture.findings.filter((finding) => ["P0", "P1"].includes(finding.severity));
  if (report.architecture.status !== "compliant" || blockingFindings.length > 0) {
    feedbacks.push({
      kind: "architecture",
      status: report.architecture.status,
      findings: report.architecture.status === "compliant"
        ? blockingFindings
        : report.architecture.findings,
      next_action: blockingFindings[0]?.next_action
        || "Resolve the architecture issue and rerun the goal review.",
    });
  }
  return {
    action: feedbacks.length === 0 ? "pass" : "feedback_required",
    feedback_required: feedbacks.length > 0,
    feedbacks,
  };
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

function feedbackBody(report, decision) {
  const lines = [
    "Goal review found a blocking issue.",
    `Goal: ${report.goal}`,
    `Observed: ${report.observed}`,
  ];
  for (const feedback of decision.feedbacks) {
    if (feedback.kind === "functional") {
      lines.push(`Functional gap: ${feedback.gap}`);
      lines.push(`Functional next action: ${feedback.next_action}`);
    } else if (feedback.kind === "architecture") {
      lines.push(`Architecture status: ${feedback.status}`);
      for (const finding of feedback.findings) {
        lines.push(`Architecture ${finding.severity}: ${finding.summary}`);
        lines.push(`Architecture evidence: ${finding.evidence.join("; ")}`);
        lines.push(`Architecture next action: ${finding.next_action}`);
      }
      if (feedback.findings.length === 0) {
        lines.push(`Architecture next action: ${feedback.next_action}`);
      }
    } else if (feedback.kind === "blocked") {
      lines.push(`Blocked reason: ${feedback.reason || "(missing)"}`);
      lines.push(`Blocked review: reasonable=${feedback.reasonable}, solvable=${feedback.solvable}, attempts_sufficient=${feedback.attempts_sufficient}, evidence_incomplete=${feedback.evidence_incomplete}`);
      lines.push(`Expected attempts: ${feedback.attempts_expected.join("; ") || "none recorded"}`);
      lines.push(`Observed attempts: ${feedback.attempts_observed.join("; ") || "none recorded"}`);
      lines.push(`Blocked next action: ${feedback.next_action || "Provide a concrete blocker reason, record the expected and observed attempts, and rerun the goal review."}`);
    }
  }
  return lines.join("\n");
}

function assertStringField(value, field) {
  if (typeof value[field] !== "string") throw invalidReport(`${field} must be a string`);
}

function assertStringArrayField(value, field) {
  if (!Array.isArray(value[field]) || value[field].some((entry) => typeof entry !== "string")) {
    throw invalidReport(`${field} must be a string array`);
  }
}

function assertObjectField(value, field) {
  assertObjectValue(value[field], field);
}

function assertObjectValue(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidReport(`${name} must be an object`);
  }
}

function invalidReport(message) {
  return Object.assign(new Error(`goal reviewer report field is invalid: ${message}`), {
    code: "reviewer_report_invalid",
  });
}
