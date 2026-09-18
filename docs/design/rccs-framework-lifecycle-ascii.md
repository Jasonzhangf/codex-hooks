# RCCS Framework Lifecycle ASCII

Status: Stage 2 review surface. The normative design is
[`rccs-framework-closeout.md`](rccs-framework-closeout.md). This file is the
human-readable end-to-end lifecycle graph and does not create a second state
machine.

```text
INSTALL / REGISTER
==================

  user / agent
      |
      | rccs init
      v
  +-----------------------------+
  | installer                   |
  | - install source + wrappers |
  | - install skills idempotent |
  | - register managed Stop hook|
  | - call mcp register         |
  +--------------+--------------+
                 |
                 | inspect existing Codex MCP config
                 v
       +-------------------+
       | routecodex-hooks  |
       | MCP entry         |
       +---------+---------+
                 |
                 | read-only
                 v
       +-------------------+
       | routecodex_hooks_ |
       | status            |
       +-------------------+


SESSION BINDING / SCHEDULE REGISTRATION
=======================================

  live Codex session
      |
      | session_id / thread_id
      v
  +-----------------------------+
  | rccs session bind <alias>   |
  +--------------+--------------+
                 |
                 | persist typed target
                 v
  +-----------------------------+
  | hooksd session_bindings     |
  | alias -> namespace/appserver|
  |          session/thread     |
  +--------------+--------------+
                 ^
                 | resolve alias once at registration
                 |
  +--------------+--------------+
  | rccs schedule add ...       |
  | notify | wait | subagent    |
  +--------------+--------------+
                 |
                 | persist occurrence identity
                 v
  +-----------------------------+
  | hooksd schedule_state       |
  | configured -> enabled       |
  +-----------------------------+


TIMER / DELIVERY PLANE
======================

  daemon clock (1s tick)
      |
      v
  +-----------------------------+
  | TimerOperator.tick          |
  | due? claim occurrence once  |
  +--------------+--------------+
                 |
                 | occurrence_id = timer:<id>:<at>
                 | = intent_id = event_key
                 v
  +-----------------------------+
  | persisted schedule state    |
  | due -> claimed ->           |
  | send_pending                |
  +--------------+--------------+
                 |
                 v
  +-----------------------------+
  | status gate                 |
  | idle_only | working_allowed |
  +----+---------+---------+----+
       |         |         |
       | busy    | input   | unknown / disconnected /
       | defer   | active* | failed / dead
       v         v         v
  +---------+ +---------+ +-------------+
  | defer   | | defer   | | fail closed |
  | one     | | no      | | no send     |
  | pending | | inject  | | explicit    |
  +----+----+ +---------+ +-------------+
       |
       | idle observed, or busy_policy=skip
       v
  +-----------------------------+
  | typed SendRequest            |
  | queue (default)             |
  | steer internal policy only   |
  | interrupt only stop request  |
  +--------------+--------------+
                 |
                 v
  +-----------------------------+
  | CodexApp typed port          |
  | only native send boundary    |
  +--------------+--------------+
                 |
                 | thread/queue/add | turn/steer* | turn/interrupt
                 v
  +-----------------------------+
  | Codex App Server             |
  +--------------+--------------+
                 |
                 | native acceptance
                 v
  +-----------------------------+

  * target behavior only: the current bridge reports input_active=false,
    and the current rccs CLI does not expose a steer command.
  | delivery ledger              |
  | accepted / sent              |
  | NOT delivery/reply/read      |
  +--------------+--------------+
                 |
                 | message_status reconciliation
                 | same message_id + attempt_id
                 v
  +-----------------------------+
  | delivered -> executed ->     |
  | replied -> read -> consumed  |
  | only with authoritative      |
  | native evidence              |
  +-----------------------------+


SCHEDULE CONTROL / RECOVERY
===========================

  rccs schedule pause <id>   -> disabled (reversible)
  rccs schedule resume <id>  -> enabled
  rccs schedule stop <id>    -> stopped (terminal; no future send)
  rccs schedule remove <id>  -> cancelled (terminal record)

  restart:
      configured/enabled/disabled -> reload
      deferred_while_working      -> flush once after idle
      claimed/send_pending        -> unknown_delivery
      sent                        -> reconcile, never blind resend
      stopped/cancelled           -> terminal, never fire


SUBAGENT LIFECYCLE
==================

  rccs subagent create <prompt> --target ... [--ephemeral]
      |
      | fresh thread, no caller conversation inheritance
      v
  +-----------------------------+
  | thread/start                |
  | ephemeral: true when asked  |
  +--------------+--------------+
                 |
                 v
  +-----------------------------+
  | turn/start                  |
  +--------------+--------------+
                 |
                 | persist native thread_id + turn_id
                 v
  +-----------------------------+
  | subagent_registry           |
  | starting -> active/working  |
  +--------------+--------------+
                 |
                 | rccs subagent list/show
                 v
  +-----------------------------+
  | normalized state + evidence |
  +--------------+--------------+
                 |
                 | rccs subagent stop <thread-id>
                 v
  +-----------------------------+
  | read native status           |
  +--------------+--------------+
                 |
                 +---- no active turn ----> stopped/released
                 |
                 | active turn
                 v
  +-----------------------------+
  | turn/interrupt              |
  | thread_id + turn_id         |
  +--------------+--------------+
                 |
                 | persist interrupt receipt
                 v
  +-----------------------------+
  | stopped | released           |
  | ephemeral -> released        |
  | no archive/delete/close      |
  +-----------------------------+


STOPLESS / LONGHORIZON GOAL REVIEW
==================================

  official Stop hook
      |
      v
  +-----------------------------+
  | hook adapter -> hooksd      |
  | stop_hook_active guard      |
  +--------------+--------------+
                 |
                 +---- user interrupt / explicit stop ----> no reviewer
                 |
                 | eligible
                 v
  +-----------------------------+
  | stopless policy state       |
  | goal_ref + turn + budget    |
  +--------------+--------------+
                 |
                 | isolated ephemeral reviewer
                 v
  +-----------------------------+
  | fixed reviewer prompt       |
  | goal / observed / gap       |
  | next_action / evidence      |
  | completion_claim / blocked  |
  +--------------+--------------+
                 |
                 +---- failure/timeout ----> unresolved, non-blocking
                 |
                 | valid gap
                 v
  +-----------------------------+
  | delivery plane feedback     |
  | one MessageIntent           |
  +--------------+--------------+
                 |
                 v
  +-----------------------------+
  | original session receives   |
  | reviewed next action        |
  +-----------------------------+


REQUEST AUGMENTATION BOUNDARY
=============================

  official Hook surface:
      SessionStart / UserPromptSubmit
          -> additionalContext (allowed)

  final provider request / arbitrary tool schema rewrite:
      -> NOT AVAILABLE to official Hooks
      -> BLOCKED without modifying Codex or owning
         the provider request-assembly boundary
```
