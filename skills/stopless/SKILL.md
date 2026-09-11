---
name: stopless
description: Explain how to use the independent Stop hook without creating a loop.
---

Stopless is a policy that may create a `MessageIntent`; it is not part of the
framework daemon and is intentionally not implemented in this skeleton.

For local installation, configuration, Stop hook enablement, and status checks,
use the `routecodex-hooks` skill. This skill only defines the Stopless policy
boundary and loop guard.

The Stop hook must respect the official `stop_hook_active` guard. If a policy
needs to wake the session through the external path, the daemon uses
`codexapp.sendmessage` and the hook returns ordinary successful output (`{}`).
Do not use `continue:false` as an injection acknowledgment: officially it
marks this hook run stopped and is not evidence that the separately sent
message was delivered or executed. Do not combine the external send with
`decision:"block"`, because official Stop `decision:"block"` creates its own
continuation prompt. Native `decision:"block"` is a separate, mutually
exclusive policy and is not enabled by this skeleton.
