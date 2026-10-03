import { PROTOCOL_VERSION } from "@decent-sync/protocol";
import type { Plugin, PluginHost } from "./host.js";

// Decaid calls onLoad synchronously and disables a plugin that takes too long
// to load, so onLoad must return quickly and leave any real work to timers.
export function createPlugin(host: PluginHost): Plugin {
  return {
    id: __PLUGIN_ID__,
    version: __PLUGIN_VERSION__,
    onLoad() {
      host.log(`Decent Sync ${__PLUGIN_VERSION__} loaded (protocol ${PROTOCOL_VERSION})`);
    },
    onUnload() {},
    onEvent() {},
  };
}
