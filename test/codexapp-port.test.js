import assert from "node:assert/strict";
import net from "node:net";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexAppBridgePort } from "../src/codexapp-port.js";

test("CodexApp bridge port maps official capabilities and preserves target/attempt identity", async () => {
  const socketPath = join(tmpdir(), `codex-hooks-port-${process.pid}.sock`);
  const requests = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const request = JSON.parse(buffer.slice(0, index));
      requests.push(request);
      const result = request.method === "capabilities"
        ? { protocol: "codex-comm/v1", query: ["session_status"], execution: ["send"], namespaces: ["codex_tui"] }
        : request.method === "status"
          ? { protocol: "codex-comm/v1", bridge: "up", scopes: [
            { scopeId: "hooks", appserverId: "hooks-appserver", namespace: "codex_tui", sessions: [{ id: "hooksd" }], agents: [{ sessionId: "hooksd", live: true }], capabilities: ["send_message_to_thread"] },
            { scopeId: "local:tui", appserverId: "tui-appserver", namespace: "codex_tui", sessions: [{ id: "thread-1" }], agents: [], capabilities: ["send_message_to_thread"] },
          ] }
        : request.method === "session_status"
          ? { address: request.params.address, scopeId: "local:tui", appserverId: "tui-appserver", namespace: "codex_tui", status: { state: "idle" } }
          : request.method === "message_status"
            ? { messageId: request.params.messageId, attemptId: request.params.messageId, from: { scopeId: "hooks", sessionId: "hooksd" }, to: { scopeId: "local:tui", sessionId: "thread-1" }, routing: { requestedTo: { scopeId: "local:tui", sessionId: "thread-1" }, routedTo: { scopeId: "local:tui", sessionId: "thread-1" } }, evidence: [{ state: "delivered", targetReceipt: { clientId: request.params.messageId } }] }
          : { state: "accepted", messageId: request.params.messageId, attemptId: request.params.attemptId, from: request.params.from, to: request.params.to, routing: { requestedTo: request.params.to, routedTo: request.params.to } };
      socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    const port = new CodexAppBridgePort({
      socket: socketPath,
      source: { scopeId: "hooks", sessionId: "hooksd" },
      target_scopes: { "codex_tui/tui-appserver": "local:tui" },
    });
    assert.deepEqual(await port.capabilities(), ["session_status", "send_message_to_thread"]);
    assert.deepEqual(await port.session_status({
      namespace: "codex_tui",
      appserver_id: "tui-appserver",
      session_id: "hook-session",
      thread_id: "thread-1",
    }), { state: "idle" });
    const receipt = await port.send_message({
      target: { namespace: "codex_tui", appserver_id: "tui-appserver", session_id: "hook-session", thread_id: "thread-1" },
      body: "wake",
      attempt_id: "attempt-1",
    });
    assert.deepEqual(receipt, { accepted: true, state: "accepted", attempt_id: "attempt-1", target_receipt: null, native_result: { state: "accepted", messageId: "attempt-1", attemptId: "attempt-1", from: { scopeId: "hooks", sessionId: "hooksd" }, to: { scopeId: "local:tui", sessionId: "thread-1" }, routing: { requestedTo: { scopeId: "local:tui", sessionId: "thread-1" }, routedTo: { scopeId: "local:tui", sessionId: "thread-1" } } } });
    const statusRequest = requests.find((request) => request.method === "session_status");
    const sendRequest = requests.find((request) => request.method === "send");
    assert.deepEqual(statusRequest.params.address, { scopeId: "local:tui", sessionId: "thread-1" });
    assert.deepEqual(sendRequest.params.from, { scopeId: "hooks", sessionId: "hooksd" });
    assert.deepEqual(sendRequest.params.to, { scopeId: "local:tui", sessionId: "thread-1" });
    assert.equal(sendRequest.params.attemptId, "attempt-1");
    assert.deepEqual(await port.delivery_evidence({ target: { namespace: "codex_tui", appserver_id: "tui-appserver", thread_id: "thread-1" }, attempt_id: "attempt-1" }), {
      attempt_id: "attempt-1",
      target_receipt: { clientId: "attempt-1" },
      source: "codexapp.message_status",
      target: { scopeId: "local:tui", sessionId: "thread-1" },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(socketPath, { force: true });
  }
});

test("CodexApp bridge port returns native execution/reply/read evidence for daemon reconciliation", async () => {
  const socketPath = join(tmpdir(), `codex-hooks-port-evidence-${process.pid}.sock`);
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const request = JSON.parse(buffer.slice(0, index));
      const result = request.method === "message_status" ? {
        messageId: request.params.messageId,
        attemptId: request.params.messageId,
        from: { scopeId: "hooks", sessionId: "hooksd" },
        to: { scopeId: "local:tui", sessionId: "thread-1" },
        routing: { requestedTo: { scopeId: "local:tui", sessionId: "thread-1" }, routedTo: { scopeId: "local:tui", sessionId: "thread-1" } },
        evidence: [
          { state: "delivered", targetReceipt: { clientId: request.params.messageId } },
          { state: "executed", executionItemId: "item-agent-1" },
          { state: "replied", responseTurnId: "turn-1", responseItemId: "item-agent-1" },
          { state: "read", cursor: "cursor-1", readItemId: "item-agent-1" },
        ],
      } : { state: "accepted" };
      socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    const port = new CodexAppBridgePort({
      socket: socketPath,
      source: { scopeId: "hooks", sessionId: "hooksd" },
      target_scopes: { "codex_tui/tui-appserver": "local:tui" },
    });
    const target = { namespace: "codex_tui", appserver_id: "tui-appserver", session_id: "hook-session", thread_id: "thread-1" };
    assert.deepEqual(await port.delivery_evidence({ target, attempt_id: "attempt-1", after_state: "accepted" }), {
      attempt_id: "attempt-1",
      target_receipt: { clientId: "attempt-1" },
      source: "codexapp.message_status",
      target: { scopeId: "local:tui", sessionId: "thread-1" },
    });
    assert.deepEqual(await port.delivery_evidence({ target, attempt_id: "attempt-1", after_state: "delivered" }), {
      attempt_id: "attempt-1",
      execution_item_id: "item-agent-1",
      source: "codexapp.message_status",
      target: { scopeId: "local:tui", sessionId: "thread-1" },
    });
    assert.deepEqual(await port.delivery_evidence({ target, attempt_id: "attempt-1", after_state: "executed" }), {
      attempt_id: "attempt-1",
      response_turn_id: "turn-1",
      response_item_id: "item-agent-1",
      source: "codexapp.message_status",
      target: { scopeId: "local:tui", sessionId: "thread-1" },
    });
    assert.deepEqual(await port.delivery_evidence({ target, attempt_id: "attempt-1", after_state: "replied" }), {
      attempt_id: "attempt-1",
      cursor: "cursor-1",
      read_item_id: "item-agent-1",
      source: "codexapp.message_status",
      target: { scopeId: "local:tui", sessionId: "thread-1" },
    });
    await assert.rejects(
      () => port.delivery_evidence({ target, attempt_id: "attempt-1", after_state: "read" }),
      /cannot reconcile after read/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(socketPath, { force: true });
  }
});

test("CodexApp bridge port refuses an implicit target scope mapping", () => {
  assert.throws(
    () => new CodexAppBridgePort({ socket: "/tmp/codex-hooks-port.sock", source: { scopeId: "hooks", sessionId: "hooksd" }, target_scopes: {} }).targetAddress({ namespace: "codex_tui", appserver_id: "unknown", thread_id: "thread-1" }),
    /no explicit codexapp scope mapping/,
  );
});

test("CodexApp bridge port rejects a caller target scope that disagrees with the configured mapping", () => {
  const port = new CodexAppBridgePort({
    socket: "/tmp/codex-hooks-port.sock",
    source: { scopeId: "hooks", sessionId: "hooksd" },
    target_scopes: { "codex_tui/tui-appserver": "local:tui" },
  });
  assert.throws(
    () => port.targetAddress({ namespace: "codex_tui", appserver_id: "tui-appserver", thread_id: "thread-1", scope_id: "other:tui" }),
    /target scope mismatch.*local:tui.*other:tui/,
  );
});
