# RouteCodex Hooks Framework

This repository is the runnable framework boundary for RouteCodex lifecycle
hooks. It intentionally does not enable Stopless, memory, or goal mutation
behavior.

It is also a valid Codex plugin. The manifest is
[`.codex-plugin/plugin.json`](.codex-plugin/plugin.json), and the official
hook adapters are loaded from [`hooks/hooks.json`](hooks/hooks.json).

The design baseline is [docs/design.md](docs/design.md). The detailed design
set is:

- [hooks-framework.md](docs/design/hooks-framework.md): layers and boundaries;
- [state-machine.md](docs/design/state-machine.md): complete lifecycle graph;
- [plugin-and-operator-model.md](docs/design/plugin-and-operator-model.md):
  Cordis and operator isolation;
- [codexapp-transport-boundary.md](docs/design/codexapp-transport-boundary.md):
  typed TUI/Desktop transport boundary;
- [official-hook-capability-research.md](docs/design/official-hook-capability-research.md):
  official capability findings;
- [acceptance-matrix.md](docs/design/acceptance-matrix.md): evidence-level
  acceptance matrix.

Resource contracts, state machines, ownership, and verification gates are
under `contracts/` and `docs/verification-plan.md`.

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

To let RouteCodex own the complete sidecar order, enable the supervisor with
the RouteCodex-internal `rccv3-codexapp`. The supervisor verifies its
advertised bridge and registered identities, then starts hooksd; shutdown is
always hooksd first and CodexApp second.

    routecodex-hooks supervisor-enable

The installed supervisor entry is routecodex-hooks-supervisor --config
~/.codex/routecodex-hooks/config/hooksd.json. It is a process supervisor only;
operator state remains in hooksd and native TUI/Desktop communication remains
in CodexApp.

## Local installation

The installation source is this checkout. On a new host, run:

```bash
npm run init
```

`init` installs the local `src/`, `hooks/`, and `skills/` under
`~/.codex/routecodex-hooks`, copies the skills into `~/.codex/skills`, creates
the daemon configuration and executable CLI/MCP/daemon wrappers under
`~/.local/bin`, and
registers the managed official Stop hook in `~/.codex/hooks.json`. It does not
overwrite unrelated hook entries and can be repeated safely. For an isolated
installation, pass `--codex-home`, `--bin-dir`, and `--endpoint`.

Bundled plugin hooks resolve the same default install record at
`~/.codex/routecodex-hooks/install.json`; run `npm run init` before enabling
the plugin hook manifest. The installed managed Stop hook passes its own
install record explicitly, including for isolated `--codex-home` installs.

The installed `rccs` CLI owns configuration and switches. The longer
`routecodex-hooks` command remains as a compatibility alias:

```bash
rccs config show
rccs config set endpoint http://127.0.0.1:8787
rccs config set target '{"namespace":"codex_tui","appserver_id":"tui-appserver","scope_id":"local:tui","endpoint":"unix:///path/to/app-server-control.sock"}'
rccs session bind timer-tui <session-id>
rccs schedule add wake-1 2026-09-16T12:00:00Z 'wake body' --session timer-tui
rccs schedule add recurring-1 2026-09-16T12:00:00Z 'wake body' --session timer-tui --every 5m
rccs schedule add subagent-1 2026-09-16T12:00:00Z 'run task' --action subagent --target codex_tui/tui-appserver
rccs schedule list
rccs schedule show wake-1
rccs schedule update wake-1 --body 'updated body'
rccs schedule pause wake-1
rccs schedule resume wake-1
rccs schedule stop wake-1
rccs schedule remove wake-1
rccs hook disable stop
rccs hook enable stop
```

`rccs session bind` persists the alias-to-target mapping in hooksd;
`rccs schedule add` resolves that alias and enables the timer operator. The
daemon ticks once per second and sends due notifications through the same
status gate as every other intent. `idle_only` remains the default.
`--every <duration>` creates a recurring notification. Missed occurrences are
coalesced, so daemon downtime or a busy target does not produce a burst.

`--action subagent` uses the native Codex App Server `thread/start` and
`turn/start` operations to create and run a new subagent task. It requires a
configured target scope instead of a session binding. Recurring subagent
creation requires explicit `--allow-concurrent`.

`schedule update` is patch-only: it changes only supplied fields and preserves
runtime evidence. `schedule pause` is reversible, `schedule stop` is a terminal
agent stop that preserves the record, and `schedule remove` is a terminal
cancellation. A stopped or cancelled schedule never fires again.

The installed MCP wrapper is read-only. Register it once with
`codex mcp add routecodex-hooks -- routecodex-hooks-mcp` and use its
`routecodex_hooks_status` tool to query health, operators, and schedules.

The installed `routecodex-hooksd` wrapper is the stable daemon process entry
for the RouteCodex lifecycle supervisor:

```bash
routecodex-hooksd --config ~/.codex/routecodex-hooks/config/hooksd.json \
  --state-file ~/.codex/routecodex-hooks/state/state.json
```

```bash
npm run check
npm test
```

The daemon entry point accepts the RouteCodex-internal CodexApp Unix control
bridge. It never starts with a fake or guessed transport:

```bash
node src/daemon-entry.js --port 8787 --config config/hooksd.example.json
```

Bridge mode uses `codexapp.socket`, a registered `source_address`, and
explicit `target_scopes` entries such as
`codex_tui/tui-appserver: local:tui`; see
[`config/hooksd.example.json`](config/hooksd.example.json). The adapter maps
the bridge `send` method to the typed `send_message_to_thread` capability.

The daemon persists to a JSON state file and exposes `/health`,
`/v1/hooks/dispatch`, `/v1/state`, `/v1/delivery/evidence`, and the read/mutation
control endpoints.
The delivery endpoint accepts only one exact native-evidence transition at a
time. The entry point is a framework process boundary; it does not claim that the supplied module has
proven native Desktop/TUI delivery.

The tests prove the local command/stdin boundary, HTTP daemon boundary, status
gate, send/defer/resume behavior, fail-closed states, idempotency, the full
9-state × 2-mode gate matrix, daemon-driven session-bound timer delivery, and
Stopless/update-goal kind separation, explicit CodexApp bridge mapping,
official event coverage, and the MCP/CLI control boundary. They do not claim
RouteCodex managed-lifecycle proof. See
[`docs/framework-graph.md`](docs/framework-graph.md).
