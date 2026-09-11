# RouteCodex Hooks Framework

This repository is the runnable framework boundary for RouteCodex lifecycle
hooks. It intentionally does not enable Stopless, scheduling, memory, or goal
mutation behavior.

It is also a valid Codex plugin. The manifest is
[`.codex-plugin/plugin.json`](.codex-plugin/plugin.json), and the official
hook adapters are loaded from [`hooks/hooks.json`](hooks/hooks.json).

The design baseline is [docs/design.md](docs/design.md). Resource contracts,
state machines, ownership, and verification gates are under `contracts/` and
`docs/verification-plan.md`.

The runtime split is fixed:

```text
Skills  → static facts and methods
MCP     → read-only daemon state
CLI     → authorized state/config mutations
Hooks   → official Codex lifecycle adapters
Daemon  → policy state, status gate, persistence, idempotency
codexapp → TUI/Desktop App Server status and sendmessage
```

## Message rule

Every future policy creates a typed `MessageIntent` with one explicit mode:

- `idle_only`: do not disturb a working session; persist `deferred` and wait
  for an idle observation.
- `working_allowed`: sending while working is explicitly permitted.

`unknown`, `disconnected`, and unsupported states fail closed. Only
`codexapp.sendmessage` wakes a session. Queue acceptance is not delivery or a
reply.

## Hook rule

The official Stop hook is an adapter. When the daemon has successfully sent an
external wake message, the adapter returns ordinary successful/no-op output.
It does not return `decision:"block"`, because official Stop `decision:"block"`
creates a separate automatic continuation prompt. The framework does not use
`continue:false` as an injection acknowledgment: that meaning is not
established until an installed same-entry TUI/Desktop replay proves it.

`update_goal` is a separate tool-hook matcher and policy kind. It does not
share Stopless counters, timer state, or a generic post-turn handler.

## Local verification

## Local installation

The installation source is this checkout. On a new host, run:

```bash
npm run init
```

`init` installs the local `src/`, `hooks/`, and `skills/` under
`~/.codex/routecodex-hooks`, copies the skills into `~/.codex/skills`, creates
the daemon configuration and executable wrappers under `~/.local/bin`, and
registers the managed official Stop hook in `~/.codex/hooks.json`. It does not
overwrite unrelated hook entries and can be repeated safely. For an isolated
installation, pass `--codex-home`, `--bin-dir`, and `--endpoint`.

The installed CLI owns configuration and switches:

```bash
routecodex-hooks config-show
routecodex-hooks config-set endpoint http://127.0.0.1:8787
routecodex-hooks hook-disable stop
routecodex-hooks hook-enable stop
```

The installed MCP wrapper is read-only. Register it once with
`codex mcp add routecodex-hooks -- routecodex-hooks-mcp` and use its
`routecodex_hooks_status` tool to query health, operators, and schedules.

```bash
npm run check
npm test
```

The daemon entry point accepts either a real typed CodexApp port module or the
existing codexapp Unix control bridge. It never starts with a fake or guessed
transport:

```bash
node src/daemon-entry.js --port 8787 \
  --codexapp-module /absolute/path/to/codexapp-port.mjs
```

Bridge mode uses `codexapp.socket`, a registered `source_address`, and
explicit `target_scopes` entries such as
`codex_tui/tui-appserver: local:tui`; see
[`config/hooksd.example.json`](config/hooksd.example.json). The adapter maps
the bridge `send` method to the typed `send_message_to_thread` capability.

The module must export `createCodexAppPort()` returning typed
`session_status(target)` and `send_message(request)` functions. The daemon
persists to a JSON state file and exposes `/health`, `/v1/hooks/dispatch`,
`/v1/state`, `/v1/delivery/evidence`, and the read/mutation control endpoints.
The delivery endpoint accepts only one exact native-evidence transition at a
time. The entry point is a framework process boundary; it does not claim that the supplied module has
proven native Desktop/TUI delivery.

The tests prove the local command/stdin boundary, HTTP daemon boundary, status
gate, send/defer/resume behavior, fail-closed states, idempotency, the full
9-state × 2-mode gate matrix, deterministic timer skeleton, and
Stopless/update-goal kind separation, explicit CodexApp bridge mapping,
official event coverage, and the MCP/CLI control boundary. They do not claim
real TUI/Desktop App-Server or RouteCodex managed-lifecycle proof. See
[`docs/framework-graph.md`](docs/framework-graph.md).
