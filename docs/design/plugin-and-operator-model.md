# Plugin and Operator Model

The installed plugin is described by
[`../../.codex-plugin/plugin.json`](../../.codex-plugin/plugin.json). Official
hook definitions live in [`../../hooks/hooks.json`](../../hooks/hooks.json),
using Codex's default plugin-bundled `hooks/hooks.json` discovery path.

Cordis owns plugin lifecycle and disposal only. The daemon owns policy state,
idempotency, persistence, status gating, and delivery decisions. Every future
operator returns a typed message intent or an observe-only result and cannot
call CodexApp directly.

Current operator slots are:

- `stopless`: independent Stop policy with the official `stop_hook_active`
  recursion guard;
- `update-goal`: independent tool matcher and goal revision state;
- `timer`: CLI-created schedule and daemon-owned occurrence state;
- `longhorizon`: future checkpoint/wakeup state;
- `memory`: future input injection and extraction, out of scope for this
  baseline.

The slots are contracts, not enabled business implementations.
