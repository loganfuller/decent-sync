// A stand-in for Decaid's plugin host, enough to load the built plugin.js the
// way Decaid does: the source is pasted into a function body, the global
// createPlugin(host) is called, the returned id must match the manifest, and
// onLoad is called synchronously without awaiting its result. See
// decaid:lib/src/plugins/plugin_manager.dart. Ticket #5 grows this into the
// simulated tablet.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const reapluginDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../decent-sync.reaplugin",
);

export interface LoadedPlugin {
  id: string;
  version: string;
  onLoad(settings: Record<string, unknown>): unknown;
  onUnload(): unknown;
  onEvent(event: { name: string; payload?: unknown }): unknown;
}

export interface StandInHost {
  logs: string[];
  host: { log(message: string): void };
}

export function createStandInHost(): StandInHost {
  const logs: string[] = [];
  return { logs, host: { log: (message) => logs.push(String(message)) } };
}

export function readBuiltPlugin(): { source: string; manifest: Record<string, unknown> } {
  return {
    source: fs.readFileSync(path.join(reapluginDir, "plugin.js"), "utf8"),
    manifest: JSON.parse(fs.readFileSync(path.join(reapluginDir, "manifest.json"), "utf8")),
  };
}

export function loadPlugin(
  source: string,
  manifestId: string,
  host: StandInHost["host"],
): LoadedPlugin {
  const factory = new Function(
    "host",
    `${source}
    if (typeof createPlugin !== "function") {
      throw new Error("Plugin must export a 'createPlugin' function. Got: " + typeof createPlugin);
    }
    return createPlugin(host);`,
  ) as (host: StandInHost["host"]) => LoadedPlugin;
  const plugin = factory(host);
  if (!plugin || typeof plugin !== "object") {
    throw new Error(`createPlugin did not return an object, got: ${typeof plugin}`);
  }
  if (plugin.id !== manifestId) {
    throw new Error(`Plugin ID mismatch. Expected: ${manifestId}, Got: ${plugin.id}`);
  }
  return plugin;
}
