# AI Protocol Notes

Read when changing messages, validators, authentication, delivery or backfill.

## Contract ownership

[Milestone 1's Protocol package section](https://github.com/loganfuller/decent-sync/issues/1) defines the requirements. `protocol/src/index.ts` is the single definition of wire types and runtime validators used by the plugin and server. Ticket #5 defined the handshake: `hello`, `welcome`, `heartbeat`, `error`, the close codes in `CLOSE_CODES` and the `/sync` path. Subsequent tickets extend it; read the assigned ticket for scope.

Validators report problems by field name, never by value, because a `hello` carries the token; keep it that way, and never log frames. The server checks a `hello`'s protocol version before its shape, so an old plugin is told it is too old. Every refusal is an `error` message followed by a close with that error's code. The plugin stops reconnecting after a bad-token, too-old or replaced close, and retries with backoff after anything else.

The replacement begins at protocol version 1. The prototype also used the number 1 but was never released; compatibility with it is not required. `PROTOCOL.md` is historical prototype documentation only. Do not copy its Bluetooth identity, shared token, collection-part format or numeric close codes as requirements for the new contract.

The spec requires current and previous protocol-version support from here on, unknown-field tolerance, opaque Decaid payloads, at-least-once delivery, idempotent handlers and acknowledgment after storage. It also specifies whole-message chunking for any oversized message. Define those behaviors in the shared package and verify them through the simulated tablet, including raw-frame cases. Prototype array splitting does not satisfy that requirement.

## Mixed Decaid versions

Host capabilities and record fields vary independently of our protocol version. A missing endpoint means the collection is unavailable, not empty. Extraction and display must tolerate missing and unfamiliar fields without discarding the original payload. Inspect the relevant Decaid release when depending on a field or host behavior; see `AI_RUNTIME_NOTES.md`.

Milestone 1 captures data only. The server still sends control messages (welcome, acknowledgments, backfill requests and errors); shared-library writes to tablets come later. See the spec's Out of Scope section and ADR-0009.
