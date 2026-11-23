import { PROTOCOL_VERSION } from "@decent-sync/protocol";
import { SyncConnection } from "./connection.js";
import type { Plugin, PluginHost } from "./host.js";
import { readSettings } from "./settings.js";
import { answerSkin } from "./skin-api.js";
import { answerHttp } from "./skins.js";
import { TabletNotice } from "./tablet-notice.js";

// Decaid calls onLoad synchronously and disables a plugin that takes too long
// to load, so onLoad must return quickly and leave any real work to timers.
// Changing a setting reloads the plugin, so each load starts afresh.
export function createPlugin(host: PluginHost): Plugin {
  let connection: SyncConnection | undefined;
  const log = (message: string) => host.log(message);
  // What Decaid shows on the tablet while the plugin has stopped syncing, kept by Decaid across loads.
  const notice = new TabletNotice(host, log);

  return {
    id: __PLUGIN_ID__,
    version: __PLUGIN_VERSION__,
    onLoad(settings) {
      host.log(`Decent Sync ${__PLUGIN_VERSION__} loaded (protocol ${PROTOCOL_VERSION})`);
      const read = readSettings(settings ?? {});
      if (!read.ok) {
        host.log(`Not connecting: ${read.problems.join("; ")}. Enter them in this plugin's settings.`);
        // A plugin never set up says nothing on the tablet, whatever an earlier load put up.
        notice.withdraw();
        return;
      }
      connection = new SyncConnection(host, read.settings, log, notice);
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
      if (event?.name === "notificationResult") notice.result(event.payload);
    },
    // Answered whether or not the plugin connects: a skin asks every loaded plugin, and a Skin asking what the server
    // holds is told the server can't be reached.
    __httpRequestHandler: (request) => answerSkin(request, connection?.skinRequests, connection?.references) ?? answerHttp(request),
  };
}
