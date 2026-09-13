# Hooks Framework

Status: framework baseline only. This document is the architectural contract;
it does not enable Stopless, scheduling, update-goal mutation, Memory, or
long-horizon behavior.

## 1. Layer contract

```text
Skill
  static facts, method, CLI/MCP usage
MCP
  read-only projection of daemon state
CLI
  explicit configuration and operator/schedule mutations
Official Hook Adapter
  stdin validation, normalization, daemon RPC, official stdout projection
Daemon (hooksd)
  state machine, persistence, clock, idempotency, policy and send gate
CodexApp Adapter
  native TUI/Desktop status observation and sendmessage transport
```

The control plane is physically separate from the message body. Native
namespace, appserver, session, thread, turn, event, attempt, and dedupe
identities are typed control data; they are never reconstructed from logs,
transcripts, response metadata, or business payloads.

## 2. Ownership

| Component | Owns | Must not own |
| --- | --- | --- |
| Skill | static facts and methods | runtime state or side effects |
| MCP | state queries | mutations, sends, timer ticks |
| CLI | authorized mutations | policy decisions or hidden retries |
| Hook adapter | official event boundary | policy state, timers, sendmessage |
| hooksd | policy state, persistence, idempotency, status gate, decision | native App Server protocol |
| CodexApp | status evidence and `sendmessage` | operator state or policy |
| Cordis | plugin dependency/lifecycle/disposal | domain truth or delivery ledger |

There is one send owner (`CodexApp`), one decision owner (`hooksd`), and one
state owner per operator namespace. Stopless and update-goal share only the
normalized event and transport gate; neither can read or mutate the other's
state.

## 3. Lifecycle

RouteCodex owns the process boundary and starts children in this order:

```text
starting
  -> codexapp capability-ready
  -> hooksd ready
  -> framework ready
```

Shutdown is the reverse: stop accepting hook work, persist in-flight state,
drain hooksd/Cordis fibers, close hooksd, then close CodexApp. A missing,
unverifiable, or disconnected CodexApp port is not readiness. The current
RouteCodex lifecycle integration is fail-open for the parent service: it
reports `hooks sidecar unavailable` while keeping the main listeners alive.
That parent-level policy must not be confused with hooksd readiness.

## 4. Typed event-to-decision flow

```text
official stdin
  -> validate/normalize HookEvent
  -> operator registry (zero or one independent policy result)
  -> persist event/intent reservation
  -> CodexApp.getRunningState
  -> WorkingPolicy gate
  -> CodexApp.sendMessage
  -> native receipt / explicit failure
  -> reconciler for delivered/replied/read/consumed evidence
```

An accepted native queue result is only an acceptance. It is not delivery,
execution, reply, read, or ACK. A timeout creates `unknown_delivery` and is not
blindly retried.

## 5. Working-state policy

Every `MessageIntent` has exactly one mode:

- `idle_only`: working and input-active sessions are deferred and persisted;
- `working_allowed`: a working session may receive the message only when the
  operator configuration explicitly permits it.

`starting`, `stopping`, `unknown`, `disconnected`, and `failed` do not permit a
guess. They defer or fail explicitly according to the typed contract. Manual
input is an independent suppress gate, including for `working_allowed`.

## 6. Operator slots

The registry provides independent slots for `stopless`, `timer`, `update-goal`,
`longhorizon`, and `memory`. The baseline exposes their contracts and status
slots but does not enable their product behavior. Timer wakeups, when later
implemented, originate inside the daemon clock and enter the same typed
`MessageIntent` path; they are not synthetic official Hook events.

## 7. Non-goals and safety boundary

This baseline deliberately does not implement a Stopless loop, reasoning-stop
injection, native Stop continuation, goal mutation, recurring schedule policy,
Memory extraction/injection, or real TUI/Desktop delivery claims. RouteCodex V3
must therefore remain free of a second continuation implementation.
