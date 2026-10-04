import { PROTOCOL_VERSION } from "@decent-sync/protocol";
import { SyncConnection } from "./connection.js";
import type { Plugin, PluginHost } from "./host.js";
import { readSettings } from "./settings.js";

// Decaid calls onLoad synchronously and disables a plugin that takes too long
// to load, so onLoad must return quickly and leave any real work to timers.
// Changing a setting reloads the plugin, so each load starts afresh.
export function createPlugin(host: PluginHost): Plugin {
  let connection: SyncConnection | undefined;

  return {
    id: __PLUGIN_ID__,
    version: __PLUGIN_VERSION__,
    onLoad(settings) {
      host.log(`Decent Sync ${__PLUGIN_VERSION__} loaded (protocol ${PROTOCOL_VERSION})`);
      const read = readSettings(settings ?? {});
      if (!read.ok) {
        host.log(`Not connecting: ${read.problems.join("; ")}. Enter them in this plugin's settings.`);
        return;
      }
      connection = new SyncConnection(host, read.settings, (message) => host.log(message));
      connection.start();
    },
    onUnload() {
      connection?.stop();
      connection = undefined;
    },
    onEvent(event) {
      // Sent only while a machine is connected, so it may now report its hardware.
      if (event?.name === "stateUpdate") connection?.machineActive();
    },
  };
}
