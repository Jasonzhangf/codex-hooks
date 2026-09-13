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
| Skills teach install/config/status | `skills/routecodex-hooks/SKILL.md`, `skills/scheduling/SKILL.md` | pass |
| MCP is query-only | `src/mcp-server.js`, `test/mcp.test.js`, CLI/MCP boundary tests | pass |
| CLI owns mutations | `src/cli.js`, `src/control.js`, `test/control.test.js` | pass |
| Official event adapters | `hooks/hooks.json`, `contracts/hook-event.schema.json`, manifest test | pass |
| Stop `stop_hook_active` guard | `src/protocol.js`, daemon tests | pass |
| Stop allow/block/external-inject contract | `test/decision.test.js`, `test/framework.test.js` | pass |
| Tool observe/allow/deny/delay contract | `test/decision.test.js`, hook-kind tests | pass |
| Daemon state/persistence/idempotency | `src/daemon.js`, `src/persistence.js`, tests 39–45/50–52 | pass |
| Working suppress/send matrix | `contracts/state-machine.json`, tests 34–38 | pass |
| Deterministic timer skeleton | `src/timer.js`, tests 70–76 | pass |
| Cordis plugin lifecycle | `src/orchestrator.js`, `test/orchestrator.test.js` | pass |
| CodexApp typed port | `src/codexapp-port.js`, bridge contract tests | pass |
| Internal `rccv3-codexapp` bin | `src/codexapp-entry.js`, `test/codexapp-entry.test.js`, `test/init.test.js` | pass |
| Loaded-thread discovery via `thread/loaded/list` | `src/codexapp-entry.js` `list_threads`, `test/codexapp-entry.test.js` | pass |
| Managed supervisor uses installed bin | `src/install.js`, `src/supervisor-entry.js`, `test/supervisor-entry.test.js` | pass |
| Native TUI send/receipt/execution/reply/read via internal bin | default TUI App Server trace, 2026-09-13 (`ADAPTER_LIVE_1789312075729` on thread `01a09b3f-ced2-70a1-9fc5-9d1124c9a8f0`) | pass-adapter |
| Native TUI two-thread bidirectional delivery | default TUI App Server trace, 2026-09-13 (`A_TO_B_CROSS_1789310703_7b3d`, `B_TO_A_CROSS_1789310703_2e8c`) | pass-adapter |
| RouteCodex managed startup | RouteCodex lifecycle owner and installed replay | pending-live |
| Real TUI send/status/reply/read via same-entry hook-to-native | default TUI App Server trace, 2026-09-13 (`SAME_ENTRY_HOOK_TO_A_1789319103`, `SAME_ENTRY_HOOK_TO_B3_1789319549`; daemon state `read`, native cursor and `readItemId`) | pass-live |
| Real Desktop send/status/reply/ACK | running native Desktop App Server endpoint and same-entry trace | pending-live |
| Framework enables no business Stopless | no enabled Stopless factory; `AGENTS.md` and docs | pass |
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
