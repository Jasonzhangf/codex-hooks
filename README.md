# RouteCodex Hooks Framework

This repository is the empty framework boundary for RouteCodex lifecycle
hooks. It intentionally does not implement Stopless, scheduling, memory, or
goal mutation behavior.

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

The official Stop hook is an adapter. When the daemon has successfully sent a
wake message, the adapter returns `{"continue":false}`. It does not return
`decision:"block"` at the same time, because official Stop `decision:"block"`
creates a separate automatic continuation prompt.

`update_goal` is a separate tool-hook matcher and policy kind. It does not
share Stopless counters, timer state, or a generic post-turn handler.

## Local verification

```bash
npm run check
npm test
```

The tests prove the local command/stdin boundary, HTTP daemon boundary, status
gate, send/defer/resume behavior, fail-closed states, idempotency, and
Stopless/update-goal kind separation. They do not claim real TUI/Desktop
App-Server or RouteCodex managed-lifecycle proof. See
[`docs/framework-graph.md`](docs/framework-graph.md).
