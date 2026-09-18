# Codex Hooks Framework

This repository owns the independent Hooks Framework, its daemon, plugin
operators, typed CodexApp port, and official Codex lifecycle adapters.

## Ownership

- Skills contain static facts and usage methods.
- MCP is read-only state projection.
- CLI is the authorized mutation surface.
- Official hooks validate and adapt events; they do not own policy state.
- `hooksd` owns policy state, persistence, idempotency, status gating, and
  delivery decisions.
- `codexapp` owns TUI/Desktop App Server transport and running-state evidence.

No operator may call CodexApp directly. No control state may be reconstructed
from logs or business message payloads. Unknown or disconnected running state
fails closed. The default message mode is idle-only so automatic work does not
interrupt a working Codex session.

This repository does not enable Stopless, update-goal mutation, or memory
behavior by default. Stopless goal review is available only through an
explicitly activated LongHorizon `goal` record. Timer scheduling is opt-in
through hooksd session bindings and schedules; no product policy enables it
implicitly. `rccs` is the user-facing CLI. One-shot and recurring
notifications are coalesced before delivery. Native subagent creation uses the
App Server `thread/start` and `turn/start` operations; tmux text is never a
substitute.
