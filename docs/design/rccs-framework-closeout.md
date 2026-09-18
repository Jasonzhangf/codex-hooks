# RCCS Framework Closeout Design

Status: Stage 2 implemented contract. This document defines the closeout
target and records which Stage 2 edges are implemented. It supersedes the
legacy subagent close/archive wording in
[`rccs-framework-lifecycle.md`](rccs-framework-lifecycle.md) and the close
states in [`state-machine.md`](state-machine.md). The canonical machine-readable
state is [`contracts/state-machine.json`](../../contracts/state-machine.json).

## 1. Scope and invariants

This closeout covers:

- one independent `rccs` CLI for mutations and control operations;
- schedule notifications and daemon wait/no-op wakeups;
- native subagent creation, listing, and stop;
- read-only MCP projection;
- idempotent skill and MCP registration;
- Stopless and LongHorizon lifecycle boundaries;
- an explicit request-augmentation boundary that does not modify Codex.

The following are hard invariants:

1. `rccs` is the only mutation surface.
2. MCP is read-only.
3. `hooksd` owns schedule state, session bindings, idempotency, status gating,
   and delivery decisions.
4. Codex App Server is the only native send, status, and subagent boundary.
5. No second send path, synthetic Hook event, log-derived control state, or
   payload-based control channel is allowed.
6. An accepted native send is not delivery, execution, reply, or read.
7. Unknown, disconnected, failed, or dead targets fail closed.
8. The runtime must not modify `/Users/fanzhang/code/codex`.
9. Subagent stop is `turn/interrupt`. Archive, delete, and close are not part
   of the `rccs` closeout path.

## 2. Current capability ledger

The implementation already present on `origin/main` is the starting point.
This ledger separates implemented source edges from remaining boundaries.

| Capability | Current state | Closeout action |
| --- | --- | --- |
| `rccs` binary and CLI dispatcher | implemented | preserve as the only CLI entry |
| Schedule add/list/show/update/pause/resume/stop/remove | implemented with tests | harden stop cancellation and argument contracts |
| One-shot and recurring notification timers | implemented, one-second daemon tick | add busy-policy selection and explicit dead-session handling |
| Blocking and async `wait` | implemented, live receipt recorded | keep as a one-shot schedule; no polling |
| Persisted schedule and outbox state | implemented | preserve restart recovery and no blind retry |
| Status gate matrix | implemented | keep [`state-machine.md`](state-machine.md) as the gate reference |
| Coalescing missed occurrences | implemented | keep one occurrence per catch-up window |
| Automatic delivery reconciliation | implemented | daemon-owned polling through `codexapp.message_status` |
| Subagent creation through `thread/start` and `turn/start` | implemented | `rccs subagent create` uses a fresh, isolated thread |
| Subagent list/show | registry projection implemented | list returns registry records; `show` is registry-only |
| Subagent stop | implemented | `turn/interrupt` with registered thread/turn; no close/archive |
| Read-only MCP server | implemented | keep `routecodex_hooks_status` as the only tool |
| Idempotent MCP registration | implemented | `rccs mcp register` is called by `rccs init` |
| Skill installation | implemented into `~/.codex/skills` and `~/.agent/skills` | keep idempotent and document every parameter in the skill |
| Stopless Stop policy | implemented; `intentFactory` is wired in `daemon-entry.js` behind a disabled-by-default LongHorizon goal record |
| Request/schema augmentation | design-only | no `rccs` command or implemented request-boundary extension |
| LongHorizon periodic mode | implemented | paused recurring schedule with skip-while-busy behavior |
| LongHorizon goal mode | implemented | reviewer protocol on Stop with user-interrupt suppression |

## 3. Ownership and data flow

```text
rccs CLI
  -> hooksd control mutation
  -> schedule/session/subagent state
  -> daemon clock or official Hook event
  -> status gate
  -> typed CodexApp port
  -> native App Server
  -> native receipt and later evidence
```

### 3.1 End-to-end ASCII lifecycle

The complete lifecycle graph is in
[`rccs-framework-lifecycle-ascii.md`](rccs-framework-lifecycle-ascii.md).

MCP reads `/health` and `/v1/control/state`. It never posts a mutation, starts
a timer, sends a message, or creates a subagent.

The official Hook adapter validates stdin, forwards one event to `hooksd`, and
projects only the official Hook output. It does not own policy state and does
not call Codex App Server directly.

## 4. CLI surface

The command surface is deliberately small. Options may be added only when
they affect a documented state transition.

### 4.1 Install and registration

```bash
rccs init [--codex-home PATH] [--agent-home PATH] [--bin-dir PATH]
          [--endpoint URL] [--enable-stop-hook] [--disable-stop-hook]
          [--enable-supervisor] [--disable-supervisor]
rccs mcp register [--name routecodex-hooks] [--command routecodex-hooks-mcp]
rccs status
```

`rccs init` is idempotent. It installs the managed source, wrappers, daemon
configuration, and skills, then calls the same idempotent MCP registration
operation. A repeated run with the same inputs must not duplicate the managed
Stop hook, MCP entry, or skill files.

`rccs mcp register` first inspects the existing Codex MCP configuration. If
`routecodex-hooks` already points to the installed wrapper, it reports
`already_registered` and makes no change. If the name exists with a different
command, it fails explicitly instead of overwriting unrelated configuration.

### 4.2 Schedule and wait

```bash
rccs schedule add <id> <at> <body>
  (--session <alias> | --target <namespace>/<appserver>)
  [--once | --every <duration>]
  [--send-mode idle_only|working_allowed]
  [--busy-policy defer|skip]
  [--action notify|subagent]
  [--cwd <absolute-path>]
  [--model <model>]
  [--effort <effort>]
  [--ephemeral]
  [--allow-concurrent]
  [--owner-session <session-id>]

rccs schedule list [--global | --session <session-id>]
rccs schedule show <id>
rccs schedule update <id> [same patchable fields as add]
rccs schedule pause <id>
rccs schedule resume <id>
rccs schedule stop <id>
rccs schedule remove <id>

rccs wait <duration> [body]
  [--session <alias>]
  [--async]
  [--send-mode idle_only|working_allowed]
  [--busy-policy defer|skip]
  [--id <id>]
  [--timeout <duration>]
```

`schedule list` defaults to the current `CODEX_SESSION_ID` or
`CODEX_THREAD_ID`. `--global` lists all schedules. `show` returns one record
without changing state.

`wait` is a one-shot schedule with action `wait`. The default form blocks in
the daemon until a terminal schedule state. `--async` registers the wait and
returns immediately. Agents must use this command for waits of one minute or
more instead of polling.

Parameter semantics belong in the installed `rccs` Skill.
CLI source comments must not become a second specification.

### 4.3 Subagents

```bash
rccs subagent create <prompt>
  --target <namespace>/<appserver>
  [--cwd <absolute-path>]
  [--model <model>]
  [--effort <effort>]
  [--ephemeral]
  [--owner-session <session-id>]

rccs subagent list [--global | --session <session-id>]
rccs subagent show <thread-id>
rccs subagent stop <thread-id>
```

The default `subagent create` path uses a fresh thread and does not inherit the
caller's conversation context. `--ephemeral` maps to native
`thread/start { ephemeral: true }`. The registry records the native thread and
turn identities, the target, and the creation receipt. It does not record a
profile snapshot.

`subagent stop` is the only stop operation. It never calls `thread/archive`,
`thread/delete`, or a simulated close operation. The stop contract is defined
in section 8.

## 5. Send abstraction

All schedule, wait, Stopless delivery, and LongHorizon wakeups produce the same
typed intent:

```text
SendRequest
  intent_id       deterministic idempotency key
  source          timer | wait | stopless | longhorizon | operator
  target          namespace, appserver_id, session_id, thread_id
  body            message body
  send_mode       idle_only | working_allowed
  busy_policy     defer | skip
  operation       queue | steer | interrupt
  turn_id         required for steer or interrupt when native state requires it
  expires_at      optional terminal deadline
```

### 5.1 Operation selection

| Operation | Native operation | Use only when | Never use when |
| --- | --- | --- | --- |
| `queue` | `thread/queue/add` through the typed CodexApp port | ordinary notification, wait wakeup, Stopless feedback, or explicitly allowed working delivery | target is unknown/disconnected or an ephemeral thread cannot accept queued submissions |
| `steer` | `turn/steer` | internal bridge/policy operation only: one live working turn exists, the intent is a same-turn correction, and the policy explicitly selects steer | there is no current `rccs` CLI command for steer; the turn identity is absent, the session is not working, or the intent is an ordinary scheduled notification |
| `interrupt` | `turn/interrupt` | an explicit user or control-plane stop request, including subagent stop | delivering a normal message, retrying a failed send, or automatically replacing queue delivery |

Queue is the default. Steer and interrupt are never inferred from message text.
An ordinary schedule cannot silently become an interrupt.

### 5.2 Busy and status behavior

The status gate is the matrix in
[`state-machine.md`](state-machine.md), with these additional rules:

| Observation | `idle_only` | `working_allowed` |
| --- | --- | --- |
| `input_active=true` | target contract: defer; not live-verified because the current bridge reports `false` | target contract: defer; not live-verified because the current bridge reports `false` |
| `working` | `busy_policy=defer` persists one pending intent; `busy_policy=skip` records a skipped occurrence and schedules the next interval | queue once; use steer only with an explicit steer request and a live turn identity |
| `starting` or `stopping` | defer | defer |
| `unknown`, `disconnected`, or `failed` | fail closed | fail closed |
| `session_missing` | stop recurring firing; remove and re-register after the target is fixed | stop recurring firing; remove and re-register after the target is fixed |

`busy_policy=defer` is the default for ordinary notifications. It preserves
one pending occurrence and flushes it when the target becomes idle.
`busy_policy=skip` is the default for LongHorizon periodic inspection. It does
not create a backlog; the next interval is the next opportunity.

## 6. Schedule closed loop

The schedule closeout has three independent parts. All three must be present
before a schedule is considered closed.

### 6.1 Timer

`TimerOperator.tick` is the only schedule clock. It claims an occurrence,
persists `claimed` before any native call, and applies the status gate.

An occurrence identity is deterministic:

```text
timer:<schedule-id>:<occurrence-at>
```

The same occurrence can never create two native attempts. A recurring schedule
advances `next_at` to a future interval after one catch-up occurrence.

### 6.2 Session binding

Registration binds an alias to an explicit target:

```text
alias -> namespace, appserver_id, session_id, thread_id, optional scope_id
```

`schedule add --session <alias>` resolves the binding at registration time.
Subagent schedules always create an ephemeral child; `--ephemeral` is accepted
as an explicit assertion of that fixed behavior.
Changing the binding later does not silently retarget an existing schedule.
Use `schedule update --session <alias>` to make that change explicit.

A missing or changed session identity is an explicit error. The daemon never
guesses a session from a process name, tmux text, or a stale log.

### 6.3 Injection by session ID

At due time the timer resolves the persisted target and sends through the
typed CodexApp port. The body is the registered body. The target session ID is
the routing identity; the message body never carries control state.

The occurrence is persisted before the native boundary:

```text
configured -> enabled -> due -> claimed -> send_pending
send_pending -> sent (native accepted)
send_pending -> deferred_while_working (busy defer)
send_pending -> failed | unknown_delivery | session_missing
```

`sent` means native acceptance only. Delivery evidence is separate.

## 7. Idempotency, coalescing, and evidence

### 7.1 Duplicate triggers

The schedule occurrence ID is also the `intent_id` and `event_key`. A duplicate
tick, duplicate Hook event, or duplicate control request returns the recorded
result and makes zero additional native calls.

### 7.2 Missed occurrences

If multiple intervals are missed while the daemon is down or the target is
busy, the daemon sends at most one coalesced occurrence. After that occurrence
reaches a terminal state, the next interval advances to a future time. A
`busy_policy=skip` schedule records the skipped occurrence without creating an
intent.

### 7.3 Daemon restart

Persisted states have these recovery rules:

| State at restart | Recovery |
| --- | --- |
| `configured`, `enabled`, `disabled` | reload and continue according to enabled flag |
| `deferred_while_working` | reload; flush once when the target is observed idle |
| `claimed` or `send_pending` | treat as `unknown_delivery`; reconcile, never blind-resend |
| `sent` with no later evidence | keep `sent`; reconcile through the evidence path |
| `stopped` or `cancelled` | terminal; no tick and no send |

The outbox is reserved before crossing the native boundary. A crash after the
reservation cannot be reported as if no send occurred.

### 7.4 Native accepted to delivered/replied

The authoritative evidence source is CodexApp `message_status`, mapped through
the typed `delivery_evidence` port. The daemon must not accept client-supplied
delivery evidence.

Stage 2 adds a daemon-owned reconciler:

1. after native acceptance, persist `accepted` and the attempt identity;
2. poll `message_status` for the same `message_id` and `attempt_id`;
3. advance only `accepted -> delivered -> executed -> replied -> read`;
4. stop on a terminal evidence state or an explicit unresolved result;
5. leave the state unresolved when the native source has no matching receipt.

Until that reconciler is implemented and live-replayed, the closeout report
must say `accepted` or `sent`, not `delivered`, `executed`, or `replied`.

## 8. Subagent lifecycle

### 8.1 Creation

Creation uses native `thread/start` followed by `turn/start`. A subagent is
fresh and isolated:

- no caller conversation history is copied;
- no caller thread is resumed or forked for a disposable child;
- the prompt, cwd, target scope, and explicit model/effort fields are
  the only inputs;
- the native thread and turn receipts are persisted before the registry
  reports success.

The native App Server boundary used by this release does not expose a Codex
configuration-profile selector on `thread/start`. A profile selector is
therefore not part of the `rccs` CLI surface; an unsupported profile option is
rejected explicitly and is never accepted and discarded. `model` and `effort`
remain explicit per-child overrides when the native boundary accepts them.

### 8.2 List fields

`rccs subagent list` returns:

| Field | Meaning |
| --- | --- |
| `thread_id` | native thread identity |
| `turn_id` | native turn identity used for stop |
| `target` | namespace, appserver, and scope identity |
| `owner_session_id` | registering session, when present |
| `schedule_id`, `occurrence_id` | schedule provenance, when present |
| `prompt_digest` | digest of the submitted prompt, not a second copy of secrets |
| `model`, `effort` | effective child settings or explicit `null` |
| `ephemeral` | true when native `thread/start` used `ephemeral: true` |
| `state` | normalized lifecycle state |
| `created_at`, `last_seen_at` | registry and native observation times |
| `stop_evidence` | interrupt receipt or explicit no-active-turn result |

Normalized states are `starting`, `active`, `working`, `idle`, `stopping`,
`stopped`, `released`, `failed`, and `disconnected`. `released` means an
ephemeral child is no longer active and has no native delete or archive
operation.

### 8.3 Stop

`rccs subagent stop <thread-id>` follows this sequence:

1. load the registry record and resolve its target;
2. read native status;
3. if a turn is working, call `turn/interrupt` with the recorded `thread_id`
   and `turn_id`;
4. persist the interrupt receipt;
5. if the child is ephemeral, mark it `released`; otherwise mark it `stopped`;
6. never call archive, delete, or close.

If the turn is already complete, stop records `no_active_turn` and marks the
record stopped/released without inventing an interrupt receipt. If the native
interrupt fails, the record remains active and the failure is explicit.

There is no `rccs subagent close`, `archive`, or `delete` command in the
closeout surface. Cross-device archive behavior is not part of the main path.

## 9. MCP projection

The MCP server exposes exactly one read-only tool:

```text
routecodex_hooks_status
input:
  scope: "current" | "global"     default: current
  session_id: string              optional when scope=current
```

The result contains:

- daemon health and protocol version;
- installation state and managed Stop hook state;
- operator registry and enabled flags;
- session bindings;
- schedules filtered by the requested scope;
- subagent registry records and normalized state;
- LongHorizon records and goal-review receipts for the requested scope;
- Stop suppression records for the requested scope;
- unresolved delivery evidence counts.

The tool never posts to `/v1/control/mutate`, starts a timer, sends a message,
or creates a subagent. A missing current session is an explicit error, not an
empty global result.

`rccs init` and `rccs mcp register` use the Codex MCP CLI as the authoritative
configuration writer. Registration is idempotent and preserves unrelated MCP
entries.

## 10. Skill installation

`rccs init` installs the single bundled `rccs` Skill into both:

```text
~/.codex/skills/<skill-name>/SKILL.md
~/.agent/skills/<skill-name>/SKILL.md
```

The installation is idempotent. The managed Skill file may be refreshed on
every init; unrelated files and unrelated Skill directories are preserved.
The installer also removes only the retired managed Skill directories
`routecodex-hooks`, `scheduling`, `stopless`, and `update-goal` from the
installed skill roots, so the repository owns one Skill after refresh.

The Skill documents:

- every schedule and wait parameter, including default value and state effect;
- the difference between `defer` and `skip`;
- the current delivery surface: `queue` for schedules/waits, `interrupt` only
  for `subagent stop`, and no `rccs` CLI steer command;
- how to stop a schedule and when an agent should stop it;
- how to list and stop subagents;
- that MCP is read-only;
- that request/schema injection is outside the official Hook surface.

## 11. Stopless and LongHorizon

### 11.1 Stopless policy state

Stopless is disabled by default. Its policy state is namespaced and contains:

```text
enabled
goal_ref
last_turn_id
last_event_key
review_count
review_budget
last_review_state
last_review_receipt
```

`HooksDaemon` accepts an `intentFactory`, and `src/daemon-entry.js` wires the
goal-review factory. It remains disabled until a LongHorizon goal record is
activated. The Stop adapter still owns the official `stop_hook_active` guard.

### 11.2 Delivery plane and request plane

Stopless has two separate planes:

| Plane | Owner | Mechanism | Current feasibility |
| --- | --- | --- | --- |
| Delivery feedback | Stopless policy + delivery plane | typed `MessageIntent` through CodexApp `thread/queue/add` | implemented |
| Request/schema augmentation | request assembly owner | request-boundary injection after complete tool and context assembly | design-only; no current Hook or `rccs` implementation |

The official Hook surface can provide `additionalContext` on `SessionStart`
and `UserPromptSubmit`. It cannot modify the complete provider request, add
arbitrary tool schemas, or rewrite the final system prompt. Without modifying
Codex or owning a request-boundary extension, schema injection remains
design-only. It must not be simulated through message text.

### 11.3 Goal reviewer protocol

Goal review is a Stop-triggered, isolated review:

1. The official Stop event enters `hooksd`.
2. `stop_hook_active=true` returns immediately with no reviewer.
3. A user interrupt or explicit stop request suppresses reviewer creation.
4. The policy reads the registered goal and current turn summary.
5. If the reviewer is eligible, the daemon creates a fresh ephemeral
   subagent with a fixed reviewer prompt.
6. The reviewer returns a structured report with:
   `goal`, `observed`, `evidence_refs`;
   `functional` status (`complete`, `incomplete`, `blocked`) plus gap and next
   action;
   `architecture` status plus P0/P1/P2 findings;
   `blocked_review` when the source agent claims a blocker.
7. The daemon validates the report schema and applies one decision:
   functional incompletion, any non-compliant or uncertain architecture status,
   a P0/P1 architecture finding, or an invalid blocker requires feedback.
   A compliant architecture with only P2 findings and a reasonable, currently
   unsolvable, sufficiently evidenced blocker pass.
8. If feedback is required, the delivery plane creates one feedback intent for
   the original session.
9. If the reviewer fails, times out, or the request cannot be completed, the
   original Stop remains successful and the review is recorded as
   `unresolved` or `failed`.

The reviewer subagent does not inherit the caller context. A reviewer's own
Stop event cannot spawn another reviewer. The policy allows at most one review
per source turn. `review_budget` is optional; when omitted, every eligible Stop
is reviewed.

### 11.4 LongHorizon periodic mode

Periodic mode is a recurring schedule with:

- fixed prompt;
- local goal document reference;
- `idle_only`;
- `busy_policy=skip`;
- an explicit `rccs schedule stop <id>` command;
- skill guidance that the agent may stop the schedule when the goal is
  complete, ownership moved, scope changed, the user asked to stop, or the
  session ended.

Each cycle that finds a busy target records a skipped occurrence and does not
queue a backlog. The next interval is the next opportunity.

### 11.5 Failure boundaries

The following failures never block the original Stop path:

- network failure while creating the reviewer;
- request failure while reading goal context;
- missing or malformed reviewer output;
- unavailable native subagent capability.

They are recorded as explicit unresolved/failed review evidence. They do not
become a fake review success and do not create a blind retry loop.

## 12. Stage 2 implementation order

1. Freeze the Stage 1 documents and update the canonical contracts.
2. Add schedule busy-policy, stop cancellation, and dead-session behavior.
3. Add daemon-owned delivery reconciliation.
4. Add `subagent create/list/show/stop` and remove close/archive semantics.
5. Add `mcp register` and make `rccs init` call it idempotently.
6. Update the installed skills with parameter semantics.
7. Wire the Stopless `intentFactory` behind a disabled operator.
8. Add the LongHorizon periodic and goal modes on top of the same primitives.
9. Run the test plan, independent review, standard merge, rebuild, install,
   restart, health check, live replay, and push in that order.

The source implementation and contract updates for items 1-8 are present in
this candidate. Delivery evidence is recorded separately from source presence.

## 13. Explicit non-goals

- modifying `/Users/fanzhang/code/codex`;
- a second native transport or direct App Server protocol implementation in
  `rccs`;
- archive, delete, or close as a subagent stop substitute;
- copy-and-delete compensation for cross-device archive;
- fabricated delivery, execution, reply, or read evidence;
- arbitrary provider request rewriting through official Hooks;
- automatic retries that can duplicate an uncertain send;
- production deployment or destructive cleanup without explicit authorization.
