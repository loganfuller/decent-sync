# AI Protocol Notes

Read when changing messages, validators, authentication, delivery or backfill.

## Contract ownership

[Milestone 1's Protocol package section](https://github.com/loganfuller/decent-sync/issues/1) defines the requirements. `protocol/` will hold the single definition of wire types and runtime validators used by the plugin and server. Ticket #2 creates the package; ticket #5 starts its handshake contract, and subsequent tickets extend it. Read the assigned ticket for scope.

The replacement begins at protocol version 1. The prototype also used the number 1 but was never released; compatibility with it is not required. `PROTOCOL.md` is historical prototype documentation only. Do not copy its Bluetooth identity, shared token, collection-part format or numeric close codes as requirements for the new contract.

The spec requires current and previous protocol-version support from here on, unknown-field tolerance, opaque Decaid payloads, at-least-once delivery, idempotent handlers and acknowledgment after storage. It also specifies whole-message chunking for any oversized message. Define those behaviors in the shared package and verify them through the simulated tablet, including raw-frame cases. Prototype array splitting does not satisfy that requirement.

## Mixed Decaid versions

Host capabilities and record fields vary independently of our protocol version. A missing endpoint means the collection is unavailable, not empty. Extraction and display must tolerate missing and unfamiliar fields without discarding the original payload. Inspect the relevant Decaid release when depending on a field or host behavior; see `AI_RUNTIME_NOTES.md`.

Milestone 1 captures data only. The server still sends control messages (welcome, acknowledgments, backfill requests and errors); shared-library writes to tablets come later. See the spec's Out of Scope section and ADR-0009.
