# Acceptance Matrix

| Capability | Framework evidence | Runtime ceiling |
| --- | --- | --- |
| Official event normalization | `protocol.js`, schema, manifest test | No production trust approval claim |
| Stop recursion guard | `stop_hook_active` regression | No real Codex Stop replay yet |
| Status-aware sending | daemon tests for idle/working/stopping/unknown/disconnected | Mock CodexApp only |
| Deferred delivery | daemon pending/flush tests | In-memory store unless JsonStateStore is selected |
| Idempotency | concurrent event/intent tests | No distributed multi-daemon claim |
| Cordis lifecycle | orchestrator tests | No RouteCodex managed startup claim |
| Persistence port | `JsonStateStore` restart test | No crash-injection production replay |
| JSON daemon entry | `daemon-entry.test.js`, `/health` probe | Requires a real supplied CodexApp module |
| MCP read boundary | `McpStateClient` same-daemon query test | No published MCP server process |
| CLI mutation boundary | control mutation HTTP contract | Timer tick remains an operator skeleton |
| Deterministic timer gate | `ManualClock` + `TimerOperator` tests | No recurring/product scheduling policy |
| Delivery evidence progression | exact daemon reconciler + state contract | Native TUI/Desktop evidence still pending |
| Unknown-delivery reconciliation | matching attempt + target receipt only | Native message-status replay pending |
| CodexApp bridge adapter | Unix control `capabilities`/`session_status`/`send` mapping test | Registered real source/target scopes pending |
| Complete edge graph | [`edge-coverage.md`](edge-coverage.md) + machine contract | Rows marked pending require managed runtime replay |
| TUI/Desktop transport | RouteCodex-internal `rccv3-codexapp` is the adapter owner | Requires same-entry native replay |
| Stopless/timer/memory behavior | extension contracts only | Explicitly out of scope |
| V3 Stopless retirement | RouteCodex candidate and removal gates | Main merge and full V3 gate still separate |

Evidence must not be promoted from one row to another. In particular, a mock
CodexApp receipt is not proof of native Desktop/TUI delivery.
