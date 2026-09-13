# RouteCodex Hooks Framework Handoff

> Handoff date: 2026-09-13
> Repository: `/Users/fanzhang/Documents/github/codex-hooks`
> Current worktree: `/Users/fanzhang/Documents/github/codex-hooks/playground/internal-codexapp-0913`
> Current branch: `codex/hooks-internal-codexapp-0913`
> Base HEAD before this handoff: `a0cc93dec96f82a7a747fb09f0326f398e9eeb2c`
> Handoff commit: the commit containing this file; verify with `git rev-parse HEAD`.
> Worktree status at handoff: clean

## 1. Handoff objective

The next worker owns the remaining implementation and verification of the
repository-local internal `rccv3-codexapp` binary. The binary must provide the
typed transport boundary used by `hooksd`, own native TUI/Desktop App Server
protocol details, and be installed by the local `npm run init` flow. It must
not become a second policy/state owner.

The intended end-to-end boundary is:

```text
official hook stdin
  -> hook adapter
  -> hooksd policy/state/idempotency/running gate
  -> codexapp typed port
  -> native TUI/Desktop App Server
  -> native receipt/reply/read evidence
```

Only `codexapp` sends messages. `hooksd` decides whether and what to send.
`Skills` teach static facts and methods; `MCP` is read-only state; `CLI` owns
configuration and switches; official hooks only adapt lifecycle events.

## 2. Completed and committed

### Framework and design

Commit `a0cc93d` (`docs: document hooks framework architecture`) is already
committed on this branch and on the documentation branch
`codex/hooks-framework-delivery-0913`.

The committed framework includes:

- the layer and owner model in `docs/design/hooks-framework.md`;
- the complete lifecycle/state graph in `docs/design/state-machine.md` and
  `docs/framework-graph.md`;
- Cordis plugin/operator boundaries in
  `docs/design/plugin-and-operator-model.md`;
- typed TUI/Desktop transport boundary in
  `docs/design/codexapp-transport-boundary.md`;
- official hook capability findings in
  `docs/design/official-hook-capability-research.md`;
- evidence-level acceptance rows in `docs/design/acceptance-matrix.md`;
- edge coverage and verification plan in
  `docs/design/edge-coverage.md` and `docs/verification-plan.md`;
- contracts under `contracts/` and the local plugin/skill assets.

The framework deliberately has no enabled Stopless business policy, timer
product policy, memory behavior, or update-goal mutation. The operator names
are extension points/skeletons only. Do not reintroduce the old Stopless
reasoning-stop continuation implementation while implementing transport.

### Existing framework code

Already present and covered by local tests:

- official hook adapters and `Stop` guard handling;
- hooksd persistence, policy state, idempotency, and running-aware send gate;
- `idle_only` versus `working_allowed` behavior and fail-closed unknown/
  disconnected states;
- read-only MCP status surface;
- CLI configuration and hook/operator/schedule switches;
- deterministic timer state-machine skeleton only;
- Cordis runtime/plugin lifecycle skeleton;
- `CodexAppBridgePort` contract and JSON-lines bridge mapping;
- process supervisor ordering: CodexApp first, hooksd second; reverse shutdown.

Local evidence already collected before this handoff:

```text
npm run check        PASS
npm test             76 passed, 0 failed
git diff --check     PASS for a0cc93d^..a0cc93d
```

Still pending and must be run by the next worker:

```text
python3 /Users/fanzhang/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
```

The validator result is not currently part of the committed evidence.

## 3. Current implementation gap: internal CodexApp bin

The repository currently advertises `rccv3-codexapp` but does not ship or
install that executable.

Current facts:

- `src/install.js` writes supervisor command `rccv3-codexapp` into generated
  config, but does not install a wrapper/bin for it;
- `src/supervisor-entry.js` currently requires
  `ROUTECODEX_V3_CODEXAPP_BINARY`, requires an absolute executable whose
  basename is exactly `rccv3-codexapp`, and fails if it cannot be verified;
- `package.json` exposes CLI/MCP/hooksd/supervisor bins, but no
  `rccv3-codexapp` bin;
- `src/codexapp-port.js` currently speaks to an external Unix JSON-lines
  control bridge and maps bridge `session_status`/`send` into the hooks-facing
  port; it is not yet the repository-local native TUI/Desktop App Server
  adapter;
- consequently, a clean-host `init` followed by managed supervisor startup
  cannot be considered complete and can fail readiness if that binary is not
  supplied.

This gap is the likely source of the earlier production symptom:

```text
managed lifecycle validation failed: hooks sidecar exited before readiness
```

Do not solve it by weakening readiness, making hooksd pretend to be ready,
silently falling back to an external path, or making RouteCodex dependent on
an operator-specific environment variable. The system must still fail
closed for an unavailable hooks component without taking down the RouteCodex
main service; that fail-open/optional lifecycle behavior is owned by the
RouteCodex lifecycle integration, not by a fake CodexApp readiness record.

## 4. Native probe evidence and first divergence

The native local App Server endpoints that were observed are:

```text
TUI:     /Users/fanzhang/.codex/tui-appserver-20260908/app-server-control.sock
Desktop: /Users/fanzhang/.codex/app-server-control/app-server-control.sock
```

The isolated TUI probe created thread
`01a09a31-5de6-7fa1-99a5-7b4d881be2e6` and received exactly
`ACK-TUI-0913`. The isolated Desktop probe used thread
`01a09a29-3f95-7271-aac2-a0fab8f9ea8a` and received exactly
`ACK-DESKTOP-0913`.

Those probes prove that the native App Server operations can be reached from
an isolated probe. They are not yet proof that the installed hooks entry,
hooksd, internal bin, and native endpoint form one same-entry delivery trace.

The reference implementation at `/Users/fanzhang/github/codexapp` exposed a
bridge and was used only for investigation. It has no `.git` and is not a
delivery worktree. Its first observed failure was before native message send:

```text
Error: list_turns is not supported yet
```

The failing path was its `snapshot()` fallback:

```text
thread/items/list failure
  -> thread/read({ includeTurns: true })
  -> native list_turns unsupported
```

The adapter must not keep this unconditional fallback. Use typed capability
mapping: prefer `thread/items/list`, explicitly try `thread/turns/list` only
when supported, and preserve the exact unsupported-capability error when no
read operation is available.

A new/unmaterialized thread is a separate case. The first `queue/add` may be
allowed only when status is idle, input is not active, the target identity is
explicit, and the adapter records an explicit empty-baseline capability
evidence. Existing threads still require a supported baseline read. Queue
acceptance must never be promoted to delivered, executed, replied, or ACKed.

## 5. Required next work, in order

Work only in the current implementation worktree. Keep each change in the
smallest owner boundary.

### A. Add red tests first

Add tests for:

1. an installed `rccv3-codexapp` process emitting a valid readiness record;
2. no registered target producing a precise readiness/capability result,
   without pretending that a target exists;
3. target registration and explicit namespace/appserver/session/thread
   identity mapping;
4. native capability mapping for TUI and Desktop;
5. unsupported `thread/items/list`/`thread/turns/list` reads returning an
   explicit error rather than using `thread/read(includeTurns)` blindly;
6. a new/unmaterialized thread's first send using the explicit empty-baseline
   rule;
7. an existing thread requiring a real baseline read;
8. send timeout/uncertain delivery remaining `unknown_delivery`, never being
   treated as success.

### B. Implement the internal bin

Add the minimum repository-local `rccv3-codexapp` entry and native adapter.
The stable port should expose typed operations equivalent to:

```text
capabilities()
session_status(target)
send_message(request)
observe_delivery(message_id)
read_thread(target, cursor)
```

The implementation must:

- use a Unix JSON-lines control socket for hooksd communication;
- use the native Unix WebSocket JSON-RPC App Server endpoints privately;
- support both `codex_tui` and `codex_app` namespace bindings;
- preserve scope/session/thread/attempt/message identity in control state;
- keep business message body separate from control metadata;
- distinguish accepted, delivered, failed, and unknown evidence;
- expose readiness only after the advertised bridge and required capabilities
  are actually available;
- keep all policy/state/outbox decisions in hooksd.

### C. Make `init` install the bin

Update only the install/package/supervisor ownership needed to make a clean
host executable:

- expose `rccv3-codexapp` in `package.json` or install a generated executable
  wrapper from the local source;
- make `scripts/init.mjs`/`src/install.js` install it and record its absolute
  path in `install.json`;
- make generated supervisor config point to that recorded installed path;
- remove the requirement that an operator manually set
  `ROUTECODEX_V3_CODEXAPP_BINARY` for normal local installation;
- preserve explicit validation and useful failure messages for a genuinely
  missing or invalid binary.

### D. Verify at increasing evidence levels

Run local unit/contract tests, then clean-host init, then same-entry native
replay. Do not mark live rows complete from fixtures.

The required trace is:

```text
hook stdin
 -> daemon decision
 -> running-state query
 -> codexapp sendmessage
 -> native queue acceptance
 -> target receipt
 -> target execution
 -> reply
 -> read with changed cursor
 -> ACK when required
```

Run the trace for each namespace and separately cover:

- `idle_only` while target is working: zero native send;
- `idle_only` while target is idle: one send;
- explicit `working_allowed`: one send;
- failed send, timeout, disconnect, duplicate event, and daemon restart.

Record the first missing boundary. Never collapse accepted into delivered.

## 6. Branch/worktree map and forbidden scope

### Hooks repository

| Purpose | Path | Branch/HEAD | State | Rule |
| --- | --- | --- | --- | --- |
| Current implementation | `/Users/fanzhang/Documents/github/codex-hooks/playground/internal-codexapp-0913` | `codex/hooks-internal-codexapp-0913` / `a0cc93d` | clean | next worker writes here |
| Framework foundation | `/Users/fanzhang/Documents/github/codex-hooks` | `codex/hooks-framework-foundation-0910` / `b5f67a4` | clean when checked | reference only; do not write |
| Framework final | `/Users/fanzhang/Documents/github/codex-hooks/playground/framework-final-0912` | `codex/hooks-framework-final-0912` / `6086488` | not owned | do not write |
| Hooks main integration | `/Users/fanzhang/Documents/github/codex-hooks/playground/main-integrate-0912` | `main` / `e433bfb` | owned by integration work | do not edit or clean |
| Documentation delivery | `/Users/fanzhang/Documents/github/codex-hooks/playground/main-integrate-0912/playground/framework-delivery-0913` | `codex/hooks-framework-delivery-0913` / `a0cc93d` | clean when checked | docs already committed |
| Historical contract work | `/Users/fanzhang/Documents/github/codex-hooks/playground/internal-codexapp-contract-0911` | `codex/hooks-internal-codexapp-contract-0911` / `ebe4e2d` | not owned | inspect only; do not overwrite |

`/Users/fanzhang/github/codexapp` is reference source only and has no Git
delivery status. Copy or reimplement only the minimum adapter behavior into
this normal `codex-hooks` project; do not claim its files as this branch's
commit.

### RouteCodex repository

The current RouteCodex/Codex worktree is outside this task's write scope and
is dirty. Do not touch, clean, merge, push, restart, or alter production from
this handoff:

```text
/Users/fanzhang/.codex/worktrees/bcd6/routecodex
```

Also do not edit the RouteCodex root or other workers' playground worktrees.
RouteCodex lifecycle optional/fail-open behavior and any Stopless resource
retirement belong to the RouteCodex owner. This hooks task only supplies the
framework-side contract and internal transport implementation.

## 7. Non-negotiable design constraints

- No AGY Review. Use local read-only review and the repository's tests.
- No merge and no push by this worker. Deliver a commit SHA to the worker who
  owns integration.
- Do not restart a production RouteCodex process.
- Hooks failure must not make the RouteCodex main service unavailable. A
  missing optional hooks component must be observable and fail closed for hook
  work; it must not be represented as a false-ready sidecar.
- Do not revive Stopless. The official `Stop` adapter and a future Stopless
  policy are separate; current policy is intentionally disabled.
- Do not let operators call CodexApp directly. Operators return typed intents;
  the transport owner performs status gating, send, and evidence recording.
- Unknown, disconnected, unsupported, or uncertain transport state is not a
  successful delivery.
- Do not send probes to the user's active work session. Use isolated test
  threads only.
- Do not use logs, snapshots, or business payloads as control-state truth.

## 8. Delivery checklist for the next worker

Before handoff back to integration, the next worker must have:

```text
[ ] red tests added for the internal-bin/read-baseline gaps
[ ] rccv3-codexapp implemented and locally executable
[ ] init installs and records rccv3-codexapp on a clean temp host
[ ] supervisor starts codexapp then hooksd and stops in reverse order
[ ] npm run check
[ ] npm test
[ ] plugin validator
[ ] isolated TUI same-entry replay with evidence ceiling recorded
[ ] isolated Desktop same-entry replay with evidence ceiling recorded
[ ] acceptance-matrix rows updated to the exact proven level
[ ] local read-only review completed; no AGY Review
[ ] one Conventional Commit created on this branch
[ ] commit SHA, files, tests, and remaining risks sent to integration owner
[ ] no merge, push, production restart, or dirty-worktree cleanup
```

The next worker should start by checking `git status`, reading this file and
the linked design docs, then adding the red tests. Do not assume any live
bridge process, lease, socket, or previous probe is still active; re-check
current state before replay.
