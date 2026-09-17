# RCCS Framework Test Plan

Status: Stage 2 verification contract. Implementation is present in the Stage
2 candidate; execution evidence is recorded separately. The design under test is
[`../design/rccs-framework-closeout.md`](../design/rccs-framework-closeout.md).
The delivery sequence is
[`../delivery/rccs-framework-delivery-standard.md`](../delivery/rccs-framework-delivery-standard.md).

## 1. Test rules

1. Every test records command, precondition, expected state, evidence path, and
   failure criteria before it is run.
2. Unit and integration tests use an isolated temporary `CODEX_HOME`, state
   file, socket, and endpoint. They must not mutate the user's live daemon.
3. Live replay uses an independent tmux server and an independent Codex TUI.
   It never uses a shared session as evidence.
4. Native acceptance, delivery, execution, reply, read, and consumed are
   separate evidence levels. A later level is never inferred from an earlier
   one.
5. No test may use `pkill`, `killall`, `xargs kill`, or `kill $(...)`.
6. Test output is retained under `artifacts/rccs-closeout/<test-id>/` in the
   test worktree or a temporary evidence directory outside the repository.
7. A skipped test is reported as `NOT RUN`; a test with missing native evidence
   is reported as `UNVERIFIED`, not pass.

## 2. Test environment

Use one shell for setup:

```bash
export RCCS_TEST_ROOT="$(mktemp -d /tmp/rccs-closeout.XXXXXX)"
export CODEX_HOME="$RCCS_TEST_ROOT/codex-home"
export RCCS_AGENT_HOME="$RCCS_TEST_ROOT/agent-home"
export RCCS_BIN_DIR="$RCCS_TEST_ROOT/bin"
export RCCS_ENDPOINT="http://127.0.0.1:18787"
export RCCS_STATE="$RCCS_TEST_ROOT/state/state.json"
export RCCS_EVIDENCE="$RCCS_TEST_ROOT/evidence"
mkdir -p "$CODEX_HOME" "$RCCS_AGENT_HOME" "$RCCS_BIN_DIR" "$RCCS_EVIDENCE"
```

The source under test is the clean Stage 2 worktree. Set:

```bash
export RCCS_WORKTREE="/absolute/path/to/rccs-stage2-worktree"
cd "$RCCS_WORKTREE"
npm run check
npm test
```

The check command is:

```bash
npm run check && npm test
```

The expected result is exit code `0`, no failing Node test, and no syntax
error. Evidence is `artifacts/rccs-closeout/source-check/stdout.log` and
`stderr.log`. Failure criteria: any non-zero exit, any failed test, or a
source file that is not the candidate SHA.

## 3. Unit tests

### U1. Timer claim and one-shot terminal state

Command:

```bash
node --test test/timer.test.js
```

Precondition: a one-shot schedule is enabled, due time is reached, and the
mock CodexApp target is idle.

Expected state: one occurrence is claimed, one `queue` send is attempted, the
schedule records `sent`, and a second tick makes zero additional sends.

Evidence: `artifacts/rccs-closeout/U1/timer.log` plus the persisted schedule
record captured after the first and second ticks.

Failure criteria: two sends, a second claim, no persisted occurrence identity,
or `sent` without a matching native acceptance receipt.

### U2. Recurring coalescing

Command:

```bash
node --test test/timer.test.js
```

Precondition: an interval schedule has several missed intervals and the
target is idle.

Expected state: exactly one catch-up occurrence is sent; `next_at` advances to
a future interval; a subsequent tick sends nothing.

Evidence: `artifacts/rccs-closeout/U2/timer.log` and the before/after schedule
JSON.

Failure criteria: one send per missed interval, duplicate occurrence IDs,
`next_at` still in the past, or an unbounded backlog.

### U3. Busy defer and busy skip

Command:

```bash
node --test test/timer.test.js test/framework.test.js
```

Precondition: the target reports `working`; run one schedule with
`busy_policy=defer` and one with `busy_policy=skip`.

Expected state: `defer` persists one pending intent and flushes once after
idle; `skip` records a skipped occurrence, creates no pending intent, and
waits for the next interval.

Evidence: `artifacts/rccs-closeout/U3/defer.json`,
`artifacts/rccs-closeout/U3/skip.json`, and the mock send count.

Failure criteria: `defer` sends while working, `skip` creates a deferred
backlog, or either path sends more than once.

### U4. Status gate matrix

Command:

```bash
node --test test/framework.test.js
```

Precondition: exercise all nine session states with both send modes and with
`input_active=true`.

Expected state: the gate matches
[`../../contracts/state-machine.json`](../../contracts/state-machine.json);
`input_active=true` always defers; unknown/disconnected/failed always fail
closed.

Evidence: `artifacts/rccs-closeout/U4/gate-matrix.json`, including call count
per combination.

Failure criteria: any mismatch, a send while input is active, or a native call
for a fail-closed state.

### U5. Duplicate intent idempotency

Command:

```bash
node --test test/framework.test.js test/control.test.js
```

Precondition: submit the same occurrence ID, event key, and attempt identity
twice, concurrently and sequentially.

Expected state: the first request creates one intent; later requests return
the recorded result with `idempotent: true`; native send count is one.

Evidence: `artifacts/rccs-closeout/U5/duplicate.json` and the transition log.

Failure criteria: two intents, two native attempts, or a duplicate request
that overwrites the original evidence.

### U6. Schedule state machine

Command:

```bash
node --test test/control.test.js test/timer.test.js
```

Precondition: drive `configured`, `enabled`, `disabled`, `deferred_while_working`,
`send_pending`, `stopped`, `cancelled`, and `failed` transitions.

Expected state: only declared transitions are accepted; terminal states do
not fire; `stop` preserves evidence; `remove` is an explicit cancellation.

Evidence: `artifacts/rccs-closeout/U6/transitions.jsonl`.

Failure criteria: a terminal record fires, `pause` is confused with `stop`,
or a transition silently resets delivery evidence.

### U7. Stop cancels future firing and deferred flush

Command:

```bash
node --test test/timer.test.js test/control.test.js
```

Precondition: create a recurring schedule, produce a deferred occurrence, and
call `rccs schedule stop <id>` before the target becomes idle.

Expected state: the schedule is `stopped`; the deferred occurrence is
cancelled or explicitly marked not sendable; a later idle observation makes
zero native sends.

Evidence: `artifacts/rccs-closeout/U7/stop-before-flush.json` and the native
call count.

Failure criteria: a stopped schedule sends after stop, a deferred intent
flushes, or the stop result claims delivery.

### U8. Session binding and rebinding

Command:

```bash
node --test test/control.test.js
```

Precondition: bind alias `work` to session A, create a schedule, then bind the
same alias to session B without updating the schedule.

Expected state: the existing schedule still targets session A; explicit
`schedule update --session work` retargets it; a missing alias fails.

Evidence: `artifacts/rccs-closeout/U8/bindings.json`.

Failure criteria: an existing schedule silently follows a changed binding,
or an unknown alias is guessed from another session.

### U9. CLI argument validation

Command:

```bash
node --test test/control.test.js
node src/cli.js schedule --help
node src/cli.js wait --help
node src/cli.js subagent --help
node src/cli.js mcp --help
```

Precondition: run valid and invalid argument combinations, including missing
session, missing target, conflicting `--once/--every`, invalid send mode,
invalid busy policy, and invalid ISO time.

Expected state: valid commands print structured JSON or help; invalid commands
exit non-zero with a specific error and make no mutation.

Evidence: `artifacts/rccs-closeout/U9/cli-args.log` and daemon state before and
after invalid commands.

Failure criteria: silent acceptance, a mutation before validation, or a
generic error that does not identify the invalid field.

### U10. MCP tool contract

Command:

```bash
node --test test/mcp.test.js
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"routecodex_hooks_status","arguments":{"scope":"current","session_id":"test-session"}}}' \
  | routecodex-hooks-mcp
```

Precondition: a test daemon is running with one current-session schedule and
one other-session schedule.

Expected state: `tools/list` returns exactly `routecodex_hooks_status`;
`tools/call` returns health, control state, and only the requested scope;
there are no mutation requests.

Evidence: `artifacts/rccs-closeout/U10/mcp.jsonl` and the HTTP request log.

Failure criteria: a second tool, a write request, current-session leakage
into `--global`, or a global record omitted from `--global`.

### U11. Skill install idempotency

Command:

```bash
node src/cli.js init --codex-home "$CODEX_HOME" \
  --agent-home "$RCCS_AGENT_HOME" --bin-dir "$RCCS_BIN_DIR"
node src/cli.js init --codex-home "$CODEX_HOME" \
  --agent-home "$RCCS_AGENT_HOME" --bin-dir "$RCCS_BIN_DIR"
find "$CODEX_HOME/skills" "$RCCS_AGENT_HOME/skills" -name SKILL.md -print | sort
```

Precondition: both skill roots are empty except for one unrelated skill file
created by the test.

Expected state: managed skills exist in both roots; the unrelated file is
preserved; a second init does not duplicate files or hook entries; skill
content includes parameter semantics.

Evidence: `artifacts/rccs-closeout/U11/skill-tree-before.json`,
`skill-tree-after-first.json`, and `skill-tree-after-second.json`.

Failure criteria: missing skill root, duplicated managed file, overwritten
unrelated file, or parameter semantics absent from the installed skill.

### U12. MCP registration idempotency

Command:

```bash
node src/cli.js mcp register --name routecodex-hooks \
  --command "$RCCS_BIN_DIR/routecodex-hooks-mcp"
node src/cli.js mcp register --name routecodex-hooks \
  --command "$RCCS_BIN_DIR/routecodex-hooks-mcp"
codex mcp get routecodex-hooks --json
```

Precondition: use an isolated Codex home containing one unrelated MCP entry.

Expected state: the first run creates the managed entry; the second reports
`already_registered`; the unrelated entry is unchanged; a conflicting
existing name fails without overwriting.

Evidence: `artifacts/rccs-closeout/U12/config-before.toml`,
`config-after-first.toml`, `config-after-second.toml`, and
`mcp-get.json`.

Failure criteria: duplicate entry, overwritten unrelated entry, or silent
replacement of a conflicting command.

## 4. Integration tests

### I1. Daemon restart recovery

Command:

```bash
node src/daemon-entry.js --port 18787 --state-file "$RCCS_STATE" \
  --config "$RCCS_TEST_ROOT/hooksd.json" >"$RCCS_EVIDENCE/I1-first.log" 2>&1 &
export RCCS_DAEMON_PID=$!
node src/cli.js schedule add restart-check <future-at> 'restart recovery' \
  --session work --send-mode idle_only
kill -TERM "$RCCS_DAEMON_PID"
wait "$RCCS_DAEMON_PID"
node src/daemon-entry.js --port 18787 --state-file "$RCCS_STATE" \
  --config "$RCCS_TEST_ROOT/hooksd.json" >"$RCCS_EVIDENCE/I1-second.log" 2>&1 &
export RCCS_DAEMON_PID=$!
```

Precondition: persist a schedule before the first shutdown; stop with the
explicit PID; restart against the same state file.

Expected state: the record reloads; no duplicate intent is created; a
`claimed`/`send_pending` record becomes `unknown_delivery`; an idle deferred
record flushes once.

Evidence: `artifacts/rccs-closeout/I1/state-before.json`,
`state-after-restart.json`, and both daemon logs.

Failure criteria: state loss, blind resend, duplicate native attempt, or a
claim that restart alone proves delivery.

### I2. Deferred resume

Command:

```bash
node src/cli.js schedule add defer-check <future-at> 'defer check' \
  --session work --send-mode idle_only --busy-policy defer
node src/cli.js schedule show defer-check
```

Precondition: target starts `working`, then transitions to `idle`.

Expected state: first observation is `deferred_while_working`; idle transition
flushes one intent; state becomes `sent`; a second idle observation sends
nothing.

Evidence: `artifacts/rccs-closeout/I2/defer-state.jsonl` and the native send
count.

Failure criteria: send while working, no flush after idle, or duplicate flush.

### I3. Dead session fail closed

Command:

```bash
node src/cli.js schedule add dead-check <future-at> 'dead session' \
  --session missing-session --send-mode idle_only
node src/cli.js schedule show dead-check
```

Precondition: bind an alias to a session that is not loaded or is
disconnected; use a native status error.

Expected state: no send; the occurrence becomes `session_missing` or
`failed`; recurring schedules stop requiring explicit rebind/resume; MCP
shows the failure.

Evidence: `artifacts/rccs-closeout/I3/status-error.json` and
`schedule-after.json`.

Failure criteria: retry loop, send to an unknown target, or a success state
without native status.

### I4. Duplicate trigger sends once

Command:

```bash
node src/cli.js schedule add duplicate-check <future-at> 'duplicate check' \
  --session work
node src/cli.js schedule add duplicate-check <future-at> 'duplicate check' \
  --session work
```

Precondition: issue two concurrent registrations for the same schedule and
two concurrent timer ticks after due time.

Expected state: one schedule record, one occurrence, one native send; the
second operation returns the recorded result or an explicit duplicate result.

Evidence: `artifacts/rccs-closeout/I4/duplicate.json` and native call count.

Failure criteria: two schedule records, two sends, or a duplicate that erases
the first receipt.

### I5. Stop prevents further sends

Command:

```bash
node src/cli.js schedule add stop-check <future-at> 'stop check' \
  --session work --every 1m
node src/cli.js schedule stop stop-check
node src/cli.js schedule show stop-check
```

Precondition: a recurring schedule is due but not yet sent; stop is issued
before the next tick.

Expected state: state is `stopped`; no later tick sends; a deferred
occurrence is not flushed; the record preserves the stop timestamp and any
prior evidence.

Evidence: `artifacts/rccs-closeout/I5/stop.json` and zero-send count after
stop.

Failure criteria: a post-stop send, a stop that claims delivery, or a
restart that rearms the record.

### I6. Native failure remains explicit

Command:

```bash
node src/cli.js schedule add failure-check <future-at> 'failure check' \
  --session work
node src/cli.js schedule show failure-check
```

Precondition: inject a native `session_status` failure and a separate native
`send` failure through the typed port.

Expected state: status failure produces `session_missing` or `failed`;
definitive send failure produces `failed`; uncertain send timeout produces
`unknown_delivery`; no state is promoted to `sent` or `delivered`.

Evidence: `artifacts/rccs-closeout/I6/status-failure.json` and
`send-failure.json`.

Failure criteria: fallback send, blind retry, or a success state without a
native receipt.

### I7. Subagent ephemeral creation and list

Command:

```bash
node src/cli.js subagent create 'review the candidate' \
  --target codex_tui/tui-appserver --ephemeral --owner-session test-session
node src/cli.js subagent list --global
```

Precondition: a test Codex App Server accepts `thread/start` with
`ephemeral: true` and `turn/start`.

Expected state: one child record contains the native thread and turn IDs,
`ephemeral: true`, normalized state, target, prompt digest, and profile
snapshot; the child does not inherit caller context.

Evidence: `artifacts/rccs-closeout/I7/create-receipt.json` and
`subagent-list.json`.

Failure criteria: no native receipt, missing `ephemeral: true`, inherited
context, or a record without the native thread/turn identity required by the
registry contract.

### I8. Subagent stop uses `turn/interrupt`

Command:

```bash
node src/cli.js subagent stop <thread-id>
node src/cli.js subagent show <thread-id>
```

Precondition: a child is active with a live turn.

Expected state: exactly one `turn/interrupt` call with the recorded
`thread_id` and `turn_id`; no archive/delete call; stop evidence is persisted;
the child is `stopped` or `released`.

Evidence: `artifacts/rccs-closeout/I8/native-calls.jsonl` and
`stop-evidence.json`.

Failure criteria: archive/delete call, missing turn identity, simulated
stop, or state `stopped` without an interrupt receipt or explicit
`no_active_turn`.

### I9. Subagent no work after stop

Command:

```bash
node src/cli.js subagent stop <thread-id>
node src/cli.js subagent show <thread-id>
sleep 5
node src/cli.js subagent show <thread-id>
```

Precondition: child is working and receives a stop request; the native test
server records later `turn/start`, `thread/queue/add`, and tool calls.

Expected state: no later turn or tool call is attributed to the stopped
thread; the registry remains stopped/released; a later status read is
read-only.

Evidence: `artifacts/rccs-closeout/I9/after-stop-native.log` and the child
state snapshots.

Failure criteria: a post-stop turn, queue submission, or tool call; a state
that changes back to active without a new native creation receipt.

### I10. Archive not possible on main path

Command:

```bash
node src/cli.js subagent archive <thread-id>
node src/cli.js subagent delete <thread-id>
node src/cli.js subagent close <thread-id>
```

Precondition: an active subagent record exists.

Expected state: all three commands fail with an explicit unsupported command
error; no native `thread/archive`, `thread/delete`, or close call occurs.

Evidence: `artifacts/rccs-closeout/I10/unsupported.log` and native call count.

Failure criteria: any archive/delete/close call, a copy+delete compensation,
or a command that reports success without native stop evidence.

## 5. MCP integration tests

### M1. MCP unregistered and registered states

Command:

```bash
codex mcp get routecodex-hooks --json
node src/cli.js mcp register --name routecodex-hooks \
  --command "$RCCS_BIN_DIR/routecodex-hooks-mcp"
codex mcp get routecodex-hooks --json
```

Precondition: isolated Codex home with no managed MCP entry, then a valid
installed wrapper.

Expected state: the first query reports not found; registration writes one
entry; the second query reports the installed command; a repeated registration
is idempotent.

Evidence: `artifacts/rccs-closeout/M1/before.json`,
`after.json`, and `second.json`.

Failure criteria: duplicate entry, unrelated entry overwritten, or a
registration that points to a non-installed command.

### M2. Schedule current session and global query

Command:

```bash
routecodex-hooks-mcp <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"routecodex_hooks_status","arguments":{"scope":"current","session_id":"session-a"}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"routecodex_hooks_status","arguments":{"scope":"global"}}}
EOF
```

Precondition: create one schedule owned by `session-a` and one owned by
`session-b`.

Expected state: current query returns only `session-a`; global query returns
both; both responses include health and control state.

Evidence: `artifacts/rccs-closeout/M2/mcp.jsonl`.

Failure criteria: current query leaks another session, global query omits a
record, or MCP performs a mutation.

### M3. MCP status is read-only

Command:

```bash
routecodex-hooks-mcp <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"routecodex_hooks_status","arguments":{"scope":"global"}}}
EOF
```

Precondition: capture a state hash before the call.

Expected state: the returned state hash after the call is identical; the HTTP
server receives only `GET /health` and `GET /v1/control/state`.

Evidence: `artifacts/rccs-closeout/M3/http.log` and
`state-hash-before-after.json`.

Failure criteria: any POST, changed schedule, changed operator, or changed
subagent registry.

## 6. Live replay tests

### L1. Independent tmux and Codex TUI wait receipt

Command:

```bash
export TMUX_SOCKET="$RCCS_TEST_ROOT/tmux.sock"
tmux -S "$TMUX_SOCKET" new-session -d -s rccs-live \
  'codex --no-alt-screen'
tmux -S "$TMUX_SOCKET" send-keys -t rccs-live 'register this session, then wait for RCCS_LIVE_WAIT_<run-id>' Enter
node src/cli.js wait 5s 'RCCS_LIVE_WAIT_<run-id>' \
  --session <live-alias> --send-mode working_allowed
tmux -S "$TMUX_SOCKET" capture-pane -t rccs-live -p
```

Precondition: the TUI is independently started and bound to a real session
alias; the daemon is installed from the candidate binary; the target is idle.

Expected state: `wait` blocks, the daemon fires once, the native receipt is
recorded, and the exact marker appears in the TUI capture.

Evidence: `artifacts/rccs-closeout/L1/wait-cli.json`,
`native-receipt.json`, `tui-capture.txt`, and `daemon-log.jsonl`.

Failure criteria: marker absent, wait returns before native acceptance,
native receipt missing, or the TUI capture comes from a different session.

### L2. Independent tmux and Codex TUI schedule receipt

Command:

```bash
tmux -S "$TMUX_SOCKET" send-keys -t rccs-live 'register this session for the schedule test' Enter
node src/cli.js schedule add live-schedule <future-at> \
  'RCCS_LIVE_SCHEDULE_<run-id>' --session <live-alias> \
  --send-mode working_allowed --busy-policy defer
node src/cli.js schedule show live-schedule
tmux -S "$TMUX_SOCKET" capture-pane -t rccs-live -p
```

Precondition: same independent TUI, target idle at due time.

Expected state: one occurrence reaches native acceptance; the exact marker
appears in the TUI; the persisted schedule records `sent` or later evidence
only when independently reconciled.

Evidence: `artifacts/rccs-closeout/L2/schedule.json`,
`native-receipt.json`, and `tui-capture.txt`.

Failure criteria: marker absent, duplicate marker, send to another session,
or a delivery claim without native evidence.

### L3. Busy skip live behavior

Command:

```bash
node src/cli.js schedule add live-busy <future-at> \
  'RCCS_BUSY_SKIP_<run-id>' --session <live-alias> \
  --send-mode idle_only --busy-policy skip --every 10s
node src/cli.js schedule show live-busy
tmux -S "$TMUX_SOCKET" capture-pane -t rccs-live -p
```

Precondition: target is working when the occurrence is due and remains
working for one interval.

Expected state: no native send during the busy interval; a skipped
occurrence is persisted; the next interval is scheduled; no backlog appears.

Evidence: `artifacts/rccs-closeout/L3/busy-state.jsonl` and
`native-call-count.json`.

Failure criteria: injection while working, a queued backlog, or a skipped
occurrence reported as sent.

### L4. User input suppression live behavior

Command:

```bash
tmux -S "$TMUX_SOCKET" send-keys -t rccs-live 'typing a user prompt'
node src/cli.js wait 3s 'RCCS_INPUT_SUPPRESSION_<run-id>' \
  --session <live-alias> --send-mode working_allowed
tmux -S "$TMUX_SOCKET" capture-pane -t rccs-live -p
```

Precondition: the TUI has active user input (`input_active=true`) at due
time.

Expected state: the intent is deferred and no native send occurs until input
becomes inactive; the TUI does not receive the marker while the user is
typing.

Evidence: `artifacts/rccs-closeout/L4/input-active.json` and
`native-call-count.json`.

Failure criteria: injection while input is active, a lost deferred intent, or
an unbounded retry.

## 7. Subagent live replay

### S1. Ephemeral creation live receipt

Command:

```bash
node src/cli.js subagent create 'RCCS_SUBAGENT_<run-id>: report status' \
  --target <real-target> --ephemeral --owner-session <live-session-id>
node src/cli.js subagent list --global
```

Precondition: real App Server supports `thread/start { ephemeral: true }` and
`turn/start`; the target scope is explicitly configured.

Expected state: native thread/turn IDs are returned; the child is isolated;
the registry records `ephemeral: true`; no caller history is copied.

Evidence: `artifacts/rccs-closeout/S1/create-receipt.json`,
`list.json`, and `native-request.jsonl`.

Failure criteria: missing native identity, inherited caller context,
persisted ephemeral thread, or a fake receipt.

### S2. Stop live replay

Command:

```bash
node src/cli.js subagent stop <thread-id>
node src/cli.js subagent show <thread-id>
```

Precondition: the ephemeral child is working.

Expected state: exactly one native `turn/interrupt`; no archive/delete; the
child stops producing work; the registry records the interrupt receipt and
`released` or `stopped`.

Evidence: `artifacts/rccs-closeout/S2/native-calls.jsonl`,
`stop-receipt.json`, and `after-stop-output.log`.

Failure criteria: no interrupt, archive/delete fallback, child continues a
turn, or stop is reported without native evidence.

### S3. Explicit archive error

Command:

```bash
node src/cli.js subagent archive <thread-id>
```

Precondition: active child record.

Expected state: command is unsupported; no native archive call; the error
names the supported stop command.

Evidence: `artifacts/rccs-closeout/S3/error.json`.

Failure criteria: archive is attempted, copy+delete compensation is used, or
the error is silently ignored.

## 8. Negative and boundary tests

### N1. Unknown session

Command:

```bash
node src/cli.js schedule add unknown <future-at> 'unknown' --session unknown
node src/cli.js schedule show unknown
```

Precondition: no binding and no live session.

Expected state: registration fails before mutation, or firing records
`session_missing` with zero sends.

Evidence: `artifacts/rccs-closeout/N1/error.json` and native call count.

Failure criteria: guessed session, retry loop, or success state.

### N2. Native send failure

Command:

```bash
node src/cli.js wait 1s 'native failure' --session <live-alias>
```

Precondition: inject a definitive native send failure through the typed port.

Expected state: state is `failed`; the exact native error is preserved; no
blind retry; MCP exposes the failed intent.

Evidence: `artifacts/rccs-closeout/N2/failure.json`.

Failure criteria: success state, swallowed error, or duplicate attempt.

### N3. Native send timeout

Command:

```bash
node src/cli.js wait 1s 'uncertain timeout' --session <live-alias>
```

Precondition: inject a transport timeout after the request was written.

Expected state: state is `unknown_delivery`; no blind resend; reconcile path
remains explicit.

Evidence: `artifacts/rccs-closeout/N3/unknown.json`.

Failure criteria: `sent`, `delivered`, or an automatic duplicate attempt.

### N4. Subagent stop interrupt failure is explicit

Command:

```bash
node src/cli.js subagent stop <thread-id>
node src/cli.js subagent show <thread-id>
```

Precondition: the child is working and the native `turn/interrupt` call
returns an error.

Expected state: the exact native interrupt error is preserved; the registry
record remains active; no archive/delete/close call is attempted; no fallback
send path or simulated stop is used.

Evidence: `artifacts/rccs-closeout/N4/interrupt-error.json`,
`native-calls.jsonl`, and `registry-after.json`.

Failure criteria: archive/delete call, record advanced to stopped/released
without an interrupt receipt, swallowed error, or a reported close success.

### N5. Corrupted persisted state

Command:

```bash
printf '{not-json' > "$RCCS_STATE"
node src/daemon-entry.js --port 18787 --state-file "$RCCS_STATE" \
  --config "$RCCS_TEST_ROOT/hooksd.json"
```

Precondition: an invalid persisted state file.

Expected state: daemon startup fails explicitly; no partial ready state; the
corrupted file is not overwritten.

Evidence: `artifacts/rccs-closeout/N5/startup-error.log`.

Failure criteria: silent reset, ready state with empty schedules, or data
loss.

### N6. Hook timeout

Command:

```bash
printf '%s\n' '{"hook_event_name":"Stop","session_id":"test","turn_id":"turn","cwd":"/tmp"}' \
  | timeout 2 node src/hook-entry.js --config "$RCCS_TEST_ROOT/install.json" --kind stop
```

Precondition: hooksd is unavailable or deliberately slow.

Expected state: non-zero hook exit with an explicit error; no direct send; no
`decision:block`; daemon state unchanged.

Evidence: `artifacts/rccs-closeout/N6/hook-output.json` and
`daemon-state-before-after.json`.

Failure criteria: timeout treated as success, direct native call, or hidden
continuation.

## 9. Stopless and LongHorizon tests

### G1. Stopless disabled by default

Command:

```bash
node src/cli.js status
printf '%s\n' '{"hook_event_name":"Stop","session_id":"test","turn_id":"turn","cwd":"/tmp","stop_hook_active":false}' \
  | node src/hook-entry.js --config "$RCCS_TEST_ROOT/install.json" --kind stop
```

Precondition: default install with Stopless disabled.

Expected state: Stop is observed with no reviewer and no delivery intent;
`stop_hook_active=true` is guarded.

Evidence: `artifacts/rccs-closeout/G1/stop.json`.

Failure criteria: reviewer creation, message send, or hidden continuation.

### G2. Goal reviewer eligibility

Command:

```bash
node src/cli.js operator enable stopless
node src/cli.js longhorizon register goal-review --mode goal --goal-file <path>
```

Precondition: one ordinary Stop event with a registered goal and no user
interrupt; a separate user-interrupt Stop event.

Expected state: ordinary Stop creates one isolated reviewer; user interrupt
creates none; reviewer output with a gap creates one feedback intent; no
reviewer is created on `stop_hook_active=true`.

Evidence: `artifacts/rccs-closeout/G2/reviewer-events.jsonl`.

Failure criteria: context inheritance, reviewer loop, user-interrupt review,
or feedback without a validated gap.

### G3. Reviewer failure is non-blocking

Command:

```bash
node src/cli.js longhorizon register goal-review --mode goal --goal-file <path>
```

Precondition: inject network failure, request failure, malformed reviewer
JSON, and missing subagent capability in separate runs.

Expected state: original Stop returns successfully; review records
`unresolved` or `failed`; no blind retry; no fabricated gap or completion.

Evidence: `artifacts/rccs-closeout/G3/failure-matrix.json`.

Failure criteria: original turn blocked, fake success, or unbounded retry.

### G4. Periodic LongHorizon skip behavior

Command:

```bash
node src/cli.js longhorizon register periodic --mode periodic \
  --prompt 'inspect the goal document' --session <alias> --every 30s
node src/cli.js schedule list
node src/cli.js schedule stop <periodic-id>
```

Precondition: target is busy for one cycle, then idle for the next.

Expected state: busy cycle records `skipped`; idle cycle sends one inspection
prompt; stop disables all future cycles; no backlog.

Evidence: `artifacts/rccs-closeout/G4/periodic.jsonl`.

Failure criteria: backlog, post-stop send, or missing stop command in skill.

## 10. Request augmentation boundary

### R1. Official Hook context surface

Command:

```bash
node src/cli.js status
```

Precondition: inspect the installed Hook manifest and event schemas.

Expected state: `SessionStart` and `UserPromptSubmit` context projection is
documented as available; arbitrary final-request schema injection is marked
`blocked` and is not implemented.

Evidence: `artifacts/rccs-closeout/R1/capability-report.json` and the
installed skill text.

Failure criteria: a claim that Stop can rewrite provider schemas, a hidden
message-based schema injection, or a runtime patch to Codex.

### R2. No provider request rewrite

Command:

```bash
rg -n "provider.*request|system prompt|schema injection" src hooks contracts skills
```

Precondition: candidate source tree.

Expected state: no second provider request path and no direct request rewrite
from Hook output; request augmentation remains an explicit blocked item.

Evidence: `artifacts/rccs-closeout/R2/source-scan.log`.

Failure criteria: hidden request mutation, unowned provider transport, or a
source comment that claims the capability is closed.

## 11. Test completion gate

The Stage 2 candidate may enter delivery only when:

- all unit and integration tests pass;
- MCP registration and query tests pass on an isolated Codex home;
- one independent tmux TUI wait replay reaches a native receipt and displays
  the exact marker;
- one independent tmux TUI schedule replay reaches a native receipt and
  displays the exact marker;
- one ephemeral subagent is created, listed, stopped with `turn/interrupt`,
  and shows no post-stop work;
- the request-augmentation report marks schema injection `blocked` rather
  than claiming completion;
- every missing or skipped test has an explicit `NOT RUN` or `UNVERIFIED`
  entry in the final report.
