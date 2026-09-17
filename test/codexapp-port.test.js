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

test("CodexApp bridge port creates a subagent through the typed bridge capability", async () => {
  const socketPath = join(tmpdir(), `codex-hooks-port-subagent-${process.pid}.sock`);
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
        ? { protocol: "codex-comm/v1", query: ["session_status"], execution: ["send", "create_subagent"], namespaces: ["codex_tui"] }
        : request.method === "status"
          ? { protocol: "codex-comm/v1", bridge: "up", service_identities: [{ scopeId: "hooks", sessionId: "hooksd", kind: "service", live: true }], scopes: [{ scopeId: "local:tui", appserverId: "tui-appserver", namespace: "codex_tui", capabilities: ["send_message_to_thread", "create_subagent"] }] }
          : {
            protocol: "codex-comm/v1",
            attemptId: request.params.attemptId,
            scopeId: "local:tui",
            appserverId: "tui-appserver",
            namespace: "codex_tui",
            threadId: "thread-new",
            turnId: "turn-new",
          };
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
      source_kind: "service",
      target_scopes: { "codex_tui/tui-appserver": "local:tui" },
    });
    assert.deepEqual(await port.capabilities(), ["session_status", "send_message_to_thread", "create_subagent"]);
    const receipt = await port.create_subagent({
      target: { namespace: "codex_tui", appserver_id: "tui-appserver", scope_id: "local:tui" },
      prompt: "run task",
      attempt_id: "timer:spawn:2026-09-16T12:00:00Z",
      cwd: "/tmp",
    });
    assert.equal(receipt.thread_id, "thread-new");
    assert.equal(receipt.turn_id, "turn-new");
    assert.deepEqual(requests.find((request) => request.method === "create_subagent").params, {
      address: { scopeId: "local:tui", appserverId: "tui-appserver", namespace: "codex_tui" },
      prompt: "run task",
      attemptId: "timer:spawn:2026-09-16T12:00:00Z",
      cwd: "/tmp",
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(socketPath, { force: true });
  }
});

test("CodexApp bridge port resolves subagent scope from configured mapping and rejects mismatches", async () => {
  const socketPath = join(tmpdir(), `codex-hooks-port-subagent-scope-${process.pid}.sock`);
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const request = JSON.parse(buffer.slice(0, index));
      const result = {
        protocol: "codex-comm/v1",
        attemptId: request.params.attemptId,
        scopeId: request.params.address.scopeId,
        appserverId: request.params.address.appserverId,
        namespace: request.params.address.namespace,
        threadId: "thread-new",
        turnId: "turn-new",
      };
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
    const receipt = await port.create_subagent({
      target: { namespace: "codex_tui", appserver_id: "tui-appserver" },
      prompt: "run task",
      attempt_id: "attempt-1",
    });
    assert.equal(receipt.thread_id, "thread-new");
    await assert.rejects(
      () => port.create_subagent({
        target: { namespace: "codex_tui", appserver_id: "tui-appserver", scope_id: "other:tui" },
        prompt: "run task",
        attempt_id: "attempt-2",
      }),
      /target scope mismatch/,
    );
    await assert.rejects(
      () => port.create_subagent({
        target: { namespace: "codex_tui", appserver_id: "missing-appserver" },
        prompt: "run task",
        attempt_id: "attempt-3",
      }),
      /no explicit codexapp scope mapping/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(socketPath, { force: true });
  }
});

test("CodexApp bridge port interrupts and archives a subagent through typed capabilities", async () => {
  const socketPath = join(tmpdir(), `codex-hooks-port-close-${process.pid}.sock`);
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
      let result;
      if (request.method === "capabilities") {
        result = { protocol: "codex-comm/v1", query: ["session_status"], execution: ["send", "interrupt_turn", "archive_thread"], namespaces: ["codex_tui"] };
      } else if (request.method === "status") {
        result = { protocol: "codex-comm/v1", bridge: "up", service_identities: [{ scopeId: "hooks", sessionId: "hooksd", kind: "service", live: true }], scopes: [{ scopeId: "local:tui", appserverId: "tui-appserver", namespace: "codex_tui", capabilities: ["send_message_to_thread", "interrupt_turn", "archive_thread"] }] };
      } else if (request.method === "interrupt_turn") {
        result = { protocol: "codex-comm/v1", scopeId: "local:tui", appserverId: "tui-appserver", namespace: "codex_tui", threadId: request.params.threadId, turnId: request.params.turnId, state: "interrupted" };
      } else if (request.method === "archive_thread") {
        result = { protocol: "codex-comm/v1", scopeId: "local:tui", appserverId: "tui-appserver", namespace: "codex_tui", threadId: request.params.threadId, state: "archived" };
      } else {
        result = { state: "accepted" };
      }
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
      source_kind: "service",
      target_scopes: { "codex_tui/tui-appserver": "local:tui" },
    });
    assert.deepEqual(await port.capabilities(), ["session_status", "send_message_to_thread", "interrupt_turn", "archive_thread"]);
    const target = { namespace: "codex_tui", appserver_id: "tui-appserver", scope_id: "local:tui" };
    assert.equal((await port.interrupt_turn({ target, thread_id: "thread-child", turn_id: "turn-child" })).state, "interrupted");
    assert.equal((await port.archive_thread({ target, thread_id: "thread-child" })).state, "archived");
    assert.deepEqual(requests.find((request) => request.method === "interrupt_turn").params, {
      address: { scopeId: "local:tui", sessionId: "thread-child" },
      threadId: "thread-child",
      turnId: "turn-child",
    });
    assert.deepEqual(requests.find((request) => request.method === "archive_thread").params, {
      address: { scopeId: "local:tui", sessionId: "thread-child" },
      threadId: "thread-child",
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(socketPath, { force: true });
  }
});
