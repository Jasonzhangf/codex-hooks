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

## Parameters

| Parameter | Default | Meaning |
| --- | --- | --- |
| `<id>` | required | Stable schedule identity and idempotency key. |
| `<at>` | required | ISO-8601 first occurrence. |
| `<body>` | required | Notification body or subagent prompt. |
| `--session <alias>` | required for notify | Persisted target binding. The binding is resolved at registration, not silently followed later. |
| `--target <namespace>/<appserver>` | required for subagent | Native target scope. |
| `--once` | default | One-shot schedule. Mutually exclusive with `--every`. |
| `--every <duration>` | none | Recurring interval: positive `ms`, `s`, `m`, `h`, or `d`. |
| `--send-mode idle_only` | default | Defer while the target is working. |
| `--send-mode working_allowed` | opt-in | Permit a working target only when explicitly selected. |
| `--busy-policy defer` | default | Keep one pending occurrence and flush it when eligible. |
| `--busy-policy skip` | opt-in | Record a skipped occurrence and wait for the next interval; no backlog. |
| `--action notify` | default | Queue the body to the bound session. |
| `--action subagent` | opt-in | Create an isolated native child from the prompt. |
| `--cwd <absolute-path>` | native default | Child working directory. |
| `--model <model>` | native default | Explicit child model override. |
| `--effort <effort>` | native default | Explicit child effort override. |
| `--ephemeral` | true for subagent | Optional explicit assertion; subagent creation and subagent schedules always use an ephemeral thread. |
| `--allow-concurrent` | false | Required for recurring subagent creation. |
| `--owner-session <session-id>` | current session when available | Scope used by list/stop controls. |

`defer` and `skip` are different state effects. `defer` persists one pending
intent and can deliver later after the target becomes idle. `skip` records the
occurrence as skipped, creates no intent, and waits for the next interval.
Neither policy retries a dead target indefinitely.

The daemon owns the persisted binding, schedule state, one-second clock, and
delivery ledger. Missed recurring occurrences are coalesced: after downtime,
the next tick sends one occurrence, then advances to the next future interval.
The target session is checked before every notification; unknown, disconnected,
failed, and missing sessions fail closed. The current native bridge reports
`input_active` as `false`; do not rely on input-active suppression as a
verified scheduling capability.

## Subagent schedules

One-shot or recurring subagent creation uses a target scope rather than a
session binding:

```sh
rccs schedule add subagent-1 <at-iso8601> '<prompt>' \
  --action subagent \
  --target codex_tui/tui-appserver \
  --ephemeral \
  --cwd /absolute/path
```

Subagent schedules always use an ephemeral native thread; `--ephemeral` makes
that fixed behavior explicit. Recurring subagent schedules require explicit
`--allow-concurrent`. The receipt records the created thread and turn
identities; no tmux text is used as a substitute for native creation.
`--model` and `--effort` are forwarded to the native child.

## Waiting

Do not poll inside an agent for waits of one minute or more. Register a
one-shot daemon wait instead:

```sh
rccs wait 5m 'continue the task' --session timer-tui
rccs wait 30m 'recheck the task' --session timer-tui --async
```

The default wait blocks in the CLI until the daemon reaches a terminal delivery
state. `--async` returns after registration and wakes the session at the
deadline. `--busy-policy defer` is the default; `skip` records a skipped wait.
`--send-mode` defaults to `working_allowed` for blocking waits and `idle_only`
for async waits.

`schedule list` defaults to the current session; use `--global` for all
schedules. `schedule stop <id>` is terminal and disables future firing.
`pause` and `resume` are reversible. Stop when the goal is complete, the
recurring task is no longer needed, ownership moved, the user asked to stop,
or the session ended.

## Delivery behavior

Notification schedules and waits use native queue delivery. `rccs subagent
stop` uses `turn/interrupt` for a working child. There is no separate `rccs`
schedule operation that changes ordinary text into a different delivery mode.

## Subagent inspection

Use `rccs subagent list` and `rccs subagent list --global` to inspect spawned
children. Stop one only through `rccs subagent stop <thread-id>`; the daemon
checks native status and sends `turn/interrupt` with the registered
`thread_id` and `turn_id` when a turn is working. An idle child records
`no_active_turn`; an ephemeral child becomes `released`, otherwise it becomes
`stopped`. `rccs subagent show` is registry-only and does not read the child's
final result. Archive, delete, and close are not part of this path.

## LongHorizon

For recurring goal inspection, register LongHorizon instead of keeping an
agent-side polling loop:

```sh
rccs longhorizon register check --mode periodic --prompt 'Inspect the goal document and continue.' \
  --session timer-tui --every 5m
rccs longhorizon activate check
rccs longhorizon stop check
```

`periodic` uses `busy_policy=skip`: a busy target skips the occurrence and the
next interval is the next opportunity. Its register form requires
`--prompt`, `--session`, and `--every`; `--at` is optional.

For a Stop-triggered review, register
`--mode goal --goal-file <path> --session <alias>` and activate it. Goal review
is disabled until activation and can be paused or stopped with the same
LongHorizon commands. `--review-budget` and `--owner-session` are optional.
The current CLI supports `register`, `list`, `show`, `activate`, `pause`,
`stop`, and `remove`; it does not expose a separate update or resume command.
