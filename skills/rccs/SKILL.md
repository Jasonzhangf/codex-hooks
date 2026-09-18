---
name: rccs
description: Use rccs to install and control the local hooks framework, schedule notifications or waits, manage isolated subagents, and configure LongHorizon and Stopless.
---

`rccs` is the single installed Skill and mutation/control surface for the
local hooks framework. MCP is read-only and must not be used to create,
update, stop, send, or spawn.

## Capability matrix

Only the following `rccs` capabilities are supported:

| Capability | Command surface | Native boundary |
| --- | --- | --- |
| Daemon status | `rccs status` | read-only daemon state |
| Session binding | `rccs session bind`, `rccs session unbind` | persisted alias-to-target mapping |
| Notification schedule | `rccs schedule add ... --session <alias>` | native session status + queue send |
| Subagent schedule | `rccs schedule add ... --action subagent --target <namespace>/<appserver>` | native `thread/start` + `turn/start` |
| Schedule control | `rccs schedule list|show|update|remove|pause|resume|stop` | persisted schedule state |
| Daemon wait | `rccs wait <duration>` | native session status + queue send |
| Subagent control | `rccs subagent create|list|show|stop` | native create/start/interrupt |
| LongHorizon control | `rccs longhorizon register|list|show|activate|pause|stop|remove` | periodic schedule or Stop review |
| MCP registration | `rccs mcp register` | read-only MCP wrapper |
| Configuration and switches | `rccs config`, `rccs hook`, `rccs supervisor`, `rccs operator` | local installation/config state |

The command surface is limited to the rows above. Do not infer additional
operations from the App Server bridge.

The native session status used by scheduling is limited to the states exposed
by the current bridge: `idle`, `working`, `starting`, `stopping`, `failed`,
`disconnected`, and `unknown`. The current bridge reports `input_active` as
`false`; do not rely on input-active suppression as a verified rccs capability.

## Install and health

Install or refresh the framework and its skills idempotently:

```sh
rccs init
rccs status
```

From a source checkout, use `npm run init` to refresh the installed CLI, hooks,
and skills. From an installed copy, `rccs init` refreshes from the installed
source. Both are idempotent. The installer copies the bundled `skills/` into
`~/.agent/skills` and `~/.codex/skills`, rewrites the wrappers, preserves
unrelated hook entries, and removes only the retired managed Skill directories
`routecodex-hooks`, `scheduling`, `stopless`, and `update-goal`. The only
managed Skill installed by this repository is `rccs`.

The installer creates the daemon configuration and executable CLI, MCP,
daemon, supervisor, and CodexApp wrappers. It registers only the managed
official Stop hook and preserves unrelated entries in `hooks.json`.

MCP exposes `routecodex_hooks_status` as a read-only daemon status tool. Use it
to read health, operators, bindings, schedules, subagents, LongHorizon state,
goal reviews, stop suppression, and delivery evidence. Do not mutate through
MCP.

Every documented command group supports side-effect-free
`rccs <command> --help`.

For an isolated install, pass `--codex-home`, `--agent-home`, `--bin-dir`, and
`--endpoint`. The installed `routecodex-hooks` command remains a compatibility
alias; new usage should use `rccs`.

Inspect or change local configuration with:

```sh
rccs config show
rccs config set endpoint http://127.0.0.1:8787
rccs config set codexapp_socket /path/to/codexapp.sock
rccs config set source_scope local:hooks
rccs config set source_session hooksd
rccs config set target_scope codex_tui/tui-appserver=local:tui
rccs config set target '{"namespace":"codex_tui","appserver_id":"tui-appserver","scope_id":"local:tui","endpoint":"unix:///path/to/app-server-control.sock"}'
```

The current hook switch surface manages only the official Stop hook:

```sh
rccs hook disable stop
rccs hook enable stop
rccs supervisor enable
rccs supervisor disable
rccs operator enable timer
rccs operator disable timer
```

`rccs operator enable|disable` accepts only an operator listed by `rccs
status`. The operator registry currently marks `stopless`, `timer`, and
`longhorizon` implemented; `update-goal` is contract-only and `memory` is
out of scope. Stopless is normally enabled by activating a LongHorizon `goal`
record, not by treating the operator switch as a separate product policy.

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
| `--send-mode idle_only` | default | Defer while the target is working. |
| `--send-mode working_allowed` | opt-in | Permit a working target only when explicitly requested. |
| `--busy-policy defer` | default | Persist one pending occurrence and flush it when the target becomes eligible. |
| `--busy-policy skip` | opt-in | Record a skipped occurrence and wait for the next interval; no backlog is created. |
| `--action notify` | default | Send the body to the bound session. |
| `--action subagent` | opt-in | Create a fresh native child from the body prompt. Requires `--target`. |
| `--cwd <absolute-path>` | native default | Working directory for a subagent schedule. |
| `--model <model>` | native default | Explicit child model override. |
| `--effort <effort>` | native default | Explicit child effort override. |
| `--ephemeral` | true for subagent creation | Optional explicit assertion; `subagent create` and subagent schedules always use an ephemeral thread. |
| `--allow-concurrent` | false | Required for recurring subagent creation. |
| `--owner-session <session-id>` | current session when available | Ownership scope used by `list` and stop controls. |

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

## Delivery behavior

Notification schedules and waits use native queue delivery. `rccs subagent
stop` is the only current `rccs` path that uses `turn/interrupt`. An accepted
queue result is not delivery, execution, or a reply; inspect the delivery
evidence exposed by `rccs status` or MCP.

The hook receives official JSON on stdin and forwards it to hooksd. hooksd owns
policy state, persistence, idempotency, running-state gating, and the send
decision; CodexApp is the only message sender. An idle-only intent is deferred
while the target is working. Unknown, disconnected, failed, missing, or dead
targets fail closed. A Stop event with `stop_hook_active: true` is guarded
before an intent is created.

The installed `routecodex-hooksd` wrapper is the daemon process entry for the
RouteCodex lifecycle supervisor. For RouteCodex-managed startup, enable the
supervisor with `rccs supervisor enable`; startup order is CodexApp ready then
hooksd ready, and shutdown order is hooksd then CodexApp.

An internal CodexApp wake and official Stop `decision: "block"` are mutually
exclusive. The send path returns ordinary successful hook output and does not
claim delivery or execution. Do not use `continue: false` as delivery
evidence. A non-zero hook exit means the daemon rejected or could not safely
process the event.

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

`rccs subagent show` is registry-only; it does not read or return the child's
final model result.

Subagent schedules create ephemeral children; `--ephemeral` states that
contract explicitly. Recurring subagent creation requires `--allow-concurrent`.
`subagent stop` reads native status first and, for a working turn, sends
`turn/interrupt` with the recorded `thread_id` and `turn_id`. An idle child
records `no_active_turn`; an ephemeral child becomes `released`, otherwise it
becomes `stopped`. Archive, delete, and close are not part of the command
surface. Never claim stop from an accepted request alone; inspect the returned
state and stop evidence.

`--model` and `--effort` are passed to the native child when supplied.

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

### LongHorizon parameters

| Parameter | Default | Meaning |
| --- | --- | --- |
| `<id>` | required | Stable LongHorizon record identity. |
| `--mode periodic` | required | Recurring inspection mode. Requires `--prompt`, `--session`, and `--every`. |
| `--mode goal` | required | Stop-triggered goal review mode. Requires `--goal-file` and `--session`. |
| `--prompt <text>` | none | Fixed prompt for periodic mode. |
| `--goal-file <path>` | none | Goal document for goal mode. |
| `--session <alias>` | none | Bound session target resolved at registration. |
| `--every <duration>` | none | Periodic interval in `ms`, `s`, `m`, `h`, or `d`. |
| `--at <ISO-8601>` | current time | First occurrence for periodic mode. |
| `--owner-session <session-id>` | current session when available | Ownership scope for list and control. |
| `--review-budget <count>` | `1` for goal mode | Maximum reviewer count recorded for the goal record. |

`periodic` mode owns a paused recurring schedule with `busy_policy=skip`.
`goal` mode enables Stopless goal review: an eligible Stop event creates one
isolated ephemeral reviewer, validates its structured report, and sends one
feedback intent only when a gap and next action are present. User interrupts
and `stop_hook_active` suppress review. Reviewer/network/schema failures are
recorded as unresolved or failed and do not block the original Stop.

The current CLI supports `register`, `list`, `show`, `activate`, `pause`,
`stop`, and `remove`. It does not expose a separate LongHorizon update or
resume command.

`periodic` mode owns a paused recurring schedule with `busy_policy=skip`.
`goal` mode enables Stopless goal review: an eligible Stop event creates one
isolated ephemeral reviewer, validates its structured report, and sends one
feedback intent only when a gap and next action are present. User interrupts
and `stop_hook_active` suppress review. Reviewer, network, schema, and
subagent capability failures are recorded as unresolved or failed and do not
block the original Stop.

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
injection is therefore not an implemented `rccs` capability. Do not simulate
it through a schedule body or message text.

## Boundaries

The framework implements the official Stop hook path, daemon
state/persistence boundaries, the typed CodexApp bridge, `rccs` configuration
and switches, read-only MCP status, one-shot and recurring notification
delivery, occurrence coalescing, native subagent creation/stop, Stopless goal
review, and LongHorizon periodic/goal registration.

Update-goal mutation and memory behavior remain outside this surface.
RouteCodex-managed sidecar startup is implemented by the RouteCodex lifecycle
integration; this repository's tests do not replace RouteCodex live
lifecycle evidence.
