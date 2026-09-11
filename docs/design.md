# RouteCodex Hooks Framework Design

Status: design baseline, framework-only implementation. No Stopless, timer,
memory, or goal policy is enabled by default. The timer contract includes a
deterministic scheduler skeleton for state-machine verification; it does not
provide a product scheduling policy.

## Decision

Use an official Codex plugin for Hook adapters, a Cordis-composed hooks daemon
for policy/runtime orchestration, and an independent `codexapp` internal binary
for TUI/Desktop App Server communication.

```text
routecodex supervisor
  ├── codexapp internal bin
  │     ├── codex_tui App Server adapter
  │     └── codex_app App Server adapter
  ├── hooksd (Cordis context)
  │     ├── transport/status gate
  │     ├── persistent policy stores
  │     └── policy plugins
  └── routecodex-hooks plugin
        └── official Hook command adapters
```

RouteCodex depends only on the typed codexapp port. It does not implement or
reimplement TUI/Desktop App Server protocol details.

## Ownership

| Layer | Owns | Must not own |
| --- | --- | --- |
| Skill | static facts, rules, method | live state or actions |
| MCP | read-only daemon projections | send, mutation, timer tick |
| CLI/operator | authorized mutations | hidden policy decisions |
| Official Hook | event adapter and official output projection | policy state or native transport |
| hooksd | policy lifecycle, persistence, idempotency, status gate, decisions | App Server protocol |
| codexapp | namespace routing, native status, `sendmessage`, read evidence | timer/goal/Stopless state |
| Cordis | plugin loading, dependencies, lifecycle, disposal, timers | domain truth |

## Cordis fit

Cordis is suitable for the daemon composition layer because its public model
contains `Context`, plugin registration, service injection, and disposable
fibers. Its timer service can drive in-process scheduling, but durable schedule
state remains owned by the timer policy store. Cordis disposal must cancel
watchers and timers during daemon drain.

Cordis is not used to infer message state or replace the delivery ledger. A
Cordis plugin may provide a policy service, but it must read/write only its own
state resource and return a typed `MessageIntent`.

## Lifecycle

1. `routecodex start` allocates an instance/runtime directory.
2. Supervisor starts `codexapp`; waits for native initialize and capabilities.
3. Supervisor starts hooksd with the codexapp local endpoint.
4. hooksd loads Cordis policy plugins and opens its IPC endpoint.
5. Plugin trust/load is checked; only then is the hook surface ready.
6. Shutdown enters draining, rejects new policy work, persists in-flight state,
   disposes Cordis fibers, closes hooksd, then closes codexapp.

Hook execution never starts or restarts either daemon. If the endpoint is not
ready, the Hook exits with an explicit error and no wake is attempted.

## Stable codexapp port

```text
capabilities() -> namespace and operation capability set
session_status(target) -> state + input_active observation
sendmessage(intent) -> accepted or explicit failure
status_watch(target) -> status transitions for pending flush
thread_read(target, cursor) -> later evidence when caller requires it
```

The target always contains namespace, appserver id, session id, and thread id.
`sendmessage` may map to native `thread/queue/add`; that mapping is private to
codexapp. In the current local bridge, `CodexAppBridgePort` explicitly maps
the hooks-facing `send_message_to_thread` capability to bridge control method
`send`, maps `<namespace>/<appserver_id>` through configured scope bindings,
and keeps native `scopeId`, `sessionId`, `threadId`, and `attemptId` out of the
business message body.

## Hook projection

Internal daemon envelopes never go to official Hook stdout. The command adapter
projects only the official top-level result:

- successful external Stop wake: ordinary successful/no-op output (`{}`);
- input injection: official `additionalContext` shape;
- no intent/deferred: normal no-op output, never `decision:"block"`;
- daemon/native failure: non-zero command with preserved error.

Stop `decision:"block"` is reserved for a separately modeled native Stop
continuation. It is not combined with a `sendmessage` wake. `continue:false`
is not used as an external injection acknowledgment because that meaning has
not been established by official documentation or an installed same-entry
replay.

## Policy modules

Each policy exposes only:

```text
on_event(event, own_state) -> zero or more MessageIntent
```

The transport layer validates target, checks idempotency, reads status, applies
the send mode, calls codexapp, and records evidence. The policy never calls
codexapp directly.

Daemon-originated timer and long-horizon events use the typed internal
`dispatchIntent` boundary. They are not fabricated official Hook events and
never pass synthetic lifecycle JSON through the Hook adapter.

Current planned policies:

- Stopless: Stop event, `stop_hook_active` guard, own loop budget/state.
- update-goal: exact `update_goal` tool matcher, own goal revision/state.
- timer: CLI-created schedule, daemon clock, own occurrence state.
- longhorizon: future checkpoint/wake condition, own state.
- memory: future input injection and extraction, explicitly out of scope now.

## Message gate

`idle_only` is the default for long-running wake policies. `working_allowed`
requires explicit policy configuration. `stopping` always defers. Unknown and
disconnected are fail-closed.

An accepted queue receipt only proves native acceptance. Delivery, execution,
reply, and read require independent evidence. An uncertain transport timeout is
not retried blindly.

## Non-goals of this baseline

- no Stopless behavior;
- no timer behavior;
- no memory capture or injection;
- no goal mutation;
- no provider `reasoningStop` compatibility path;
- no claim of real TUI/Desktop bidirectional proof until same-entry replay
  produces the required evidence sequence.
