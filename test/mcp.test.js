import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { McpStateClient } from "../src/mcp.js";

test("MCP state client aggregates health and control state without mutation", async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") response.end(JSON.stringify({ protocol: "routecodex-hooks/v1", ready: true }));
    else if (request.url === "/v1/control/state") response.end(JSON.stringify({ protocol: "routecodex-hooks/v1", state: { operators: {}, schedules: {} } }));
    else { response.statusCode = 404; response.end(JSON.stringify({ error: "not found" })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const status = await new McpStateClient(`http://127.0.0.1:${address.port}`).queryStatus();
    assert.equal(status.health.ready, true);
    assert.deepEqual(status.control.state.schedules, {});
    assert.deepEqual(requests.sort(), ["GET /health", "GET /v1/control/state"]);
    assert.equal(requests.some((entry) => entry.startsWith("POST")), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("MCP current scope filters schedules and bindings while global preserves all", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") response.end(JSON.stringify({ protocol: "routecodex-hooks/v1", ready: true }));
    else if (request.url === "/v1/control/state") {
      response.end(JSON.stringify({
        protocol: "routecodex-hooks/v1",
        state: {
          session_bindings: {
            current: { alias: "current", target: { session_id: "s1", thread_id: "s1" } },
            other: { alias: "other", target: { session_id: "s2", thread_id: "s2" } },
          },
          schedules: {
            current: { id: "current", owner_session_id: "s1" },
            other: { id: "other", owner_session_id: "s2" },
          },
          subagents: {
            child: { thread_id: "child", owner_session_id: "s1" },
          },
          longhorizon: {
            goal: { id: "goal", owner_session_id: "s1", mode: "goal", enabled: true },
            other: { id: "other", owner_session_id: "s2", mode: "periodic", enabled: true },
          },
          goal_reviews: {
            review: { review_id: "review", source_session_id: "s1", state: "completed" },
            other: { review_id: "other", source_session_id: "s2", state: "claimed" },
          },
          stop_suppression: {
            "s1:turn-1": { session_id: "s1", turn_id: "turn-1" },
            "s2:turn-1": { session_id: "s2", turn_id: "turn-1" },
          },
          delivery_intents: {
            unresolved: {
              intent_id: "unresolved",
              state: "unknown_delivery",
              target: { session_id: "s1", thread_id: "s1" },
            },
            other: {
              intent_id: "other",
              state: "unknown_delivery",
              target: { session_id: "s2", thread_id: "s2" },
            },
          },
        },
      }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const client = new McpStateClient(`http://127.0.0.1:${address.port}`);
    const current = await client.queryStatusForScope({ scope: "current", sessionId: "s1", env: {} });
    assert.equal(current.scope, "current");
    assert.equal(current.session_id, "s1");
    assert.deepEqual(current.schedules.map((entry) => entry.id), ["current"]);
    assert.deepEqual(current.subagents.map((entry) => entry.thread_id), ["child"]);
    assert.deepEqual(current.longhorizon.map((entry) => entry.id), ["goal"]);
    assert.deepEqual(current.goal_reviews.map((entry) => entry.review_id), ["review"]);
    assert.deepEqual(current.stop_suppression.map((entry) => entry.session_id), ["s1"]);
    assert.equal(current.unresolved_delivery.length, 1);
    assert.equal(current.unresolved_delivery[0].intent_id, "unresolved");

    const global = await client.queryStatusForScope({ scope: "global" });
    assert.deepEqual(Object.keys(global.control.state.schedules).sort(), ["current", "other"]);
    await assert.rejects(
      () => client.queryStatusForScope({ scope: "current", sessionId: null, env: {} }),
      /current MCP status scope requires/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
