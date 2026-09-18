#!/usr/bin/env node

import fs from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { McpStateClient } from "./mcp.js";
import {
  installFromSource,
  readInstallRecord,
  setStopHookEnabled,
  writeInstallRecord,
} from "./install.js";
import { normalizeLoopbackEndpoint } from "./endpoint.js";

const endpoint = process.env.ROUTECODEX_HOOKS_ENDPOINT || null;
const argv = process.argv.slice(2);
const [operation, ...args] = argv;

if (operation === "--help" || operation === "-h") {
  printHelp(usage());
} else if (operation === "init") {
  print({ initialized: true, ...initCommand(args) });
} else if (operation === "status") {
  const record = readInstallRecord();
  print(await new McpStateClient(normalizeEndpoint(endpoint || record.endpoint)).queryStatus());
} else if (operation === "session") {
  await sessionCommand(args);
} else if (operation === "schedule") {
  await scheduleCommand(args);
} else if (operation === "wait") {
  await waitCommand(args);
} else if (operation === "subagent") {
  await subagentCommand(args);
} else if (operation === "mcp") {
  mcpCommand(args);
} else if (operation === "config") {
  configCommand(args);
} else if (operation === "hook") {
  hookCommand(args);
} else if (operation === "supervisor") {
  supervisorCommand(args);
} else if (operation === "operator") {
  await operatorCommand(args);
} else if (operation === "longhorizon") {
  await longHorizonCommand(args);
} else if (operation === "snapshot") {
  snapshotCommand(args);
} else if (operation === "config-show") {
  const record = readInstallRecord();
  const daemon = readJson(record.daemon_config);
  print({ install: record, daemon });
} else if (operation === "config-set") {
  const record = readInstallRecord();
  const key = required(args[0], "config key");
  const value = required(args[1], "config value");
  print(setConfig(record, key, value));
} else if (operation === "hook-enable" || operation === "hook-disable") {
  const hook = required(args[0], "hook name");
  if (hook !== "stop") throw new Error(`unsupported hook: ${hook}`);
  print(setStopHookEnabled(readInstallRecord(), operation === "hook-enable"));
} else if (operation === "supervisor-enable" || operation === "supervisor-disable") {
  print(setSupervisorEnabled(readInstallRecord(), operation === "supervisor-enable"));
} else if (operation === "operator-enable" || operation === "operator-disable") {
  const name = required(args[0], "operator name");
  await mutate({ operation: "operator.set_enabled", name, enabled: operation === "operator-enable" });
} else if (operation === "session-bind") {
  const record = readInstallRecord();
  const daemon = readJson(record.daemon_config);
  const alias = required(args[0], "session alias");
  const sessionId = required(args[1], "session id");
  const options = parseOptions(args.slice(2), ["--target", "--namespace", "--appserver", "--replace"]);
  await mutate({
    operation: "session.bind",
    alias,
    target: resolveSessionTarget(daemon, options, sessionId),
    replace: options.replace === true,
  });
} else if (operation === "session-unbind") {
  await mutate({ operation: "session.unbind", alias: required(args[0], "session alias") });
} else if (operation === "schedule-add") {
  const options = parseOptions(args.slice(3), ["--session", "--send-mode"]);
  await mutate({
    operation: "schedule.add",
    id: required(args[0], "schedule id"),
    at: required(args[1], "schedule time"),
    body: required(args[2], "schedule body"),
    session: required(options.session, "--session"),
    ...(options.send_mode ? { send_mode: options.send_mode } : {}),
  });
} else if (operation === "schedule-upsert") {
  await mutate({ operation: "schedule.upsert", id: required(args[0], "schedule id"), at: required(args[1], "schedule time"), body: required(args[2], "schedule body"), target: parseTarget(args[3]), ...(args[4] ? { send_mode: args[4] } : {}) });
} else if (operation === "schedule-remove") {
  await mutate({ operation: "schedule.remove", id: required(args[0], "schedule id") });
} else if (operation === "schedule-pause" || operation === "schedule-resume") {
  await mutate({ operation: operation === "schedule-pause" ? "schedule.pause" : "schedule.resume", id: required(args[0], "schedule id") });
} else {
  throw new Error(usage());
}

async function sessionCommand(args) {
  if (hasHelp(args)) {
    printHelp(sessionHelp());
    return;
  }
  const [subcommand, ...rest] = args;
  if (subcommand === "bind") {
    const record = readInstallRecord();
    const daemon = readJson(record.daemon_config);
    const alias = required(rest[0], "session alias");
    const sessionId = required(rest[1], "session id");
    const options = parseOptions(rest.slice(2), ["--target", "--namespace", "--appserver", "--replace"]);
    await mutate({
      operation: "session.bind",
      alias,
      target: resolveSessionTarget(daemon, options, sessionId),
      replace: options.replace === true,
    });
    return;
  }
  if (subcommand === "unbind") {
    await mutate({ operation: "session.unbind", alias: required(rest[0], "session alias") });
    return;
  }
  throw new Error("usage: rccs session bind|unbind ...");
}

async function scheduleCommand(args) {
  if (hasHelp(args)) {
    printHelp(scheduleHelp());
    return;
  }
  const [subcommand, ...rest] = args;
  if (subcommand === "add") {
    const options = parseOptions(rest.slice(3), [
      "--session",
      "--target",
      "--send-mode",
      "--busy-policy",
      "--every",
      "--once",
      "--action",
      "--cwd",
      "--model",
      "--effort",
      "--ephemeral",
      "--allow-concurrent",
      "--owner-session",
    ]);
    if (options.once && options.every) throw new Error("--once and --every cannot be used together");
    const action = options.action || "notify";
    validateScheduleSelector(action, options);
    const mode = options.every ? "interval" : "once";
    const at = required(rest[1], "schedule time");
    const body = required(rest[2], "schedule body");
    const request = {
      operation: "schedule.add",
      id: required(rest[0], "schedule id"),
      action,
      mode,
      at,
      body,
      ...(options.send_mode ? { send_mode: options.send_mode } : {}),
      ...(options.busy_policy ? { busy_policy: options.busy_policy } : {}),
      ...(options.every ? { interval_ms: parseDuration(options.every) } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.ephemeral === true ? { ephemeral: true } : {}),
      ...(options.allow_concurrent === true ? { allow_concurrent: true } : {}),
      ...(ownerSessionId(options) ? { owner_session_id: ownerSessionId(options) } : {}),
    };
    if (action === "subagent") request.target = parseTargetIdentity(options.target);
    else request.session = options.session;
    await mutate(request);
    return;
  }
  if (subcommand === "list") {
    const options = parseOptions(rest, ["--global", "--session"]);
    if (options.global && options.session) throw new Error("--global and --session cannot be used together");
    const state = await queryControl();
    const owner = options.global ? null : required(options.session || currentSessionId(), "current session; pass --session or --global");
    const schedules = Object.values(state.state.schedules || {})
      .filter((schedule) => owner == null || schedule.owner_session_id === owner)
      .sort((left, right) => left.id.localeCompare(right.id));
    print(schedules);
    return;
  }
  if (subcommand === "show") {
    const id = required(rest[0], "schedule id");
    const state = await queryControl();
    const schedules = state.state.schedules || {};
    if (!Object.hasOwn(schedules, id)) throw new Error(`schedule not found: ${id}`);
    print(schedules[id]);
    return;
  }
  if (subcommand === "update") {
    const options = parseOptions(rest.slice(1), [
      "--at",
      "--body",
      "--send-mode",
      "--busy-policy",
      "--session",
      "--target",
      "--every",
      "--once",
      "--action",
      "--cwd",
      "--model",
      "--effort",
      "--ephemeral",
      "--allow-concurrent",
      "--owner-session",
    ]);
    if (options.once && options.every) throw new Error("--once and --every cannot be used together");
    const mode = options.once ? "once" : options.every ? "interval" : undefined;
    const request = {
      operation: "schedule.update",
      id: required(rest[0], "schedule id"),
      ...(options.at ? { at: options.at } : {}),
      ...(options.body ? { body: options.body } : {}),
      ...(options.send_mode ? { send_mode: options.send_mode } : {}),
      ...(options.busy_policy ? { busy_policy: options.busy_policy } : {}),
      ...(mode ? { mode } : {}),
      ...(options.every ? { interval_ms: parseDuration(options.every) } : {}),
      ...(options.action ? { action: options.action } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.ephemeral === true ? { ephemeral: true } : {}),
      ...(options.allow_concurrent === true ? { allow_concurrent: true } : {}),
      ...(options.session ? { session: options.session } : {}),
      ...(options.target ? { target: parseTargetIdentity(options.target) } : {}),
      ...(ownerSessionId(options) ? { owner_session_id: ownerSessionId(options) } : {}),
    };
    await mutate(request);
    return;
  }
  if (["remove", "pause", "resume", "stop"].includes(subcommand)) {
    const operation = { remove: "schedule.remove", pause: "schedule.pause", resume: "schedule.resume", stop: "schedule.stop" }[subcommand];
    await mutate({ operation, id: required(rest[0], "schedule id") });
    return;
  }
  throw new Error("usage: rccs schedule add|list|show|update|remove|pause|resume|stop ...");
}

async function waitCommand(args) {
  if (hasHelp(args)) {
    printHelp(waitHelp());
    return;
  }
  const duration = required(args[0], "wait duration");
  const remainder = args.slice(1);
  const body = remainder[0] && !remainder[0].startsWith("--") ? remainder.shift() : "Wait elapsed. Continue the current task.";
  const options = parseOptions(remainder, [
    "--session",
    "--async",
    "--send-mode",
    "--busy-policy",
    "--id",
    "--timeout",
    "--owner-session",
  ]);
  const session = options.session || await findCurrentSessionAlias();
  const request = {
    operation: options.async ? "wait.create" : "wait.block",
    id: options.id || `wait-${Date.now()}-${process.pid}`,
    at: parseWaitTime(duration),
    body,
    session: required(session, "current session alias; bind the session or pass --session"),
    send_mode: options.send_mode || (options.async ? "idle_only" : "working_allowed"),
    busy_policy: options.busy_policy || "defer",
    ...(ownerSessionId(options) ? { owner_session_id: ownerSessionId(options) } : {}),
    ...(options.timeout ? { timeout_ms: parseDuration(options.timeout) } : {}),
  };
  await mutate(request);
}

function mcpCommand(args) {
  if (hasHelp(args)) {
    printHelp(mcpHelp());
    return;
  }
  const [subcommand, ...rest] = args;
  if (subcommand !== "register") throw new Error("usage: rccs mcp register [--name <name>] [--command <path>]");
  const options = parseOptions(rest, ["--name", "--command"]);
  const record = readInstallRecord();
  const name = options.name || "routecodex-hooks";
  const command = options.command || record.mcp_wrapper;
  print(registerMcp({ name, command }));
}

function registerMcp({ name, command, codexHome = null }) {
  const environment = {
    ...process.env,
    ...(codexHome == null ? {} : { CODEX_HOME: resolve(codexHome) }),
  };
  const existing = spawnSync("codex", ["mcp", "get", name, "--json"], { encoding: "utf8", env: environment });
  if (existing.status === 0) {
    const parsed = JSON.parse(existing.stdout);
    const registered = parsed?.transport?.command || parsed?.command;
    if (registered !== command) {
      throw new Error(`MCP entry already exists with different command: ${name}`);
    }
    return { operation: "mcp.register", name, command, state: "already_registered" };
  }
  if (!/No MCP server (?:named .* )?found|not found/i.test(existing.stderr || "")) {
    throw new Error(`cannot inspect MCP entry ${name}: ${(existing.stderr || existing.stdout).trim()}`);
  }
  const added = spawnSync("codex", ["mcp", "add", name, "--", command], { encoding: "utf8", env: environment });
  if (added.status !== 0) throw new Error(`cannot register MCP entry ${name}: ${(added.stderr || added.stdout).trim()}`);
  return { operation: "mcp.register", name, command, state: "registered" };
}

async function subagentCommand(args) {
  if (hasHelp(args)) {
    printHelp(subagentHelp());
    return;
  }
  const [subcommand, ...rest] = args;
  if (subcommand === "create") {
    const options = parseOptions(rest.slice(1), [
      "--target",
      "--cwd",
      "--model",
      "--effort",
      "--ephemeral",
      "--owner-session",
      "--id",
    ]);
    await mutate({
      operation: "subagent.create",
      prompt: required(rest[0], "subagent prompt"),
      target: parseTargetIdentity(required(options.target, "--target")),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ephemeral: true,
      ...(options.owner_session ? { owner_session_id: options.owner_session } : {}),
      ...(options.id ? { attempt_id: options.id } : {}),
    });
    return;
  }
  if (subcommand === "list") {
    const options = parseOptions(rest, ["--global", "--session"]);
    if (options.global && options.session) throw new Error("--global and --session cannot be used together");
    const owner = options.global ? null : required(options.session || currentSessionId(), "current session; pass --session or --global");
    const state = await queryControl();
    const subagents = Object.values(state.state.subagents || {})
      .filter((subagent) => owner == null || subagent.owner_session_id === owner)
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
    print(subagents);
    return;
  }
  if (subcommand === "show") {
    const threadId = required(rest[0], "subagent thread id");
    const state = await queryControl();
    const subagent = state.state.subagents?.[threadId];
    if (!subagent) throw new Error(`subagent not found: ${threadId}`);
    print(subagent);
    return;
  }
  if (subcommand === "stop") {
    await mutate({ operation: "subagent.stop", thread_id: required(rest[0], "subagent thread id") });
    return;
  }
  if (["close", "archive", "delete"].includes(subcommand)) {
    throw new Error(`unsupported subagent command: ${subcommand}; use rccs subagent stop <thread-id>`);
  }
  throw new Error("usage: rccs subagent create <prompt> --target <namespace>/<appserver> [--ephemeral] | rccs subagent list [--global|--session <session-id>] | rccs subagent show <thread-id> | rccs subagent stop <thread-id>");
}

function configCommand(args) {
  if (hasHelp(args)) {
    printHelp(configHelp());
    return;
  }
  const [subcommand, ...rest] = args;
  if (subcommand === "show") {
    const record = readInstallRecord();
    print({ install: record, daemon: readJson(record.daemon_config) });
    return;
  }
  if (subcommand === "set") {
    const record = readInstallRecord();
    print(setConfig(record, required(rest[0], "config key"), required(rest[1], "config value")));
    return;
  }
  throw new Error("usage: rccs config show|set ...");
}

function hookCommand(args) {
  if (hasHelp(args)) {
    printHelp(hookHelp());
    return;
  }
  const [subcommand, name] = args;
  if (subcommand !== "enable" && subcommand !== "disable") throw new Error("usage: rccs hook enable|disable stop");
  if (required(name, "hook name") !== "stop") throw new Error(`unsupported hook: ${name}`);
  print(setStopHookEnabled(readInstallRecord(), subcommand === "enable"));
}

function supervisorCommand(args) {
  if (hasHelp(args)) {
    printHelp(supervisorHelp());
    return;
  }
  const [subcommand] = args;
  if (subcommand !== "enable" && subcommand !== "disable") throw new Error("usage: rccs supervisor enable|disable");
  print(setSupervisorEnabled(readInstallRecord(), subcommand === "enable"));
}

async function operatorCommand(args) {
  if (hasHelp(args)) {
    printHelp(operatorHelp());
    return;
  }
  const [subcommand, name] = args;
  if (subcommand !== "enable" && subcommand !== "disable") throw new Error("usage: rccs operator enable|disable <name>");
  await mutate({ operation: "operator.set_enabled", name: required(name, "operator name"), enabled: subcommand === "enable" });
}

async function longHorizonCommand(args) {
  if (hasHelp(args)) {
    printHelp(longHorizonHelp());
    return;
  }
  const [subcommand, ...rest] = args;
  if (subcommand === "register") {
    const options = parseOptions(rest.slice(1), [
      "--mode",
      "--goal-file",
      "--prompt",
      "--session",
      "--every",
      "--at",
      "--owner-session",
      "--review-budget",
    ]);
    await mutate({
      operation: "longhorizon.register",
      id: required(rest[0], "longhorizon id"),
      mode: required(options.mode, "--mode"),
      ...(options.goal_file ? { goal_file: options.goal_file } : {}),
      ...(options.prompt ? { prompt: options.prompt } : {}),
      ...(options.session ? { session: options.session } : {}),
      ...(options.every ? { interval_ms: parseDuration(options.every) } : {}),
      ...(options.at ? { at: options.at } : {}),
      ...(options.owner_session ? { owner_session_id: options.owner_session } : {}),
      ...(options.review_budget ? { review_budget: Number(options.review_budget) } : {}),
    });
    return;
  }
  if (subcommand === "list") {
    const options = parseOptions(rest, ["--global", "--session"]);
    const state = await queryControl();
    const owner = options.global ? null : options.session || currentSessionId();
    if (!options.global && !owner) throw new Error("current session; pass --session or --global");
    print(Object.values(state.state.longhorizon || {})
      .filter((record) => owner == null || record.owner_session_id === owner)
      .sort((left, right) => left.id.localeCompare(right.id)));
    return;
  }
  if (subcommand === "show") {
    const state = await queryControl();
    const record = state.state.longhorizon?.[required(rest[0], "longhorizon id")];
    if (!record) throw new Error(`longhorizon not found: ${rest[0]}`);
    print(record);
    return;
  }
  if (["activate", "pause", "stop", "remove"].includes(subcommand)) {
    const operation = {
      activate: "longhorizon.activate",
      pause: "longhorizon.pause",
      stop: "longhorizon.stop",
      remove: "longhorizon.remove",
    }[subcommand];
    await mutate({ operation, id: required(rest[0], "longhorizon id") });
    return;
  }
  throw new Error("usage: rccs longhorizon register|list|show|activate|pause|stop|remove ...");
}

function snapshotCommand(args) {
  if (hasHelp(args)) {
    printHelp(snapshotHelp());
    return;
  }
  const [subcommand, ...rest] = args;
  if (!["backup", "list", "restore"].includes(subcommand)) {
    throw new Error("usage: rccs snapshot backup|list|restore ...");
  }
  const record = readInstallRecord();
  const command = record.recover_wrapper;
  if (typeof command !== "string" || command === "") {
    throw new Error("installed rccs-recover command is missing; run rccs init");
  }
  const result = spawnSync(command, [subcommand, ...rest], { encoding: "utf8" });
  if (result.error) throw new Error(`cannot run rccs-recover: ${result.error.message}`);
  if (result.status !== 0) {
    process.stderr.write(result.stderr || "");
    process.exit(result.status ?? 1);
  }
  process.stdout.write(result.stdout || "");
}

function usage() {
  return `
usage:
  rccs init [--codex-home <path>] [--bin-dir <path>] [--agent-home <path>] [--endpoint <http-origin>]
  rccs status
  rccs session bind <alias> <session-id> [--target <namespace>/<appserver>] [--replace]
  rccs session unbind <alias>
  rccs schedule add|list|show|update|remove|pause|resume|stop ...
  rccs wait <duration> [body] [--async]
  rccs subagent create|list|show|stop ...
  rccs longhorizon register|list|show|activate|pause|stop|remove ...
  rccs snapshot backup|list|restore ...
  rccs mcp register ...
  rccs config show|set ...
  rccs hook enable|disable stop
  rccs supervisor enable|disable
  rccs operator enable|disable <name>

Use "rccs <command> --help" for side-effect-free command details.
`;
}

function hasHelp(args) {
  return args.includes("--help") || args.includes("-h");
}

function printHelp(value) {
  process.stdout.write(`${value.trimEnd()}\n`);
}

function scheduleHelp() {
  return `
usage:
  rccs schedule add <id> <at> <body> --session <alias> [notify options]
  rccs schedule add <id> <at> <body> --target <namespace>/<appserver> --action subagent [subagent options]
  rccs schedule list [--global | --session <session-id>]
  rccs schedule show <id>
  rccs schedule update <id> [options]
  rccs schedule pause|resume|stop|remove <id>

options:
  --once                         one-shot schedule; default
  --every <duration>             recurring interval such as 30s, 5m, 1h, 1d
  --send-mode idle_only|working_allowed
                                 default idle_only; working_allowed permits a working target
  --busy-policy defer|skip       default defer; skip records one skipped occurrence
  --action notify|subagent       default notify
  --cwd <absolute-path>          subagent working directory
  --model <model>                subagent model override
  --effort <effort>              subagent effort override
  --ephemeral                    optional assertion; subagent schedules always use an ephemeral thread
  --allow-concurrent             required for recurring subagent schedules
  --owner-session <session-id>   ownership scope for list/stop

notes:
  --once and --every are mutually exclusive.
  notify schedules require --session and reject --target.
  subagent schedules require --target and --action subagent.
  recurring occurrences are coalesced; a missed backlog creates one occurrence.
  stop is terminal for the schedule; pause and resume are reversible.
`;
}

function waitHelp() {
  return `
usage:
  rccs wait <duration> [body] [--session <alias>] [options]

options:
  --session <alias>              target binding; otherwise resolve from CODEX_SESSION_ID/CODEX_THREAD_ID
  --async                        register and return; default is blocking until terminal delivery
  --send-mode idle_only|working_allowed
                                 async default idle_only; blocking default working_allowed
  --busy-policy defer|skip       default defer
  --id <id>                      schedule identity; default wait-<timestamp>-<pid>
  --timeout <duration>           maximum blocking wait such as 30s or 5m
  --owner-session <session-id>   ownership scope for list/stop

notes:
  wait is one-shot. Duration accepts ms, s, m, h, or d.
  Use async for long waits instead of polling the agent.
`;
}

function subagentHelp() {
  return `
usage:
  rccs subagent create <prompt> --target <namespace>/<appserver> [options]
  rccs subagent list [--global | --session <session-id>]
  rccs subagent show <thread-id>
  rccs subagent stop <thread-id>

options:
  --target <namespace>/<appserver> required native target scope
  --cwd <absolute-path>            child working directory
  --model <model>                  child model override
  --effort <effort>                child effort override
  --ephemeral                      create a disposable native thread
  --owner-session <session-id>     ownership scope for list
  --id <id>                        idempotency attempt identity
  --global                         list all children
  --session <session-id>           list children owned by one session

notes:
  create starts a fresh thread; caller conversation context is not inherited.
  stop reads native status and uses turn/interrupt only.
  archive, delete, and close are not supported stop substitutes.
`;
}

function mcpHelp() {
  return `
usage:
  rccs mcp register [--name <name>] [--command <path>]

options:
  --name <name>                  MCP entry name; default routecodex-hooks
  --command <path>               MCP executable; default installed routecodex-hooks-mcp

notes:
  MCP is read-only. Use the routecodex_hooks_status tool for health, schedules,
  bindings, subagents, LongHorizon state, and unresolved delivery evidence.
`;
}

function sessionHelp() {
  return `
usage:
  rccs session bind <alias> <session-id> [options]
  rccs session unbind <alias>

options:
  --target <namespace>/<appserver>  configured target when multiple are present
  --namespace <namespace>           configured namespace selector
  --appserver <appserver-id>        configured App Server selector
  --replace                         replace an existing alias binding

notes:
  bind resolves and persists the target at registration time.
  unbind removes only the named alias.
`;
}

function configHelp() {
  return `
usage:
  rccs config show
  rccs config set <key> <value>

keys:
  endpoint          loopback daemon endpoint, for example http://127.0.0.1:8787
  codexapp_socket   CodexApp bridge Unix socket path
  source_scope      source scope id
  source_session    source session id
  target_scope      <namespace/appserver>=<scope-id>
  target            target JSON with namespace, appserver_id, scope_id, endpoint
`;
}

function hookHelp() {
  return `
usage:
  rccs hook enable stop
  rccs hook disable stop

notes:
  The current hook surface manages only the official Stop hook.
`;
}

function supervisorHelp() {
  return `
usage:
  rccs supervisor enable
  rccs supervisor disable

notes:
  Enables or disables the RouteCodex-managed CodexApp -> hooksd supervisor.
`;
}

function operatorHelp() {
  return `
usage:
  rccs operator enable <name>
  rccs operator disable <name>

notes:
  Operator names are listed by rccs status. Only implemented operators can be enabled.
`;
}

function longHorizonHelp() {
  return `
usage:
  rccs longhorizon register <id> --mode periodic --prompt <text> --session <alias> --every <duration> [options]
  rccs longhorizon register <id> --mode goal --goal-file <path> --session <alias> [options]
  rccs longhorizon list [--global | --session <session-id>]
  rccs longhorizon show <id>
  rccs longhorizon activate|pause|stop|remove <id>

options:
  --mode periodic|goal            required mode
  --prompt <text>                 periodic prompt
  --goal-file <path>              goal document for goal mode
  --session <alias>               bound target session
  --every <duration>              periodic interval such as 5m or 1h
  --at <ISO-8601>                 optional first periodic occurrence
  --owner-session <session-id>    ownership scope for list/control
  --review-budget <count>         optional goal review budget; default unlimited

notes:
  Records are active on registration.
  goal mode schedules a liveness check after 60 seconds and repeats every 60 seconds.
  periodic uses busy_policy=skip.
  The CLI does not expose a separate update or resume command.
`;
}

function snapshotHelp() {
  return `
usage:
  rccs snapshot backup [--id <snapshot-id>]
  rccs snapshot list
  rccs snapshot restore [latest|<snapshot-id>]

notes:
  Snapshots include rccv3, rccv3-admin, rccv3-hooksd, rccv3-codexapp,
  config.toml, provider configuration, and alias targets.
  Recovery is also available without Node or rccs through rccs-recover.
  restore validates hashes and config, then uses rccv3 restart/status.
`;
}

function initCommand(args) {
  const options = parseInitOptions(args);
  const previous = tryReadInstallRecord();
  const reusePrevious = !options.codexHome && !options.binDir && !options.agentHome;
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const record = installFromSource({
    sourceRoot,
    codexHome: options.codexHome ?? (reusePrevious && previous?.install_root ? dirname(previous.install_root) : undefined),
    binDir: options.binDir ?? (reusePrevious ? previous?.bin_directory : undefined),
    agentHome: options.agentHome ?? (reusePrevious && previous?.agent_skills_directory ? dirname(previous.agent_skills_directory) : undefined),
    endpoint: options.endpoint ?? (reusePrevious ? previous?.endpoint : undefined) ?? "http://127.0.0.1:8787",
    stopHookEnabled: options.stopHookEnabled ?? (reusePrevious ? previous?.stop_hook_enabled : undefined) ?? true,
    supervisorEnabled: options.supervisorEnabled ?? (reusePrevious ? previous?.supervisor_enabled : undefined),
  });
  return {
    ...record,
    mcp_registration: registerMcp({ name: "routecodex-hooks", command: record.mcp_wrapper, codexHome: options.codexHome }),
  };
}

function parseInitOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (["--endpoint", "--codex-home", "--bin-dir", "--agent-home"].includes(key)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
      const option = {
        "--endpoint": "endpoint",
        "--codex-home": "codexHome",
        "--bin-dir": "binDir",
        "--agent-home": "agentHome",
      }[key];
      options[option] = value;
      index += 1;
      continue;
    }
    if (key === "--disable-stop-hook") {
      options.stopHookEnabled = false;
      continue;
    }
    if (key === "--enable-stop-hook") {
      options.stopHookEnabled = true;
      continue;
    }
    if (key === "--enable-supervisor") {
      options.supervisorEnabled = true;
      continue;
    }
    if (key === "--disable-supervisor") {
      options.supervisorEnabled = false;
      continue;
    }
    throw new Error(`unsupported init argument: ${key}`);
  }
  return options;
}

async function mutate(value) {
  const record = tryReadInstallRecord();
  const targetEndpoint = normalizeEndpoint(endpoint || record?.endpoint || "http://127.0.0.1:8787");
  const response = await fetch(`${targetEndpoint}/v1/control/mutate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `daemon mutation failed: ${response.status}`);
  print(body.result);
}

async function queryControl() {
  const record = tryReadInstallRecord();
  const targetEndpoint = normalizeEndpoint(endpoint || record?.endpoint || "http://127.0.0.1:8787");
  return new McpStateClient(targetEndpoint).queryState();
}

function setConfig(record, key, value) {
  const daemon = readJson(record.daemon_config);
  if (key === "endpoint") {
    const parsed = normalizeLoopbackEndpoint(value);
    record.endpoint = parsed.endpoint;
    daemon.runtime.host = parsed.host;
    daemon.runtime.port = parsed.port;
  } else if (key === "codexapp_socket") {
    daemon.codexapp.socket = value;
  } else if (key === "source_scope") {
    daemon.codexapp.source_address.scopeId = value;
  } else if (key === "source_session") {
    daemon.codexapp.source_address.sessionId = value;
  } else if (key === "target_scope") {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) throw new Error("target_scope must be <namespace/appserver>=<scope-id>");
    daemon.codexapp.target_scopes[value.slice(0, separator)] = value.slice(separator + 1);
  } else if (key === "target") {
    const target = parseTargetConfig(value);
    const targetsPath = daemon.codexapp.targets_file;
    if (!targetsPath) throw new Error("codexapp.targets_file is required for target configuration");
    const targets = readJson(targetsPath);
    const index = targets.findIndex((entry) => entry.scope_id === target.scope_id);
    if (index >= 0) targets[index] = target;
    else targets.push(target);
    fs.writeFileSync(targetsPath, `${JSON.stringify(targets, null, 2)}\n`, "utf8");
    daemon.codexapp.target_scopes[`${target.namespace}/${target.appserver_id}`] = target.scope_id;
  } else {
    throw new Error(`unsupported config key: ${key}`);
  }
  fs.writeFileSync(record.daemon_config, `${JSON.stringify(daemon, null, 2)}\n`, "utf8");
  writeInstallRecord(record);
  return { key, value, install: record, daemon };
}

function setSupervisorEnabled(record, enabled) {
  const daemon = readJson(record.daemon_config);
  daemon.supervisor.enabled = enabled;
  fs.writeFileSync(record.daemon_config, `${JSON.stringify(daemon, null, 2)}\n`, "utf8");
  const updated = { ...record, supervisor_enabled: enabled };
  writeInstallRecord(updated);
  return { enabled, install: updated, daemon };
}

function parseTarget(value) {
  try { return JSON.parse(required(value, "target JSON")); } catch (error) { throw new Error(`target JSON is invalid: ${error.message}`); }
}

function parseTargetIdentity(value) {
  const [namespace, appserverId, ...extra] = required(value, "target").split("/");
  if (!namespace || !appserverId || extra.length > 0) throw new Error("--target must be <namespace/appserver>");
  return { namespace, appserver_id: appserverId };
}

function validateScheduleSelector(action, options) {
  if (action === "subagent") {
    if (!options.target) throw new Error("--target is required when --action subagent");
    if (options.session) throw new Error("--session is not valid with --action subagent; use --target");
    return;
  }
  if (action !== "notify") throw new Error(`unsupported schedule action: ${action}; use notify or subagent`);
  if (!options.session) throw new Error("--session is required for action=notify");
  if (options.target) throw new Error("--target requires --action subagent");
}

function parseTargetConfig(value) {
  let target;
  try { target = JSON.parse(value); } catch (error) { throw new Error(`target config is invalid: ${error.message}`); }
  if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error("target config must be an object");
  for (const key of ["namespace", "appserver_id", "scope_id", "endpoint"]) required(target[key], `target.${key}`);
  if (!["codex_tui", "codex_app"].includes(target.namespace)) throw new Error("target.namespace must be codex_tui or codex_app");
  if (!target.endpoint.startsWith("unix://")) throw new Error("target.endpoint must use unix://");
  return { namespace: target.namespace, appserver_id: target.appserver_id, scope_id: target.scope_id, endpoint: target.endpoint };
}

function resolveSessionTarget(daemon, options, sessionId) {
  const targets = readJson(daemon.codexapp.targets_file);
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error("no codexapp target is configured; run config-set target first");
  }
  let target;
  if (options.target) {
    const [namespace, appserverId, ...extra] = options.target.split("/");
    if (!namespace || !appserverId || extra.length > 0) throw new Error("--target must be <namespace/appserver>");
    target = targets.find((entry) => entry.namespace === namespace && entry.appserver_id === appserverId);
  } else if (options.namespace || options.appserver) {
    target = targets.find((entry) => entry.namespace === options.namespace && entry.appserver_id === options.appserver);
  } else if (targets.length === 1) {
    target = targets[0];
  } else {
    throw new Error("multiple codexapp targets are configured; pass --target <namespace/appserver>");
  }
  if (!target) throw new Error("requested codexapp target is not configured");
  return {
    namespace: target.namespace,
    appserver_id: target.appserver_id,
    scope_id: target.scope_id,
    session_id: sessionId,
    thread_id: sessionId,
  };
}

function parseOptions(args, allowed) {
  const allowedSet = new Set(allowed);
  const booleanOptions = new Set(["--replace", "--once", "--allow-concurrent", "--async", "--global", "--ephemeral"]);
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!allowedSet.has(key)) throw new Error(`unsupported option: ${key}`);
    if (booleanOptions.has(key)) {
      options[key.slice(2).replaceAll("-", "_")] = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
    options[key.slice(2).replaceAll("-", "_")] = value;
    index += 1;
  }
  return options;
}

function parseDuration(value) {
  const match = /^([1-9]\d*)(ms|s|m|h|d)$/.exec(value);
  if (!match) throw new Error("--every must be a positive duration such as 30s, 5m, 1h, or 1d");
  const multiplier = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
  const milliseconds = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(milliseconds)) throw new Error("--every duration is too large");
  return milliseconds;
}

function parseWaitTime(value) {
  if (!Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return new Date(Date.now() + parseDuration(value)).toISOString();
}

function ownerSessionId(options = {}) {
  return options.owner_session || currentSessionId();
}

function currentSessionId() {
  return process.env.CODEX_SESSION_ID || process.env.CODEX_THREAD_ID || null;
}

async function findCurrentSessionAlias() {
  const sessionId = currentSessionId();
  if (!sessionId) return null;
  const state = await queryControl();
  const bindings = Object.values(state.state.session_bindings || {});
  const match = bindings.find((binding) => binding.target?.thread_id === sessionId || binding.target?.session_id === sessionId);
  return match?.alias || null;
}

function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value;
}

function readJson(path) {
  try { return JSON.parse(fs.readFileSync(path, "utf8")); } catch (error) { throw new Error(`cannot load ${path}: ${error.message}`); }
}

function tryReadInstallRecord() {
  try { return readInstallRecord(); } catch { return null; }
}

function normalizeEndpoint(value) {
  return normalizeLoopbackEndpoint(value).endpoint;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
