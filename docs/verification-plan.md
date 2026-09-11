# Framework Verification Plan

The graph is accepted only when each edge has an executable positive and
negative probe. Configuration presence is not runtime evidence.

## Contract and resource checks

- validate `.codex-plugin/plugin.json` with the official plugin validator;
- validate every JSON resource contract;
- verify every event in `src/protocol.js` has one reachable manifest adapter;
- verify every manifest matcher maps to exactly one hook kind;
- verify resource owner and forbidden-edge map is machine-readable.

## Runtime lifecycle

- `routecodex start` starts codexapp, waits for capabilities, then starts
  hooksd;
- codexapp startup failure prevents hooksd-ready;
- hooksd startup failure prevents hook-ready;
- shutdown disposes Cordis plugins and leaves no owned endpoint;
- Hook invocation before ready fails explicitly and does not direct-send.

## Communication

For each real namespace (`codex_tui`, `codex_app`), record:

```text
emitted → provider/native acceptance → target receipt → executed → replied
→ read with cursor → consumed, when required
```

An accepted queue insertion must not be reported as a reply. Unsupported native
operation, empty read page, unchanged cursor, timeout, and native error remain
explicit failures or incomplete states.

## Status gate matrix

Run all ten combinations of five statuses and two send modes. Assert actual
codexapp `sendmessage` call count:

```text
idle + either mode                 => one send
working + idle_only                => zero sends, pending persisted
working + working_allowed           => one send
stopping + either mode              => zero sends, pending persisted
unknown/disconnected + either mode  => zero sends, fail_closed
```

After a deferred item, produce a real status transition to idle and verify one
send. Restart before flush and verify pending recovery without duplicate send.

## Hook boundaries

- official stdin reaches daemon through installed command;
- stdout contains only official top-level JSON;
- external Stop wake returns ordinary successful/no-op output and never
  `decision:block`;
- native Stop `decision:block` is a separate, mutually exclusive policy and
  requires its own installed replay; `continue:false` is not treated as an
  injection acknowledgment;
- `stop_hook_active=true` produces no new intent;
- `tool_use_id` is required for tool idempotency;
- `update_goal` matcher cannot enter ordinary tool policy;
- input injection uses official `additionalContext` projection;
- timer wake originates in daemon, not background Hook.

## Persistence and uncertainty

- schedule, policy state, pending, accepted, failed, and unknown delivery
  survive restart;
- same event/intent concurrent requests produce one native attempt;
- transport timeout creates `unknown_delivery` and does not blind-retry;
- reconcile either proves the original delivery or leaves it unresolved;
- MCP reads all transitions without mutating them;
- CLI mutation is visible through subsequent MCP query.

## V3 removal gate

Only after all applicable checks above pass on installed same-entry runtime:

1. freeze V3 Stopless behavior as migration baseline;
2. remove V3 Stopless unique owner and all references;
3. run V3 transparent proxy, tool, web-search, continuation, and non-Codex
   client regressions;
4. run independent Codex Review on the exact deletion candidate;
5. merge the isolated worktree into the project mainline.
