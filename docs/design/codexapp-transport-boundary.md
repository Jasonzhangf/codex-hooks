# CodexApp Transport Boundary

`codexapp` is an independent internal component. It owns namespace routing for
`codex_tui` and `codex_app`, native App Server capability checks, running-state
observation, `sendmessage`, and native transport error mapping.

The hooks daemon owns neither App Server protocol details nor Codex input
transport. Its only dependency is a typed port equivalent to:

```text
capabilities(target) -> capability evidence
session_status(target) -> idle|working|stopping|disconnected|unknown
sendmessage(request) -> accepted or explicit failure
```

An App Server queue acceptance is only an acceptance receipt. Delivery,
execution, reply, read, and consumption require their own native evidence. A
timeout has uncertain delivery and is not blindly retried. TUI and Desktop
adapters may differ internally, but those differences must not enter daemon
policy state.
