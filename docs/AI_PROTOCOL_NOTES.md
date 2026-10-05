# AI Protocol Notes

Read when changing messages, validators, authentication, delivery or backfill.

## Contract ownership

[Milestone 1's Protocol package section](https://github.com/loganfuller/decent-sync/issues/1) defines the requirements. `protocol/src/index.ts` is the single definition of wire types and runtime validators used by the plugin and server. Ticket #5 defined the handshake: `hello`, `welcome`, `heartbeat`, `error`, the close codes in `CLOSE_CODES` and the `/sync` path. Ticket #9 adds Shot delivery, indices, requests and acknowledgments; see `SHOTS.md` for the contract and delivery behavior. Subsequent tickets extend it; read the assigned ticket for scope.

Validators report problems by field name, never by value, because a `hello` carries the token; keep it that way, and never log frames. The only exception is a Decaid version's release numbers, which cannot hold a token. The server checks a `hello`'s protocol version before its shape, so an old plugin is told it is too old, then a valid `hello`'s Decaid version (ADR-0017). A version refusal keeps a string `token`, so the server can show the reason on a valid token's Machine (an invalid token changes nothing). Every refusal is an `error` message followed by a close with that error's code. The plugin stops reconnecting after a bad-token, plugin-too-old, Decaid-too-old or replaced close, waits for the machine to report other hardware after a hardware-dismissed close, and retries with backoff after anything else.

Identity is settled only at `hello` (ADR-0015). The plugin reconnects with a new `hello` when the machine first reports its hardware or reports different hardware, checking `GET /machine/info` on `stateUpdate` events (at most every 5 s) and every poll interval.

Supported versions follow ADR-0017. Before v1 the server accepts only the current protocol version, so a wire change that older plugins can't follow raises `PROTOCOL_VERSION` and `OLDEST_SUPPORTED_PROTOCOL_VERSION` together, with no handling for what an older plugin sent. A change they already follow or can ignore, such as a field they already send or a message they skip, needs no new version. From v1 it also accepts the previous release's protocol version. The archived prototype's protocol was never released and is not supported.

The spec also requires unknown-field tolerance, opaque Decaid payloads, at-least-once delivery, idempotent handlers and acknowledgment after storage. It specifies whole-message chunking for any oversized message. Define those behaviors in the shared package and verify them through the simulated tablet, including raw-frame cases.

## Mixed Decaid versions

Machines may run different supported Decaid versions, whose host capabilities and record fields vary independently of our protocol version. A missing endpoint means the collection is unavailable, not empty. Extraction and display must tolerate missing optional and unfamiliar fields without discarding the original payload. Write no fallbacks for layouts older than the oldest supported Decaid: a record missing what every supported version sends is ignored. Inspect the oldest supported Decaid release and the one in question when depending on a field or host behavior; see `AI_RUNTIME_NOTES.md`.

Milestone 1 captures data only. The server still sends control messages (welcome, acknowledgments, backfill requests and errors); shared-library writes to tablets come later. See the spec's Out of Scope section and ADR-0009.
