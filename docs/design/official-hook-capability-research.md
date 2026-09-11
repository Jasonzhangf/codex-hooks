# Official Codex Hook Capability Research

Source: [OpenAI ChatGPT Learn — Hooks](https://learn.chatgpt.com/docs/hooks)

Retrieved: 2026-09-10

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
official recursion guard. A Stop hook may also return `continue: false`, but the
framework does not combine `decision: "block"` with an external
`codexapp.sendmessage` wake: that would create two continuation mechanisms.

The framework therefore uses this boundary:

```text
Stop hook -> hooksd policy -> codexapp.sendmessage (when a wake is needed)
                         -> official Stop output projection
```

The adapter returns `continue: false` only after a send has been accepted. A
native official Stop continuation remains a separately modeled policy and is
not enabled by this baseline.

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
logs, or queue acceptance.
