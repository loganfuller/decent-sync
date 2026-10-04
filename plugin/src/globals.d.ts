// Replaced at build time by plugin/build.mjs.
declare const __PLUGIN_ID__: string;
declare const __PLUGIN_VERSION__: string;

// Decaid puts these in scope of the plugin's code (plugin_manager.dart). Its
// timers run on the host and are cancelled when the plugin unloads.
declare function setTimeout(callback: () => void, delay: number): number;
declare function clearTimeout(id: number): void;

/** Plugin-scoped fetch, with `api`. Responses are capped at 10 MiB and time out after 30 s. */
declare function fetch(url: string): Promise<DecaidResponse>;

interface DecaidResponse {
  status: number;
  ok: boolean;
  text(): Promise<string>;
  json(): Promise<unknown>;
}
