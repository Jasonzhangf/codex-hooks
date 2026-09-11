import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertNonEmpty } from "./protocol.js";

export const CODEXAPP_CAPABILITIES = Object.freeze([
  "session_status",
  "send_message_to_thread",
]);

const BRIDGE_METHODS = Object.freeze({
  session_status: "session_status",
  send_message_to_thread: "send",
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

export async function verifyCodexAppPort(port, required = CODEXAPP_CAPABILITIES) {
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
  for (const required of CODEXAPP_CAPABILITIES) {
    if (!capabilities.includes(required)) throw new Error(`codexapp missing capability: ${required}`);
  }
  return [...new Set(capabilities)];
}

// Bridge control methods and the hooks-facing port are different contracts.
// Keep this explicit mapping at the transport boundary.
export class CodexAppBridgePort {
  constructor({ socket, source, source_address: configuredSource, target_scopes = {}, timeout_ms = 10_000 }) {
    this.client = new UnixControlClient(expandHome(assertNonEmpty(socket, "codexapp.socket")), timeout_ms);
    this.source = normalizeBridgeAddress(source || configuredSource, "codexapp.source");
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
    if (!Array.isArray(bridge.namespaces)) throw new Error("codexapp bridge did not advertise namespaces");
    const status = await this.client.call("status");
    if (status?.protocol !== "codex-comm/v1" || status.bridge !== "up" || !Array.isArray(status.scopes)) {
      throw new Error("codexapp bridge did not provide live scope status");
    }
    const sourceScope = findScope(status.scopes, this.source.scopeId);
    assertSourceScope(sourceScope, this.source);
    for (const [key, scopeId] of Object.entries(this.targetScopes)) {
      const [namespace, appserverId] = key.split("/");
      if (!bridge.namespaces.includes(namespace)) throw new Error(`codexapp bridge does not support configured namespace: ${namespace}`);
      assertTargetScope(findScope(status.scopes, scopeId), { namespace, appserverId, scopeId });
    }
    return [...CODEXAPP_CAPABILITIES];
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

  async delivery_evidence({ target, attempt_id, after_state }) {
    const id = assertNonEmpty(attempt_id, "attempt_id");
    if (after_state && !["accepted", "unknown_delivery"].includes(after_state)) {
      throw Object.assign(new Error(`codexapp bridge cannot reconcile after ${after_state}`), { code: "delivery_evidence_unavailable" });
    }
    const address = this.targetAddress(target);
    const result = await this.client.call("message_status", { messageId: id });
    assertMessageStatusBinding(result, id, address, this.source);
    const delivered = result?.evidence?.find((entry) => entry.state === "delivered");
    if (!delivered?.targetReceipt) {
      throw Object.assign(new Error(`codexapp has no delivery receipt for ${id}`), { code: "delivery_unresolved" });
    }
    return {
      attempt_id: id,
      target_receipt: delivered.targetReceipt,
      source: "codexapp.message_status",
      target: address,
    };
  }

  close() {}

  targetAddress(target) {
    if (!target || typeof target !== "object") throw new Error("codexapp target is required");
    const key = `${assertNonEmpty(target.namespace, "target.namespace")}/${assertNonEmpty(target.appserver_id, "target.appserver_id")}`;
    const scopeId = this.targetScopes[key];
    if (typeof scopeId !== "string" || scopeId.trim() === "") throw new Error(`no explicit codexapp scope mapping for ${key}`);
    if (target.scope_id != null && target.scope_id !== scopeId) throw new Error(`target scope mismatch for ${key}: expected ${scopeId}, received ${target.scope_id}`);
    return {
      scopeId,
      sessionId: assertNonEmpty(target.thread_id, "target.thread_id"),
    };
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
      const timer = setTimeout(() => finish(reject, Object.assign(new Error(`codexapp control timeout: ${method}`), { code: "transport_timeout", uncertain: method === BRIDGE_METHODS.send_message_to_thread })), this.timeoutMs);
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
  if (method === BRIDGE_METHODS.send_message_to_thread && requestWritten && !DEFINITIVE_SEND_ERRORS.has(error.code)) {
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

function assertMessageStatusBinding(result, messageId, target, source) {
  if (!result || result.messageId !== messageId || result.attemptId !== messageId || !sameAddress(result.from, source) || !sameAddress(result.to, target) || !sameAddress(result.routing?.requestedTo, target) || !sameAddress(result.routing?.routedTo, target)) {
    throw new Error("codexapp message status identity mismatch");
  }
}

function sameAddress(left, right) {
  return left?.scopeId === right?.scopeId && left?.sessionId === right?.sessionId;
}
