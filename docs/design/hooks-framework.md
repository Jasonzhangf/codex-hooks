# Hooks Framework Design Entry Point

The authoritative framework design is [`../design.md`](../design.md). This
entry point exists so the plugin, operator, and RouteCodex integration docs all
refer to one design owner instead of copying policy rules.

The implementation is deliberately a framework skeleton. It defines the
official hook adapter, Cordis lifecycle, daemon status gate, persistence port,
MCP read boundary, CLI mutation boundary, and CodexApp transport port. The
Stopless, timer, update-goal, long-horizon, and memory operators remain
independent extension points; no business policy is enabled by default.
