---
name: scheduling
description: Use rccs to bind sessions, wait without polling, and create one-shot or recurring notifications or subagent schedules.
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
substitute for native creation. `--model` and `--effort` are forwarded to the
native child. `--profile` is rejected explicitly because the current App Server
`thread/start` boundary has no Codex configuration-profile selector.

Do not poll inside an agent for waits of one minute or more. Register a
one-shot daemon wait instead:

```sh
rccs wait 5m 'continue the task' --session timer-tui
rccs wait 30m 'recheck the task' --session timer-tui --async
```

The default wait blocks in the CLI until the daemon reaches a terminal delivery
state. `--async` returns after registration and wakes the session at the
deadline. `schedule list` defaults to the current session; use `--global` for
all schedules.

Use `rccs subagent list` and `rccs subagent list --global` to inspect spawned
children. Stop one only through `rccs subagent stop <thread-id>`; the daemon
checks native status and sends `turn/interrupt` with the registered
`thread_id` and `turn_id` when a turn is working. An idle child records
`no_active_turn`; an ephemeral child becomes `released`, otherwise it becomes
`stopped`. Archive, delete, and close are not part of this path.

For recurring goal inspection, register LongHorizon instead of keeping an
agent-side polling loop:

```sh
rccs longhorizon register check --mode periodic --prompt 'Inspect the goal document and continue.' \
  --session timer-tui --every 5m
rccs longhorizon activate check
rccs longhorizon stop check
```

`periodic` uses `busy_policy=skip`: a busy target skips the occurrence and the
next interval is the next opportunity. For a Stop-triggered review, register
`--mode goal --goal-file <path> --session <alias>` and activate it. Goal review
is disabled until activation and can be paused or stopped with the same
LongHorizon commands.
