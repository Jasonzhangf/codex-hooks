---
name: rccs
description: Use the rccs CLI to schedule wakeups, wait without polling, inspect daemon state, and manage spawned subagents.
---

`rccs` is the mutation surface for the local hooks daemon. MCP only reads
daemon health and state.

## Install and health

Install or refresh the framework and its skills idempotently:

```sh
rccs init
rccs status
```

`rccs init` copies the bundled `skills/` into `~/.agent/skills` and
`~/.codex/skills`, rewrites the wrappers, and can be repeated safely. MCP exposes
`routecodex_hooks_status` as a read-only daemon status tool; use it to check
health, schedules, session bindings, and subagent registry state. Do not mutate
through MCP.

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

`schedule list` defaults to the current session. Use `--global` to inspect all
schedules. A recurring notification coalesces missed occurrences into one
delivery. `idle_only` is the default: while the target is working, delivery is
deferred until it is idle. Use `--send-mode working_allowed` only when the
message is safe to inject during a working turn.

For waits of one minute or more, do not poll in the agent. Register a one-shot
daemon wait. The default form blocks in the CLI until delivery reaches a
terminal state; `--async` returns after registration and lets the daemon wake
the session later.

```sh
rccs wait 2m 'continue after the wait' --session work
rccs wait 30m 'recheck the long-running task' --session work --async
```

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
contract explicitly. Recurring subagent creation requires `--allow-concurrent`. `subagent stop`
reads native status first and, for a working turn, sends `turn/interrupt` with
the recorded `thread_id` and `turn_id`. An idle child records
`no_active_turn`; an ephemeral child becomes `released`, otherwise it becomes
`stopped`. Archive, delete, and close are not part of the command surface.
Never claim stop from an accepted request alone; inspect the returned state
and stop evidence.

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
