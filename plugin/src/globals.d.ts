// Replaced at build time by plugin/build.mjs.
declare const __PLUGIN_ID__: string;
declare const __PLUGIN_VERSION__: string;

// Decaid puts these in scope of the plugin's code (plugin_manager.dart). Its
// timers run on the host and are cancelled when the plugin unloads.
declare function setTimeout(callback: () => void, delay: number): number;
declare function clearTimeout(id: number): void;

/**
 * Plugin-scoped fetch, with `api`. Responses are capped at 10 MiB and time
 * out after 30 s. A body is sent as given, a string as its UTF-8.
 */
declare function fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<DecaidResponse>;

interface DecaidResponse {
  status: number;
  ok: boolean;
  /** Response headers, by name in any case; null for one not sent. */
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}
