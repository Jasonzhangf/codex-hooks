# RCCS Notification Liveness DAG

Status: implemented contract.

This document is the human review surface for LongHorizon goal liveness and
the shared notification gate. The machine-readable source is
[`contracts/rccs-notification-dag.json`](../../contracts/rccs-notification-dag.json).
The executable owners are [`src/control.js`](../../src/control.js),
[`src/timer.js`](../../src/timer.js), and [`src/daemon.js`](../../src/daemon.js).

## Scope

Registering a LongHorizon goal record activates it immediately. The control
plane creates one one-shot liveness schedule due 60 seconds after activation.
The schedule uses `idle_only`, `busy_policy=skip`, and source `longhorizon`.
It never uses `turn/steer`.

The same DAG also defines what happens after a wake is emitted. Native
acceptance is only one receipt state; delivery, execution, reply, and read are
separate evidence transitions. An uncertain transport result enters
reconciliation and is never blindly retried with the same attempt identity.

## DAG

```mermaid
flowchart TD
  A["register LongHorizon goal"] --> B["active by default"]
  B --> C["schedule one-shot liveness at activated_at + 60s"]
  C --> D["timer occurrence due"]
  D --> E["read CodexApp session status"]
  E -->|active / running / working| F["skip without queue backlog"]
  E -->|idle / interrupted| G["emit queue MessageIntent"]
  E -->|starting / stopping| H["persist deferred occurrence"]
  H --> E
  E -->|unknown / disconnected / failed / missing| I["fail closed and terminate occurrence"]
  G --> J["CodexApp send / thread queue"]
  J -->|accepted| K["accepted receipt"]
  K -->|matching target receipt| L["delivered"]
  L -->|execution evidence| M["executed"]
  M -->|response evidence| N["replied"]
  N -->|read cursor and item| O["read"]
  J -->|uncertain transport| P["unknown_delivery"]
  P --> Q["reconcile by attempt identity"]
  Q -->|matching receipt| L
  Q -->|no matching receipt| P
```

## Edge contract

| Edge | Owner | Input | Output / state | Failure evidence |
| --- | --- | --- | --- | --- |
| Register goal → active | `policy.longhorizon` | goal id, goal file, session alias | active record with `activated_at` | missing goal file or session binding |
| Active → liveness schedule | `policy.longhorizon` | activation timestamp | one-shot schedule due in 60s | schedule persistence error |
| Due → status observation | `policy.timer` → `codexapp` | target identity | normalized session state | status error maps to explicit failure |
| Active/running → skip | `hooksd` | `working` observation + `skip` | terminal `skipped`, no queue backlog | native send would be a contract failure |
| Idle/interrupted → queue | `hooksd` | legal send state | `MessageIntent.operation=queue` | no steer operation is allowed |
| Starting/stopping → deferred | `hooksd` | non-legal transition state | persisted pending occurrence | no blind send |
| Unknown/disconnected/failed/missing → fail closed | `hooksd` | non-authoritative state | terminal failure, no send | error retained on the schedule |
| Queue → accepted | `codexapp` | target, body, attempt id | native accepted receipt | transport error remains explicit |
| Accepted → delivered | `hooksd.transport` | matching target receipt | delivered evidence | acceptance alone is insufficient |
| Delivered → executed → replied → read | `hooksd.transport` | matching item, turn, cursor | ordered evidence states | missing evidence leaves state unresolved |
| Queue → unknown delivery | `hooksd.transport` | timeout or uncertain transport | `unknown_delivery` | no blind retry |
| Unknown → reconcile | `hooksd.transport` | same attempt identity | matching evidence or unresolved | mismatched receipt is rejected |

## Invariants

1. A newly registered LongHorizon goal is active by default.
2. The first liveness check is scheduled 60 seconds after activation.
3. Working, active, or running targets are skipped without creating a queue
   backlog.
4. Idle and interrupted targets receive a queue wake. Liveness never steers.
5. Starting and stopping are deferred until a legal observation.
6. Unknown, disconnected, failed, missing, and dead targets fail closed.
7. Accepted, queued, delivered, executed, replied, and read are distinct
   evidence states.
8. An uncertain delivery is reconciled by the same attempt identity and is
   never blindly retried.

## Evidence mapping

| Contract edge | Executable evidence |
| --- | --- |
| First liveness check | `test/longhorizon-liveness.test.js`: waits 60 seconds before the first wake |
| Idle queue wake | `test/longhorizon-liveness.test.js`: wakes an idle target through queue |
| Working skip | `test/longhorizon-liveness.test.js`: skips a working target without queueing |
| Interrupted queue wake | `test/longhorizon-liveness.test.js`: wakes an interrupted target through queue |
| Starting/stopping defer | `test/longhorizon-liveness.test.js`: defers while starting or stopping |
| Fail closed | `test/longhorizon-liveness.test.js`: fails closed for unknown disconnected failed |
| Missing session | `test/longhorizon-liveness.test.js`: records a missing session as terminal |
| Queue-only delivery | `test/longhorizon-liveness.test.js`: uses queue and never steers |
| Evidence progression | `test/longhorizon-liveness.test.js`: accepted evidence is not promoted to executed |
| Uncertain reconciliation | `test/longhorizon-liveness.test.js`: uncertain delivery reconciles without blind retry |
| Native status mapping | `test/codexapp-entry.test.js`: maps live and interrupted native status through the control socket |

## Verification

The feature is closed only when all of the following hold:

```sh
npm run check
npm test
```

Expected result: zero exit status, all Node tests passing, and the contract
test validating the notification DAG nodes, edges, resources, and test
bindings.
