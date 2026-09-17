---
name: scheduling
description: Use rccs to bind sessions and create one-shot or recurring notifications or subagent schedules.
---

The scheduling skill teaches `rccs` schedule operations. Runtime schedule
state, timers, persistence, and delivery belong to the daemon. MCP is
query-only and CLI is the mutation surface. At fire time a notification creates
a `MessageIntent`; `codexapp.sendmessage` is the only wake action. A subagent
schedule uses the native Codex App Server `thread/start` and `turn/start`
operations.

Bind a session once, then schedule against its alias:

```sh
rccs session bind timer-tui <session-id>
rccs schedule add wake-1 <at-iso8601> '<body>' --session timer-tui
rccs schedule add recurring-1 <at-iso8601> '<body>' --session timer-tui --every 5m
```

The daemon owns the persisted binding, schedule state, one-second clock, and
delivery ledger. `idle_only` is the default send mode and `working_allowed`
must be explicit. Missed recurring occurrences are coalesced: after downtime,
the next tick sends one occurrence, then advances to the next future interval.
The target session is checked before every notification; unknown, disconnected,
or failed sessions fail closed.

One-shot or recurring subagent creation uses a target scope rather than a
session binding:

```sh
rccs schedule add subagent-1 <at-iso8601> '<prompt>' \
  --action subagent \
  --target codex_tui/tui-appserver \
  --cwd /absolute/path
```

Recurring subagent schedules require explicit `--allow-concurrent`. The receipt
records the created thread and turn identities; no tmux text is used as a
substitute for native creation.
