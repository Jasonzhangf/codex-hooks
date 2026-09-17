---
name: rccs
description: Use the rccs CLI to schedule wakeups, wait without polling, inspect daemon state, and manage spawned subagents.
---

`rccs` is the mutation and control surface for the local hooks daemon. MCP is
read-only and must not be used to create, update, stop, send, or spawn.

## Install and health

Install or refresh the framework and its skills idempotently:

```sh
rccs init
rccs status
```

`rccs init` copies the bundled `skills/` into `~/.agent/skills` and
`~/.codex/skills`, rewrites the wrappers, and can be repeated safely. MCP
exposes `routecodex_hooks_status` as a read-only daemon status tool. Use it to
read health, schedules, bindings, subagents, LongHorizon state, and delivery
evidence. Do not mutate through MCP.

Use `rccs <command> --help` before constructing a command when the exact
argument shape matters. Help is side-effect free.

## Scheduling and waiting

Bind the current session once, then use its alias. When `CODEX_SESSION_ID` or
`CODEX_THREAD_ID` matches a binding, `rccs` can select it automatically.

```sh
rccs session bind work <session-id>
rccs schedule add check 2026-09-16T12:00:00Z 'inspect the goal document' --session work
rccs schedule add pulse 2026-09-16T12:00:00Z 'continue the task' --session work --every 5m
rccs schedule list
rccs schedule list --global
rccs schedule show check
rccs schedule update check --body 'updated prompt'
rccs schedule pause check
rccs schedule resume check
rccs schedule stop check
```

### Schedule parameters

| Parameter | Default | Meaning |
| --- | --- | --- |
| `--session <alias>` | required for notify/wait | Resolve the persisted target at registration time. Changing the binding later does not retarget the schedule. |
| `--target <namespace>/<appserver>` | required for subagent | Native target scope for a subagent schedule. |
| `--once` | default | One-shot occurrence. It cannot be combined with `--every`. |
| `--every <duration>` | none | Recurring interval in `ms`, `s`, `m`, `h`, or `d`, for example `5m`. |
| `--send-mode idle_only` | default | Defer while working or input-active. |
| `--send-mode working_allowed` | opt-in | Permit a working target only when explicitly requested; input-active still suppresses. |
| `--busy-policy defer` | default | Persist one pending occurrence and flush it when the target becomes eligible. |
| `--busy-policy skip` | opt-in | Record a skipped occurrence and wait for the next interval; no backlog is created. |
| `--action notify` | default | Send the body to the bound session. |
| `--action subagent` | opt-in | Create a fresh native child from the body prompt. Requires `--target`. |
| `--cwd <absolute-path>` | native default | Working directory for a subagent schedule. |
| `--model <model>` | native default | Explicit child model override. |
| `--effort <effort>` | native default | Explicit child effort override. |
| `--ephemeral` | optional for subagent schedule | Explicit assertion that the native child is disposable. Subagent schedules always use an ephemeral thread. |
| `--allow-concurrent` | false | Required for recurring subagent creation. |
| `--owner-session <session-id>` | current session when available | Ownership scope used by `list` and stop controls. |
| `--profile <profile>` | rejected | The native `thread/start` boundary has no Codex profile selector. It is rejected, never silently ignored. |

`schedule list` defaults to the current session. Use `--global` to inspect all
schedules. `schedule stop` is terminal and disables future firing. `pause` and
`resume` are reversible. A recurring notification coalesces missed occurrences
into one delivery. A missing, unknown, disconnected, or failed target fails
closed; a dead session is not repeatedly notified.

For waits of one minute or more, do not poll in the agent. Register a one-shot
daemon wait. The default form blocks in the CLI until delivery reaches a
terminal state; `--async` returns after registration and lets the daemon wake
the session later.

```sh
rccs wait 2m 'continue after the wait' --session work
rccs wait 30m 'recheck the long-running task' --session work --async
```

### Wait parameters

| Parameter | Default | Meaning |
| --- | --- | --- |
| `<duration>` | required | Wait deadline in `ms`, `s`, `m`, `h`, or `d`. |
| `[body]` | `Wait elapsed. Continue the current task.` | Message sent when the wait expires. |
| `--session <alias>` | current matching binding | Target binding. |
| `--async` | false | Register and return immediately instead of blocking. |
| `--send-mode idle_only` | async default | Defer until idle. |
| `--send-mode working_allowed` | blocking default | Permit delivery while working. |
| `--busy-policy defer` | default | Persist the pending wake when delivery is not currently legal. |
| `--busy-policy skip` | opt-in | Record a skipped occurrence instead of retaining it. |
| `--id <id>` | `wait-<timestamp>-<pid>` | Deterministic schedule identity. |
| `--timeout <duration>` | daemon wait limit | Maximum blocking wait before returning `wait_timed_out`. |
| `--owner-session <session-id>` | current session when available | Ownership scope. |

## Send operations

Ordinary schedules and waits use the standard queue path. They do not expose a
CLI option that silently changes their delivery into a steer or interrupt.

| Operation | Legal use | Forbidden use |
| --- | --- | --- |
| `queue` | Ordinary notification, wait wakeup, Stopless feedback, LongHorizon wake, or explicitly allowed working delivery. | Unknown/disconnected target, active manual input, or a target that cannot accept queued submissions. |
| `steer` | One live working turn exists, the caller explicitly selects same-turn correction, and the turn identity matches the observed active turn. | Ordinary schedule text, missing or stale turn identity, idle target, or automatic retry. |
| `interrupt` | Explicit user or control-plane stop, including `rccs subagent stop`. | Normal message delivery, retry, or replacing queue behavior. |

Queue is the default. Steer and interrupt are never inferred from message text.
`rccs subagent stop` is the only current CLI path that intentionally uses
`turn/interrupt`.

## Subagents

Subagent schedules use native App Server `thread/start` and `turn/start`; they
do not inherit the caller's conversation.

```sh
rccs schedule add review 2026-09-16T12:00:00Z 'review the candidate' \
  --action subagent --target codex_tui/tui-appserver --ephemeral
rccs subagent list
rccs subagent list --global
rccs subagent show <thread-id>
rccs subagent stop <thread-id>
```

Subagent schedules create ephemeral children; `--ephemeral` states that
contract explicitly. Recurring subagent creation requires `--allow-concurrent`.
`subagent stop` reads native status first and, for a working turn, sends
`turn/interrupt` with the recorded `thread_id` and `turn_id`. An idle child
records `no_active_turn`; an ephemeral child becomes `released`, otherwise it
becomes `stopped`. Archive, delete, and close are not part of the command
surface. Never claim stop from an accepted request alone; inspect the returned
state and stop evidence.

`--model` and `--effort` are passed to the native child when supplied.
`--profile` is rejected explicitly because this App Server `thread/start`
boundary has no Codex configuration-profile selector; do not retry it as a
silent fallback.

## LongHorizon

LongHorizon is registered paused and requires explicit activation:

```sh
rccs longhorizon register review --mode goal --goal-file /path/goal.md --session work
rccs longhorizon activate review
rccs longhorizon list
rccs longhorizon show review
rccs longhorizon pause review
rccs longhorizon stop review
```

`periodic` mode owns a paused recurring schedule with `busy_policy=skip`.
`goal` mode enables Stopless goal review: an eligible Stop event creates one
isolated ephemeral reviewer, validates its structured report, and sends one
feedback intent only when a gap and next action are present. User interrupts
and `stop_hook_active` suppress review. Reviewer/network/schema failures are
recorded as unresolved or failed and do not block the original Stop.

## Stop conditions

The agent owns explicit stop commands for recurring work:

```sh
rccs schedule stop <id>
```

Use it when the goal is complete, the recurring task is no longer needed,
ownership moved, the user asked to stop, or the session ended. Do not keep a
recurring wake alive merely because it was previously registered.

## Request and schema injection

The official Hook surface can provide `additionalContext` on `SessionStart`
and `UserPromptSubmit`. It cannot modify the complete provider request, append
arbitrary tool schemas, or rewrite the final system prompt. Request/schema
injection is therefore `blocked`; do not simulate it through message text.
