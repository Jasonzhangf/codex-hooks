#!/usr/bin/env node

import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PROTOCOL = "codex-comm/v1";
const DEFAULT_SOCKET = join(homedir(), ".codex", "routecodex-hooks", "codexapp.sock");
const DEFAULT_TARGETS = join(homedir(), ".codex", "routecodex-hooks", "config", "codexapp-targets.json");
const SERVICE = Object.freeze({ scopeId: "local:hooks", sessionId: "hooksd", kind: "service", live: true });
const CAPABILITIES = Object.freeze({
  protocol: PROTOCOL,
  query: ["capabilities", "status", "list_threads", "session_status", "message_status"],
  execution: ["register_target", "unregister_target", "send"],
  namespaces: ["codex_app", "codex_tui"],
  routeRules: ["service_to_registered_target"],
});

const options = parseArgs(process.argv.slice(2));
const targets = new Map();
const messages = new Map();
const adapters = new Map();
const controlSockets = new Set();

for (const target of readTargets(options.targetsFile)) {
  targets.set(target.scope_id, normalizeTarget(target));
}

const server = net.createServer((socket) => {
  controlSockets.add(socket);
  socket.on("close", () => controlSockets.delete(socket));
  handleControlSocket(socket);
});
await listen(server, options.socket);
process.stdout.write(`${JSON.stringify({
  protocol: PROTOCOL,
  bridge: "up",
  ready: true,
  socket: options.socket,
  targets: [...targets.keys()],
})}\n`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await closeServer(server);
  for (const adapter of adapters.values()) adapter.close();
  adapters.clear();
  try {
    fs.unlinkSync(options.socket);
  } catch (error) {
    if (error.code !== "ENOENT") process.stderr.write(`${error.stack || error}\n`);
  }
}

process.once("SIGTERM", () => void shutdown().then(() => process.exit(0), (error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
}));
process.once("SIGINT", () => void shutdown().then(() => process.exit(0), (error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
}));

function handleControlSocket(socket) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      void respond(socket, line);
    }
  });
  socket.on("error", () => {});
}

async function respond(socket, line) {
  let request;
  try {
    request = JSON.parse(line);
    const result = await dispatch(request);
    socket.write(`${JSON.stringify({ id: request.id ?? null, result })}\n`);
  } catch (error) {
    socket.write(`${JSON.stringify({ id: request?.id ?? null, error: serializeError(error) })}\n`);
  }
}

async function dispatch(request) {
  const method = request?.method;
  const params = request?.params || {};
  switch (method) {
    case "capabilities": return capabilities();
    case "status": return status();
    case "register_target": return registerTarget(params);
    case "unregister_target": return unregisterTarget(params);
    case "list_threads": return listThreads(params.address);
    case "session_status": return sessionStatus(params.address);
    case "send": return sendMessage(params.message || params);
    case "message_status": return messageStatus(params.messageId);
    default: throw codedError(`unknown codexapp method: ${method}`, "method_not_found");
  }
}

function capabilities() {
  return { ...CAPABILITIES, identities: [SERVICE] };
}

function status() {
  return {
    protocol: PROTOCOL,
    bridge: "up",
    service_identities: [SERVICE],
    scopes: [...targets.values()].map(publicScope),
  };
}

function registerTarget(input) {
  const target = normalizeTarget(input);
  const existing = targets.get(target.scope_id);
  if (existing && JSON.stringify(existing) !== JSON.stringify(target)) {
    throw codedError(`target already registered with different identity: ${target.scope_id}`, "target_conflict");
  }
  targets.set(target.scope_id, target);
  persistTargets();
  return { target: publicScope(target), state: "registered" };
}

function unregisterTarget(input) {
  const scopeId = required(input.scope_id || input.scopeId, "scope_id");
  const removed = targets.delete(scopeId);
  persistTargets();
  return { scope_id: scopeId, state: removed ? "unregistered" : "absent" };
}

async function sessionStatus(address) {
  const { target, sessionId } = resolveTarget(address);
  const thread = await adapter(target).threadStatus(sessionId);
  return {
    address: { scopeId: target.scope_id, sessionId },
    scopeId: target.scope_id,
    appserverId: target.appserver_id,
    namespace: target.namespace,
    status: normalizeThreadStatus(thread.status),
  };
}

async function listThreads(address) {
  if (!address || typeof address !== "object") throw codedError("address is required", "invalid_request");
  const scopeId = required(address.scopeId || address.scope_id, "address.scopeId");
  const target = targets.get(scopeId);
  if (!target) throw codedError(`target scope not found: ${scopeId}`, "target_scope_not_found");
  const loaded = await adapter(target).loadedThreads();
  const threads = [];
  for (const threadId of loaded) {
    const thread = await adapter(target).threadStatus(threadId);
    threads.push({
      threadId,
      status: normalizeThreadStatus(thread.status),
    });
  }
  return {
    scopeId: target.scope_id,
    namespace: target.namespace,
    appserverId: target.appserver_id,
    threads,
  };
}

async function sendMessage(input) {
  const message = normalizeMessage(input);
  if (message.from.scopeId !== SERVICE.scopeId || message.from.sessionId !== SERVICE.sessionId) {
    throw codedError("send source is not the registered service identity", "sender_not_registered");
  }
  const { target, sessionId } = resolveTarget(message.to);
  if (messages.has(message.messageId)) throw codedError(`messageId is already in use: ${message.messageId}`, "message_conflict");
  const messageRecord = {
    protocol: PROTOCOL,
    messageId: message.messageId,
    attemptId: message.attemptId,
    from: { ...message.from },
    to: { ...message.to },
    body: message.body,
    state: "emitted",
    evidence: [],
    routing: {
      requestedTo: { ...message.to },
      routedTo: { scopeId: target.scope_id, sessionId },
    },
  };
  messages.set(message.messageId, messageRecord);
  try {
    const baseline = await adapter(target).thread(target, sessionId);
    messageRecord.baseline = {
      state: "read",
      items: itemIds(baseline.items),
      cursor: baseline.cursor,
    };
  } catch (error) {
    if (!isUnmaterializedBaselineError(error)) throw error;
    const status = await adapter(target).threadStatus(sessionId);
    messageRecord.baseline = {
      state: "empty",
      reason: error.message,
      status: normalizeThreadStatus(status.status),
    };
  }
  const native = await adapter(target).send(target, sessionId, message.body, message.messageId);
  messageRecord.nativeResult = native;
  messageRecord.state = "accepted";
  messageRecord.evidence.push({ state: "accepted", native });
  return publicMessage(messageRecord);
}

async function messageStatus(messageId) {
  const id = required(messageId, "messageId");
  const message = messages.get(id);
  if (!message) throw codedError(`message not found: ${id}`, "message_not_found");
  const { target, sessionId } = resolveTarget(message.to);
  const current = await adapter(target).thread(target, sessionId);
  const receipt = current.items.find((item) => item.clientId === id || item.clientUserMessageId === id);
  const reply = receipt && current.items.find((item) => isAgentMessage(item) && item.turnId === receipt.turnId);
  if (receipt && !message.evidence.some((entry) => entry.state === "delivered")) {
    message.evidence.push({ state: "delivered", targetReceipt: receipt });
    message.state = "delivered";
  }
  if (reply && receipt) {
    if (!message.evidence.some((entry) => entry.state === "executed")) {
      message.evidence.push({ state: "executed", executionItemId: reply.id });
    }
    if (!message.evidence.some((entry) => entry.state === "replied")) {
      message.evidence.push({ state: "replied", responseTurnId: reply.turnId || null, responseItemId: reply.id, response: reply });
    }
    if (!message.evidence.some((entry) => entry.state === "read")) {
      message.evidence.push({ state: "read", cursor: current.cursor, readItemId: reply.id });
    }
    message.state = "read";
  } else if (receipt) {
    message.state = "delivered";
  }
  return publicMessage(message);
}

function publicMessage(message) {
  return {
    protocol: message.protocol,
    messageId: message.messageId,
    attemptId: message.attemptId,
    from: message.from,
    to: message.to,
    routing: message.routing,
    state: message.state,
    nativeResult: message.nativeResult,
    evidence: message.evidence,
    baseline: message.baseline,
  };
}

function isUnmaterializedBaselineError(error) {
  return error?.code === "native_read_unsupported"
    && (error.message.includes("not materialized") || error.message.includes("before first user message"));
}

function publicScope(target) {
  return {
    scopeId: target.scope_id,
    appserverId: target.appserver_id,
    namespace: target.namespace,
    endpoint: target.endpoint,
    sessions: [],
    capabilities: ["session_status", "send_message_to_thread"],
  };
}

function resolveTarget(address) {
  if (!address || typeof address !== "object") throw codedError("address is required", "invalid_request");
  const scopeId = required(address.scopeId || address.scope_id, "address.scopeId");
  const sessionId = required(address.sessionId || address.thread_id, "address.sessionId");
  const target = targets.get(scopeId);
  if (!target) throw codedError(`target scope not found: ${scopeId}`, "target_scope_not_found");
  return { target, sessionId };
}

function normalizeTarget(input) {
  return {
    scope_id: required(input.scope_id || input.scopeId, "target.scope_id"),
    appserver_id: required(input.appserver_id || input.appserverId, "target.appserver_id"),
    namespace: required(input.namespace, "target.namespace"),
    endpoint: required(input.endpoint, "target.endpoint"),
  };
}

function normalizeMessage(input) {
  return {
    messageId: required(input.messageId, "message.messageId"),
    attemptId: required(input.attemptId, "message.attemptId"),
    from: normalizeAddress(input.from, "message.from"),
    to: normalizeAddress(input.to, "message.to"),
    body: required(input.body, "message.body"),
  };
}

function normalizeAddress(value, name) {
  return {
    scopeId: required(value?.scopeId || value?.scope_id, `${name}.scopeId`),
    sessionId: required(value?.sessionId || value?.session_id, `${name}.sessionId`),
  };
}

function adapter(target) {
  let current = adapters.get(target.scope_id);
  if (!current) {
    current = new NativeAppServer(target.endpoint);
    adapters.set(target.scope_id, current);
  }
  return current;
}

function normalizeThreadStatus(status) {
  const state = status?.type || status?.state || "unknown";
  const normalized = state === "notLoaded" ? "unknown" : state;
  return {
    state: ["idle", "active", "working", "starting", "stopping", "systemError", "disconnected", "failed", "unknown"].includes(normalized)
      ? (normalized === "active" ? "working" : normalized === "systemError" ? "failed" : normalized)
      : "unknown",
    input_active: false,
  };
}

class NativeAppServer {
  constructor(endpoint) {
    if (!endpoint.startsWith("unix://")) throw codedError(`target endpoint must use unix://: ${endpoint}`, "invalid_request");
    const socketPath = endpoint.slice("unix://".length);
    if (!socketPath) throw codedError("target endpoint must include a socket path", "invalid_request");
    this.socketPath = socketPath;
    this.rpc = new UnixWebSocketJsonRpc(socketPath);
    this.initialized = false;
  }

  async connect() {
    if (this.initialized) return;
    await this.rpc.call("initialize", {
      clientInfo: { name: "rccv3-codexapp", title: "RouteCodex Hooks CodexApp", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.initialized = true;
  }

  async thread(target, threadId) {
    await this.connect();
    const thread = await this.threadStatus(threadId);
    let page;
    try {
      page = await this.rpc.call("thread/items/list", { threadId, limit: 100, sortDirection: "desc" });
    } catch (itemsError) {
      try {
        page = await this.rpc.call("thread/turns/list", { threadId, limit: 100, sortDirection: "desc" });
      } catch (turnsError) {
        throw codedError(`thread history read is unsupported: items=${itemsError.message}; turns=${turnsError.message}`, "native_read_unsupported");
      }
    }
    return {
      thread,
      status: thread.status,
      items: normalizeItems(page),
      cursor: page?.backwardsCursor || page?.nextCursor || null,
    };
  }

  async threadStatus(threadId) {
    await this.connect();
    const result = await this.rpc.call("thread/read", { threadId });
    const thread = result?.thread;
    if (!thread || thread.id !== threadId) throw codedError(`thread/read identity mismatch for ${threadId}`, "native_transport_error");
    return thread;
  }

  async loadedThreads() {
    await this.connect();
    const result = await this.rpc.call("thread/loaded/list", {});
    if (!Array.isArray(result?.data) || result.data.some((threadId) => typeof threadId !== "string" || threadId === "")) {
      throw codedError("thread/loaded/list returned an invalid thread list", "native_transport_error");
    }
    return result.data;
  }

  async send(target, threadId, body, clientUserMessageId) {
    await this.connect();
    return this.rpc.call("thread/queue/add", {
      threadId,
      input: [{ type: "text", text: body }],
      clientUserMessageId,
    });
  }

  close() {
    this.rpc.close();
  }
}

class UnixWebSocketJsonRpc extends EventEmitter {
  constructor(socketPath) {
    super();
    this.socketPath = socketPath;
    this.buffer = Buffer.alloc(0);
    this.handshake = false;
    this.pending = new Map();
    this.nextId = 1;
    this.fragmented = null;
    this.on("error", () => {});
  }

  async connect() {
    if (this.socket) return;
    const socket = net.createConnection(this.socketPath);
    this.socket = socket;
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("app server websocket closed")));
    await new Promise((resolve, reject) => {
      const onConnect = () => {
        socket.off("error", onError);
        resolve();
      };
      const onError = (error) => {
        socket.off("connect", onConnect);
        reject(error);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
    const key = crypto.randomBytes(16).toString("base64");
    socket.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    await new Promise((resolve, reject) => {
      this.once("handshake", resolve);
      this.once("handshakeError", reject);
    });
  }

  async call(method, params = {}, timeoutMs = 30_000) {
    await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(codedError(`native RPC timeout: ${method}`, "native_transport_error"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.write(encodeFrame(JSON.stringify({ method, id, params })));
    });
  }

  close() {
    this.socket?.destroy();
    this.socket = undefined;
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.handshake) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const header = this.buffer.subarray(0, end).toString("utf8");
      this.buffer = this.buffer.subarray(end + 4);
      if (!/^HTTP\/1\.1 101 /m.test(header)) {
        this.emit("handshakeError", codedError(`websocket upgrade rejected: ${header}`, "native_transport_error"));
        return;
      }
      this.handshake = true;
      this.emit("handshake");
    }
    const parsed = parseFrames(this.buffer);
    this.buffer = parsed.remaining;
    for (const frame of parsed.frames) this.onFrame(frame);
  }

  onFrame(frame) {
    if (frame.opcode === 0x8) {
      this.socket?.end();
      return;
    }
    if (frame.opcode === 0x9) {
      this.socket?.write(encodeControlFrame(frame.payload));
      return;
    }
    if (frame.opcode === 0x0) {
      if (!this.fragmented) return;
      this.fragmented.payload = Buffer.concat([this.fragmented.payload, frame.payload]);
      if (!frame.fin) return;
      frame = this.fragmented;
      this.fragmented = null;
    } else if (frame.opcode === 0x1 && !frame.fin) {
      this.fragmented = { opcode: 0x1, payload: frame.payload };
      return;
    }
    if (frame.opcode !== 0x1) return;
    let message;
    try {
      message = JSON.parse(frame.payload.toString("utf8"));
    } catch (error) {
      this.emit("protocolError", error);
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(codedError(message.error.message || `native RPC error: ${pending.method}`, message.error.code || "native_transport_error", message.error.data));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("error", error);
  }
}

function encodeFrame(payload) {
  const body = Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(body.length);
  for (let index = 0; index < body.length; index += 1) masked[index] = body[index] ^ mask[index % 4];
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x81, 0x80 | body.length]);
  } else if (body.length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, mask, masked]);
}

function encodeControlFrame(payload) {
  return Buffer.concat([Buffer.from([0x8a, payload.length]), payload]);
}

function parseFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      const raw = buffer.readBigUInt64BE(offset + 2);
      if (raw > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("websocket frame too large");
      length = Number(raw);
      headerLength = 10;
    }
    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + length;
    if (buffer.length - offset < frameLength) break;
    let payloadStart = offset + headerLength;
    let mask;
    if (masked) {
      mask = buffer.subarray(payloadStart, payloadStart + 4);
      payloadStart += 4;
    }
    const payload = Buffer.from(buffer.subarray(payloadStart, payloadStart + length));
    if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    frames.push({ fin: (first & 0x80) !== 0, opcode, payload });
    offset += frameLength;
  }
  return { frames, remaining: buffer.subarray(offset) };
}

function normalizeItems(page) {
  const data = Array.isArray(page?.data) ? page.data : [];
  if (data.every((entry) => entry?.item)) {
    return data.map((entry) => ({ ...entry.item, turnId: entry.turnId }));
  }
  if (data.every((entry) => Array.isArray(entry?.items))) {
    return data.flatMap((turn) => turn.items.map((item) => ({ ...item, turnId: turn.id })));
  }
  return data;
}

function itemIds(items) {
  return items.map((item) => item.id).filter((id) => typeof id === "string" && id !== "");
}

function isAgentMessage(item) {
  return item?.type === "agentMessage" || item?.type === "assistantMessage";
}

function readTargets(path) {
  if (!path || !fs.existsSync(path)) return [];
  const value = JSON.parse(fs.readFileSync(path, "utf8"));
  if (!Array.isArray(value)) throw new Error(`targets file must contain an array: ${path}`);
  return value;
}

function persistTargets() {
  if (!options.targetsFile) return;
  fs.mkdirSync(dirname(options.targetsFile), { recursive: true });
  fs.writeFileSync(options.targetsFile, `${JSON.stringify([...targets.values()], null, 2)}\n`, "utf8");
}

function parseArgs(args) {
  const parsed = { socket: DEFAULT_SOCKET, targetsFile: DEFAULT_TARGETS };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--socket" || value === "--targets-file") {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${value} requires a value`);
      if (value === "--socket") parsed.socket = next;
      else parsed.targetsFile = next;
      index += 1;
    } else {
      throw new Error(`unsupported argument: ${value}`);
    }
  }
  return parsed;
}

async function listen(instance, socketPath) {
  fs.mkdirSync(dirname(socketPath), { recursive: true });
  try {
    fs.unlinkSync(socketPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await new Promise((resolve, reject) => {
    instance.once("error", reject);
    instance.listen(socketPath, () => {
      instance.off("error", reject);
      resolve();
    });
  });
}

function closeServer(instance) {
  return new Promise((resolve) => {
    instance.close(() => resolve());
    for (const socket of controlSockets) socket.destroy();
    controlSockets.clear();
  });
}

function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw codedError(`${name} must be a non-empty string`, "invalid_request");
  return value;
}

function codedError(message, code, data = null) {
  const error = new Error(message);
  error.code = code;
  if (data !== null) error.data = data;
  return error;
}

function serializeError(error) {
  return {
    code: error.code || "codexapp_error",
    message: error.message,
    data: error.data || null,
  };
}
