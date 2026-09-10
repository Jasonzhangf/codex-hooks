import assert from "node:assert/strict";
import test from "node:test";
import { HooksRuntime } from "../src/orchestrator.js";

test("Cordis runtime loads configured plugins and disposes them on shutdown", async () => {
  const events = [];
  const runtime = new HooksRuntime({
    plugins: [{
      plugin: {
        name: "probe",
        apply(_ctx, config) {
          events.push(["start", config]);
          return () => events.push(["stop"]);
        },
      },
      config: { enabled: true },
    }],
  });

  assert.deepEqual(runtime.status(), { state: "down", cordis_plugins: 0, valid_state: true });
  await runtime.start();
  assert.equal(runtime.status().state, "ready");
  assert.deepEqual(events, [["start", { enabled: true }]]);

  await runtime.stop();
  assert.deepEqual(runtime.status(), { state: "down", cordis_plugins: 0, valid_state: true });
  assert.deepEqual(events, [["start", { enabled: true }], ["stop"]]);
});

test("Cordis runtime makes repeated start while ready idempotent", async () => {
  const runtime = new HooksRuntime();
  const first = await runtime.start();
  const second = await runtime.start();
  assert.deepEqual(second, first);
  await runtime.stop();
});
