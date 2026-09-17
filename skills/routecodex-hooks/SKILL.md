---
name: routecodex-hooks
description: Install and operate the local RouteCodex hooks framework, including its official Stop hook, daemon configuration, CLI controls, and read-only MCP status.
---

Use the repository's local source as the installation source. From the repository root, run:

```sh
npm run init
```

For an isolated host or test install, provide `--codex-home`, `--bin-dir`, and optionally `--endpoint`. `init` copies `src/`, `hooks/`, and `skills/` from this checkout into the selected Codex home, generates `routecodex-hooks/config/hooksd.json`, installs executable CLI/MCP/daemon wrappers, and registers only the managed official `Stop` hook. It is idempotent and preserves unrelated entries in `hooks.json`.

Inspect and change local configuration with the installed `rccs` CLI:

```sh
rccs config show
rccs config set endpoint http://127.0.0.1:8787
rccs config set codexapp_socket /path/to/codexapp.sock
rccs config set source_scope local:hooks
rccs config set source_session hooksd
rccs config set target_scope codex_tui/tui-appserver=local:tui
rccs config set target '{"namespace":"codex_tui","appserver_id":"tui-appserver","scope_id":"local:tui","endpoint":"unix:///path/to/app-server-control.sock"}'
rccs session bind timer-tui <session-id>
rccs schedule add wake-1 2026-09-16T12:00:00Z 'wake body' --session timer-tui
rccs schedule list
rccs schedule list --global
rccs wait 5m 'continue after the wait' --session timer-tui
rccs subagent list
rccs subagent list --global
rccs subagent close <thread-id>
rccs hook disable stop
rccs hook enable stop
```

`routecodex-hooks` remains installed as a compatibility alias. New usage
should use `rccs`.

CLI changes configuration and operator/schedule switches. MCP is query-only: register the installed wrapper once with `codex mcp add routecodex-hooks -- routecodex-hooks-mcp`, then use `routecodex_hooks_status` to read daemon health, Stop hook installation state, operators, and schedules. MCP must not be used to mutate state.

Refresh the installed CLI, hooks, and skills with `rccs init`; it copies the
same `skills/` bundle to `~/.agent/skills` and `~/.codex/skills`, preserves the
existing install target when rerun without explicit path flags, and is safe to
repeat.

`rccs schedule list` defaults to the current `CODEX_SESSION_ID`/`CODEX_THREAD_ID`;
use `--global` to inspect all schedules. `rccs wait` is a one-shot schedule:
the default form blocks in the daemon until delivery reaches a terminal state,
and `--async` returns immediately so the daemon can wake the session later.
Do not implement waits of one minute or more by polling in the agent.

Subagent schedules are registered as native children. `rccs subagent list`
defaults to the current session and `--global` lists all children. Closing a
working child interrupts its turn before archiving the thread; close success is
reported only after the native archive receipt is recorded.

The hook receives official JSON on stdin and forwards it to hooksd. hooksd owns policy state, persistence, idempotency, running-state gating, and the send decision; codexapp is the only message sender. An idle-only intent is deferred while the target is working or input-active. Unknown or disconnected state fails closed. A Stop event with `stop_hook_active: true` is guarded before an intent is created.

The installed `routecodex-hooksd` wrapper is the daemon process entry for the
RouteCodex lifecycle supervisor. It must be started with the
RouteCodex-internal `rccv3-codexapp` port; a missing or unverifiable CodexApp
port is a startup failure, not a ready state.

For RouteCodex-managed startup, enable routecodex-hooks-supervisor; init wires
the internal `rccv3-codexapp` command and its service socket. Its order is CodexApp ready → hooksd
ready, and its shutdown order is hooksd → CodexApp.

    rccs supervisor enable

An internal `codexapp.sendmessage` wake and official Stop `decision: "block"` are mutually exclusive. The send path returns ordinary successful hook output and does not claim delivery or execution. Do not use `continue: false` as delivery evidence. A non-zero hook exit means the daemon rejected or could not safely process the event.

This framework implements the official Stop hook path, daemon state/persistence
boundaries, CodexApp bridge contract, `rccs` configuration/switch controls, MCP
read-only status, one-shot and recurring notification delivery, occurrence
coalescing, and native subagent creation. Stopless policy, update-goal
mutation, and memory behavior remain contract-only.
RouteCodex-managed sidecar startup is implemented by the RouteCodex lifecycle
integration; the hooks repository's tests do not replace RouteCodex live
lifecycle evidence.
