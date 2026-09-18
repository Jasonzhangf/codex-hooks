# RCCS Framework Lifecycle

Status: Stage 2 implementation surface. Schedule, delivery, subagent
create/list/stop, Stopless goal review, and LongHorizon registration/control
are implemented. Tool-call policy and request augmentation remain separate
boundaries and are not claimed as implemented here.

This document is the lifecycle contract for the independent `rccs` CLI and the
hooks framework. It separates the planes by ownership and evidence, so no
later capability reintroduces a second scheduler, a second delivery path, or a
payload-based control channel.

## 1. Ownership

| Plane | Owner | Current status |
| --- | --- | --- |
| Delivery | `hooksd` `MessageIntent` state, CodexApp send gate | implemented |
| Schedule | `hooksd` persisted schedule state and daemon clock | implemented |
| Stop interception | official Stop hook + goal-review policy | implemented |
| Tool-call interception | official PreToolUse / PermissionRequest / PostToolUse adapters | contract-only |
| Request augmentation | provider request assembly boundary | design-only |
| Subagent creation and stop | CodexApp `thread/start`, `turn/start`, `turn/interrupt` | implemented |

`rccs` is the only authorized mutation surface. MCP remains read-only.
Official hooks validate and adapt events; they do not own policy state.

## 2. Four framework planes

### Delivery Plane

Normal input, scheduled notifications, sleep/noop wakeups, and stopless daemon
feedback all enter the same `MessageIntent` lifecycle:

```text
created -> suppressed | queued | deferred | emitted
emitted -> sending -> accepted -> sent -> delivered -> executed
sent -> replied -> read -> consumed | acknowledged
sending -> failed | unknown_delivery
```

The delivery plane owns the target, send mode, idempotency key, expiry, and
native receipt evidence. A queued or deferred intent is not a send. An accepted
native result is not delivery. Unknown or disconnected session state fails
closed.

### Stop Interception

The official Stop hook observes the terminal-stop event and produces one of:

- no-op;
- a `MessageIntent` that carries daemon feedback to the same session;
- an explicit failure.

The stop decision does not rewrite the original request. A stopless loop is
therefore two separate operations: interception decides whether to continue,
and the delivery plane sends the feedback message.

### Request Augmentation Plane

Request augmentation runs after the complete tool list and system/developer
context are assembled, and before the provider request is sent. The target
contract may:

- inject or update tool schemas;
- inject a feedback schema;
- modify system or developer prompts;
- attach model/effort selection at the request boundary.

This plane is design-only in the current release. No implemented Hook or
`rccs` command provides provider request/schema injection or a Codex
configuration-profile selector.

This plane is separate from the delivery plane. Stopless daemon feedback is a
message; stopless request/schema injection is part of request assembly. A hook
must not use stdout injection as a hidden second path into this plane.

### Tool-call Interception

PreToolUse, PermissionRequest, and PostToolUse hooks observe a tool call and
project `observe`, `allow`, `deny`, `delay`, or a future rewrite. They never
own delivery state or schedule state, and they never reconstruct control truth
from logs or tool payload.

## 3. Schedule lifecycle

Schedule state is persisted by hooksd and mutated only through `rccs` or the
same typed control endpoint:

```text
absent -> configured -> enabled -> due -> claimed -> send_pending -> sent
enabled -> disabled -> enabled
configured | enabled | disabled | deferred_while_working -> stopped
configured | disabled -> cancelled
```

`rccs schedule` supports:

```bash
rccs schedule add <id> <at> <body> ...
rccs schedule list [--global|--session <session-id>]
rccs schedule show <id>
rccs schedule update <id> [--at ...] [--body ...] [--every ...] ...
rccs schedule pause <id>
rccs schedule resume <id>
rccs schedule stop <id>
rccs schedule remove <id>
rccs wait <duration> [body] [--async] [--session <alias>]
rccs subagent list [--global|--session <session-id>]
rccs subagent show <thread-id>
rccs subagent stop <thread-id>
```

`schedule list` and `subagent list` default to the current session inferred
from `CODEX_SESSION_ID` or `CODEX_THREAD_ID`. `--global` explicitly lists every
registered record. `wait` is a one-shot schedule: its default CLI form blocks
in the daemon until a terminal delivery state, while `--async` returns after
registration and lets the daemon wake the session at the deadline. Agents must
use this instead of polling for waits of one minute or more.

Semantic distinctions:

| Operation | State | Meaning |
| --- | --- | --- |
| pause | `disabled` | reversible; no tick fires |
| resume | `enabled` | rearm a paused schedule |
| stop | `stopped` | terminal agent stop; future firing disabled; evidence retained |
| remove | `cancelled` | record cancellation; may also cancel a stopped record; evidence retained |
| update | unchanged unless timing/target/action changed | patch-only update |

`stop` is accepted only from `configured`, `enabled`, `disabled`, or
`deferred_while_working`. It does not overwrite a completed or unresolved
delivery record.

`remove` is the explicit record-cancellation command. It may cancel a stopped
record, but it does not rearm either terminal state.

`update` changes only supplied fields. It does not reset unrelated runtime
evidence. Changing `at`, `mode`, `interval`, `target`, or `action` clears only
occurrence scheduling fields and returns the schedule to `configured`; a body
or send-mode patch preserves the current lifecycle state.

Recurring occurrences are coalesced. If multiple due intervals accumulate while
the daemon is down or the target is busy, only one occurrence is sent, then the
next interval advances to a future time.

## 4. Session and subagent evidence

Every scheduled notification checks the target before dispatch:

- `idle_only` defers while the session is working or starting;
- `working_allowed` sends while working only when explicitly configured;
- unknown, disconnected, and failed sessions fail closed;
- the target must still exist before every send, so a dead session is not
  repeatedly notified.

Subagent schedules use native `thread/start` and `turn/start`. This native
boundary does not expose a Codex configuration-profile selector, so an
explicit profile selector is not part of the CLI surface and is rejected as an
unsupported option. Explicit `model` and `effort` overrides may be applied
without changing the caller's runtime state. Spawned subagents never inherit
the caller's conversation context; they receive only the typed prompt, target
scope, and explicit override fields.

`rccs subagent stop` reads the native session state first. A working child is
interrupted through `turn/interrupt` with its registered `thread_id` and
`turn_id`; an idle child records `no_active_turn`. Ephemeral children become
`released`, other children become `stopped`. Archive, delete, and close are
not part of the implemented surface.

## 5. LongHorizon modes

LongHorizon is a registered operator with two closed-loop modes. It is opt-in
through `rccs`, active on registration, and can be paused or stopped by an
agent.

Current CLI surface:

```bash
rccs longhorizon register <id> --mode periodic|goal ...
rccs longhorizon list|show|pause|stop|remove <id>
```

### Periodic inspection mode

Registration binds a periodic wake to a fixed prompt and a local document
target. Each cycle checks the target document content, executes the prompt,
and records a new delivery receipt. If the target session is busy, that cycle
is skipped and the next interval rechecks instead of queuing a backlog.

The agent learns from the skill that it owns a stop command for this mode, and
when to use it:

- the periodic task has been completed;
- the task no longer needs recurring inspection;
- ownership or scope has moved;
- the user has asked to stop;
- the session ended.

The stop command is explicit, terminal for the record, and never fires another
periodic message after it is issued. The current CLI does not expose separate
LongHorizon `update` or `resume` commands.

### Goal review mode

Registration schedules a one-shot liveness check after 60 seconds. If the
target is idle or interrupted, the daemon queues a wake that tells the agent to
read the goal and continue. If the target is already working, the occurrence is
skipped without creating a backlog. On later Stop events, the goal reviewer
checks current turn status and goal state. It spawns an isolated subagent with
a fixed reviewer prompt that re-anchors:

- what the goal is;
- what was actually done;
- what the gap is;
- what to do next;
- whether the delivery is genuinely complete.

The reviewer subagent does not inherit the caller's context. User interrupts
must not trigger the reviewer. Network errors, request errors, or missing
runtime evidence must fail closed without blocking the original turn; the
reviewer simply does not run and the Stop path remains explicit.

## 7. Phase order

1. Schedule: CRUD, stop, pause/resume, coalescing, status gating.
2. Stop interception: Stop event -> stopless feedback intent.
3. Tool-call interception: observe/allow/deny/delay.
4. LongHorizon: registration, first liveness check, periodic inspection, goal
   review.
5. Request augmentation: schema, system prompt, and model/effort selection.
6. Subagent model/effort overrides; Codex profile selection remains blocked by
   the native App Server boundary.

Each phase must close its own tests, review, and live-entry evidence before
the next phase claims production capability.
