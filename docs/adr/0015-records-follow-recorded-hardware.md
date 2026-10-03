# Records follow the hardware they recorded, and identity is settled at hello

ADR-0004 credits each shot to the machine whose model and serial it recorded. Decaid's records make that partial, so this decision fills in the cases ADR-0004 leaves open.

A Shot is credited by its own `workflow.machine` when that names real hardware: a non-empty serial other than `"0"`, and a `provenanceStatus` other than `unavailable`. Model and serial together are the identity, so the same serial on a different model is different hardware. If no Machine has that identity, the Shot is credited to a **Pending Machine** for it, the same record a mismatched connection creates. An Admin either creates a machine entry for that hardware, which takes over its Shots, or dismisses it. Dismissing keeps the Shots but leaves them out of lists; creating a machine entry for the same hardware later brings them back. Capture never deletes data.

Every other Shot (no `workflow.machine`, serial `"0"`, or `provenanceStatus: unavailable`) is credited to the Machine whose tablet reported it and marked as inferred. That covers legacy `de1app` imports and every Shot recorded before Decaid v0.7.6, when `workflow.machine` was introduced.

We rejected crediting unknown hardware to the reporting Machine, because a tablet that moved between machines would refile the old machine's history under the new one, which ADR-0004 exists to prevent. We rejected creating machine entries automatically, because Machines would then appear that nobody adopted.

## Consequences

- **Steam Records carry no hardware identity.** Decaid's steam sequencer stores the current Workflow without `workflow.machine`. Steam Records are credited to the reporting Machine without an inferred marker, which would otherwise be on every one. After a tablet moves to another machine, backfilled Steam Records can be misattributed. Stamping machine identity on Steam Records is an upstream ask.
- **Identity is decided only at `hello`.** A tablet often loads the plugin before its machine connects, so a `hello` can arrive without model and serial (Decaid's `machine/info` fails while no machine is connected). Such a connection is accepted for the token's Machine without changing the token's binding. It counts as identified if its connection id is a known alias of that Machine; otherwise the Machine shows that its hardware has not been reported yet. It is never treated as unidentified or as a mismatch. When the machine first reports its hardware, or reports different hardware, the plugin reconnects and sends a new `hello`. The gateway never changes a session's identity mid-session.
