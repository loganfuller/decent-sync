# A short window of Decaid and plugin versions, enforced at hello

Before v1, Decent Sync supports only Decaid v0.8.7 and later and only the current release of its own plugin and server. It supports nothing from the legacy Tcl de1app. Nobody but the owner runs it before v1, so code for older versions would add paths that nothing exercises. A release may change the wire protocol or the database incompatibly, and the database may be recreated (ADR-0016).

From v1, the server supports:

- **Decaid:** the newest Decaid release tag and the two release tags before it. Pre-release tags such as `v0.8.8-beta.1` don't count toward the two. Each Decent Sync release sets `OLDEST_SUPPORTED_DECAID` (`protocol/src/index.ts`) to the second release tag before the newest Decaid release at that time. A pre-release of a later version is accepted; a pre-release of the oldest supported version is not.
- **The plugin:** the current release and the one before it. `OLDEST_SUPPORTED_PROTOCOL_VERSION` is the protocol version the previous release's plugin speaks, so a release that changes the protocol still accepts the previous one.

The server enforces both at `hello`. A plugin speaking an older protocol is refused with `plugin_too_old`, and a tablet whose Decaid reports an older version (or no release version) with `decaid_too_old`. The reason is recorded on the token's Machine, and the plugin stops until it or Decaid is updated. Decaid's version comes from its `/info` endpoint as `fullVersion`, the tag it was built from plus a build number (`0.8.7+2847`). Every supported Decaid reports it, so `hello` requires it.

We rejected checking the Decaid version in the plugin. The minimum would then move only with a plugin release, and a plugin that refused to connect would leave nothing on the Machine's page. Decaid's manifest has no field for a minimum host version. We also rejected per-record fallbacks for older Decaid layouts. With the minimum enforced, a record missing what every supported Decaid sends is malformed: it is acknowledged and ignored.

## Consequences

- **No compatibility code before v1.** No fallbacks for older Decaid record layouts, no server handling for messages an older plugin sent, and no upgrade paths for pre-v1 data. A wire change that older plugins can't follow raises `PROTOCOL_VERSION` and `OLDEST_SUPPORTED_PROTOCOL_VERSION` together; one they already follow or can ignore doesn't.
- **de1app.** The plugin skips Decaid's imports from the legacy Tcl app (ids `de1app-*`, ADR-0004). Nothing else handles them.
- **Unfamiliar fields are still accepted.** Validators ignore fields they do not know, and Decaid payloads are stored as sent, so a newer Decaid or plugin within the window doesn't break capture.
- **Raising the Decaid minimum is a release step from v1.** Before tagging, check Decaid's releases and set `OLDEST_SUPPORTED_DECAID`. Once the server is upgraded, it refuses tablets below the new minimum, so the release notes name it.
- **Older hardware stays supported.** The window covers software only. DE1s that report serial `"0"`, and Shots recorded before Decaid v0.7.6 that a supported Decaid still serves, are handled as ADR-0015 describes.
