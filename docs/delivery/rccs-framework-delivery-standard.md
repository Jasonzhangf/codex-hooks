# RCCS Framework Delivery Standard

Status: Stage 2 delivery contract. This document defines the evidence required
to call the implemented Stage 2 candidate delivered. It is paired with
[`../design/rccs-framework-closeout.md`](../design/rccs-framework-closeout.md)
and [`../verification/rccs-framework-test-plan.md`](../verification/rccs-framework-test-plan.md).

## 1. Delivery rule

No stage may be inferred from an earlier stage. A candidate commit is not a
review, a review is not a merge, a merge is not an installed binary, an
installed binary is not a restarted daemon, a restart is not health, health is
not a live replay, and a live replay is not a remote push.

Every report must name:

- the exact worktree;
- the exact branch and candidate SHA;
- the exact test command and result;
- the review receipt identity;
- the exact merge SHA;
- the built artifact path and hash;
- the installed path and hash;
- the supervisor, CodexApp, and hooksd PIDs;
- the health JSON;
- the native receipt and TUI display evidence;
- the remote push receipt, when push is in scope.

## 2. Preconditions

Before implementation starts:

1. Read the project and global `AGENTS.md`.
2. Confirm `origin/main` is the integration base.
3. Create a new clean worktree from the latest `origin/main`.
4. Confirm the worktree is not `main` and is not the user's dirty tree.
5. Record the base SHA and allowed paths.
6. Confirm the pre-existing untracked files are not touched:
   - `docs/design/lifecycle-flowchart.md`
   - `docs/design/rcc-internal-hooks-sidecar-goal.md`
   - `docs/design/rcc-internal-hooks-sidecar-plan.md`

The candidate may not modify `/Users/fanzhang/code/codex`.

## 3. Candidate stage

Command pattern:

```bash
git status --short --branch
git rev-parse HEAD
git diff --check
git diff --stat origin/main...HEAD
```

Required evidence:

| Evidence | Required content |
| --- | --- |
| Candidate worktree | absolute path and branch |
| Base SHA | `origin/main` at worktree creation |
| Candidate SHA | commit containing the reviewed source |
| Changed paths | complete list, with no unrelated edits |
| Contract impact | schedule, subagent, MCP, skill, Stopless boundaries |

Candidate completion criteria:

- the candidate contains only the scoped Stage 2 implementation;
- no archive/delete/close subagent path exists;
- no second send path exists;
- no fake delivery evidence exists;
- no provider request rewrite is claimed;
- `git diff --check` passes.

Failure criteria: dirty worktree, main worktree development, missing scope
declaration, or unrelated changes.

## 4. Verification stage

Run the commands in
[`../verification/rccs-framework-test-plan.md`](../verification/rccs-framework-test-plan.md).

Required evidence:

```text
artifacts/rccs-closeout/source-check/stdout.log
artifacts/rccs-closeout/source-check/stderr.log
artifacts/rccs-closeout/U*/...
artifacts/rccs-closeout/I*/...
artifacts/rccs-closeout/M*/...
artifacts/rccs-closeout/L*/...
artifacts/rccs-closeout/S*/...
artifacts/rccs-closeout/N*/...
artifacts/rccs-closeout/G*/...
artifacts/rccs-closeout/R*/...
```

The candidate is eligible for review only when:

- `npm run check` passes;
- `npm test` passes;
- unit and integration evidence is present;
- at least one independent tmux wait replay reaches native receipt and exact
  TUI display;
- at least one independent tmux schedule replay reaches native receipt and
  exact TUI display;
- one ephemeral subagent creation/list/stop replay reaches native
  `turn/interrupt` evidence and no post-stop work;
- MCP current-session and global queries are both verified;
- the request augmentation report explicitly marks schema injection
  `design-only`.

Missing live evidence makes the candidate `UNVERIFIED`, not failed and not
passed.

## 5. Independent review stage

Review is independent from implementation. The reviewer receives the exact
candidate SHA and a read-only worktree.

Required review checks:

- schedule timer, binding, and injection ownership;
- idempotency and coalescing;
- stop cancellation of future and deferred sends;
- subagent stop uses only `turn/interrupt`;
- ephemeral creation/release/no-delete semantics;
- MCP remains read-only;
- skill parameters match CLI behavior;
- Stopless `intentFactory` wiring is enabled only by a registered LongHorizon
  goal record;
- request/schema injection is not claimed as implemented;
- no forbidden fallback, second send path, or fake evidence;
- no modifications outside the allowed scope.

Required review receipt:

```text
reviewer:
backend:
candidate_sha:
reviewed_at:
verdict: PASS | FAIL
findings:
evidence_refs:
```

Only `PASS` on the exact candidate SHA permits the merge stage. A review of an
older SHA is invalid.

## 6. Merge stage

Merge only the reviewed candidate into the project mainline.

Command pattern:

```bash
git switch main
git pull --ff-only
git merge --no-ff <candidate-branch>
git status --short --branch
git rev-parse HEAD
git log -1 --oneline --decorate
```

Required evidence:

| Evidence | Required content |
| --- | --- |
| Candidate SHA | reviewed commit |
| Merge SHA | resulting `main` commit |
| Merge type | `--no-ff` traceable merge |
| Main status | clean, except explicitly listed pre-existing untracked files |
| Parentage | candidate is an ancestor of the merge SHA |

Required checks:

```bash
git merge-base --is-ancestor <candidate-sha> <merge-sha>
git status --short --branch
```

Main must be clean after the merge. The explicitly listed pre-existing
untracked files may remain; they must not be overwritten or removed.

Failure criteria: merge from a stale main, force push, missing candidate
ancestry, protected-branch hook bypass, or unlisted dirty files.

## 7. Rebuild stage

Rebuild from the merged main, not from the candidate worktree and not from a
cached artifact.

Command pattern:

```bash
git switch main
git rev-parse HEAD
npm run check
npm test
node src/cli.js init --codex-home "$CODEX_HOME" \
  --agent-home "$RCCS_AGENT_HOME" --bin-dir "$RCCS_BIN_DIR" \
  --endpoint "$RCCS_ENDPOINT"
```

Required evidence:

```text
main_sha:
build_command:
build_exit_code:
installed_cli:
installed_cli_sha256:
installed_mcp:
installed_mcp_sha256:
installed_daemon:
installed_daemon_sha256:
installed_skill_paths:
installed_skill_hashes:
```

The installed `rccs`, `routecodex-hooks-mcp`, `routecodex-hooksd`, and
`routecodex-hooks-supervisor` must be executable and point to the merged
source.

Failure criteria: artifact built from a candidate SHA, stale wrapper, missing
skill, or hash mismatch.

## 8. Install and restart stage

Install the merged build into the real runtime location. Restart only through
the supervisor or an explicit PID/service lifecycle.

Allowed shutdown methods:

- `routecodex-hooks supervisor` graceful stop;
- `kill -TERM <explicit-pid>`;
- a project-declared service lifecycle command that targets the named
  service.

Banned methods:

```text
pkill
killall
xargs kill
kill $(...)
```

Restart order:

1. stop hooksd;
2. stop CodexApp;
3. start CodexApp;
4. verify capabilities;
5. start hooksd;
6. verify hooksd readiness.

Required evidence:

```text
supervisor_pid:
codexapp_pid:
hooksd_pid:
stop_command:
stop_exit_code:
start_command:
start_exit_code:
restart_timestamp:
```

The installed runtime must be the merged build. A restart of the old process
is not evidence of installing the new one.

Failure criteria: broad kill command, restarted old binary, missing PID
evidence, or unverifiable readiness.

## 9. Health stage

Health is a separate query after restart.

Command:

```bash
curl -fsS "$RCCS_ENDPOINT/health"
curl -fsS "$RCCS_ENDPOINT/v1/control/state"
```

Required evidence:

```text
health_json:
control_state_json:
ready:
protocol:
operator_registry:
schedule_count:
binding_count:
subagent_count:
```

Health must report the installed runtime, not a mock. The state must be
consistent with the install record and the real PIDs.

Failure criteria: health from a different endpoint, mock daemon, stale
process, or a control state that cannot be tied to the restarted runtime.

## 10. Live replay stage

Live replay is the first evidence that the installed runtime can affect a real
Codex TUI/Desktop session.

### 10.1 Wait replay

Command:

```bash
tmux -S <isolated-socket> new-session -d -s <isolated-name> \
  'codex --no-alt-screen'
node <installed-rccs> wait 5s 'RCCS_LIVE_WAIT_<run-id>' \
  --session <live-alias> --send-mode working_allowed
tmux -S <isolated-socket> capture-pane -t <isolated-name> -p
```

Required evidence:

```text
wait_command:
wait_exit_code:
schedule_record:
native_message_id:
native_attempt_id:
native_receipt:
tui_capture:
marker_match:
```

The marker must appear in the isolated TUI. A `sent` state without a matching
native receipt is `UNVERIFIED`.

### 10.2 Schedule replay

Command:

```bash
node <installed-rccs> schedule add <id> <future-at> \
  'RCCS_LIVE_SCHEDULE_<run-id>' --session <live-alias> \
  --send-mode working_allowed --busy-policy defer
tmux -S <isolated-socket> capture-pane -t <isolated-name> -p
```

Required evidence:

```text
schedule_id:
occurrence_id:
native_message_id:
native_attempt_id:
native_receipt:
tui_capture:
marker_match:
```

The same run ID must appear in the CLI evidence, native receipt, daemon state,
and TUI capture.

Failure criteria: marker absent, wrong session, duplicate marker, or
delivery/reply claim without native evidence.

### 10.3 Subagent replay

Command:

```bash
node <installed-rccs> subagent create 'RCCS_SUBAGENT_<run-id>' \
  --target <real-target> --ephemeral
node <installed-rccs> subagent list --global
node <installed-rccs> subagent stop <thread-id>
node <installed-rccs> subagent show <thread-id>
```

Required evidence:

```text
thread_id:
turn_id:
ephemeral:
create_receipt:
interrupt_receipt:
post_stop_native_calls:
registry_state:
```

The stop path must use `turn/interrupt`. Archive/delete/close evidence is a
failure for this delivery.

## 11. Remote push stage

Push only after the merge and required local validation. Push is a separate
authorization-sensitive stage when the task scope does not already include it.

Command pattern:

```bash
git push origin main
git ls-remote origin refs/heads/main
```

Required evidence:

```text
local_main_sha:
remote_main_sha:
push_exit_code:
remote_receipt:
```

The local and remote main SHA must match. A push receipt alone does not prove
installation, restart, health, or live replay.

## 12. Completion definition

The Stage 2 delivery is `COMPLETE` only when all applicable items below are
present:

- candidate SHA and clean candidate worktree;
- review `PASS` on the exact candidate;
- merge SHA with candidate ancestry;
- main clean except the explicitly listed pre-existing untracked files;
- rebuild from main;
- installed binary and skill hashes;
- supervisor, CodexApp, and hooksd PIDs;
- health JSON from the restarted runtime;
- independent tmux wait replay with native receipt and TUI marker;
- independent tmux schedule replay with native receipt and TUI marker;
- ephemeral subagent creation/list/stop with `turn/interrupt` evidence;
- MCP current-session and global query evidence;
- explicit `design-only` status for request/schema injection;
- remote push receipt when push is in scope.

If any applicable item is missing, the report is `INCOMPLETE`.

If an item was executed but its authoritative evidence is missing, the report
is `UNVERIFIED`.

If the candidate contains a forbidden path, fake evidence, a second send
path, archive/delete/close for subagent stop, or an unapproved production
change, the report is `FAILED`.

## 13. Cleanup

After delivery, remove only resources created by this task:

- the Stage 2 worktree;
- temporary test directories under `/tmp/rccs-closeout.*`;
- isolated tmux servers created for the replay;
- temporary sockets and state files created by the tests;
- temporary logs and build artifacts created by this run.

Do not remove user files, unrelated worktrees, existing daemon state, or
shared evidence. Do not use broad process-kill commands. Cleanup is reported
separately from delivery success.

## 14. Report template

```text
STATUS: COMPLETE | INCOMPLETE | UNVERIFIED | FAILED

Source
- worktree:
- branch:
- candidate SHA:
- base main SHA:

Verification
- check:
- tests:
- live wait replay:
- live schedule replay:
- subagent replay:
- MCP:
- request augmentation:

Review
- reviewer:
- candidate SHA:
- verdict:
- receipt:

Merge
- merge SHA:
- candidate ancestor:
- main status:

Build and install
- build command:
- installed paths:
- binary hashes:
- skill hashes:

Runtime
- supervisor PID:
- codexapp PID:
- hooksd PID:
- health JSON:
- replay receipts:
- remote push:

Remaining
- blocked:
- not run:
- unverified:
```
