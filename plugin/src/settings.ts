import { SYNC_PATH } from "@decent-sync/protocol";
import type { PluginSettings } from "./host.js";

// The plugin's settings, as declared in plugin/manifest.json. Decaid passes
// only the settings someone has set, so each has its default here.

export interface SyncSettings {
  /** The sync endpoint: ws(s)://<host>/sync, from the server's public URL. */
  syncUrl: string;
  token: string;
  pollSeconds: number;
}

const DEFAULT_POLL_SECONDS = 30;

/** The settings needed to connect, or what is missing or wrong, for the log. */
export function readSettings(settings: PluginSettings): { ok: true; settings: SyncSettings } | { ok: false; problems: string[] } {
  const problems: string[] = [];

  const serverUrl = typeof settings.ServerUrl === "string" ? settings.ServerUrl.trim() : "";
  const syncUrl = serverUrl ? syncUrlFor(serverUrl) : undefined;
  if (!serverUrl) problems.push("Server URL is not set");
  else if (!syncUrl) problems.push("Server URL must be the server's http:// or https:// address");

  // Never logged: only whether it is set.
  const token = typeof settings.Token === "string" ? settings.Token.trim() : "";
  if (!token) problems.push("Token is not set");

  const poll = Number(settings.PollSeconds);
  const pollSeconds = settings.PollSeconds !== undefined && Number.isFinite(poll) && poll > 0 ? poll : DEFAULT_POLL_SECONDS;

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, settings: { syncUrl: syncUrl!, token, pollSeconds } };
}

/**
 * The sync endpoint for a server's public http(s):// URL: ws:// for http and
 * wss:// for https, on the same host and port. Any path is ignored, since the
 * public URL is an origin. Parsed by hand: Decaid's runtime has no `URL`.
 */
export function syncUrlFor(serverUrl: string): string | undefined {
  const match = /^(https?):\/\/([^/?#@\s]+)(?:[/?#]\S*)?$/i.exec(serverUrl);
  if (!match) return undefined;
  const scheme = match[1]!.toLowerCase() === "https" ? "wss" : "ws";
  return `${scheme}://${match[2]}${SYNC_PATH}`;
}
