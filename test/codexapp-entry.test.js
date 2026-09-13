import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

test("internal codexapp initializes the native App Server before target reads and sends", async () => {
  const root = await mkdtemp(join(tmpdir(), "routecodex-codexapp-entry-"));
  const appserverSocket = join(root, "appserver.sock");
  const controlSocket = join(root, "codexapp.sock");
  const targetsFile = join(root, "targets.json");
  const calls = [];
  const native = await startNativeFixture(appserverSocket, calls);
  const codexapp = spawn(process.execPath, [
    "src/codexapp-entry.js",
    "--socket", controlSocket,
    "--targets-file", targetsFile,
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  try {
    const ready = JSON.parse(await readLine(codexapp.stdout));
    assert.equal(ready.ready, true);
    assert.equal(ready.bridge, "up");
    await control(controlSocket, "register_target", {
      scope_id: "local:test",
      appserver_id: "test-appserver",
      namespace: "codex_tui",
      endpoint: `unix://${appserverSocket}`,
    });
    const status = await control(controlSocket, "session_status", {
      address: { scopeId: "local:test", sessionId: "thread-1" },
    });
    assert.deepEqual(status.status, { state: "idle", input_active: false });
    const sent = await control(controlSocket, "send", {
      message: {
        messageId: "message-1",
        attemptId: "attempt-1",
        from: { scopeId: "local:hooks", sessionId: "hooksd" },
        to: { scopeId: "local:test", sessionId: "thread-1" },
        body: "probe",
      },
    });
    assert.equal(sent.state, "accepted");
    assert.equal(calls[0][0], "initialize");
    assert.deepEqual(calls[0][1], {
      clientInfo: { name: "rccv3-codexapp", title: "RouteCodex Hooks CodexApp", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    assert.deepEqual(calls.slice(1, 4), [
      ["initialized"],
      ["thread/read", { threadId: "thread-1" }],
      ["thread/items/list", { threadId: "thread-1", limit: 100, sortDirection: "desc" }],
    ]);
    assert.deepEqual(calls.at(-1), ["thread/queue/add", {
      threadId: "thread-1",
      input: [{ type: "text", text: "probe" }],
      clientUserMessageId: "message-1",
    }]);
    assert.deepEqual(JSON.parse(await readFile(targetsFile, "utf8")), [{
      scope_id: "local:test",
      appserver_id: "test-appserver",
      namespace: "codex_tui",
      endpoint: `unix://${appserverSocket}`,
    }]);
  } finally {
    codexapp.kill("SIGTERM");
    await once(codexapp, "exit");
    await new Promise((resolve) => native.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("internal codexapp preserves the first unsupported history read error", async () => {
  const root = await mkdtemp(join(tmpdir(), "routecodex-codexapp-read-error-"));
  const appserverSocket = join(root, "appserver.sock");
  const controlSocket = join(root, "codexapp.sock");
  const native = await startNativeFixture(appserverSocket, [], {
    itemsError: { code: -32601, message: "thread/items/list unsupported" },
    turnsError: { code: -32601, message: "thread/turns/list unsupported" },
  });
  const codexapp = spawn(process.execPath, [
    "src/codexapp-entry.js",
    "--socket", controlSocket,
    "--targets-file", join(root, "targets.json"),
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  try {
    await readLine(codexapp.stdout);
    await control(controlSocket, "register_target", {
      scope_id: "local:test",
      appserver_id: "test-appserver",
      namespace: "codex_app",
      endpoint: `unix://${appserverSocket}`,
    });
    await assert.rejects(
      control(controlSocket, "session_status", { address: { scopeId: "local:test", sessionId: "thread-1" } }),
      (error) => error.code === "native_read_unsupported"
        && error.message.includes("thread/items/list unsupported")
        && error.message.includes("thread/turns/list unsupported"),
    );
  } finally {
    codexapp.kill("SIGTERM");
    await once(codexapp, "exit");
    await new Promise((resolve) => native.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("internal codexapp discovers loaded threads without calling thread/list", async () => {
  const root = await mkdtemp(join(tmpdir(), "routecodex-codexapp-discover-"));
  const appserverSocket = join(root, "appserver.sock");
  const controlSocket = join(root, "codexapp.sock");
  const calls = [];
  const native = await startNativeFixture(appserverSocket, calls);
  const codexapp = spawn(process.execPath, [
    "src/codexapp-entry.js",
    "--socket", controlSocket,
    "--targets-file", join(root, "targets.json"),
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  try {
    await readLine(codexapp.stdout);
    await control(controlSocket, "register_target", {
      scope_id: "local:test",
      appserver_id: "test-appserver",
      namespace: "codex_tui",
      endpoint: `unix://${appserverSocket}`,
    });
    assert.deepEqual(await control(controlSocket, "list_threads", {
      address: { scopeId: "local:test" },
    }), {
      scopeId: "local:test",
      namespace: "codex_tui",
      appserverId: "test-appserver",
      threads: [{ threadId: "thread-1", status: { state: "idle", input_active: false } }],
    });
    assert.deepEqual(calls.filter(([method]) => method === "thread/list"), []);
    assert.deepEqual(calls.find(([method]) => method === "thread/loaded/list"), ["thread/loaded/list", {}]);
  } finally {
    codexapp.kill("SIGTERM");
    await once(codexapp, "exit");
    await new Promise((resolve) => native.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("internal codexapp advances a message through receipt, reply, and read evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "routecodex-codexapp-evidence-"));
  const appserverSocket = join(root, "appserver.sock");
  const controlSocket = join(root, "codexapp.sock");
  const calls = [];
  const native = await startNativeFixture(appserverSocket, calls, {
    queueResult: {
      queuedSubmission: {
        id: "queued-1",
        clientUserMessageId: "message-1",
      },
    },
    readPages: [
      { data: [], nextCursor: null, backwardsCursor: "cursor-0" },
      {
        data: [{
          turnId: "turn-1",
          item: {
            type: "userMessage",
            id: "item-user-1",
            clientId: "message-1",
            content: [{ type: "text", text: "probe" }],
          },
        }],
        nextCursor: null,
        backwardsCursor: "cursor-1",
      },
      {
        data: [{
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "item-agent-1",
            text: "ACK-message-1",
            phase: "final_answer",
          },
        }, {
          turnId: "turn-1",
          item: {
            type: "userMessage",
            id: "item-user-1",
            clientId: "message-1",
            content: [{ type: "text", text: "probe" }],
          },
        }],
        nextCursor: null,
        backwardsCursor: "cursor-2",
      },
    ],
  });
  const codexapp = spawn(process.execPath, [
    "src/codexapp-entry.js",
    "--socket", controlSocket,
    "--targets-file", join(root, "targets.json"),
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  try {
    await readLine(codexapp.stdout);
    await control(controlSocket, "register_target", {
      scope_id: "local:test",
      appserver_id: "test-appserver",
      namespace: "codex_tui",
      endpoint: `unix://${appserverSocket}`,
    });
    const sent = await control(controlSocket, "send", {
      message: {
        messageId: "message-1",
        attemptId: "message-1",
        from: { scopeId: "local:hooks", sessionId: "hooksd" },
        to: { scopeId: "local:test", sessionId: "thread-1" },
        body: "probe",
      },
    });
    assert.equal(sent.state, "accepted");
    const delivered = await control(controlSocket, "message_status", { messageId: "message-1" });
    assert.equal(delivered.state, "delivered");
    assert.equal(delivered.evidence.find((entry) => entry.state === "delivered").targetReceipt.clientId, "message-1");
    const replied = await control(controlSocket, "message_status", { messageId: "message-1" });
    assert.equal(replied.state, "read");
    assert.equal(replied.evidence.find((entry) => entry.state === "executed").executionItemId, "item-agent-1");
    assert.equal(replied.evidence.find((entry) => entry.state === "replied").responseTurnId, "turn-1");
    assert.equal(replied.evidence.find((entry) => entry.state === "read").cursor, "cursor-2");
  } finally {
    codexapp.kill("SIGTERM");
    await once(codexapp, "exit");
    await new Promise((resolve) => native.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

async function control(socketPath, method, params = {}) {
  const response = await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: 1, method, params })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.end();
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
    socket.on("error", reject);
  });
  if (response.error) {
    const error = new Error(response.error.message);
    error.code = response.error.code;
    throw error;
  }
  return response.result;
}

async function startNativeFixture(socketPath, calls, options = {}) {
  let readIndex = 0;
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        buffer = buffer.subarray(end + 4);
        upgraded = true;
        socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fixture\r\n\r\n");
      }
      const parsed = parseFrames(buffer);
      buffer = parsed.remaining;
      for (const frame of parsed.frames) {
        const request = JSON.parse(frame.payload.toString("utf8"));
        if (request.method === "initialized") {
          calls.push(["initialized"]);
          continue;
        }
        calls.push([request.method, request.params]);
        let response;
        if (request.method === "initialize") response = { result: { userAgent: "fixture" } };
        else if (request.method === "thread/read") response = { result: { thread: { id: request.params.threadId, status: { type: "idle" }, turns: [] } } };
        else if (request.method === "thread/loaded/list") response = { result: { data: ["thread-1"], nextCursor: null } };
        else if (request.method === "thread/items/list") response = options.itemsError
          ? { error: options.itemsError }
          : { result: options.readPages?.[Math.min(readIndex++, options.readPages.length - 1)] || { data: [], nextCursor: null, backwardsCursor: null } };
        else if (request.method === "thread/turns/list") response = options.turnsError
          ? { error: options.turnsError }
          : { result: { data: [], nextCursor: null } };
        else if (request.method === "thread/queue/add") response = { result: options.queueResult || { accepted: true } };
        else response = { error: { code: -32601, message: `unsupported ${request.method}` } };
        socket.write(encodeFrame(JSON.stringify({ id: request.id, ...response })));
      }
    });
  });
  await new Promise((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
  return server;
}

function encodeFrame(payload) {
  const body = Buffer.from(payload);
  const header = body.length < 126
    ? Buffer.from([0x81, body.length])
    : (() => {
      const value = Buffer.alloc(4);
      value[0] = 0x81;
      value[1] = 126;
      value.writeUInt16BE(body.length, 2);
      return value;
    })();
  return Buffer.concat([header, body]);
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
    frames.push({ opcode, payload });
    offset += frameLength;
  }
  return { frames, remaining: buffer.subarray(offset) };
}

function readLine(stream) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      stream.off("data", onData);
      resolve(buffer.slice(0, newline));
    };
    stream.on("data", onData);
    stream.once("error", reject);
  });
}
