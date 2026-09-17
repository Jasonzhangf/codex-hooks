import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertNonEmpty } from "./protocol.js";

export const CODEXAPP_CAPABILITIES = Object.freeze([
  "session_status",
  "send_message_to_thread",
  "steer_message",
  "create_subagent",
  "interrupt_turn",
  "read_subagent_result",
]);
export const CODEXAPP_REQUIRED_CAPABILITIES = Object.freeze([
  "session_status",
  "send_message_to_thread",
]);

const BRIDGE_METHODS = Object.freeze({
  session_status: "session_status",
  send_message_to_thread: "send",
  steer_message: "steer",
  create_subagent: "create_subagent",
  interrupt_turn: "interrupt_turn",
  read_subagent_result: "read_subagent_result",
});

const DEFINITIVE_SEND_ERRORS = new Set([
  "scope_not_found",
  "session_not_found",
  "sender_not_registered",
  "agent_lease_expired",
  "capability_missing",
  "cross_scope_master_required",
  "cross_scope_target_must_be_master",
  "scope_peer_route_forbidden",
]);

export function assertCodexAppPort(port) {
  if (!port || typeof port !== "object") throw new Error("codexapp port must be an object");
  if (typeof port.session_status !== "function") throw new Error("codexapp port requires session_status");
  if (typeof port.send_message !== "function") throw new Error("codexapp port requires send_message");
  return port;
}

export async function verifyCodexAppPort(port, required = CODEXAPP_REQUIRED_CAPABILITIES) {
  assertCodexAppPort(port);
  if (typeof port.capabilities !== "function") throw new Error("codexapp port requires capabilities()");
  if (!Array.isArray(required)) throw new Error("required codexapp capabilities must be an array");
  const capabilities = normalizeCodexAppCapabilities(await port.capabilities());
  for (const capability of required) {
    if (!capabilities.includes(capability)) throw new Error(`codexapp missing configured capability: ${capability}`);
  }
  return capabilities;
}

export function normalizeCodexAppCapabilities(value) {
  if (!Array.isArray(value)) throw new Error("codexapp capabilities must be an array");
  const capabilities = value.map((entry) => assertNonEmpty(entry, "codexapp capability"));
  for (const required of CODEXAPP_REQUIRED_CAPABILITIES) {
    if (!capabilities.includes(required)) throw new Error(`codexapp missing capability: ${required}`);
  }
  return [...new Set(capabilities)];
}

const DELIVERY_NEXT = Object.freeze({
  accepted: "delivered",
  unknown_delivery: "delivered",
  delivered: "executed",
  executed: "replied",
  replied: "read",
});

function deliveryNextState(afterState) {
  if (afterState == null) return "delivered";
  const next = DELIVERY_NEXT[afterState];
  if (!next) {
    throw Object.assign(new Error(`codexapp bridge cannot reconcile after ${afterState}`), { code: "delivery_evidence_unavailable" });
  }
  return next;
}

// Bridge control methods and the hooks-facing port are different contracts.
// Keep this explicit mapping at the transport boundary.
export class CodexAppBridgePort {
  constructor({ socket, source, source_address: configuredSource, source_kind = "appserver", target_scopes = {}, timeout_ms = 10_000 }) {
    this.client = new UnixControlClient(expandHome(assertNonEmpty(socket, "codexapp.socket")), timeout_ms);
    this.source = normalizeBridgeAddress(source || configuredSource, "codexapp.source");
    if (!["service", "appserver"].includes(source_kind)) throw new Error("codexapp.source_kind must be service or appserver");
    this.sourceKind = source_kind;
    if (!target_scopes || typeof target_scopes !== "object" || Array.isArray(target_scopes)) {
      throw new Error("codexapp.target_scopes must be an object");
    }
    this.targetScopes = { ...target_scopes };
  }

  async capabilities() {
    const bridge = await this.client.call("capabilities");
    if (bridge?.protocol !== "codex-comm/v1") throw new Error("codexapp bridge protocol is unsupported");
    if (!bridge.query?.includes(BRIDGE_METHODS.session_status) || !bridge.execution?.includes(BRIDGE_METHODS.send_message_to_thread)) {
      throw new Error("codexapp bridge lacks the required session status/send control methods");
    }
    const advertised = ["session_status", "send_message_to_thread"];
    if (bridge.execution?.includes(BRIDGE_METHODS.steer_message)) advertised.push("steer_message");
    if (bridge.execution?.includes(BRIDGE_METHODS.create_subagent)) advertised.push("create_subagent");
    if (bridge.execution?.includes(BRIDGE_METHODS.interrupt_turn)) advertised.push("interrupt_turn");
    if (bridge.query?.includes(BRIDGE_METHODS.read_subagent_result)) advertised.push("read_subagent_result");
    if (!Array.isArray(bridge.namespaces)) throw new Error("codexapp bridge did not advertise namespaces");
    const status = await this.client.call("status");
    if (status?.protocol !== "codex-comm/v1" || status.bridge !== "up" || !Array.isArray(status.scopes)) {
      throw new Error("codexapp bridge did not provide live scope status");
    }
    if (this.sourceKind === "service") {
      assertSourceService(status.service_identities, this.source);
    } else {
      const sourceScope = findScope(status.scopes, this.source.scopeId);
      assertSourceScope(sourceScope, this.source);
    }
    for (const [key, scopeId] of Object.entries(this.targetScopes)) {
      const [namespace, appserverId] = key.split("/");
      if (!bridge.namespaces.includes(namespace)) throw new Error(`codexapp bridge does not support configured namespace: ${namespace}`);
      assertTargetScope(findScope(status.scopes, scopeId), { namespace, appserverId, scopeId });
    }
    return advertised;
  }

  async session_status(target) {
    const address = this.targetAddress(target);
    const result = await this.client.call(BRIDGE_METHODS.session_status, { address });
    assertSessionStatusBinding(result, target, address);
    return result.status;
  }

  async send_message({ target, body, attempt_id }) {
    const id = assertNonEmpty(attempt_id, "attempt_id");
    const to = this.targetAddress(target);
    const result = await this.client.call(BRIDGE_METHODS.send_message_to_thread, {
      from: this.source,
      to,
      body: assertNonEmpty(body, "body"),
      messageId: id,
      attemptId: id,
      requiresAck: false,
    });
    assertSendBinding(result, id, this.source, to);
    const state = result?.state === "delivered" ? "delivered" : result?.state === "accepted" ? "accepted" : null;
    if (!state) throw new Error("codexapp bridge returned no accepted send state");
    const delivered = result.evidence?.find((entry) => entry.state === "delivered");
    return {
      accepted: true,
      state,
      attempt_id: id,
      target_receipt: delivered?.targetReceipt || null,
      native_result: result,
    };
  }

  async steer_message({ target, body, attempt_id, turn_id }) {
    const id = assertNonEmpty(attempt_id, "attempt_id");
    const to = this.targetAddress(target);
    const result = await this.client.call(BRIDGE_METHODS.steer_message, {
      from: this.source,
      to,
      body: assertNonEmpty(body, "body"),
      messageId: id,
      attemptId: id,
      turnId: assertNonEmpty(turn_id, "turn_id"),
      requiresAck: false,
    });
    assertSendBinding(result, id, this.source, to);
    const state = result?.state === "delivered" ? "delivered" : result?.state === "accepted" ? "accepted" : null;
    if (!state) throw new Error("codexapp bridge returned no accepted steer state");
    const delivered = result.evidence?.find((entry) => entry.state === "delivered");
    return {
      accepted: true,
      state,
      attempt_id: id,
      target_receipt: delivered?.targetReceipt || null,
      native_result: result,
    };
  }

  async create_subagent({ target, prompt, attempt_id, cwd = null, profile = null, model = null, effort = null, ephemeral = false }) {
    const id = assertNonEmpty(attempt_id, "attempt_id");
    if (profile != null) {
      throw Object.assign(new Error("codexapp create_subagent does not support profile at the native App Server boundary"), {
        code: "unsupported_profile",
      });
    }
    const address = this.targetScopeAddress(target);
    const result = await this.client.call(BRIDGE_METHODS.create_subagent, {
      address,
      prompt: assertNonEmpty(prompt, "prompt"),
      attemptId: id,
      ...(cwd == null ? {} : { cwd: assertNonEmpty(cwd, "cwd") }),
      ...(model == null ? {} : { model: assertNonEmpty(model, "model") }),
      ...(effort == null ? {} : { effort: assertNonEmpty(effort, "effort") }),
      ...(ephemeral === true ? { ephemeral: true } : {}),
    });
    if (!result || result.attemptId !== id || result.namespace !== address.namespace || result.appserverId !== address.appserverId) {
      throw new Error("codexapp create_subagent receipt identity mismatch");
    }
    if (typeof result.threadId !== "string" || result.threadId.trim() === "" || typeof result.turnId !== "string" || result.turnId.trim() === "") {
      throw new Error("codexapp create_subagent receipt is incomplete");
    }
    return {
      accepted: true,
      state: "accepted",
      attempt_id: id,
      thread_id: result.threadId,
      turn_id: result.turnId,
      native_result: result,
    };
  }

  async interrupt_turn({ target, thread_id, turn_id }) {
    const address = this.targetAddress({ ...target, thread_id });
    const result = await this.client.call(BRIDGE_METHODS.interrupt_turn, {
      address,
      threadId: assertNonEmpty(thread_id, "thread_id"),
      turnId: assertNonEmpty(turn_id, "turn_id"),
    });
    if (result?.scopeId !== address.scopeId || result?.threadId !== thread_id || result?.turnId !== turn_id || result?.state !== "interrupted") {
      throw new Error("codexapp interrupt_turn receipt identity mismatch");
    }
    return result;
  }

  async read_subagent_result({ target, thread_id, turn_id }) {
    const address = this.targetAddress({ ...target, thread_id });
    const result = await this.client.call(BRIDGE_METHODS.read_subagent_result, {
      address,
      threadId: assertNonEmpty(thread_id, "thread_id"),
      turnId: assertNonEmpty(turn_id, "turn_id"),
    });
    if (result?.scopeId !== address.scopeId || result?.threadId !== thread_id || result?.turnId !== turn_id) {
      throw new Error("codexapp read_subagent_result identity mismatch");
    }
    if (!["working", "completed", "failed", "interrupted", "unknown"].includes(result.state)) {
      throw new Error("codexapp read_subagent_result returned an unsupported state");
    }
    return result;
  }

  async delivery_evidence({ target, attempt_id, after_state }) {
    const id = assertNonEmpty(attempt_id, "attempt_id");
    const address = this.targetAddress(target);
    const result = await this.client.call("message_status", { messageId: id, attemptId: id });
    assertMessageStatusBinding(result, id, id, address, this.source);
    const nextState = deliveryNextState(after_state);
    const evidence = Array.isArray(result?.evidence)
      ? result.evidence.find((entry) => entry?.state === nextState)
      : null;
    const base = {
      attempt_id: id,
      source: "codexapp.message_status",
      target: address,
    };
    if (nextState === "delivered") {
      if (!evidence?.targetReceipt) {
        throw Object.assign(new Error(`codexapp has no delivery receipt for ${id}`), { code: "delivery_unresolved" });
      }
      return { ...base, target_receipt: evidence.targetReceipt };
    }
    if (nextState === "executed") {
      if (!evidence?.executionItemId) {
        throw Object.assign(new Error(`codexapp has no execution evidence for ${id}`), { code: "delivery_unresolved" });
      }
      return { ...base, execution_item_id: evidence.executionItemId };
    }
    if (nextState === "replied") {
      if (!evidence?.responseTurnId && !evidence?.responseItemId) {
        throw Object.assign(new Error(`codexapp has no reply evidence for ${id}`), { code: "delivery_unresolved" });
      }
      return {
        ...base,
        response_turn_id: evidence.responseTurnId || null,
        response_item_id: evidence.responseItemId || null,
      };
    }
    if (nextState === "read") {
      if (!evidence?.cursor || !evidence?.readItemId) {
        throw Object.assign(new Error(`codexapp has no read evidence for ${id}`), { code: "delivery_unresolved" });
      }
      return { ...base, cursor: evidence.cursor, read_item_id: evidence.readItemId };
    }
    throw Object.assign(new Error(`codexapp bridge cannot reconcile after ${after_state}`), { code: "delivery_evidence_unavailable" });
  }

  close() {}

  targetAddress(target) {
    const address = this.resolveTargetScope(target);
    return {
      scopeId: address.scopeId,
      sessionId: assertNonEmpty(target.thread_id, "target.thread_id"),
    };
  }

  targetScopeAddress(target) {
    const address = this.resolveTargetScope(target);
    return {
      scopeId: address.scopeId,
      appserverId: assertNonEmpty(target.appserver_id, "target.appserver_id"),
      namespace: assertNonEmpty(target.namespace, "target.namespace"),
    };
  }

  resolveTargetScope(target) {
    if (!target || typeof target !== "object") throw new Error("codexapp target is required");
    const key = `${assertNonEmpty(target.namespace, "target.namespace")}/${assertNonEmpty(target.appserver_id, "target.appserver_id")}`;
    const scopeId = this.targetScopes[key];
    if (typeof scopeId !== "string" || scopeId.trim() === "") throw new Error(`no explicit codexapp scope mapping for ${key}`);
    if (target.scope_id != null && target.scope_id !== scopeId) throw new Error(`target scope mismatch for ${key}: expected ${scopeId}, received ${target.scope_id}`);
    return { scopeId };
  }
}

class UnixControlClient {
  constructor(socketPath, timeoutMs) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = "";
      let settled = false;
      let requestWritten = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        callback(value);
      };
      const timer = setTimeout(() => finish(reject, Object.assign(new Error(`codexapp control timeout: ${method}`), {
        code: "transport_timeout",
        uncertain: [BRIDGE_METHODS.send_message_to_thread, BRIDGE_METHODS.steer_message].includes(method),
      })), this.timeoutMs);
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        requestWritten = true;
        socket.write(`${JSON.stringify({ id: 1, method, params })}\n`);
      });
      socket.on("data", (chunk) => {
        buffer += chunk;
        const index = buffer.indexOf("\n");
        if (index < 0) return;
        try {
          const response = JSON.parse(buffer.slice(0, index));
          if (response.error) {
            const error = Object.assign(new Error(response.error.message), response.error);
            finish(reject, markUncertainSend(error, method, requestWritten));
          }
          else finish(resolve, response.result);
        } catch (error) {
          finish(reject, markUncertainSend(error, method, requestWritten));
        }
      });
      socket.on("error", (error) => finish(reject, markUncertainSend(error, method, requestWritten)));
    });
  }
}

function markUncertainSend(error, method, requestWritten) {
  if ([BRIDGE_METHODS.send_message_to_thread, BRIDGE_METHODS.steer_message].includes(method) && requestWritten && !DEFINITIVE_SEND_ERRORS.has(error.code)) {
    error.uncertain = true;
    error.code ||= "unknown_delivery";
  }
  return error;
}

function normalizeBridgeAddress(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return {
    scopeId: assertNonEmpty(value.scopeId, `${name}.scopeId`),
    sessionId: assertNonEmpty(value.sessionId, `${name}.sessionId`),
  };
}

function expandHome(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function findScope(scopes, scopeId) {
  return scopes.find((scope) => scope?.scopeId === scopeId);
}

function assertSourceScope(scope, source) {
  if (!scope) throw new Error(`codexapp source scope is not registered: ${source.scopeId}`);
  if (!scope.sessions?.some((session) => session.id === source.sessionId)) {
    throw new Error(`codexapp source session is not registered: ${source.scopeId}/${source.sessionId}`);
  }
  if (!scope.agents?.some((agent) => agent.sessionId === source.sessionId && agent.live === true)) {
    throw new Error(`codexapp source agent is not live: ${source.scopeId}/${source.sessionId}`);
  }
}

function assertSourceService(services, source) {
  const service = Array.isArray(services)
    ? services.find((entry) => entry?.scopeId === source.scopeId && entry?.sessionId === source.sessionId)
    : null;
  if (!service) throw new Error(`codexapp source service is not registered: ${source.scopeId}/${source.sessionId}`);
  if (service.kind !== "service" || service.live !== true) {
    throw new Error(`codexapp source service is not live: ${source.scopeId}/${source.sessionId}`);
  }
}

function assertTargetScope(scope, expected) {
  if (!scope) throw new Error(`codexapp target scope is not registered: ${expected.scopeId}`);
  if (scope.namespace !== expected.namespace || scope.appserverId !== expected.appserverId) {
    throw new Error(`codexapp target scope identity mismatch: ${expected.scopeId}`);
  }
  if (!scope.capabilities?.includes("send_message_to_thread")) {
    throw new Error(`codexapp target scope cannot send messages: ${expected.scopeId}`);
  }
}

function assertSessionStatusBinding(result, target, address) {
  if (!result?.status || result.scopeId !== address.scopeId || result.namespace !== target.namespace || result.appserverId !== target.appserver_id || result.address?.sessionId !== address.sessionId) {
    throw new Error("codexapp session status identity mismatch");
  }
}

function assertSendBinding(result, attemptId, source, target) {
  if (!result || result.messageId !== attemptId || result.attemptId !== attemptId || !sameAddress(result.from, source) || !sameAddress(result.to, target) || !sameAddress(result.routing?.requestedTo, target) || !sameAddress(result.routing?.routedTo, target)) {
    throw new Error("codexapp send receipt identity mismatch");
  }
}

function assertMessageStatusBinding(result, messageId, attemptId, target, source) {
  if (!result || result.messageId !== messageId || result.attemptId !== attemptId || !sameAddress(result.from, source) || !sameAddress(result.to, target) || !sameAddress(result.routing?.requestedTo, target) || !sameAddress(result.routing?.routedTo, target)) {
    throw new Error("codexapp message status identity mismatch");
  }
}

function sameAddress(left, right) {
  return left?.scopeId === right?.scopeId && left?.sessionId === right?.sessionId;
}
