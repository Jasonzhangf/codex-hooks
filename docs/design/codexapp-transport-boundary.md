# CodexApp Transport Boundary

CodexApp is an independent internal component. The daemon depends on a typed
port, not on TUI or Desktop protocol details.

## Typed port

```text
capabilities() -> CapabilitySet
get_running_state(Target) -> RunningState
send_message(SendMessageRequest) -> SendMessageResult
observe_delivery(MessageId) -> DeliveryEvidence
read_thread(Target, Cursor) -> ThreadPage
```

`Target` carries `namespace`, `appserver_id`, `scope_id`, `session_id`, and
`thread_id`. A `SendMessageRequest` carries `message_id`, `event_id`,
`attempt_id`, `operator_id`, `priority`, `working_policy`, `dedupe_key`,
`payload`, `created_at`, and `expires_at`. These are control fields around a
separate message body; the body cannot override them.

`RunningState` is one of `unknown`, `starting`, `working`, `idle`,
`waiting_for_input`, `stopping`, `stopped`, `disconnected`, or `failed`, plus
the orthogonal `input_active` observation. `SendMessageResult` distinguishes
`accepted`, `delivered`, `failed`, and `unknown` rather than returning a
boolean.

## Local CodexApp evidence

The reference project is `/Users/fanzhang/github/codexapp`. Its bridge exposes
the real local contract `codex-comm/v1`:

- namespaces: `codex_tui` and `codex_app`;
- query methods: discovery, session listing/status, message status,
  capabilities, and bridge status;
- execution methods: register, send, wait, reply, and ACK;
- native App Server adapter: Unix WebSocket JSON-RPC;
- shared bridge: Unix JSON-lines control socket with a durable journal.

The bridge README explicitly says MCP is query-only; CLI owns registration and
execution. `send` is routed through the bridge and `session_status` is
observed from the App Server. Its six automated tests pass, including
bidirectional routing and reply correlation.

## Adapter isolation

The TUI and Desktop adapters may differ in endpoint and native method details.
They map into the same typed port and keep namespace/appserver/session/thread
identities in control state. The daemon never imports either native adapter or
infers a namespace from a flattened string.

## Evidence ceiling

The local bridge tests prove the adapter contract and mock/native transport
shape. They do not prove that a currently running real TUI and Desktop session
has accepted a message. The required live sequence remains:

```text
send call emitted
  -> native acceptance
  -> target receipt
  -> target execution
  -> reply turn
  -> read with changed cursor
  -> consumer ACK (when required)
```

The framework must report the first missing boundary and must never promote a
queue acceptance, log line, screenshot, or process listing to delivery.
