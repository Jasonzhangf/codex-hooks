---
name: routecodex-hooks
description: Install and operate the local RouteCodex hooks framework, including its official Stop hook, daemon configuration, CLI controls, and read-only MCP status.
---

Use the repository's local source as the installation source. From the repository root, run:

```sh
npm run init
```

For an isolated host or test install, provide `--codex-home`, `--bin-dir`, and optionally `--endpoint`. `init` copies `src/`, `hooks/`, and `skills/` from this checkout into the selected Codex home, generates `routecodex-hooks/config/hooksd.json`, installs executable CLI/MCP/daemon wrappers, and registers only the managed official `Stop` hook. It is idempotent and preserves unrelated entries in `hooks.json`.

Inspect and change local configuration with the installed CLI:

```sh
routecodex-hooks config-show
routecodex-hooks config-set endpoint http://127.0.0.1:8787
routecodex-hooks config-set codexapp_socket /path/to/codexapp.sock
routecodex-hooks config-set source_scope local:hooks
routecodex-hooks config-set source_session hooksd
routecodex-hooks config-set target_scope codex_tui/tui-appserver=local:tui
routecodex-hooks hook-disable stop
routecodex-hooks hook-enable stop
```

CLI changes configuration and operator/schedule switches. MCP is query-only: register the installed wrapper once with `codex mcp add routecodex-hooks -- routecodex-hooks-mcp`, then use `routecodex_hooks_status` to read daemon health, Stop hook installation state, operators, and schedules. MCP must not be used to mutate state.

The hook receives official JSON on stdin and forwards it to hooksd. hooksd owns policy state, persistence, idempotency, running-state gating, and the send decision; codexapp is the only message sender. An idle-only intent is deferred while the target is working or input-active. Unknown or disconnected state fails closed. A Stop event with `stop_hook_active: true` is guarded before an intent is created.

The installed `routecodex-hooksd` wrapper is the daemon process entry for the
RouteCodex lifecycle supervisor. It must be started with a real CodexApp port
module or the configured local bridge; a missing or unverifiable CodexApp port
is a startup failure, not a ready state.

An external `codexapp.sendmessage` wake and official Stop `decision: "block"` are mutually exclusive. The external path returns ordinary successful hook output and does not claim delivery or execution. Do not use `continue: false` as delivery evidence. A non-zero hook exit means the daemon rejected or could not safely process the event.

This framework currently supplies boundaries and probes; Stopless, scheduling policy, update-goal mutation, memory behavior, and RouteCodex-managed sidecar startup are not claimed as implemented by the skeleton.
