import fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { normalizeLoopbackEndpoint } from "./endpoint.js";

export const INSTALL_SCHEMA_VERSION = 1;
export const INSTALL_DIRNAME = "routecodex-hooks";
export const MANAGED_HOOK_ID = "routecodex-hooks.stop.v1";

export function installPaths({ codexHome = join(homedir(), ".codex"), binDir = join(homedir(), ".local", "bin") } = {}) {
  const home = resolve(codexHome);
  const installRoot = join(home, INSTALL_DIRNAME);
  return {
    codexHome: home,
    installRoot,
    sourceDirectory: join(installRoot, "src"),
    hooksDirectory: join(installRoot, "hooks"),
    configDirectory: join(installRoot, "config"),
    stateDirectory: join(installRoot, "state"),
    installRecord: join(installRoot, "install.json"),
    daemonConfig: join(installRoot, "config", "hooksd.json"),
    codexappTargets: join(installRoot, "config", "codexapp-targets.json"),
    hooksFile: join(home, "hooks.json"),
    skillsDirectory: join(home, "skills"),
    binDirectory: resolve(binDir),
    cliWrapper: join(resolve(binDir), "routecodex-hooks"),
    mcpWrapper: join(resolve(binDir), "routecodex-hooks-mcp"),
    daemonWrapper: join(resolve(binDir), "routecodex-hooksd"),
    supervisorWrapper: join(resolve(binDir), "routecodex-hooks-supervisor"),
    codexappWrapper: join(resolve(binDir), "rccv3-codexapp"),
  };
}

export function readInstallRecord({ codexHome, installRecord } = {}) {
  const path = installRecord || process.env.ROUTECODEX_HOOKS_INSTALL_RECORD || installPaths({ codexHome }).installRecord;
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot load install record: ${error.message}; run npm run init first`);
  }
}

export function installFromSource({ sourceRoot, codexHome, binDir, endpoint = "http://127.0.0.1:8787", stopHookEnabled = true, supervisorEnabled } = {}) {
  if (typeof sourceRoot !== "string" || sourceRoot.trim() === "") throw new Error("source root is required");
  const source = resolve(sourceRoot);
  const paths = installPaths({ codexHome, binDir });
  const normalizedEndpoint = normalizeLoopbackEndpoint(endpoint);
  const previous = tryRead(paths.installRecord);
  const managedCommands = previous?.managed_hook_commands || [];
  const hookCommand = `${shellQuote(process.execPath)} ${shellQuote(join(paths.sourceDirectory, "hook-entry.js"))} --config ${shellQuote(paths.installRecord)} --kind stop`;

  ensureDirectory(paths.installRoot);
  copyDirectory(join(source, "src"), paths.sourceDirectory);
  copyDirectory(join(source, "hooks"), paths.hooksDirectory);
  copyDirectory(join(source, "skills"), paths.skillsDirectory);
  ensureDirectory(paths.configDirectory);
  ensureDirectory(paths.stateDirectory);
  writeJson(paths.codexappTargets, readJsonIfExists(previous?.codexapp_targets) || []);
  ensureDirectory(paths.binDirectory);

  const daemonConfig = buildDaemonConfig({ paths, endpoint: normalizedEndpoint, previous: readJsonIfExists(previous?.daemon_config), supervisorEnabled });
  writeJson(paths.daemonConfig, daemonConfig);
  writeExecutable(paths.cliWrapper, wrapperSource(paths.sourceDirectory, "cli.js", paths.installRecord));
  writeExecutable(paths.mcpWrapper, wrapperSource(paths.sourceDirectory, "mcp-server.js", paths.installRecord));
  writeExecutable(paths.daemonWrapper, wrapperSource(paths.sourceDirectory, "daemon-entry.js", paths.installRecord));
  writeExecutable(paths.supervisorWrapper, wrapperSource(paths.sourceDirectory, "supervisor-entry.js", paths.installRecord));
  writeExecutable(paths.codexappWrapper, wrapperSource(paths.sourceDirectory, "codexapp-entry.js", paths.installRecord));

  const hookConfig = readJsonIfExists(paths.hooksFile) || {};
  removeManagedHooks(hookConfig, [...managedCommands, hookCommand]);
  if (stopHookEnabled) addStopHook(hookConfig, hookCommand);
  writeJson(paths.hooksFile, hookConfig);

  const record = {
    schema_version: INSTALL_SCHEMA_VERSION,
    managed_id: MANAGED_HOOK_ID,
    source_root: source,
    install_root: paths.installRoot,
    source_directory: paths.sourceDirectory,
    skills_directory: paths.skillsDirectory,
    hooks_file: paths.hooksFile,
    daemon_config: paths.daemonConfig,
    codexapp_targets: paths.codexappTargets,
    state_directory: paths.stateDirectory,
    endpoint: normalizedEndpoint.endpoint,
    stop_hook_enabled: stopHookEnabled,
    managed_hook_commands: [hookCommand],
    bin_directory: paths.binDirectory,
    cli_wrapper: paths.cliWrapper,
    mcp_wrapper: paths.mcpWrapper,
    daemon_wrapper: paths.daemonWrapper,
    supervisor_wrapper: paths.supervisorWrapper,
    codexapp_wrapper: paths.codexappWrapper,
    supervisor_enabled: daemonConfig.supervisor.enabled,
    initialized_at: new Date().toISOString(),
  };
  writeJson(paths.installRecord, record);
  return record;
}

export function setStopHookEnabled(record, enabled) {
  if (!record || typeof record !== "object") throw new Error("install record is required");
  const hooks = readJsonIfExists(record.hooks_file) || {};
  const command = record.managed_hook_commands?.[0];
  if (!command) throw new Error("install record has no managed hook command");
  removeManagedHooks(hooks, [command]);
  if (enabled) addStopHook(hooks, command);
  writeJson(record.hooks_file, hooks);
  const updated = { ...record, stop_hook_enabled: enabled };
  writeJson(recordPath(record), updated);
  return updated;
}

export function writeInstallRecord(record) {
  writeJson(recordPath(record), record);
  return record;
}

export function recordPath(record) {
  if (typeof record?.install_root !== "string") throw new Error("install record install_root is required");
  return join(record.install_root, "install.json");
}

function buildDaemonConfig({ paths, endpoint, previous, supervisorEnabled }) {
  const normalized = typeof endpoint === "string" ? normalizeLoopbackEndpoint(endpoint) : endpoint;
  const old = previous && typeof previous === "object" ? previous : {};
  const oldSupervisor = old.supervisor && typeof old.supervisor === "object" ? old.supervisor : {};
  const codexappSocket = old.codexapp?.socket || join(paths.installRoot, "codexapp.sock");
  const codexappTargets = paths.codexappTargets;
  const supervisor = {
    enabled: supervisorEnabled ?? oldSupervisor.enabled ?? false,
    startup_timeout_ms: oldSupervisor.startup_timeout_ms || 10000,
    codexapp: {
      command: paths.codexappWrapper,
      args: ["--socket", codexappSocket, "--targets-file", codexappTargets],
    },
    hooksd: {
      command: oldSupervisor.hooksd?.command || paths.daemonWrapper,
      args: oldSupervisor.hooksd?.args || ["--config", paths.daemonConfig],
    },
  };
  return {
    runtime: {
      host: normalized.host,
      port: normalized.port,
      state_directory: paths.stateDirectory,
    },
    codexapp: {
      socket: codexappSocket,
      required_capabilities: old.codexapp?.required_capabilities || ["session_status", "send_message_to_thread"],
      source_kind: old.codexapp?.source_kind || "service",
      targets_file: codexappTargets,
      source_address: old.codexapp?.source_address || { scopeId: "local:hooks", sessionId: "hooksd" },
      target_scopes: old.codexapp?.targets_file ? (old.codexapp.target_scopes || {}) : {},
    },
    policies: old.policies || [],
    supervisor,
  };
}

function addStopHook(config, command) {
  if (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) config.hooks = {};
  const entries = Array.isArray(config.hooks.Stop) ? config.hooks.Stop : [];
  entries.push({ hooks: [{ type: "command", command, timeout: 10 }] });
  config.hooks.Stop = entries;
}

function removeManagedHooks(config, commands) {
  if (!config.hooks || typeof config.hooks !== "object") return;
  const commandSet = new Set(commands.filter((value) => typeof value === "string"));
  for (const [event, entries] of Object.entries(config.hooks)) {
    if (!Array.isArray(entries)) continue;
    config.hooks[event] = entries.filter((entry) => !entryHasCommand(entry, commandSet));
    if (config.hooks[event].length === 0) delete config.hooks[event];
  }
}

function entryHasCommand(entry, commands) {
  return Array.isArray(entry?.hooks) && entry.hooks.some((hook) => commands.has(hook?.command));
}

function copyDirectory(source, destination) {
  if (!fs.existsSync(source)) throw new Error(`source directory does not exist: ${source}`);
  fs.cpSync(source, destination, { recursive: true, force: true });
}

function wrapperSource(sourceDirectory, entry, installRecord) {
  return `#!/bin/sh\nROUTECODEX_HOOKS_INSTALL_RECORD=${shellQuote(installRecord)} exec ${shellQuote(process.execPath)} ${shellQuote(join(sourceDirectory, entry))} "$@"\n`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function ensureDirectory(path) {
  fs.mkdirSync(path, { recursive: true });
}

function writeExecutable(path, content) {
  ensureDirectory(dirname(path));
  fs.writeFileSync(path, content, { mode: 0o755 });
  fs.chmodSync(path, 0o755);
}

function writeJson(path, value) {
  ensureDirectory(dirname(path));
  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJsonIfExists(path) {
  if (typeof path !== "string" || !fs.existsSync(path)) return null;
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function tryRead(path) {
  try { return readJsonIfExists(path); } catch { return null; }
}
