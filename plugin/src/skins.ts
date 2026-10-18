import { sameValue } from "@decent-sync/protocol";
import type { HttpAnswer, HttpRequest, PluginHost } from "./host.js";
import type { Dye2Key } from "./library-writes.js";

// A skin that shows DYE2's recipes, as Streamline's DYE strip does, reads
// them as it loads and when the barista comes back to it, so a recipe the
// plugin writes while the tablet's dashboard stays visible would show only
// later (ADR-0005). Its tiles read the Workflow every 20 s and just after a
// write of its own, so a write of the plugin's into the Workflow would show
// only at the next poll. Streamline asks every loaded plugin that declares
// an HTTP endpoint `skin` what to show, and keeps a WebSocket open to the
// endpoint its answer names under `live` while the page is visible: a push
// there of anything but `{"what":"skin"}` has it read the Workflow again,
// and its DYE strip DYE2's recipes (streamline-js:docs/plugin-surfaces.md,
// decentespresso/streamline-js#120 and #127, checked on `main` at 07be2b3).
// The plugin shows nothing on the dashboard, so it answers with no surfaces,
// and pushes once it has written DYE2's recipes, or changed the Workflow:
// the server's writes of the Loaded Recipe and its clears of the Workflow's
// grinder, batch and Basket, and the plugin's loads of a recipe DYE2
// selected. Decaid sends a push only to the sockets open at the time, so a
// skin without one catches up as it does without the plugin.

/** The plugin's HTTP endpoint a skin asks what to show (manifest.json). */
const SKIN_ENDPOINT = "skin";

/** The plugin's WebSocket endpoint a skin listens on for changes (manifest.json). */
const CHANGED_ENDPOINT = "changed";

/** What the plugin answers `skin` with: no surfaces, and where to listen for changes. */
const SKIN_ANSWER = { version: 1, surfaces: [], live: { endpoint: CHANGED_ENDPOINT } } as const;

/** The push that has a skin read the Workflow and DYE2's recipes again; `{"what":"skin"}` would have it read only `skin`. */
const WORKFLOW_CHANGED = { what: "workflow" } as const;

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
 * What the skins listening on `changed` are told of, as each write's answer
 * is made. Neither throws: a push Decaid refuses is logged, and changes
 * nothing of the write.
 */
export interface Skins {
  /** Decaid took a post of one of DYE2's lists, under its key: told of for the recipes, as the DYE strip shows no baskets or tools. */
  listPosted(key: Dye2Key): void;
  /**
   * Decaid took a `PUT /workflow` of the plugin's, with the Workflow read
   * just before it and the one Decaid answered: told of where they differ,
   * so a write of what the Workflow held already is not.
   */
  workflowWritten(before: Record<string, unknown>, after: Record<string, unknown>): void;
}

/** Tells the skins listening on `changed`, each with the same push. */
export function tellSkins(host: PluginHost, log: (message: string) => void): Skins {
  const push = (what: string) => {
    try {
      host.emit(CHANGED_ENDPOINT, WORKFLOW_CHANGED);
    } catch (error) {
      log(`Could not tell skins that ${what} changed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return {
    listPosted: (key) => {
      if (key === "recipes") push("DYE2's recipes");
    },
    workflowWritten: (before, after) => {
      if (!sameValue(before, after)) push("the Workflow");
    },
  };
}
