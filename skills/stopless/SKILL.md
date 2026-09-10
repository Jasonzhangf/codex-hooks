---
name: stopless
description: Explain how to use the independent Stop hook without creating a loop.
---

Stopless is a policy that may create a `MessageIntent`; it is not part of the
framework daemon and is intentionally not implemented in this skeleton.

The Stop hook must respect the official `stop_hook_active` guard. If a policy
needs to wake the session, the daemon uses `codexapp.sendmessage` and the hook
returns `{"continue":false}`. It must not combine that send with
`decision:"block"`, because official Stop `decision:"block"` creates its own
continuation prompt.
