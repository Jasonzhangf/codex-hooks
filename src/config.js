import fs from "node:fs";
import { clone } from "./protocol.js";

export function loadDaemonConfig(filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") throw new Error("daemon config path is required");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`cannot load daemon config: ${error.message}`);
  }
  return validateDaemonConfig(parsed);
}

export function validateDaemonConfig(value) {
  assertObject(value, "daemon config");
  assertKeys(value, ["runtime", "codexapp", "policies"], "daemon config");
  assertObject(value.runtime, "runtime");
  assertKeys(value.runtime, ["host", "port", "state_directory"], "runtime");
  assertString(value.runtime.host, "runtime.host");
  if (!Number.isInteger(value.runtime.port) || value.runtime.port < 0 || value.runtime.port > 65535) {
    throw new Error("runtime.port must be an integer from 0 to 65535");
  }
  assertString(value.runtime.state_directory, "runtime.state_directory");

  assertObject(value.codexapp, "codexapp");
  assertKeys(value.codexapp, ["socket", "required_capabilities", "source_address", "target_scopes"], "codexapp");
  assertString(value.codexapp.socket, "codexapp.socket");
  if (!Array.isArray(value.codexapp.required_capabilities) || value.codexapp.required_capabilities.length === 0) {
    throw new Error("codexapp.required_capabilities must be a non-empty array");
  }
  value.codexapp.required_capabilities.forEach((entry, index) => assertString(entry, `codexapp.required_capabilities[${index}]`));
  assertObject(value.codexapp.source_address, "codexapp.source_address");
  assertKeys(value.codexapp.source_address, ["scopeId", "sessionId"], "codexapp.source_address");
  assertString(value.codexapp.source_address.scopeId, "codexapp.source_address.scopeId");
  assertString(value.codexapp.source_address.sessionId, "codexapp.source_address.sessionId");
  assertObject(value.codexapp.target_scopes, "codexapp.target_scopes");
  for (const [key, scopeId] of Object.entries(value.codexapp.target_scopes)) assertString(scopeId, `codexapp.target_scopes.${key}`);

  if (!Array.isArray(value.policies)) throw new Error("policies must be an array");
  const names = new Set();
  value.policies.forEach((policy, index) => {
    assertObject(policy, `policies[${index}]`);
    assertKeys(policy, ["name", "enabled", "config"], `policies[${index}]`);
    assertString(policy.name, `policies[${index}].name`);
    if (names.has(policy.name)) throw new Error(`duplicate policy name: ${policy.name}`);
    names.add(policy.name);
    if (typeof policy.enabled !== "boolean") throw new Error(`policies[${index}].enabled must be boolean`);
    assertObject(policy.config, `policies[${index}].config`);
  });
  return clone(value);
}

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
}

function assertKeys(value, keys, name) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${name} has unsupported field: ${key}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) throw new Error(`${name}.${key} is required`);
}

function assertString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
}
