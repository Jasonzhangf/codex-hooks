# Hooks Framework State Machine

The machine-readable source is [`contracts/state-machine.json`](../../contracts/state-machine.json).
The graph in [`../framework-graph.md`](../framework-graph.md) is the human
review surface. This document records the complete state dimensions and the
failure/recovery edges that the contract tests exercise.

## Runtime

```text
down -> starting_codexapp -> codexapp_ready -> starting_hooksd -> ready
  |          capability error                 | startup error
  +------------------------------------------> failed
ready -> degraded -> ready
ready -> draining -> stopping -> stopped
stopping -> crashed -> restarting -> codexapp_ready
restarting -> failed
ready -> failed (fatal error)
```

`degraded` means the parent can remain alive while the optional hooks sidecar
is unavailable; it never means hooksd is ready.

## Codex session dimension

The observed states are `unknown`, `starting`, `working`, `idle`,
`waiting_for_input`, `stopping`, `stopped`, `disconnected`, and `failed`.
The orthogonal `input_active` flag suppresses automatic sending. The complete
gate is:

| Session state | idle_only | working_allowed |
| --- | --- | --- |
| idle | send | send |
| working | defer | send |
| waiting_for_input | send | send |
| stopping | defer | defer |
| stopped | send | send |
| starting | defer | defer |
| unknown | fail closed | fail closed |
| disconnected | fail closed | fail closed |
| failed | fail closed | fail closed |

Each `defer` persists a pending intent. A later legal idle observation flushes
it once; a status error remains visible and does not become a send.

## Hook dimension

```text
received -> validated -> normalized -> dispatched -> waiting -> decided
                                                   |       |
                                                   |       +-> timed_out
                                                   +-> duplicate / stale
decided -> projected -> observe | allow | deny | delay | inject | acknowledged
decided -> failed (projection error)
received -> failed (malformed input)
```

Duplicate events return their recorded result. Delayed/expired events do not
create a new intent. `Stop`, `SubagentStop`, `SessionStart`, `UserPromptSubmit`,
`PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`,
`Interrupt`, and `SessionEnd` each have an adapter manifest entry; observe-only
events still pass validation and idempotency.

## Message dimension

```text
created -> suppressed | queued | deferred | emitted
emitted -> sending -> accepted -> sent -> delivered -> executed -> replied
                                            -> read -> consumed/acknowledged
sending -> failed | unknown_delivery
unknown_delivery -> delivered only after matching native evidence
retryable -> emitted only with a new attempt identity
created -> deduplicated | expired | cancelled
```

No log, MCP read, or queue insertion advances a message past the evidence it
actually proves. A send timeout, disconnect during send, ACK loss, duplicate
ACK, unchanged read cursor, and reply timeout remain explicit unresolved or
failed states.

## Schedule and operator dimensions

The future timer contract is:

```text
absent -> configured -> enabled -> due -> claimed
claimed -> send_pending -> sent -> completed
claimed -> deferred_while_working -> send_pending
claimed -> failed | expired | session_missing
enabled -> disabled
configured/disabled -> cancelled
configured/enabled/disabled/deferred_while_working -> stopped
failed -> retryable -> send_pending (new attempt)
```

`stop` is a terminal agent stop that preserves delivery evidence and disables
future firing. It is distinct from reversible `disabled`, from terminal
`cancelled`, and from a successful `sent` occurrence.

## Subagent registry dimension

The implemented registry machine is:

```text
absent -> active (native thread/turn receipt)
active -> working -> stopping -> stopped
active -> stopping -> released (ephemeral)
stopping -> active (interrupt error, no simulated stop)
```

`active` proves the native thread and turn identities were returned by
`thread/start` and `turn/start`. The stop path reads native status, sends
`turn/interrupt` for a working turn, and advances only after the interrupt
receipt or an explicit `no_active_turn` observation. It never calls archive,
delete, or close. A failed registration after native creation preserves the
receipt on the schedule record; it is not erased or reported as if no child
existed.

Operators are namespaced and independent:

```text
inactive -> armed -> triggered -> eligible -> completed
                         |           |
                         +-> deferred +-> failed
deferred -> eligible
triggered -> failed
```

The graph explicitly covers: startup against working or idle Codex; unknown
state; Stop allow/block/external-inject decisions; idle-to-working races;
send timeout/failure/disconnect; duplicate/stale hooks; daemon restart and
crash recovery; concurrent operators; Stopless/update-goal simultaneous
events; manual input; disabled operators; corrupted config; persistence
failure; timer expiry during working or with a missing session; versioned state
rehydration; lost or repeated ACK; Stop timeout; and tool-call observe/allow/
deny/delay outcomes.

## Recovery invariants

1. Reserve event and intent before awaiting status or transport.
2. Never retry an uncertain native send without matching receipt evidence.
3. Persist pending and unknown states before reporting them.
4. Never synthesize an official event for a daemon timer.
5. Never let Stopless state, update-goal state, timer state, or Memory state
   leak across operator namespaces.
