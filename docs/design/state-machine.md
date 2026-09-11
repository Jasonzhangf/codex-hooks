# State Machine Design Entry Point

The machine-readable state owner is [`../../contracts/state-machine.json`](../../contracts/state-machine.json).
The complete edge graph and evidence ceiling are in
[`../framework-graph.md`](../framework-graph.md).

The state model has independent concerns, all represented in the machine
readable contract:

1. Runtime lifecycle: `down → starting_codexapp → codexapp_ready →
   starting_hooksd → ready`, with explicit `draining` and `failed` exits.
2. Codex observation: `idle`, `working`, `stopping`, `disconnected`, and
   `unknown`.
3. Hook processing: validation, classification, idempotency, decision, timeout,
   duplicate, and failure.
4. Message delivery: suppression/queueing, deferred, emitted/sending, accepted,
   uncertain delivery, terminal failure/expiry, and later native evidence.
   Accepted is never promoted to delivered without a matching CodexApp receipt.
5. Schedule and operator lifecycle: configured/due/claimed schedule occurrences
   and independent inactive/armed/triggered/deferred/eligible operator states.

The default gate is `idle_only`: a working session is deferred and never calls
`sendmessage`. `working_allowed` is an explicit operator decision. Unknown,
disconnected, failed, and unknown states fail closed; starting and stopping
defer according to the typed contract; they are never guessed as idle.
