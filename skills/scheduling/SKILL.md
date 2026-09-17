---
name: scheduling
description: Bind a session alias and create daemon-delivered timer intents.
---

The scheduling skill teaches schedule operations. Runtime schedule state,
timers, persistence, and delivery belong to the daemon. MCP is query-only and
CLI is the mutation surface. At fire time the daemon creates a
`MessageIntent`; `codexapp.sendmessage` is the only wake action.

Bind a session once, then schedule against its alias:

```sh
routecodex-hooks session-bind timer-tui <session-id>
routecodex-hooks schedule-add <id> <at-iso8601> <body> --session timer-tui
```

The daemon owns the persisted binding, schedule state, one-second clock, and
delivery ledger. `idle_only` is the default send mode and `working_allowed`
must be explicit. `schedule-add` enables the timer operator. The lower-level
`schedule-upsert <target-json>` remains available for explicit target tests.
