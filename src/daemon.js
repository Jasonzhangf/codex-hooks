import {
  DELIVERY_STATES,
  SEND_MODES,
  SESSION_STATES,
  classifyHook,
  clone,
  eventKey,
  normalizeHookEvent,
  normalizeIntent,
} from "./protocol.js";

const DELIVERY = Object.freeze({
  DEFERRED: "deferred",
  EMITTED: "emitted",
  ACCEPTED: "accepted",
  FAILED: "failed",
});

export class MemoryStateStore {
  constructor() {
    this.events = new Map();
    this.intents = new Map();
    this.transitions = [];
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

  putIntent(key, value) {
    this.intents.set(key, clone(value));
  }

  recordTransition(value) {
    this.transitions.push(clone(value));
  }
}

export class HooksDaemon {
  constructor({ codexapp, store = new MemoryStateStore(), now = () => new Date().toISOString(), intentFactory = null }) {
    if (!codexapp) throw new Error("codexapp port is required");
    this.codexapp = codexapp;
    this.store = store;
    this.now = now;
    this.intentFactory = intentFactory;
    this.inflightEvents = new Map();
    this.inflightIntents = new Map();
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

  async processHook(event, hookKind, key, rawIntent) {

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

    if (hookKind === "stop" && event.stop_hook_active) {
      const result = this.result(event, hookKind, "guarded", { delivery: null, guard: "stop_hook_active" });
      this.rememberIntent(intent, { intent_id: intent.intent_id }, "guarded");
      return result;
    }

    const observed = await this.codexapp.session_status(intent.target);
    const state = observed?.state || observed?.status?.type || "unknown";
    if (!SESSION_STATES.includes(state)) return this.fail(event, hookKind, intent, "unknown_session_state", state);

    if (state === "disconnected" || state === "unknown") {
      return this.fail(event, hookKind, intent, `${state}_session`, state);
    }

    if (state === "working" && intent.send_mode === SEND_MODES.IDLE_ONLY) {
      const delivery = this.transition(intent, DELIVERY.DEFERRED, { state, at: this.now() });
      const result = this.result(event, hookKind, "deferred", { delivery });
      this.rememberIntent(intent, delivery, "deferred");
      return result;
    }

    if (state === "stopping") {
      const delivery = this.transition(intent, DELIVERY.DEFERRED, { state, at: this.now() });
      const result = this.result(event, hookKind, "deferred", { delivery });
      this.rememberIntent(intent, delivery, "deferred");
      return result;
    }

    return this.send(event, hookKind, intent, state);
  }

  async flushPending(target) {
    const normalizedTarget = target;
    const status = await this.codexapp.session_status(normalizedTarget);
    const state = status?.state || status?.status?.type || "unknown";
    const pending = [...this.store.intents.values()]
      .filter((record) => record.decision === "deferred" && sameTarget(record.target, normalizedTarget))
      .map((record) => record.intent || record);
    if (state === "unknown" || state === "disconnected") {
      const failed = pending.map((intent) => {
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
    if (state !== "idle") return { state, decision: "deferred", sent: [] };

    const sent = [];
    const failed = [];
    for (const intent of pending) {
      try {
        const attemptId = `${intent.intent_id}:resume`;
        const emitted = this.transition(intent, DELIVERY.EMITTED, { state, attempt_id: attemptId, at: this.now() });
        const result = await this.codexapp.send_message({ target: intent.target, body: intent.body, attempt_id: attemptId });
        assertAcceptedReceipt(result);
        const delivery = this.transition({ ...emitted, native: result }, DELIVERY.ACCEPTED, { state, attempt_id: attemptId, native: result, at: this.now() });
        this.rememberIntent(intent, delivery, "sent");
        sent.push(clone(delivery));
      } catch (error) {
        const deliveryState = isUncertainTransportError(error) ? "unknown_delivery" : DELIVERY.FAILED;
        const delivery = this.transition(intent, deliveryState, { state, code: error.code || "send_failed", message: error.message, at: this.now() });
        this.rememberIntent(intent, delivery, deliveryState === "unknown_delivery" ? "unknown_delivery" : "failed");
        failed.push(clone(delivery));
      }
    }
    return { state, sent, failed };
  }

  async send(event, hookKind, intent, state) {
    const emitted = this.transition(intent, DELIVERY.EMITTED, { state, at: this.now() });
    try {
      const native = await this.codexapp.send_message({ target: intent.target, body: intent.body, attempt_id: intent.intent_id });
      assertAcceptedReceipt(native);
      const accepted = this.transition({ ...emitted, native }, DELIVERY.ACCEPTED, { state, native, at: this.now() });
      this.rememberIntent(intent, accepted, "sent");
      const hookOutput = hookKind === "stop" ? { continue: false } : {};
      return this.result(event, hookKind, "sent", { delivery: accepted, hook_output: hookOutput });
    } catch (error) {
      if (isUncertainTransportError(error)) {
        const unknown = this.transition(emitted, "unknown_delivery", {
          state,
          code: error.code || "unknown_delivery",
          message: error.message,
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

function assertAcceptedReceipt(value) {
  if (value?.accepted === true || value?.state === "accepted" || value?.state === "delivered" || value?.nativeResult?.state === "accepted" || value?.nativeResult?.state === "delivered") return value;
  const error = new Error("codexapp returned no accepted send receipt");
  error.code = "invalid_send_receipt";
  throw error;
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
    left.thread_id === right.thread_id;
}

function assertSameIntent(left, right) {
  if (!left || left.intent_id !== right.intent_id || left.source !== right.source || left.body !== right.body || left.send_mode !== right.send_mode || !sameTarget(left.target, right.target) || left.event_key !== right.event_key) {
    const error = new Error(`intent_id already used with different intent: ${right.intent_id}`);
    error.code = "intent_id_conflict";
    throw error;
  }
}
