// The parts of Decaid's plugin host this plugin uses. Decaid builds the host
// in lib/src/plugins/plugin_manager.dart; each member exists only when the
// manifest declares its permission.

export interface PluginHost {
  log(message: string): void;
}

/** Plugin settings as Decaid passes them to onLoad, keyed by manifest setting name. */
export type PluginSettings = Record<string, unknown>;

export interface PluginEvent {
  name: string;
  payload?: unknown;
}

export interface Plugin {
  id: string;
  version: string;
  onLoad(settings: PluginSettings): void;
  onUnload(): void;
  onEvent(event: PluginEvent): void;
}
