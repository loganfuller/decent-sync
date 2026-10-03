// The wire contract between the plugin and the server. Both ends import it from
// here so they cannot drift apart. The plugin bundles it into an ES2020 script,
// so this package must not depend on Node or browser APIs.

/** The protocol version this build of the plugin and server speaks. */
export const PROTOCOL_VERSION = 1;
