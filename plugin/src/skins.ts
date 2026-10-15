import type { HttpAnswer, HttpRequest, PluginHost } from "./host.js";
import type { ListPosted } from "./library-writes.js";

// A skin that shows DYE2's recipes, as Streamline's DYE strip does, reads
// them as it loads and when the barista comes back to it, so a recipe the
// plugin writes while the tablet's dashboard stays visible would show only
// later (ADR-0005). Streamline asks every loaded plugin that declares an HTTP
// endpoint `skin` what to show, and keeps a WebSocket open to the endpoint
// its answer names under `live` while the page is visible: a push there of
// anything but `{"what":"skin"}` has it read the Workflow again, and its DYE
// strip DYE2's recipes (streamline-js:docs/plugin-surfaces.md,
// decentespresso/streamline-js#120 and #127, checked on `main` at 07be2b3).
// The plugin shows nothing on the dashboard, so it answers with no surfaces,
// and pushes once it has written DYE2's recipes. Decaid sends a push only to
// the sockets open at the time, so a skin without one catches up as it does
// without the plugin.

/** The plugin's HTTP endpoint a skin asks what to show (manifest.json). */
const SKIN_ENDPOINT = "skin";

/** The plugin's WebSocket endpoint a skin listens on for changes (manifest.json). */
const CHANGED_ENDPOINT = "changed";

/** What the plugin answers `skin` with: no surfaces, and where to listen for changes. */
const SKIN_ANSWER = { version: 1, surfaces: [], live: { endpoint: CHANGED_ENDPOINT } } as const;

/** The push that has a skin read the Workflow and DYE2's recipes again; `{"what":"skin"}` would have it read only `skin`. */
const RECIPES_CHANGED = { what: "workflow" } as const;

/** Answers a request to one of the plugin's HTTP endpoints: `skin` to a GET, and nothing else. */
export function answerHttp(request: HttpRequest): HttpAnswer {
  if (request.endpoint !== SKIN_ENDPOINT) return json(404, { error: "Not found" });
  if (request.method !== "GET") return { ...json(405, { error: "Only GET is answered" }), headers: { "Content-Type": "application/json", Allow: "GET" } };
  return json(200, SKIN_ANSWER);
}

function json(status: number, body: unknown): HttpAnswer {
  return { status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/**
 * Tells the skins listening on `changed` of each post of DYE2's recipes
 * Decaid took, as a write's answer is made: the DYE strip shows no baskets or
 * tools. Never throws: a push Decaid refuses is logged, and changes nothing
 * of the write.
 */
export function tellSkins(host: PluginHost, log: (message: string) => void): ListPosted {
  return (key) => {
    if (key !== "recipes") return;
    try {
      host.emit(CHANGED_ENDPOINT, RECIPES_CHANGED);
    } catch (error) {
      log(`Could not tell skins that DYE2's recipes changed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
