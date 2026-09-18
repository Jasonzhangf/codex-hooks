import {
  DELIVERY_STATES,
  SEND_OPERATIONS,
  SEND_MODES,
  DEFERRED_SESSION_STATES,
  FAIL_CLOSED_SESSION_STATES,
  SEND_ELIGIBLE_STATES,
  SESSION_STATES,
  classifyHook,
  clone,
  eventKey,
  interruptSuppressionKey,
  normalizeHookEvent,
  normalizeIntent,
  normalizeSessionObservation,
} from "./protocol.js";
import { assertCodexAppPort } from "./codexapp-port.js";
import { projectStopDecision } from "./decision.js";

const DELIVERY = Object.freeze({
  DEFERRED: "deferred",
  EMITTED: "emitted",
  SENDING: "sending",
  ACCEPTED: "accepted",
  FAILED: "failed",
});

const DELIVERY_EVIDENCE_NEXT = Object.freeze({
  unknown_delivery: "delivered",
  accepted: "delivered",
  delivered: "executed",
  executed: "replied",
  replied: "read",
  read: "consumed",
});

export class MemoryStateStore {
  constructor() {
    this.events = new Map();
    this.intents = new Map();
    this.transitions = [];
    this.controls = new Map();
  }

  getEvent(key) {
    return clone(this.events.get(key));
  }

  putEvent(key, value) {
    this.events.set(key, clone(value));
  }

  getIntent(key) {
    return clone(this.intents.get(key));
  }

  listIntents() {
    return [...this.intents.values()].map(clone);
  }

  putIntent(key, value) {
    this.intents.set(key, clone(value));
  }

  recordTransition(value) {
    this.transitions.push(clone(value));
  }

  getControl(key) {
    return clone(this.controls.get(key));
  }

  putControl(key, value) {
    this.controls.set(key, clone(value));
  }

  snapshot() {
    return {
      events: clone(Object.fromEntries(this.events)),
      intents: clone(Object.fromEntries(this.intents)),
      transitions: clone(this.transitions),
      controls: clone(Object.fromEntries(this.controls)),
    };
  }
}

export class HooksDaemon {
  constructor({ codexapp, store = new MemoryStateStore(), now = () => new Date().toISOString(), intentFactory = null }) {
    this.codexapp = assertCodexAppPort(codexapp);
    this.store = store;
    this.now = now;
    this.intentFactory = intentFactory;
    this.inflightEvents = new Map();
    this.inflightIntents = new Map();
    this.inflightSends = new Map();
  }

  async handleHook(rawEvent, { intent: rawIntent = null, kind = null } = {}) {
    const event = normalizeHookEvent(rawEvent);
    const hookKind = classifyHook(event, kind);
    const key = eventKey(event, hookKind);
    const previous = this.store.getEvent(key);
    if (previous) return { ...previous, idempotent: true };

    const inflight = this.inflightEvents.get(key);
    if (inflight) return { ...(await inflight), idempotent: true };

    const work = this.processHook(event, hookKind, key, rawIntent);
    this.inflightEvents.set(key, work);
    try {
      return await work;
    } finally {
      this.inflightEvents.delete(key);
    }
  }

  async dispatchIntent(rawIntent, { kind = "daemon" } = {}) {
    const intent = normalizeIntent(rawIntent);
    return this.dispatch({ hook_event_name: `daemon:${kind}` }, kind, intent);
  }

  async createSubagent(request) {
    if (typeof this.codexapp.create_subagent !== "function") {
      throw Object.assign(new Error("codexapp does not provide subagent creation"), {
        code: "subagent_capability_missing",
      });
    }
    return this.codexapp.create_subagent(request);
  }

  async sessionStatus(target) {
    return this.codexapp.session_status(target);
  }

  async interruptSubagent(request) {
    if (typeof this.codexapp.interrupt_turn !== "function") {
      throw Object.assign(new Error("codexapp does not provide turn interruption"), {
        code: "subagent_interrupt_capability_missing",
      });
    }
    return this.codexapp.interrupt_turn(request);
  }

  async steerMessage(request) {
    if (typeof this.codexapp.steer_message !== "function") {
      throw Object.assign(new Error("codexapp does not provide message steering"), {
        code: "steer_capability_missing",
      });
    }
    return this.codexapp.steer_message(request);
  }

  async deliveryEvidence(request) {
    if (typeof this.codexapp.delivery_evidence !== "function") {
      const error = new Error("codexapp does not provide delivery evidence");
      error.code = "delivery_evidence_unavailable";
      throw error;
    }
    return this.codexapp.delivery_evidence(request);
  }

  async readSubagentResult(request) {
    if (typeof this.codexapp.read_subagent_result !== "function") {
      throw Object.assign(new Error("codexapp does not provide subagent result reads"), {
        code: "read_subagent_result_capability_missing",
      });
    }
    return this.codexapp.read_subagent_result(request);
  }

  async processHook(event, hookKind, key, rawIntent) {
    if (hookKind === "stop" && event.stop_hook_active) {
      const result = this.result(event, hookKind, "guarded", { delivery: null, guard: "stop_hook_active" });
      this.store.putEvent(key, result);
      return result;
    }
    if (hookKind === "lifecycle" && event.hook_event_name === "Interrupt") {
      this.recordInterrupt(event);
    }
    const generatedIntent = rawIntent || (this.intentFactory ? await this.intentFactory(event, hookKind) : null);
    if (!generatedIntent) {
      const result = this.result(event, hookKind, "observed", { delivery: null });
      this.store.putEvent(key, result);
      return result;
    }

    const intent = normalizeIntent({ ...generatedIntent, event_key: generatedIntent.event_key || key });
    const result = await this.dispatch(event, hookKind, intent);
    this.store.putEvent(key, result);
    return result;
  }

  recordInterrupt(event) {
    const suppressionKey = interruptSuppressionKey(event.session_id, event.turn_id);
    const suppressions = this.store.getControl("stop_suppression") || {};
    suppressions[suppressionKey] = {
      session_id: event.session_id,
      turn_id: event.turn_id || null,
      hook_event_name: event.hook_event_name,
      reason: event.reason || null,
      source: event.source || null,
      observed_at: this.now(),
    };
    this.store.putControl("stop_suppression", suppressions);
    return clone(suppressions[suppressionKey]);
  }

  async dispatch(event, hookKind, intent) {
    const existing = this.store.getIntent(intent.intent_id);
    if (existing) {
      assertSameIntent(existing.intent, intent);
      return this.result(event, hookKind, existing.decision, { delivery: existing });
    }

    const inflight = this.inflightIntents.get(intent.intent_id);
    if (inflight) {
      assertSameIntent(inflight.intent, intent);
      return { ...(await inflight.promise), idempotent: true };
    }

    const work = this.dispatchOnce(event, hookKind, intent);
    this.inflightIntents.set(intent.intent_id, { intent: clone(intent), promise: work });
    try {
      return await work;
    } finally {
      this.inflightIntents.delete(intent.intent_id);
    }
  }

  async dispatchOnce(event, hookKind, intent) {
    if (intent.expires_at && Date.parse(intent.expires_at) <= Date.parse(this.now())) {
      const delivery = this.transition(intent, "expired", { at: this.now(), expires_at: intent.expires_at });
      this.rememberIntent(intent, delivery, "expired");
      return this.result(event, hookKind, "expired", { delivery });
    }

    let observed;
    try {
      observed = await this.codexapp.session_status(intent.target);
    } catch (error) {
      const code = mapSessionStatusError(error);
      return this.fail(event, hookKind, intent, code, String(error.code ?? "session_status_failed"), error.message);
    }
    const observation = normalizeSessionObservation(observed);
    const state = observation.state;
    if (!SESSION_STATES.includes(state)) return this.fail(event, hookKind, intent, "unknown_session_state", state);

    if (FAIL_CLOSED_SESSION_STATES.includes(state)) {
      return this.fail(event, hookKind, intent, `${state}_session`, state);
    }

    if (observation.input_active || (state === "working" && intent.send_mode === SEND_MODES.IDLE_ONLY) ||
      (DEFERRED_SESSION_STATES.includes(state) && state !== "working")) {
      const delivery = this.transition(intent, DELIVERY.DEFERRED, { state, input_active: observation.input_active, at: this.now() });
      const result = this.result(event, hookKind, "deferred", { delivery });
      this.rememberIntent(intent, delivery, "deferred");
      return result;
    }

    if (!SEND_ELIGIBLE_STATES.includes(state) && !(state === "working" && intent.send_mode === SEND_MODES.WORKING_ALLOWED)) {
      return this.fail(event, hookKind, intent, "session_not_sendable", state);
    }

    if (intent.operation === SEND_OPERATIONS.STEER) {
      if (state !== "working" || !intent.turn_id || observation.active_turn_id !== intent.turn_id) {
        return this.fail(event, hookKind, intent, "steer_requires_live_working_turn", state);
      }
    }
    if (intent.operation === SEND_OPERATIONS.INTERRUPT) {
      return this.fail(event, hookKind, intent, "interrupt_is_explicit_stop_only", state);
    }
    return this.send(event, hookKind, intent, state);
  }

  async flushPending(target) {
    const normalizedTarget = target;
    const status = await this.codexapp.session_status(normalizedTarget);
    const observation = normalizeSessionObservation(status);
    const state = observation.state;
    const pending = this.store.listIntents
      ? this.store.listIntents()
      : [...this.store.intents.values()].map(clone);
    const deferred = pending
      .filter((record) => record.decision === "deferred" && sameTarget(record.target, normalizedTarget))
      .map((record) => record.intent || record);
    if (FAIL_CLOSED_SESSION_STATES.includes(state)) {
      const failed = deferred.map((intent) => {
        const delivery = this.transition(intent, DELIVERY.FAILED, {
          code: `${state}_session`,
          state,
          at: this.now(),
        });
        this.rememberIntent(intent, delivery, "fail_closed");
        return delivery;
      });
      return { state, decision: "fail_closed", sent: [], failed };
    }
    if (observation.input_active || !SEND_ELIGIBLE_STATES.includes(state)) return { state, input_active: observation.input_active, decision: "deferred", sent: [] };

    const sent = [];
    const deferredResults = [];
    const failed = [];
    for (const intent of deferred) {
      try {
        const result = await this.resumePendingIntent(intent, state);
        if (result.decision === "sent") sent.push(clone(result.delivery));
        else if (result.decision === "deferred") deferredResults.push(clone(result.delivery));
        else failed.push(clone(result.delivery));
      } catch (error) {
        failed.push({ intent_id: intent.intent_id, state: "failed", evidence: { state, code: error.code || "send_failed", message: error.message } });
      }
    }
    return {
      state,
      decision: deferredResults.length > 0
        ? "deferred"
        : sent.length > 0
          ? "sent"
          : failed.length > 0
            ? "fail_closed"
            : "sent",
      sent,
      deferred: deferredResults,
      failed,
    };
  }

  async resumePendingIntent(intent, state) {
    const existing = this.store.getIntent(intent.intent_id);
    if (!existing) throw new Error(`deferred intent disappeared: ${intent.intent_id}`);
    assertSameIntent(existing.intent, intent);
    const inflight = this.inflightSends.get(intent.intent_id);
    if (inflight) return { ...(await inflight), idempotent: true };
    if (existing.decision !== "deferred") return this.result({ hook_event_name: "daemon:resume" }, intent.source, existing.decision, { delivery: existing });
    const attemptId = `${intent.intent_id}:resume`;
    const work = this.send({ hook_event_name: "daemon:resume" }, intent.source, intent, state, attemptId);
    this.inflightSends.set(intent.intent_id, work);
    try {
      return await work;
    } finally {
      this.inflightSends.delete(intent.intent_id);
    }
  }

  recoverOutbox() {
    const pending = this.store.listIntents
      ? this.store.listIntents()
      : [...this.store.intents.values()].map(clone);
    const unresolved = pending.filter((record) => ["emitted", "sending"].includes(record.state));
    return unresolved.map((record) => {
      const intent = record.intent || record;
      const delivery = this.transition(intent, "unknown_delivery", {
        code: "restart_recovery_requires_reconcile",
        previous_state: record.state,
        attempt_id: record.evidence?.attempt_id,
        at: this.now(),
      });
      this.rememberIntent(intent, delivery, "unknown_delivery");
      return clone(delivery);
    });
  }

  #recordDeliveryEvidence(intentId, state, evidence) {
    if (typeof intentId !== "string" || intentId.trim() === "") throw new Error("intent_id is required");
    if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) throw new Error("delivery evidence must be an object");
    const existing = this.store.getIntent(intentId);
    if (!existing) {
      const error = new Error(`intent not found: ${intentId}`);
      error.code = "intent_not_found";
      throw error;
    }
    if (existing.state === state) {
      assertSameEvidence(existing, state, evidence);
      return clone(existing);
    }
    if (DELIVERY_EVIDENCE_NEXT[existing.state] !== state) {
      const error = new Error(`invalid delivery evidence transition: ${existing.state} -> ${state}`);
      error.code = "invalid_delivery_transition";
      throw error;
    }
    assertDeliveryEvidence(existing, state, evidence);
    const intent = existing.intent || existing;
    const delivery = this.transition(intent, state, { ...clone(evidence), at: this.now() });
    this.rememberIntent(intent, delivery, existing.decision || "sent");
    return clone(delivery);
  }

  async reconcileDeliveryEvidence(intentId) {
    const existing = this.store.getIntent(intentId);
    if (!existing) {
      const error = new Error(`intent not found: ${intentId}`);
      error.code = "intent_not_found";
      throw error;
    }
    if (!DELIVERY_EVIDENCE_NEXT[existing.state]) {
      const error = new Error(`intent is not awaiting delivery reconciliation: ${intentId}`);
      error.code = "intent_not_reconcilable";
      throw error;
    }
    if (typeof this.codexapp.delivery_evidence !== "function") {
      const error = new Error("codexapp port does not provide authoritative delivery evidence");
      error.code = "delivery_evidence_unavailable";
      throw error;
    }
    const evidence = await this.codexapp.delivery_evidence({
      target: existing.intent?.target || existing.target,
      attempt_id: existing.evidence?.attempt_id,
      after_state: existing.state,
    });
    return this.#recordDeliveryEvidence(intentId, DELIVERY_EVIDENCE_NEXT[existing.state], evidence);
  }

  async reconcileNextDelivery() {
    const pending = this.store.listIntents
      ? this.store.listIntents()
      : [...this.store.intents.values()].map(clone);
    const candidates = pending
      .filter((record) => DELIVERY_EVIDENCE_NEXT[record.state])
      .sort((left, right) => String(left.evidence?.at || "").localeCompare(String(right.evidence?.at || "")));
    if (candidates.length === 0) return null;
    const unresolved = [];
    for (const candidate of candidates) {
      try {
        return await this.reconcileDeliveryEvidence(candidate.intent_id);
      } catch (error) {
        if (!DELIVERY_RECONCILE_SKIP_CODES.has(error?.code)) throw error;
        unresolved.push({
          intent_id: candidate.intent_id,
          state: candidate.state,
          code: error.code,
          message: error.message,
        });
      }
    }
    return { state: "unresolved", unresolved };
  }

  async send(event, hookKind, intent, state, attemptId = intent.intent_id) {
    const emitted = this.transition(intent, DELIVERY.EMITTED, { state, attempt_id: attemptId, at: this.now() });
    // Reserve the durable outbox record before crossing the transport
    // boundary. A crash after this point is unknown delivery, never a reason
    // to blindly retry the same message.
    this.rememberIntent(intent, emitted, "emitted");
    const sending = this.transition(emitted, DELIVERY.SENDING, { state, attempt_id: attemptId, at: this.now() });
    this.rememberIntent(intent, sending, "sending");
    try {
      const native = intent.operation === SEND_OPERATIONS.STEER
        ? await this.steerMessage({
          target: intent.target,
          body: intent.body,
          attempt_id: attemptId,
          turn_id: intent.turn_id,
        })
        : await this.codexapp.send_message({ target: intent.target, body: intent.body, attempt_id: attemptId });
      assertAcceptedReceipt(native, attemptId);
      const accepted = this.transition({ ...sending, native }, DELIVERY.ACCEPTED, { state, attempt_id: attemptId, native, at: this.now() });
      this.rememberIntent(intent, accepted, "sent");
      const delivered = nativeState(native) === "delivered"
        ? this.#recordDeliveryEvidence(intent.intent_id, "delivered", { native, target_receipt: nativeReceipt(native), attempt_id: attemptId })
        : accepted;
      // An external sendmessage wake is not the official Stop continuation
      // protocol. Do not emit `decision:block` or `continue:false` here:
      // neither value is a proof that the separately queued message was
      // delivered or executed. Native Stop continuation is a future,
      // explicitly selected policy with its own replay evidence.
      const hookOutput = hookKind === "stop"
        ? projectStopDecision({ action: "inject" }, { externalWakeAccepted: true })
        : {};
      return this.result(event, hookKind, "sent", { delivery: delivered, hook_output: hookOutput });
    } catch (error) {
      if (error.code === "native_thread_busy") {
        const deferred = this.transition(sending, DELIVERY.DEFERRED, {
          state,
          code: error.code,
          message: error.message,
          attempt_id: attemptId,
          at: this.now(),
        });
        this.rememberIntent(intent, deferred, "deferred");
        return this.result(event, hookKind, "deferred", {
          delivery: deferred,
          error: { code: error.code, message: error.message },
        });
      }
      if (isUncertainTransportError(error)) {
        const unknown = this.transition(sending, "unknown_delivery", {
          state,
          code: error.code || "unknown_delivery",
          message: error.message,
          attempt_id: attemptId,
          at: this.now(),
        });
        this.rememberIntent(intent, unknown, "unknown_delivery");
        return this.result(event, hookKind, "unknown_delivery", {
          delivery: unknown,
          error: { code: error.code || "unknown_delivery", message: error.message },
        });
      }
      return this.fail(event, hookKind, intent, error.code || "send_failed", state, error.message);
    }
  }

  fail(event, hookKind, intent, code, state, message = code) {
    const delivery = this.transition(intent, DELIVERY.FAILED, { code, state, message, at: this.now() });
    this.rememberIntent(intent, delivery, "failed");
    return this.result(event, hookKind, "fail_closed", { delivery, error: { code, message } });
  }

  transition(intent, state, evidence) {
    if (!DELIVERY_STATES.includes(state)) throw new Error(`invalid delivery state: ${state}`);
    const value = { intent_id: intent.intent_id, source: intent.source, target: intent.target, body: intent.body, send_mode: intent.send_mode, state, evidence };
    this.store.recordTransition(value);
    return value;
  }

  rememberIntent(intent, delivery, decision) {
    this.store.putIntent(intent.intent_id, { ...delivery, decision, intent: clone(intent) });
  }

  result(event, hookKind, decision, extra) {
    return {
      protocol: "routecodex-hooks/v1",
      event: event.hook_event_name,
      kind: hookKind,
      decision,
      ...clone(extra),
    };
  }
}

const SESSION_STATUS_ERROR_MAP = Object.freeze({
  target_scope_not_found: "target_scope_not_found",
  session_not_found: "session_not_found",
  invalid_request: "invalid_request",
  native_transport_error: "session_status_unavailable",
  transport_timeout: "session_status_unavailable",
});

const DELIVERY_RECONCILE_SKIP_CODES = new Set([
  "message_not_found",
  "delivery_unresolved",
]);

function mapSessionStatusError(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (SESSION_STATUS_ERROR_MAP[code]) return SESSION_STATUS_ERROR_MAP[code];
  if (code === "native_transport_error" || code.startsWith("transport_")) return "session_status_unavailable";
  if (typeof error?.message === "string" && error.message.includes("invalid thread id")) return "session_not_found";
  return "unknown_session_state";
}

function assertAcceptedReceipt(value, attemptId) {
  const accepted = value?.accepted === true || value?.state === "accepted" || value?.state === "delivered" || value?.nativeResult?.state === "accepted" || value?.nativeResult?.state === "delivered";
  const receiptAttemptId = value?.attempt_id || value?.nativeResult?.attempt_id;
  if (accepted && receiptAttemptId === attemptId) return value;
  const error = new Error("codexapp returned no accepted send receipt");
  error.code = "invalid_send_receipt";
  throw error;
}

function assertDeliveryEvidence(existing, state, evidence) {
  const expectedAttemptId = existing.evidence?.attempt_id;
  if (typeof expectedAttemptId !== "string" || evidence.attempt_id !== expectedAttemptId) {
    const error = new Error(`delivery evidence attempt_id does not match intent: ${existing.intent_id}`);
    error.code = "delivery_evidence_attempt_mismatch";
    throw error;
  }
  if (state === "read" && !isNonEmptyString(evidence.cursor)) {
    const error = new Error("read evidence requires a cursor");
    error.code = "read_evidence_requires_cursor";
    throw error;
  }
  if (state === "delivered" && !validTargetReceipt(evidence.target_receipt || nativeReceipt(evidence.native), expectedAttemptId)) {
    const error = new Error("delivered evidence requires a matching target receipt");
    error.code = "delivered_evidence_requires_target_receipt";
    throw error;
  }
  if (state === "executed" && !isNonEmptyString(evidence.execution_item_id)) {
    const error = new Error("executed evidence requires an execution_item_id");
    error.code = "executed_evidence_requires_execution_item";
    throw error;
  }
  if (state === "replied" && !isNonEmptyString(evidence.response_turn_id) && !isNonEmptyString(evidence.response_item_id)) {
    const error = new Error("replied evidence requires a response turn or item");
    error.code = "replied_evidence_requires_response";
    throw error;
  }
  if (state === "read" && !isNonEmptyString(evidence.read_item_id)) {
    const error = new Error("read evidence requires a read_item_id");
    error.code = "read_evidence_requires_item";
    throw error;
  }
  if (state === "consumed" && !isNonEmptyString(evidence.ack_id)) {
    const error = new Error("consumed evidence requires an ack_id");
    error.code = "consumed_evidence_requires_ack";
    throw error;
  }
}

function assertSameEvidence(existing, state, evidence) {
  if (evidenceIdentity(existing.evidence, state) !== evidenceIdentity(evidence, state)) {
    const error = new Error(`duplicate delivery evidence does not match existing ${state} evidence`);
    error.code = "duplicate_delivery_evidence_mismatch";
    throw error;
  }
}

function evidenceIdentity(evidence, state) {
  if (!evidence || typeof evidence !== "object") return null;
  if (state === "delivered") return `${evidence.attempt_id || ""}:${receiptIdentity(evidence.target_receipt || nativeReceipt(evidence.native))}`;
  if (state === "executed") return `${evidence.attempt_id || ""}:${evidence.execution_item_id || ""}`;
  if (state === "replied") return `${evidence.attempt_id || ""}:${evidence.response_turn_id || evidence.response_item_id || ""}`;
  if (state === "read") return `${evidence.attempt_id || ""}:${evidence.cursor || ""}:${evidence.read_item_id || ""}`;
  if (state === "consumed") return `${evidence.attempt_id || ""}:${evidence.ack_id || ""}`;
  return JSON.stringify(evidence);
}

function receiptIdentity(receipt) {
  if (!receipt || typeof receipt !== "object") return "";
  return receipt.clientId || receipt.clientUserMessageId || receipt.messageId || "";
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function nativeState(value) {
  return value?.state || value?.nativeResult?.state || null;
}

function nativeReceipt(value) {
  return value?.target_receipt || value?.targetReceipt || value?.native_result?.targetReceipt || value?.nativeResult?.targetReceipt || null;
}

function validTargetReceipt(receipt, attemptId) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  return receipt.clientId === attemptId || receipt.clientUserMessageId === attemptId || receipt.messageId === attemptId;
}

function isUncertainTransportError(error) {
  if (error?.uncertain === true) return true;
  const code = typeof error?.code === "string" ? error.code : "";
  return code === "timeout" || code === "timed_out" || code === "transport_timeout" || code === "unknown_delivery" || code.endsWith("_timeout");
}

function sameTarget(left, right) {
  return left.namespace === right.namespace &&
    left.appserver_id === right.appserver_id &&
    left.session_id === right.session_id &&
    left.thread_id === right.thread_id &&
    (left.scope_id || null) === (right.scope_id || null);
}

function assertSameIntent(left, right) {
    if (!left || left.intent_id !== right.intent_id || left.source !== right.source || left.body !== right.body || left.send_mode !== right.send_mode || left.operation !== right.operation || left.turn_id !== right.turn_id || !sameTarget(left.target, right.target) || left.event_key !== right.event_key) {
    const error = new Error(`intent_id already used with different intent: ${right.intent_id}`);
    error.code = "intent_id_conflict";
    throw error;
  }
}
