# Plugin and Operator Model

## Cordis decision

Cordis is feasible for one narrow responsibility: composing daemon plugins and
disposing them during shutdown. The current project has the real dependency
`cordis@4.0.0-rc.10`, and `src/orchestrator.js` uses `Context.plugin`, plugin
configuration, and disposable fibers. The contract test proves load,
idempotent start, and disposal.

Cordis is not the state machine, timer ledger, delivery outbox, or policy
owner. This avoids a second lifecycle or hidden global state. A future Cordis
plugin must provide services through the daemon context but persist domain
state through its own typed resource.

## Plugin contract

```text
plugin_id
version
dependencies
config schema
owned resource ids
event subscriptions
start(context, config) -> disposable fiber/service
stop/dispose() -> durable drain result
```

Plugin registration is deterministic and configuration-driven. Invalid plugin
entries fail before readiness. A plugin cannot call CodexApp directly; it emits
typed `MessageIntent` values to the daemon transport service.

## Operator contract

Every operator declares:

```text
operator_id
enabled/activation state
configuration schema
accepted event kinds
owned state namespace
decision result
dedupe key
cooldown/expiry policy
working-state policy
failure policy
```

The only shared inputs are a normalized event, a target reference, a status
observation, and the common decision contract. Each operator must be testable
with a fresh state store and cannot import another operator's state module.

## Baseline operators

| Operator | Input | Current status | Future responsibility |
| --- | --- | --- | --- |
| Stopless | `Stop`/`SubagentStop` | implemented goal review, active when a LongHorizon goal record is registered | loop guard policy through the explicit goal record |
| Timer | daemon clock/CLI schedule | implemented, opt-in | due/claim/defer/send |
| UpdateGoal | `PreToolUse`/`PostToolUse` matcher `update_goal` | classification only | independent goal update policy |
| LongHorizon | daemon clock or `Stop` | implemented periodic/goal modes, active on registration | durable wake condition and goal review |
| Memory | input/stop/tool boundaries | extension slot only | context injection/extraction/writeback |

The product factory enables Stopless when an explicit LongHorizon goal record
is registered. Timer is enabled only by `schedule-add`, which resolves an
explicit session binding and persists the schedule in hooksd. Update-goal and
Memory remain boundary-only.

## CLI/MCP separation

CLI commands mutate configuration, operator switches, and schedule records.
MCP only reads health, current state, operator slots, schedule records, and
delivery evidence. Every CLI mutation must be visible through the next MCP
query. Neither surface advances a timer or sends a message implicitly.
