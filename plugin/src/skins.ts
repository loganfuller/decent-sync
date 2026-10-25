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
// The plugin pushes once it has written DYE2's recipes, or changed the
// Workflow: the server's writes of the Loaded Recipe and its clears of the
// Workflow's grinder, batch and Basket, the plugin's loads of a recipe the
// Workflow names, and its clears of that recipe. Decaid sends a push only to
// the sockets open at the time, so a skin without one catches up as it does
// without the plugin.
//
// Every change on a Machine with a Recipe loaded is saved into it (ADR-0022),
// so a one-off change, as hot water at another temperature, needs the Recipe
// unloaded first, which Streamline's DYE strip offers no clean way to do
// (decentespresso/streamline-js#159). While the Machine has a Loaded Recipe,
// the plugin's answer holds a Clear button for Streamline's top bar. A header
// button can only open the plugin's `ui` page, so a tap opens it as a page,
// which unloads the Recipe as DYE2 does, writing `recipeId: null` into the
// Workflow (`LoadedRecipes.unloadNow`), and returns to the dashboard at once,
// whose reload has the strip read DYE2's selection again. An unload that
// fails is not tried again, as it could unload a recipe the barista applied
// since: the button still showing tells them. The plugin pushes
// `{"what":"skin"}` as the button is to show, hide or change its name, so
// Streamline draws it again at once. Streamline draws one plugin header
// button, the first plugin's in Decaid's list whose `skin` read succeeds.

/** The plugin's HTTP endpoint a skin asks what to show (manifest.json). */
const SKIN_ENDPOINT = "skin";

/** The plugin's HTTP endpoint for pages a skin opens (manifest.json): the Clear button's. */
const UI_ENDPOINT = "ui";

/** The view of `ui` the Clear button opens, which unloads the Loaded Recipe. */
const CLEAR_VIEW = "clear";

/** The plugin's WebSocket endpoint a skin listens on for changes (manifest.json). */
const CHANGED_ENDPOINT = "changed";

/** The push that has a skin read the Workflow and DYE2's recipes again; `{"what":"skin"}` would have it read only `skin`. */
const WORKFLOW_CHANGED = { what: "workflow" } as const;

/** The push that has a skin read only `skin`, as the Clear button shows, hides or changes its name. */
const SKIN_CHANGED = { what: "skin" } as const;

/** How long the Clear button's page waits for the unload before returning to the dashboard anyway. */
const UNLOAD_MS = 3_000;

/** The longest text Streamline shows on a header button, in UTF-16 code units (`CAPS.text` in streamline-js:src/modules/plugin-surfaces.js). */
const TEXT_MAX = 40;

/** What the Clear button needs of the Machine's Loaded Recipe (`LoadedRecipes`). */
export interface Unloadable {
  /** The Loaded Recipe's name, while the Machine has one; null while it has none. */
  loadedName(): string | null;
  /**
   * Unloads the Loaded Recipe as a barista's tap asks, once: resolves with
   * why it did not, or null where it did, or the Machine had none by then.
   * Given up on, and never made later, where it is not written within `ms`.
   */
  unloadNow(ms: number): Promise<string | null>;
}

/**
 * Answers a request to one of the plugin's HTTP endpoints: `skin` and `ui`
 * to a GET, and nothing else. The Clear button shows only with the
 * Machine's Loaded Recipe (`unloadable`), which a plugin with no settings
 * does not follow. `ui` has no page but the Clear button's: any other view,
 * as Streamline's settings card opens with its Open button, which it shows
 * for every plugin declaring `ui`, goes straight back.
 */
export async function answerHttp(request: HttpRequest, unloadable: Unloadable | undefined, log: (message: string) => void): Promise<HttpAnswer> {
  if (request.endpoint !== SKIN_ENDPOINT && request.endpoint !== UI_ENDPOINT) return json(404, { error: "Not found" });
  if (request.method !== "GET") return { ...json(405, { error: "Only GET is answered" }), headers: { "Content-Type": "application/json", Allow: "GET" } };
  if (request.endpoint === SKIN_ENDPOINT) return json(200, { version: 1, surfaces: clearButton(unloadable?.loadedName() ?? null), live: { endpoint: CHANGED_ENDPOINT } });
  const returnTo = request.query.returnTo;
  const back = typeof returnTo === "string" && isPageUrl(returnTo) ? returnTo : null;
  if (request.query.view !== CLEAR_VIEW) return back === null ? json(404, { error: "Not found" }) : goBack(back);
  if (unloadable !== undefined) {
    const problem = await unloadable.unloadNow(UNLOAD_MS).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    if (problem !== null) log(`Could not unload the Loaded Recipe for the Clear button: ${problem}`);
  }
  // No page to go back to: the browser stays where it is.
  return back === null ? { status: 204, headers: { "Cache-Control": "no-store" }, body: "" } : goBack(back);
}

/** Sends the browser back to the skin's page, leaving nothing in its history or cache to open the plugin's page again. */
function goBack(returnTo: string): HttpAnswer {
  return { status: 303, headers: { Location: returnTo, "Cache-Control": "no-store" }, body: "" };
}

/** The Clear button for the Loaded Recipe of that name, as a list of surfaces; none where the Machine has none. */
function clearButton(name: string | null): unknown[] {
  if (name === null) return [];
  return [
    {
      id: "clear",
      kind: "header-button",
      label: "Clear",
      text: fitted(`Unload ${name}`),
      action: { type: "open", view: CLEAR_VIEW, presentation: "page" },
    },
  ];
}

/**
 * The text cut to Streamline's limit, which it counts in UTF-16 code units
 * (`cleanText` in streamline-js:src/modules/plugin-surfaces.js), ending in
 * an ellipsis where it is cut: by whole code points, so Streamline never
 * cuts a character outside the Basic Multilingual Plane in half.
 */
function fitted(text: string): string {
  if (text.length <= TEXT_MAX) return text;
  let kept = "";
  for (const character of text) {
    if (kept.length + character.length > TEXT_MAX - 1) break;
    kept += character;
  }
  return `${kept}…`;
}

/**
 * Whether a skin's `returnTo` is a page to go back to: an `http:` or
 * `https:` URL with no credentials, as Streamline sends (`pluginUiUrl` in
 * streamline-js:src/settings/plugin-view.js), in printable ASCII, as a
 * URL's `href` is, so nothing in it can break the `Location` header.
 */
function isPageUrl(url: string): boolean {
  return /^[!-~]+$/.test(url) && /^https?:\/\/[^/?#@]+([/?#]|$)/i.test(url);
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
  /** The Clear button is to show, hide or change its name, as the Loaded Recipe or its name changed (`Unloadable.loadedName`). */
  clearButtonChanged(): void;
}

/** Tells the skins listening on `changed`: to read the Workflow and DYE2's recipes again, or only `skin` for the Clear button. */
export function tellSkins(host: PluginHost, log: (message: string) => void): Skins {
  const push = (what: string, payload: { what: string } = WORKFLOW_CHANGED) => {
    try {
      host.emit(CHANGED_ENDPOINT, payload);
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
    clearButtonChanged: () => push("the Loaded Recipe", SKIN_CHANGED),
  };
}
