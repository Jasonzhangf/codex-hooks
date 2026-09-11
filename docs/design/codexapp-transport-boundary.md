# CodexApp Transport Boundary

`codexapp` is an independent internal component. It owns namespace routing for
`codex_tui` and `codex_app`, native App Server capability checks, running-state
observation, `sendmessage`, and native transport error mapping.

The current codexapp project exposes a `codex-comm/v1` Unix control bridge.
Its control methods are `session_status` and `send`; the hooks-facing typed
port advertises `session_status` and `send_message_to_thread`. The mapping is
explicit and local to `CodexAppBridgePort`. `target_scopes` explicitly maps
`<namespace>/<appserver_id>` to a registered bridge scope, and the configured
source address must already be a registered bridge agent.

The hooks daemon owns neither App Server protocol details nor Codex input
transport. Its only dependency is a typed port equivalent to:

```text
capabilities(target) -> capability evidence
session_status(target) -> { state: idle|working|stopping|disconnected|unknown, input_active: boolean }
sendmessage(request) -> accepted or explicit failure
delivery_evidence(intent_id, after_state) -> one exact native transition or explicit unavailable
```

`input_active` is an orthogonal observation: the daemon defers automatic
messages while the user is typing, including messages explicitly marked
`working_allowed`. An App Server queue acceptance is only an acceptance receipt.
Delivery, execution, reply, read, and consumption require their own native evidence;
each receipt must carry the original `attempt_id`; read evidence also carries a
cursor and consumption evidence carries an independent `ack_id`. The daemon accepts
them only through the exact progression and never infers them. A timeout has uncertain
delivery and is not blindly retried. TUI and Desktop
adapters may differ internally, but those differences must not enter daemon
policy state.

The current bridge adapter implements `delivery_evidence` for the
`accepted/unknown_delivery → delivered` transition through `message_status`.
Later execution/reply/read/ACK transitions remain an explicit typed extension
point; the daemon refuses to synthesize them when the adapter does not expose
the corresponding native evidence.

The bridge adapter preserves the target `thread_id` as the native thread
address and carries the original `attempt_id` into the bridge message id and
attempt id. A bridge response is still only accepted/sent evidence; later
delivery, reply, read, and ACK evidence remains owned by the daemon ledger.
