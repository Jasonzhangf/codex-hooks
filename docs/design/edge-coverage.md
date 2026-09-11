# Framework Edge Coverage

This table is the complete contract graph for the framework foundation. “Probe”
means the local deterministic test or machine-readable contract exercises the
edge. “Pending” means the boundary is designed and fail-closed, but requires a
real RouteCodex-managed TUI/Desktop replay before it can be promoted to runtime
evidence.

| # | Precondition / event | Owner | Decision and side effect | Durable state / recovery | Evidence level |
|---:|---|---|---|---|---|
| 1 | daemon starts while Codex is working | supervisor + CodexApp | start CodexApp, observe working; do not emit wake | runtime ready; later idle flush | Contract |
| 2 | daemon starts while Codex is idle | supervisor + CodexApp | capability handshake, no unsolicited message | runtime ready | Contract |
| 3 | running state unknown | hooksd transport gate | fail closed; no send | failed intent preserves state | Probe |
| 4 | Stop arrives while working | stop adapter + hooksd | idle-only Stop wake deferred | pending intent; idle recheck | Probe |
| 5 | Stop arrives after stop | stop adapter + hooksd | eligible send gate | accepted receipt | Probe |
| 6 | Stop policy allows | Stop operator | official empty/no-op output | event result recorded | Probe |
| 7 | Stop policy blocks | Stop operator | official `decision:block` with reason only for native continuation policy | no external wake | Probe |
| 8 | Stop policy injects | hooksd + CodexApp | one `send_message_to_thread` request; no `decision:block` | outbox and attempt preserved | Probe; native pending |
| 9 | CodexApp accepts send | CodexApp adapter | record `accepted`; do not claim delivery | accepted outbox; reconcile later | Probe |
| 10 | send transport times out | hooksd transport | record `unknown_delivery`; no blind retry | unresolved outbox; explicit reconcile | Probe |
| 11 | send transport fails definitively | hooksd transport | record `failed`; expose exact error | terminal failure | Probe |
| 12 | status changes idle → working during decision | hooksd transport gate | status observation wins; defer unless working is explicitly allowed | pending intent | Contract |
| 13 | CodexApp disconnects during send | CodexApp + hooksd | preserve native error; classify uncertain vs definitive | unknown or failed, never success | Contract |
| 14 | duplicate Hook event arrives | hook adapter + hooksd | return recorded result; no second intent/send | event key remains idempotent | Probe |
| 15 | stale/expired Hook or intent arrives | hooksd policy | drop as expired/stale; no status/send call | expired receipt | Probe |
| 16 | daemon restarts with accepted/in-flight outbox | hooksd persistence | restore; mark in-flight as unknown | reconcile, never same-attempt resend | Probe |
| 17 | daemon crashes after send boundary | hooksd persistence | recovery starts from durable outbox evidence | target receipt reconciliation | Contract |
| 18 | multiple operators trigger together | operator registry + hooksd | keep operator ids and intents independent; shared gate only | one record per operator/intent | Contract |
| 19 | Stopless and update-goal trigger together | separate operators | independent decisions; no cross-read or cross-write | separate state resources | Probe |
| 20 | ordinary wake while working | hooksd gate | suppress/defer; zero CodexApp send calls | pending record and idle watcher | Probe |
| 21 | user is manually typing | hooksd gate | defer even `working_allowed` | pending record; retry on inactive input | Probe |
| 22 | CodexApp unavailable | supervisor + hooksd | hooksd is not ready or fails closed | runtime failed/degraded | Contract |
| 23 | Hook adapter unavailable | official hook runtime | non-zero hook result; no direct send | daemon state unchanged | Probe |
| 24 | configuration malformed | config owner | refuse startup; no partial runtime | no hook-ready marker | Probe |
| 25 | persistence write fails | persistence owner | surface write error; do not claim durable state | operation fails closed | Probe |
| 26 | timer due while working | timer operator + gate | defer; no send for idle-only timer | `deferred_while_working`; idle resume | Probe |
| 27 | timer due with missing session | timer operator + CodexApp | explicit session-missing failure | occurrence terminal failure | Contract |
| 28 | disabled operator receives old event | registry + hooksd | observe/ignore according to recorded operator version; no wake | no new intent | Probe |
| 29 | version upgrade finds old state | persistence + schema owner | validate version; migrate only declared fields or fail explicitly | old state retained on failure | Contract |
| 30 | send accepted but ACK is lost | delivery reconciler | remain accepted/sent; never promote to consumed | retry read/reconcile only | Contract |
| 31 | duplicate ACK arrives | delivery reconciler | idempotent same ACK; no duplicate transition | one ack id recorded | Contract |
| 32 | Stop hook command times out | official hook adapter + hooksd | non-zero hook failure; no synthetic continuation | event remains unresolved/failed | Contract |
| 33 | tool-call event observe/allow/deny/delay | tool-call adapter + operator | project only official action; never undo PostToolUse side effects | independent tool decision | Probe |
| 34 | future Memory input/stop/tool extraction | Memory extension point | typed injection/extraction contract only; no business behavior | memory state remains inactive | Contract-only |

The canonical machine is [`../../contracts/state-machine.json`](../../contracts/state-machine.json).
The implementation currently proves the local daemon, mock port, HTTP/CLI/MCP,
official stdin/stdout, persistence, status gate, and exact evidence checks. It
does not promote rows marked pending to real TUI/Desktop evidence.
