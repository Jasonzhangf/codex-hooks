import { assertNonEmpty } from "./protocol.js";

export const CODEXAPP_CAPABILITIES = Object.freeze([
  "session_status",
  "sendmessage",
]);

export function assertCodexAppPort(port) {
  if (!port || typeof port !== "object") throw new Error("codexapp port must be an object");
  if (typeof port.session_status !== "function") throw new Error("codexapp port requires session_status");
  if (typeof port.send_message !== "function") throw new Error("codexapp port requires send_message");
  return port;
}

export function normalizeCodexAppCapabilities(value) {
  if (!Array.isArray(value)) throw new Error("codexapp capabilities must be an array");
  const capabilities = value.map((entry) => assertNonEmpty(entry, "codexapp capability"));
  for (const required of CODEXAPP_CAPABILITIES) {
    if (!capabilities.includes(required)) throw new Error(`codexapp missing capability: ${required}`);
  }
  return [...new Set(capabilities)];
}
