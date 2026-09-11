import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CommunicationBridge, BridgeServer } from "/Users/fanzhang/github/codexapp/src/bridge.js";
import { MockAppServerAdapter } from "/Users/fanzhang/github/codexapp/src/mock-adapter.js";
import { CodexAppBridgePort } from "../src/codexapp-port.js";
import { HooksDaemon } from "../src/daemon.js";

test("hooksd closes the real codexapp bridge control loop with explicit identity mapping", async () => {
  const socketPath = join(tmpdir(), `codex-hooks-bridge-${process.pid}.sock`);
  const bridge = new CommunicationBridge({
    adapterFactory: (config) => new MockAppServerAdapter({
      appserverId: config.appserverId,
      namespace: config.namespace,
      sessions: config.sessionIds.map((id) => ({ id })),
    }),
  });
  const server = new BridgeServer(bridge, socketPath);
  await server.listen();
  try {
    await bridge.registerScope({ scopeId: "local:hooks", appserverId: "hooks-appserver", namespace: "codex_tui", endpoint: "mock://hooks", sessionIds: ["hooksd"] });
    await bridge.registerScope({ scopeId: "local:tui", appserverId: "tui-appserver", namespace: "codex_tui", endpoint: "mock://tui", sessionIds: ["thread-1"] });
    await bridge.registerAgent({ scopeId: "local:hooks", sessionId: "hooksd", agentId: "hooksd", role: "master" });
    await bridge.registerAgent({ scopeId: "local:tui", sessionId: "thread-1", agentId: "tui-master", role: "master" });

    const codexapp = new CodexAppBridgePort({
      socket: socketPath,
      source: { scopeId: "local:hooks", sessionId: "hooksd" },
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
    await bridge.unregisterScope("local:tui").catch(() => {});
    await bridge.unregisterScope("local:hooks").catch(() => {});
    await new Promise((resolve) => server.close().then(resolve));
    await rm(socketPath, { force: true });
  }
});
