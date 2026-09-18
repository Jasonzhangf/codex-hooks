# Acceptance Matrix

Status labels are evidence levels, not intent: `pass` means the listed
artifact or test currently proves that row; `pending-live` means the contract
exists but the required real endpoint evidence is not present.

`pass-adapter` means the internal bin was exercised against a real native App
Server through the control socket (accepted/receipt/execution/reply/read).
`pass-live` means the same-entry hook stdin --> daemon --> codexapp --> native
route reached native receipt/execution/reply/read evidence.

| Requirement | Authoritative evidence | Status |
| --- | --- | --- |
| One installed Skill teaches install/config/status | `skills/rccs/SKILL.md` | pass |
| MCP is query-only | `src/mcp-server.js`, `test/mcp.test.js`, CLI/MCP boundary tests | pass |
| CLI owns mutations | `src/cli.js`, `src/control.js`, `test/control.test.js` | pass |
| Official event adapters | `hooks/hooks.json`, `contracts/hook-event.schema.json`, manifest test | pass |
| Stop `stop_hook_active` guard | `src/protocol.js`, daemon tests | pass |
| Stop allow/block/external-inject contract | `test/decision.test.js`, `test/framework.test.js` | pass |
| Tool observe/allow/deny/delay contract | `test/decision.test.js`, hook-kind tests | pass |
| Daemon state/persistence/idempotency | `src/daemon.js`, `src/persistence.js`, tests 39–45/50–52 | pass |
| Working suppress/send matrix | `contracts/state-machine.json`, tests 34–38 | pass |
| Session-bound timer delivery | `src/timer.js`, `src/daemon-entry.js`, `test/timer.test.js`, `test/daemon-entry.test.js`, `test/init.test.js` | pass |
| Cordis plugin lifecycle | `src/orchestrator.js`, `test/orchestrator.test.js` | pass |
| CodexApp typed port | `src/codexapp-port.js`, bridge contract tests | pass |
| Internal `rccv3-codexapp` bin | `src/codexapp-entry.js`, `test/codexapp-entry.test.js`, `test/init.test.js` | pass |
| Loaded-thread discovery via `thread/loaded/list` | `src/codexapp-entry.js` `list_threads`, `test/codexapp-entry.test.js` | pass |
| LongHorizon `notLoaded` resume, active-writer deferral, and pending queue start | `src/codexapp-entry.js` `send`, `test/codexapp-entry.test.js`, `test/longhorizon-liveness.test.js`, `contracts/rccs-notification-dag.json` | pass |
| Managed supervisor uses installed bin | `src/install.js`, `src/supervisor-entry.js`, `test/supervisor-entry.test.js` | pass |
| Native TUI send/receipt/execution/reply/read via internal bin | default TUI App Server trace, 2026-09-13 (`ADAPTER_LIVE_1789312075729` on thread `01a09b3f-ced2-70a1-9fc5-9d1124c9a8f0`) | pass-adapter |
| Native TUI two-thread bidirectional delivery | default TUI App Server trace, 2026-09-13 (`A_TO_B_CROSS_1789310703_7b3d`, `B_TO_A_CROSS_1789310703_2e8c`) | pass-adapter |
| RouteCodex managed startup | RouteCodex lifecycle owner and installed replay | pending-live |
| Real TUI send/status/reply/read via same-entry hook-to-native | default TUI App Server trace, 2026-09-13 (`SAME_ENTRY_HOOK_TO_A_1789319103`, `SAME_ENTRY_HOOK_TO_B3_1789319549`; daemon state `read`, native cursor and `readItemId`) | pass-live |
| Real Desktop send/status/reply/read via same-entry hook-to-native | default Desktop App Server trace, 2026-09-13 (`SAME_ENTRY_DESKTOP2_1789320180` on thread `01a09bc7-6a66-7271-8bbb-6446b727b503`; empty-baseline first send, daemon state `read`) | pass-live |
| Session-bound timer to real TUI | default TUI App Server trace, 2026-09-16 (`RCC_TIMER_LIVE_0916` on thread `01a0acc8-e48a-71d1-bcd7-7427e67252a5`; CLI bind -> due -> native queue acceptance -> exact TUI reply) | pass-live |
| Unmaterialized desktop thread first-send empty baseline | default Desktop App Server trace, 2026-09-13 (`SAME_ENTRY_DESKTOP2_1789320180`; adapter baseline `{ state: "empty" }` before first queue/add) | pass-live |
| `idle_only` while target is working suppresses native send | default TUI App Server trace, 2026-09-13 (`WORKING_IDLE_ONLY_1789320995`: daemon `deferred`, codexapp `message_not_found`) | pass-live |
| `working_allowed` while target is working sends once | default TUI App Server trace, 2026-09-13 (`WORKING_ALLOWED_LIVE_1789321365`: daemon `sent`, native status `working`, native `accepted`) | pass-live |
| Duplicate Stop event does not duplicate delivery | default TUI App Server trace, 2026-09-13 (`DUP2_FIRST_1789321398`, `DUP2_SECOND_1789321398`: one delivery, second message `message_not_found`) | pass-live |
| Unknown sessions fail closed | default TUI App Server live invalid-thread trace, 2026-09-13 (`INVALID_THREAD_1789345359`; hook-entry nonzero, error.code `unknown_session_state`) | pass-live |
| Disconnected sessions fail closed | `test/framework.test.js` working/send matrix and fail-closed cases; live replay not yet present | pass |
| Restart recovery never blind-retries an in-flight send | `test/framework.test.js` outbox recovery cases | pass |
| Subagent create/list/stop | `src/control.js`, `src/codexapp-entry.js`, `test/control.test.js`, `test/codexapp-entry.test.js` | pass |
| Goal review is opt-in and non-blocking | `src/goal-review.js`, `src/daemon-entry.js`, `test/goal-review.test.js` | pass |
| Goal review skips user interruption | `src/daemon.js`, `test/framework.test.js`, `test/goal-review.test.js` | pass |
| LongHorizon periodic/goal CRUD | `src/control.js`, `src/cli.js`, `test/control.test.js`, `test/init.test.js` | pass |
| Ephemeral subagent result via `turn/completed` | `src/codexapp-entry.js`, `test/codexapp-entry.test.js` | pass |
| MCP projects LongHorizon/goal review/suppression | `src/mcp.js`, `src/control.js`, `test/mcp.test.js` | pass |
| V3 Stopless resources removed | latest RouteCodex `origin/main` source scan and mapped gates | pass-source; runtime pending |

## Required real trace

For each namespace, the evidence record must retain the same `message_id`,
`attempt_id`, target identity, and native cursor through:

```text
hook stdin
 -> daemon decision
 -> get_running_state
 -> send_message
 -> native acceptance
 -> target receipt/execution
 -> reply turn
 -> read with changed cursor
 -> ACK when required
```

The trace must be run once with `idle_only` while working (zero native send),
once while idle (one send), and once with explicit `working_allowed` (one send).
A failed send, timeout, disconnect, duplicate event, and daemon restart must
remain visible as their respective failure/recovery states.
