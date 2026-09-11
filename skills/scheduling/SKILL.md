---
name: scheduling
description: Explain how a future scheduling policy will create timer intents.
---

The scheduling skill teaches schedule operations. Runtime schedule state,
timers, persistence, and delivery belong to the daemon. MCP is query-only and
CLI is the mutation surface. At fire time the daemon creates a
`MessageIntent`; `codexapp.sendmessage` is the only wake action.

This repository currently contains only the framework contract and tests.
The CLI skeleton supports `schedule-upsert`, `schedule-pause`,
`schedule-resume`, and `schedule-remove`; `idle_only` is the default send mode
and `working_allowed` must be explicit. A daemon-owned deterministic timer
operator verifies due/deferred/recovery transitions without enabling a product
schedule policy.
