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
