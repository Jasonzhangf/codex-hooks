import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { CodexAppBridgePort } from "../src/codexapp-port.js";
import { FrameworkControlPlane } from "../src/control.js";
import { HooksDaemon, MemoryStateStore } from "../src/daemon.js";
import { ManualClock, TimerOperator } from "../src/timer.js";

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
      ["thread/read", { threadId: "thread-1" }],
      ["thread/read", { threadId: "thread-1" }],
      ["thread/items/list", { threadId: "thread-1", limit: 100, sortDirection: "desc" }],
    ]);
    assert.equal(calls.some(([method]) => method === "initialized"), false);
    assert.deepEqual(calls.find(([method]) => method === "thread/queue/add"), ["thread/queue/add", {
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
    assert.deepEqual((await control(controlSocket, "session_status", { address: { scopeId: "local:test", sessionId: "thread-1" } })).status, { state: "idle", input_active: false });
    await assert.rejects(
      control(controlSocket, "send", {
        message: {
          messageId: "message-1",
          attemptId: "message-1",
          from: { scopeId: "local:hooks", sessionId: "hooksd" },
          to: { scopeId: "local:test", sessionId: "thread-1" },
          body: "probe",
        },
      }),
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

test("internal codexapp reports an active writer during notLoaded resume as definitive", async () => {
  const root = await mkdtemp(join(tmpdir(), "routecodex-codexapp-writer-busy-"));
  const appserverSocket = join(root, "appserver.sock");
  const controlSocket = join(root, "codexapp.sock");
  const calls = [];
  const native = await startNativeFixture(appserverSocket, calls, {
    threadStatus: { type: "notLoaded" },
    threadResumeError: {
      code: -32600,
      message: "thread thread-1 already has an active writer",
    },
  });
  const codexapp = spawn(process.execPath, [
    "src/codexapp-entry.js",
    "--socket", controlSocket,
    "--targets-file", join(root, "targets.json"),
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  const port = new CodexAppBridgePort({
    socket: controlSocket,
    source: { scopeId: "local:hooks", sessionId: "hooksd" },
    source_kind: "service",
    target_scopes: { "codex_tui/test-appserver": "local:test" },
  });
  try {
    await readLine(codexapp.stdout);
    await control(controlSocket, "register_target", {
      scope_id: "local:test",
      appserver_id: "test-appserver",
      namespace: "codex_tui",
      endpoint: `unix://${appserverSocket}`,
    });
    await assert.rejects(
      port.send_message({
        target: {
          namespace: "codex_tui",
          appserver_id: "test-appserver",
          scope_id: "local:test",
          session_id: "thread-1",
          thread_id: "thread-1",
        },
        body: "probe",
        attempt_id: "writer-busy",
      }),
      (error) => error.code === "native_thread_busy" && error.uncertain !== true,
    );
    assert.equal(calls.some(([method]) => method === "thread/resume"), true);
    assert.equal(calls.some(([method]) => method === "thread/queue/add"), false);
    assert.equal(calls.some(([method]) => method === "thread/queue/start"), false);
    assert.equal(calls.some(([method]) => method === "turn/steer"), false);
  } finally {
    port.close();
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

test("internal codexapp allows an unmaterialized thread first send with explicit empty baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "routecodex-codexapp-empty-baseline-"));
  const appserverSocket = join(root, "appserver.sock");
  const controlSocket = join(root, "codexapp.sock");
  const calls = [];
  const native = await startNativeFixture(appserverSocket, calls, {
    threadExtras: { canAcceptDirectInput: true, turns: [] },
    itemsError: { code: -32601, message: "thread/items/list is not supported yet" },
    turnsError: { code: -32601, message: "thread thread-1 is not materialized yet; thread/turns/list is unavailable before first user message" },
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
    const status = await control(controlSocket, "session_status", {
      address: { scopeId: "local:test", sessionId: "thread-1" },
    });
    assert.deepEqual(status.status, { state: "idle", input_active: false });
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
    assert.deepEqual(sent.baseline, {
      state: "empty",
      reason: "thread history read is unsupported: items=thread/items/list is not supported yet; turns=thread thread-1 is not materialized yet; thread/turns/list is unavailable before first user message",
      status: { state: "idle", input_active: false },
    });
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
    const delivered = await control(controlSocket, "message_status", { messageId: "message-1", attemptId: "message-1" });
    assert.equal(delivered.state, "delivered");
    assert.equal(delivered.evidence.find((entry) => entry.state === "delivered").targetReceipt.clientId, "message-1");
    await assert.rejects(
      control(controlSocket, "message_status", { messageId: "message-1", attemptId: "other-attempt" }),
      (error) => error.code === "message_attempt_mismatch",
    );
    const replied = await control(controlSocket, "message_status", { messageId: "message-1", attemptId: "message-1" });
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

test("internal codexapp creates a native subagent through thread/start and turn/start", async () => {
  const root = await mkdtemp(join(tmpdir(), "routecodex-codexapp-subagent-"));
  const appserverSocket = join(root, "appserver.sock");
  const controlSocket = join(root, "codexapp.sock");
  const calls = [];
  const native = await startNativeFixture(appserverSocket, calls, {
    threadStartResult: { thread: { id: "thread-new", status: { type: "idle" } } },
    turnStartResult: { turn: { id: "turn-new", status: "inProgress" } },
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
    const result = await control(controlSocket, "create_subagent", {
      address: { scopeId: "local:test", appserverId: "test-appserver", namespace: "codex_tui" },
      attemptId: "timer:spawn:2026-09-16T12:00:00Z",
      prompt: "run task",
      cwd: "/tmp",
      model: "gpt-test",
      effort: "high",
      ephemeral: true,
    });
    assert.equal(result.threadId, "thread-new");
    assert.equal(result.turnId, "turn-new");
    assert.deepEqual(calls.filter(([method]) => method === "thread/start" || method === "turn/start"), [
      ["thread/start", { cwd: "/tmp", model: "gpt-test", ephemeral: true }],
      ["turn/start", {
        threadId: "thread-new",
        clientUserMessageId: "timer:spawn:2026-09-16T12:00:00Z",
        input: [{ type: "text", text: "run task", text_elements: [] }],
        model: "gpt-test",
        effort: "high",
      }],
    ]);
  } finally {
    codexapp.kill("SIGTERM");
    await once(codexapp, "exit");
    await new Promise((resolve) => native.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("internal codexapp reads an ephemeral subagent result from turn/completed without history calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "routecodex-codexapp-subagent-result-"));
  const appserverSocket = join(root, "appserver.sock");
  const controlSocket = join(root, "codexapp.sock");
  const calls = [];
  const native = await startNativeFixture(appserverSocket, calls, {
    threadStartResult: { thread: { id: "thread-new", status: { type: "active" }, ephemeral: true } },
    turnStartResult: { turn: { id: "turn-new", status: "inProgress" } },
    turnCompletedNotification: {
      threadId: "thread-new",
      turn: {
        id: "turn-new",
        items: [{ type: "agentMessage", id: "item-final", text: '{"gap":"missing verification"}' }],
        itemsView: "summary",
        status: "completed",
      },
    },
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
    await control(controlSocket, "create_subagent", {
      address: { scopeId: "local:test", appserverId: "test-appserver", namespace: "codex_tui" },
      attemptId: "subagent-result",
      prompt: "review the turn",
      ephemeral: true,
    });
    const result = await control(controlSocket, "read_subagent_result", {
      address: { scopeId: "local:test", sessionId: "thread-new" },
      threadId: "thread-new",
      turnId: "turn-new",
    });
    assert.equal(result.state, "completed");
    assert.equal(result.finalMessage, '{"gap":"missing verification"}');
    assert.equal(result.item.id, "item-final");
    assert.deepEqual(calls.filter(([method]) => method === "thread/turns/list"), []);
  } finally {
    codexapp.kill("SIGTERM");
    await once(codexapp, "exit");
    await new Promise((resolve) => native.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("internal codexapp reports an ephemeral subagent without an observed completion as unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "routecodex-codexapp-subagent-working-"));
  const appserverSocket = join(root, "appserver.sock");
  const controlSocket = join(root, "codexapp.sock");
  const calls = [];
  const native = await startNativeFixture(appserverSocket, calls, {
    threadStartResult: { thread: { id: "thread-new", status: { type: "idle" }, ephemeral: true } },
    turnStartResult: { turn: { id: "turn-new", status: "inProgress" } },
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
    await control(controlSocket, "create_subagent", {
      address: { scopeId: "local:test", appserverId: "test-appserver", namespace: "codex_tui" },
      attemptId: "subagent-working",
      prompt: "review the turn",
      ephemeral: true,
    });
    const result = await control(controlSocket, "read_subagent_result", {
      address: { scopeId: "local:test", sessionId: "thread-new" },
      threadId: "thread-new",
      turnId: "turn-new",
    });
    assert.equal(result.state, "unknown");
    assert.equal(result.finalMessage, null);
    assert.deepEqual(calls.filter(([method]) => method === "thread/turns/list"), []);
  } finally {
    codexapp.kill("SIGTERM");
    await once(codexapp, "exit");
    await new Promise((resolve) => native.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("internal codexapp rejects an unsupported subagent profile explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "routecodex-codexapp-profile-"));
  const appserverSocket = join(root, "appserver.sock");
  const controlSocket = join(root, "codexapp.sock");
  const native = await startNativeFixture(appserverSocket, []);
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
    await assert.rejects(
      control(controlSocket, "create_subagent", {
        address: { scopeId: "local:test", appserverId: "test-appserver", namespace: "codex_tui" },
        attemptId: "subagent-profile",
        prompt: "run task",
        profile: "review",
      }),
      /does not support profile/,
    );
  } finally {
    codexapp.kill("SIGTERM");
    await once(codexapp, "exit");
    await new Promise((resolve) => native.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("internal codexapp interrupts a native subagent thread", async () => {
  const root = await mkdtemp(join(tmpdir(), "routecodex-codexapp-subagent-stop-"));
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
    const interrupted = await control(controlSocket, "interrupt_turn", {
      address: { scopeId: "local:test", sessionId: "thread-child" },
      threadId: "thread-child",
      turnId: "turn-child",
    });
    assert.equal(interrupted.state, "interrupted");
    assert.deepEqual(calls.filter(([method]) => method === "turn/interrupt" || method === "thread/archive"), [
      ["turn/interrupt", { threadId: "thread-child", turnId: "turn-child" }],
    ]);
  } finally {
    codexapp.kill("SIGTERM");
    await once(codexapp, "exit");
    await new Promise((resolve) => native.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("internal codexapp keeps an ephemeral working status without unsupported active-turn lookup", async () => {
  const root = await mkdtemp(join(tmpdir(), "routecodex-codexapp-ephemeral-status-"));
  const appserverSocket = join(root, "appserver.sock");
  const controlSocket = join(root, "codexapp.sock");
  const calls = [];
  const native = await startNativeFixture(appserverSocket, calls, {
    threadStatus: { type: "working" },
    turnsError: { code: -32600, message: "ephemeral threads do not support thread/turns/list" },
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
    const status = await control(controlSocket, "session_status", {
      address: { scopeId: "local:test", sessionId: "thread-child" },
    });
    assert.deepEqual(status.status, { state: "working", input_active: false });
    assert.deepEqual(calls.filter(([method]) => method === "thread/turns/list"), [
      ["thread/turns/list", { threadId: "thread-child", limit: 100, sortDirection: "desc" }],
    ]);
  } finally {
    codexapp.kill("SIGTERM");
    await once(codexapp, "exit");
    await new Promise((resolve) => native.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("internal codexapp preserves active-turn transport failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "routecodex-codexapp-active-turn-error-"));
  const appserverSocket = join(root, "appserver.sock");
  const controlSocket = join(root, "codexapp.sock");
  const native = await startNativeFixture(appserverSocket, [], {
    threadStatus: { type: "working" },
    turnsError: { code: -32600, message: "transport closed" },
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
    await assert.rejects(
      control(controlSocket, "session_status", {
        address: { scopeId: "local:test", sessionId: "thread-child" },
      }),
      (error) => error.code === "native_transport_error" && error.message.includes("transport closed"),
    );
  } finally {
    codexapp.kill("SIGTERM");
    await once(codexapp, "exit");
    await new Promise((resolve) => native.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("internal codexapp steers a live turn through turn/steer", async () => {
  const root = await mkdtemp(join(tmpdir(), "routecodex-codexapp-steer-"));
  const appserverSocket = join(root, "appserver.sock");
  const controlSocket = join(root, "codexapp.sock");
  const calls = [];
  const native = await startNativeFixture(appserverSocket, calls, {
    threadStatus: { type: "active", activeFlags: [] },
    turns: [{ id: "turn-live", status: "inProgress", items: [] }],
    steerResult: { turnId: "turn-live" },
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
    const result = await control(controlSocket, "steer", {
      message: {
        messageId: "steer-1",
        attemptId: "steer-1",
        from: { scopeId: "local:hooks", sessionId: "hooksd" },
        to: { scopeId: "local:test", sessionId: "thread-1" },
        body: "adjust course",
        turnId: "turn-live",
      },
    });
    assert.equal(result.state, "accepted");
    assert.deepEqual(calls.at(-1), ["turn/steer", {
      threadId: "thread-1",
      expectedTurnId: "turn-live",
      input: [{ type: "text", text: "adjust course", text_elements: [] }],
      clientUserMessageId: "steer-1",
    }]);
  } finally {
    codexapp.kill("SIGTERM");
    await once(codexapp, "exit");
    await new Promise((resolve) => native.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("internal codexapp maps every native thread status through the control socket", async () => {
  for (const [nativeState, expectedState] of [
    ["idle", "idle"],
    ["active", "working"],
    ["running", "working"],
    ["interrupted", "interrupted"],
    ["cancelled", "interrupted"],
    ["starting", "starting"],
    ["stopping", "stopping"],
    ["systemError", "failed"],
    ["disconnected", "disconnected"],
    ["failed", "failed"],
    ["unknown", "unknown"],
    ["notLoaded", "idle"],
  ]) {
    const root = await mkdtemp(join(tmpdir(), `routecodex-codexapp-status-${nativeState}-`));
    const appserverSocket = join(root, "appserver.sock");
    const controlSocket = join(root, "codexapp.sock");
    const calls = [];
    const native = await startNativeFixture(appserverSocket, calls, {
      threadStatus: { type: nativeState },
      turns: [{ id: "turn-live", status: "inProgress", items: [] }],
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
      const status = await control(controlSocket, "session_status", {
        address: { scopeId: "local:test", sessionId: "thread-1" },
      });
      assert.deepEqual(status.status, {
        state: expectedState,
        input_active: false,
        ...(expectedState === "working" ? { active_turn_id: "turn-live" } : {}),
      });
      assert.equal(
        calls.some(([method]) => method === "thread/turns/list"),
        expectedState === "working",
      );
    } finally {
      codexapp.kill("SIGTERM");
      await once(codexapp, "exit");
      await new Promise((resolve) => native.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("internal codexapp treats active without a running turn as wake-eligible idle", async () => {
  const root = await mkdtemp(join(tmpdir(), "routecodex-codexapp-active-idle-"));
  const appserverSocket = join(root, "appserver.sock");
  const controlSocket = join(root, "codexapp.sock");
  const calls = [];
  let native;
  let codexapp;
  try {
    native = await startNativeFixture(appserverSocket, calls, {
      threadStatus: { type: "active", activeFlags: [] },
      turns: [],
    });
    codexapp = spawn(process.execPath, [
      "src/codexapp-entry.js",
      "--socket", controlSocket,
      "--targets-file", join(root, "targets.json"),
    ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    await readLine(codexapp.stdout);
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
    assert.deepEqual(calls.filter(([method]) => method === "thread/turns/list"), [
      ["thread/turns/list", { threadId: "thread-1", limit: 100, sortDirection: "desc" }],
    ]);
  } finally {
    if (codexapp) {
      codexapp.kill("SIGTERM");
      await once(codexapp, "exit");
    }
    if (native) await new Promise((resolve) => native.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("longhorizon liveness DAG applies every native status through the native bridge", async () => {
  for (const {
    label,
    threadStatus,
    turns = [{ id: "turn-live", status: "inProgress", items: [] }],
    queueListResult,
    expectedDecision,
    expectedScheduleState,
  } of [
    { label: "active", threadStatus: { type: "active", activeFlags: [] }, expectedDecision: "skipped", expectedScheduleState: "enabled" },
    { label: "active-no-turn", threadStatus: { type: "active", activeFlags: [] }, turns: [], queueListResult: { data: [{ id: "queued-1", clientUserMessageId: "message-1" }], nextCursor: null }, expectedDecision: "sent", expectedScheduleState: "enabled" },
    { label: "running", threadStatus: { type: "running" }, expectedDecision: "skipped", expectedScheduleState: "enabled" },
    { label: "idle", threadStatus: { type: "idle" }, expectedDecision: "sent", expectedScheduleState: "enabled" },
    { label: "interrupted", threadStatus: { type: "interrupted" }, expectedDecision: "sent", expectedScheduleState: "enabled" },
    { label: "cancelled", threadStatus: { type: "cancelled" }, expectedDecision: "sent", expectedScheduleState: "enabled" },
    { label: "starting", threadStatus: { type: "starting" }, expectedDecision: "deferred", expectedScheduleState: "deferred_while_working" },
    { label: "stopping", threadStatus: { type: "stopping" }, expectedDecision: "deferred", expectedScheduleState: "deferred_while_working" },
    { label: "systemError", threadStatus: { type: "systemError" }, expectedDecision: "fail_closed", expectedScheduleState: "enabled" },
    { label: "disconnected", threadStatus: { type: "disconnected" }, expectedDecision: "fail_closed", expectedScheduleState: "enabled" },
    { label: "failed", threadStatus: { type: "failed" }, expectedDecision: "fail_closed", expectedScheduleState: "enabled" },
    { label: "unknown", threadStatus: { type: "unknown" }, expectedDecision: "fail_closed", expectedScheduleState: "enabled" },
    { label: "notLoaded", threadStatus: { type: "notLoaded" }, expectedDecision: "sent", expectedScheduleState: "enabled" },
  ]) {
    const nativeState = threadStatus.type;
    const root = await mkdtemp(join(tmpdir(), `routecodex-longhorizon-dag-${label}-`));
    const appserverSocket = join(root, "appserver.sock");
    const controlSocket = join(root, "codexapp.sock");
    const calls = [];
    let native;
    let codexapp;
    try {
      native = await startNativeFixture(appserverSocket, calls, {
        threadStatus,
        turns,
        ...(queueListResult == null ? {} : { queueListResult }),
      });
      codexapp = spawn(process.execPath, [
        "src/codexapp-entry.js",
        "--socket", controlSocket,
        "--targets-file", join(root, "targets.json"),
      ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      await readLine(codexapp.stdout);
      await control(controlSocket, "register_target", {
        scope_id: "local:test",
        appserver_id: "test-appserver",
        namespace: "codex_tui",
        endpoint: `unix://${appserverSocket}`,
      });

      const store = new MemoryStateStore();
      const codexappPort = new CodexAppBridgePort({
        socket: controlSocket,
        source: { scopeId: "local:hooks", sessionId: "hooksd" },
        source_kind: "service",
        target_scopes: { "codex_tui/test-appserver": "local:test" },
      });
      const daemon = new HooksDaemon({ codexapp: codexappPort, store });
      const clock = new ManualClock("2026-09-18T12:00:00.000Z");
      const controlPlane = new FrameworkControlPlane({ store, now: () => clock.now() });
      const target = {
        namespace: "codex_tui",
        appserver_id: "test-appserver",
        scope_id: "local:test",
        session_id: "thread-1",
        thread_id: "thread-1",
      };
      controlPlane.mutate({ operation: "session.bind", alias: "goal-session", target });
      const registered = controlPlane.mutate({
        operation: "longhorizon.register",
        id: `goal-${label}`,
        mode: "goal",
        goal_file: "/tmp/goal.md",
        session: "goal-session",
      });
      const timer = new TimerOperator({
        store,
        clock,
        dispatch: (intent) => daemon.dispatchIntent(intent, { kind: "longhorizon" }),
        resume: (pendingTarget) => daemon.flushPending(pendingTarget),
        sessionStatus: (pendingTarget) => daemon.sessionStatus(pendingTarget),
      });

      clock.advance(60_000);
      const fired = await timer.tick();
      assert.equal(fired[0].result.decision, expectedDecision);
      assert.equal(
        store.getControl("schedules")[registered.liveness_schedule_id].state,
        expectedScheduleState,
      );
      assert.equal(calls.some(([method]) => method === "turn/steer"), false);
      if (expectedDecision === "sent") {
        const queued = calls.find(([method]) => method === "thread/queue/add");
        assert.ok(queued, "idle or interrupted target must receive a queue wake");
        assert.equal(queued[1].threadId, "thread-1");
        assert.equal(queued[1].input[0].text.includes("/tmp/goal.md"), true);
        assert.equal(queued[1].input[0].text.includes("continue executing the goal"), true);
        if (nativeState === "notLoaded") {
          assert.ok(
            calls.some(([method, params]) => method === "thread/resume" && params.threadId === "thread-1"),
            "notLoaded target must resume before the queued wake can execute",
          );
          assert.equal(calls.some(([method]) => method === "thread/queue/start"), false);
        } else if (["interrupted", "cancelled"].includes(nativeState) || label === "active-no-turn") {
          const started = calls.find(([method]) => method === "thread/queue/start");
          assert.ok(started, "wake-eligible thread must explicitly start the queued wake");
          assert.equal(started[1].threadId, "thread-1");
          assert.equal(started[1].queuedSubmissionId, "queued-1");
        } else {
          assert.equal(calls.some(([method]) => method === "thread/resume"), false);
          assert.equal(calls.some(([method]) => method === "thread/queue/start"), false);
        }
      } else {
        assert.equal(calls.some(([method]) => method === "thread/queue/add"), false);
      }
    } finally {
      if (codexapp) {
        codexapp.kill("SIGTERM");
        await once(codexapp, "exit");
      }
      if (native) await new Promise((resolve) => native.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
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
        let notification = null;
        if (request.method === "initialize") response = { result: { userAgent: "fixture" } };
        else if (request.method === "thread/read") response = { result: { thread: { id: request.params.threadId, status: options.threadStatus || { type: "idle" }, turns: options.turns || [], ...(options.threadExtras || {}) } } };
        else if (request.method === "thread/loaded/list") response = { result: { data: ["thread-1"], nextCursor: null } };
        else if (request.method === "thread/items/list") response = options.itemsError
          ? { error: options.itemsError }
          : { result: options.readPages?.[Math.min(readIndex++, options.readPages.length - 1)] || { data: [], nextCursor: null, backwardsCursor: null } };
        else if (request.method === "thread/turns/list") response = options.turnsError
          ? { error: options.turnsError }
          : { result: { data: options.turns || [], nextCursor: null } };
        else if (request.method === "thread/queue/add") response = {
          result: options.queueResult || {
            queuedSubmission: {
              id: "queued-1",
              clientUserMessageId: request.params.clientUserMessageId,
            },
          },
        };
        else if (request.method === "thread/resume") response = options.threadResumeError
          ? { error: options.threadResumeError }
          : {
            result: options.threadResumeResult || {
              thread: { id: request.params.threadId, status: { type: "idle" } },
            },
          };
        else if (request.method === "thread/queue/list") response = {
          result: options.queueListResult || (
            ["interrupted", "cancelled"].includes(options.threadStatus?.type)
              ? {
                data: [{
                  id: "queued-1",
                  clientUserMessageId: "message-1",
                }],
                nextCursor: null,
              }
              : { data: [], nextCursor: null }
          ),
        };
        else if (request.method === "thread/queue/start") response = {
          result: options.queueStartResult || {
            turn: { id: "turn-queued", status: "inProgress" },
          },
        };
        else if (request.method === "thread/start") response = { result: options.threadStartResult || { thread: { id: "thread-new", status: { type: "idle" } } } };
        else if (request.method === "turn/start") {
          response = { result: options.turnStartResult || { turn: { id: "turn-new", status: "inProgress" } } };
          if (options.turnCompletedNotification) {
            notification = {
              method: "turn/completed",
              params: options.turnCompletedNotification,
            };
          }
        }
        else if (request.method === "turn/steer") response = { result: options.steerResult || { turnId: request.params.expectedTurnId } };
        else if (request.method === "turn/interrupt") response = { result: {} };
        else if (request.method === "thread/archive") response = { result: {} };
        else response = { error: { code: -32601, message: `unsupported ${request.method}` } };
        socket.write(encodeFrame(JSON.stringify({ id: request.id, ...response })));
        if (notification) socket.write(encodeFrame(JSON.stringify(notification)));
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
