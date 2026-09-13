# Official Codex Hooks Capability Research

Source: [OpenAI Codex Hooks documentation](https://learn.chatgpt.com/docs/hooks)
and its release Markdown representation at
`https://learn.chatgpt.com/docs/hooks.md`, retrieved 2026-09-13.
The page states that the generated `main`-branch schemas may contain fields
not in the current release; this document treats the page's release behavior
as authoritative.

## Supported lifecycle events

The official page lists `SessionStart`, `SubagentStart`, `UserPromptSubmit`,
`PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`,
`SubagentStop`, `Stop`, `Interrupt`, and `SessionEnd`.

There is no event literally named `Input`. Input/context injection is exposed
through `SessionStart` and `UserPromptSubmit` output (`additionalContext`),
while `PreToolUse`/`PostToolUse`/`PermissionRequest` are the tool-call boundary.

## Command hook transport

- One JSON object is delivered on command-hook stdin.
- Commands run with the session `cwd`.
- JSON or supported plain text is read from stdout according to the event.
- stderr is the error/blocking-reason channel where the event supports exit 2.
- exit 0 with no output is success and Codex continues.
- command timeout is in seconds; the documented default is 600 seconds for
  most hooks, with one-second default and a three-second maximum for
  `Interrupt`/`SessionEnd` rules as documented.
- `async:true` runs a background command; background hooks cannot block,
  approve, rewrite, or control the triggering operation.
- hooks are invoked concurrently when multiple matching command handlers match
  the same event; one hook cannot prevent another from starting.

## Context injection

`SessionStart` and `UserPromptSubmit` support:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "..."
  }
}
```

This is official model-visible context. It is not a general arbitrary prompt
send API and is not available as a blanket guarantee for `Stop`.

## Stop

`Stop` has `turn_id`, `stop_hook_active`, and
`last_assistant_message`. Its matcher is ignored. With exit 0 it expects JSON.
The documented continuation shape is:

```json
{
  "decision": "block",
  "reason": "Run one more pass."
}
```

`decision:"block"` does not reject the finished turn: Codex creates a new
continuation prompt using `reason`. If any matching Stop hook returns
`continue:false`, that takes precedence over continuation decisions. This is
an official native continuation mechanism, distinct from an external
`codexapp.sendmessage` wake. The framework never treats `continue:false` as
proof that an external send was delivered and never combines external send
with native `decision:"block"`.

`stop_hook_active:true` means the turn was already continued by Stop and is the
mandatory loop guard for any future Stop policy.

## Tool-call hooks

`PreToolUse` can observe, block, or rewrite supported tool input using
`permissionDecision` and `updatedInput`. `PostToolUse` can observe feedback or
block/replace the model-visible result, but cannot undo completed side effects.
`PermissionRequest` can allow, deny, or decline. Tool matchers include Bash,
`apply_patch` aliases, MCP tool names, and most local function tools. Hosted
tools such as WebSearch are outside this local hook path. Some specialized
tools can opt out, so this is not a complete enforcement boundary.

MCP tool hooks use an already-connected MCP server; they do not start or
reconnect one. Missing servers/tools and MCP errors do not block the operation.

## Adapter consequences

The official contract guarantees lifecycle event delivery and event-specific
stdout decisions. It does not guarantee a direct sendmessage primitive, native
TUI/Desktop target discovery, cross-process retry, or a reply/ACK. Those belong
to the typed CodexApp adapter and daemon evidence ledger. The adapter therefore
validates stdin, sends one daemon RPC, and projects only the official result;
native transport identities and policy state never go into hook stdout or the
business payload.
