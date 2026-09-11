import assert from "node:assert/strict";
import test from "node:test";
import { validateDaemonConfig } from "../src/config.js";

const valid = {
  runtime: { host: "127.0.0.1", port: 8787, state_directory: "/tmp/hooks-state" },
  codexapp: {
    socket: "/tmp/codexapp.sock",
    required_capabilities: ["session_status", "send_message_to_thread"],
    source_address: { scopeId: "hooks", sessionId: "hooksd" },
    target_scopes: { "codex_tui/tui-appserver": "local:tui" },
  },
  policies: [{ name: "timer", enabled: false, config: {} }],
};

test("daemon config is strict and returns a detached validated value", () => {
  const result = validateDaemonConfig(valid);
  assert.deepEqual(result, valid);
  assert.notEqual(result, valid);
  assert.throws(() => validateDaemonConfig({ ...valid, extra: true }), /unsupported field: extra/);
  assert.throws(() => validateDaemonConfig({ ...valid, policies: [{ ...valid.policies[0], enabled: "yes" }] }), /must be boolean/);
  assert.throws(() => validateDaemonConfig({ ...valid, policies: [valid.policies[0], valid.policies[0]] }), /duplicate policy name/);
});

test("daemon config rejects malformed required sections", () => {
  assert.throws(() => validateDaemonConfig({}), /runtime is required/);
  assert.throws(() => validateDaemonConfig({ ...valid, codexapp: { ...valid.codexapp, required_capabilities: [] } }), /non-empty array/);
  assert.throws(() => validateDaemonConfig({ ...valid, runtime: { ...valid.runtime, host: "" } }), /runtime.host/);
  assert.throws(() => validateDaemonConfig({ ...valid, runtime: { ...valid.runtime, port: 65536 } }), /runtime.port/);
});

test("daemon config rejects non-loopback control binding", () => {
  assert.throws(() => validateDaemonConfig({
    runtime: { host: "0.0.0.0", port: 8787, state_directory: "/tmp/state" },
    codexapp: {
      socket: "/tmp/codexapp.sock",
      required_capabilities: ["session_status"],
      source_address: { scopeId: "hooks", sessionId: "hooksd" },
      target_scopes: {},
    },
    policies: [],
  }), /runtime\.host must be loopback-only/);
});
