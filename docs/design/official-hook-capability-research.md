# Official Codex Hook Capability Research

Source: [OpenAI ChatGPT Learn — Hooks](https://learn.chatgpt.com/docs/hooks)

Retrieved: 2026-09-11

## Confirmed lifecycle surface

The official page documents these events:

```text
SessionStart
SubagentStart
UserPromptSubmit
PreToolUse
PermissionRequest
PostToolUse
PreCompact
PostCompact
SubagentStop
Stop
Interrupt
SessionEnd
```

Command hooks receive JSON on stdin. Matching hooks from multiple sources all
run; matching command hooks for one event can run concurrently. Hook commands
run with the session cwd. A hook definition may specify `timeout`,
`statusMessage`, `async`, and `additionalContextLimit`. The page documents
command and `mcp_tool` handlers; prompt and agent handlers are parsed but
skipped.

## Stop semantics

`Stop` receives `turn_id`, `stop_hook_active`, and
`last_assistant_message`. It expects JSON on stdout. Returning:

```json
{
  "decision": "block",
  "reason": "Run one more pass."
}
```

tells Codex to continue and creates a new continuation prompt using `reason`.
`stop_hook_active` identifies a turn already continued by Stop and is the
official recursion guard. This is the official native continuation path.

The common output field `continue: false` means that the current Hook run is
stopped. It is not a receipt for a message sent through another transport, and
it can affect how other Stop hook decisions are handled. The framework does
not use it to acknowledge external injection.

The framework keeps a separate external-wake path:

```text
Stop hook -> hooksd policy -> codexapp.sendmessage (when a wake is needed)
                         -> ordinary successful Stop output
```

The external path does not emit `decision: "block"`; that would ask Codex to
create a second continuation in addition to the queued message. It also does
not emit `continue: false` as an injection acknowledgment. The official page
does not establish that `continue: false` means “the separately sent message
was injected and will execute”. The adapter therefore returns the ordinary
successful/no-op Hook output until an installed same-entry TUI/Desktop replay
proves a more specific projection. Native Stop continuation and external
`sendmessage` are mutually exclusive policy choices.

## Input and tool semantics

`UserPromptSubmit` receives `prompt` and can return
`hookSpecificOutput.additionalContext`, which Codex adds as developer context.
`SessionStart` can also return `additionalContext`. This is the official input
injection projection; it is not a hidden metadata or response-payload carrier.

`PreToolUse` can deny a supported tool call or return `updatedInput` with an
allow decision. `PostToolUse` cannot undo a completed side effect; it can
provide feedback, and a blocking result changes the model-visible result.
`PermissionRequest` can allow, deny, or decline to decide. The framework keeps
these as adapter events and does not duplicate RouteCodex's existing tool
governance owner.

## Plugin and trust semantics

Codex discovers plugin-bundled hooks from the default
`hooks/hooks.json` path. A plugin may declare a custom hook path in its
manifest, but this repository uses the default path so the local plugin
validator and official discovery path agree. Non-managed hooks require review
and trust of the exact hook definition hash before running.

## Not established by official Hooks

The official page does not make the hook itself the owner of durable timer
state, Codex running-state observation, cross-process persistence, or native
TUI/Desktop message transport. Those remain `hooksd` and `codexapp` concerns.
The framework does not infer those capabilities from hook stdin, transcripts,
logs, or queue acceptance. In particular, a successful external send and an
empty/no-op Stop output are only adapter-level evidence; they are not proof of
delivery, execution, reply, or read.
