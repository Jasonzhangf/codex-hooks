#!/usr/bin/env node

import readline from "node:readline";
import { readInstallRecord } from "./install.js";
import { McpStateClient } from "./mcp.js";

const record = readInstallRecord({ installRecord: process.env.ROUTECODEX_HOOKS_INSTALL_RECORD });
const client = new McpStateClient(record.endpoint);
const tools = [{
  name: "routecodex_hooks_status",
  description: "Read hooksd health, operator, schedule, binding, subagent registry, and delivery evidence state.",
  inputSchema: {
    type: "object",
    properties: {
      scope: { type: "string", enum: ["current", "global"], default: "current" },
      session_id: { type: "string" },
    },
    additionalProperties: false,
  },
}];

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  await handle(line);
}

async function handle(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    writeResponse(null, -32700, "invalid JSON");
    return;
  }
  if (request.method === "notifications/initialized") return;
  if (request.method === "initialize") {
    writeResult(request.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "routecodex-hooks", version: "0.1.0" },
    });
    return;
  }
  if (request.method === "tools/list") {
    writeResult(request.id, { tools });
    return;
  }
  if (request.method === "tools/call") {
    if (request.params?.name !== "routecodex_hooks_status") {
      writeResponse(request.id, -32602, "unknown tool");
      return;
    }
    try {
      const args = request.params?.arguments || {};
      const value = {
        ...(await client.queryStatusForScope({
          scope: args.scope || "current",
          sessionId: args.session_id || null,
        })),
        installation: {
          hooks_file: record.hooks_file,
          stop_hook_enabled: record.stop_hook_enabled,
        },
      };
      writeResult(request.id, { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
    } catch (error) {
      writeResult(request.id, { isError: true, content: [{ type: "text", text: error.message }] });
    }
    return;
  }
  writeResponse(request.id, -32601, `method not found: ${request.method}`);
}

function writeResult(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeResponse(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}
