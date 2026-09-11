# State Machine Design Entry Point

The machine-readable state owner is [`../../contracts/state-machine.json`](../../contracts/state-machine.json).
The complete edge graph and evidence ceiling are in
[`../framework-graph.md`](../framework-graph.md).
The requirement-by-requirement edge ledger is
[`edge-coverage.md`](edge-coverage.md); it distinguishes deterministic probes
from real native runtime evidence.

The state model has independent concerns, all represented in the machine
readable contract:

1. Runtime lifecycle: `down → starting_codexapp → codexapp_ready →
   starting_hooksd → ready`, with explicit `draining` and `failed` exits.
2. Codex observation: `idle`, `working`, `stopping`, `disconnected`, and
   `unknown`.
3. Hook processing: validation, classification, idempotency, decision, timeout,
   duplicate, and failure.
4. Message delivery: suppression/queueing, deferred, emitted/sending, accepted,
   uncertain delivery, terminal failure/expiry, and later native evidence
   through `delivered → executed → replied → read → consumed`.
   Accepted is never promoted to delivered without a matching CodexApp receipt.
5. Schedule and operator lifecycle: configured/due/claimed schedule occurrences
   and independent inactive/armed/triggered/deferred/eligible operator states.

Runtime lifecycle also models degraded service, orderly stopping/stopped,
crash, and restart. Hook action projection models observe/allow/deny/delay/
inject separately from the generic acknowledged result. Message contracts
include accepted/sent, later native evidence, retryable, deduplicated, and
unknown-delivery reconciliation states. `sent` and `acknowledged` are valid
receipt vocabulary for adapters, while the foundation's live outbox uses
`accepted` and `consumed` as its durable states. These are contract states;
the foundation does not enable a business operator.

The default gate is `idle_only`: a working session is deferred and never calls
`sendmessage`. `working_allowed` is an explicit operator decision. Unknown,
disconnected, failed, and unknown states fail closed; starting and stopping
defer according to the typed contract; they are never guessed as idle.
