import assert from "node:assert/strict";
import net from "node:net";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexAppBridgePort } from "../src/codexapp-port.js";
import { HooksDaemon } from "../src/daemon.js";

test("hooksd accepts the internal codexapp service identity contract", async () => {
  const socketPath = join(tmpdir(), `codex-hooks-bridge-${process.pid}.sock`);
  const server = await startInternalBridgeFixture(socketPath);
  try {
    const codexapp = new CodexAppBridgePort({
      socket: socketPath,
      source: { scopeId: "local:hooks", sessionId: "hooksd" },
      source_kind: "service",
      target_scopes: { "codex_tui/tui-appserver": "local:tui" },
    });
    assert.deepEqual(await codexapp.capabilities(), ["session_status", "send_message_to_thread"]);
    const daemon = new HooksDaemon({ codexapp });
    const result = await daemon.handleHook({
      session_id: "hook-session",
      turn_id: "turn-1",
      hook_event_name: "Stop",
      cwd: "/workspace",
    }, {
      intent: {
        intent_id: "bridge-attempt-1",
        source: "operator",
        target: { namespace: "codex_tui", appserver_id: "tui-appserver", session_id: "hook-session", thread_id: "thread-1" },
        body: "bridge wake",
        send_mode: "working_allowed",
      },
    });
    assert.equal(result.decision, "sent");
    assert.equal(result.delivery.state, "delivered");
    assert.equal(result.delivery.evidence.target_receipt.clientId, "bridge-attempt-1");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(socketPath, { force: true });
  }
});

async function startInternalBridgeFixture(socketPath) {
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const request = JSON.parse(line);
        socket.write(`${JSON.stringify({ id: request.id, result: fixtureResponse(request.method, request.params || {}) })}\n`);
      }
    });
  });
  await new Promise((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
  return server;
}

function fixtureResponse(method, params) {
  if (method === "capabilities") return {
    protocol: "codex-comm/v1",
    execution: ["register_target", "send"],
    query: ["session_status", "message_status", "status", "capabilities"],
    namespaces: ["codex_app", "codex_tui"],
  };
  if (method === "status") return {
    protocol: "codex-comm/v1",
    bridge: "up",
    service_identities: [{ scopeId: "local:hooks", sessionId: "hooksd", kind: "service", live: true }],
    scopes: [{ scopeId: "local:tui", appserverId: "tui-appserver", namespace: "codex_tui", capabilities: ["session_status", "send_message_to_thread"] }],
  };
  if (method === "session_status") return {
    address: params.address,
    scopeId: "local:tui",
    appserverId: "tui-appserver",
    namespace: "codex_tui",
    status: { state: "idle", input_active: false },
  };
  if (method === "send") {
    const message = params.message || params;
    return {
      protocol: "codex-comm/v1",
      messageId: message.messageId,
      attemptId: message.attemptId,
      from: message.from,
      to: message.to,
      routing: { requestedTo: message.to, routedTo: message.to },
      state: "delivered",
      evidence: [{ state: "delivered", targetReceipt: { clientId: message.messageId } }],
    };
  }
  throw new Error(`fixture does not implement ${method}`);
}
