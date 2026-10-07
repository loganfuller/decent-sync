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
      if (event?.name === "shotStored") connection?.shotEvent("shot", event.payload);
      if (event?.name === "shotUpdated") connection?.shotEvent("shotUpdated", event.payload);
      // Decaid sends the current Workflow just after loading the plugin, and again on every change.
      if (event?.name === "workflowUpdated") connection?.workflowUpdated(event.payload);
      if (event?.name === "stateUpdate") connection?.stateUpdate(event.payload);
      if (event?.name === "storageRead" || event?.name === "storageWrite") connection?.storageEvent(event.name, event.payload);
    },
  };
}
