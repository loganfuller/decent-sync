import { postSelection, readSelectedName } from "./dye2-selection.js";
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
// The plugin pushes once it has written DYE2's recipes. Decaid sends a push
// only to the sockets open at the time, so a skin without one catches up as
// it does without the plugin.
//
// Streamline's DYE strip has no way to unload what DYE2 has selected, so a
// one-off change, as hot water at another temperature, is recorded into the
// recipe and shared with every Machine at the Location. While DYE2 has a
// recipe or favourite selected, the plugin's answer holds a Clear button for
// Streamline's top bar, on any Machine, Capture-only ones too, as it only
// talks to DYE2. A header button can only open the plugin's `ui` page, so a
// tap opens it as a page, which clears DYE2's selection, as Streamline does
// as its DYE2 switch is turned off, and returns to the dashboard at once,
// whose reload has the strip read DYE2's stored selection again. A clear
// that fails is not tried again, as it could unload a recipe the barista
// applied since: the button still showing tells them. The plugin pushes
// `{"what":"skin"}` on each push from DYE2, which pushes on every change of
// which item it has selected, so the button shows and hides at once.
// Interim, until Streamline unloads it itself (decentespresso/streamline-js#159,
// ADR-0022). Streamline draws one plugin header button, the first plugin's
// in Decaid's list whose `skin` read succeeds.

/** The plugin's HTTP endpoint a skin asks what to show (manifest.json). */
const SKIN_ENDPOINT = "skin";

/** The plugin's HTTP endpoint for pages a skin opens (manifest.json): the Clear button's. */
const UI_ENDPOINT = "ui";

/** The view of `ui` the Clear button opens, which clears DYE2's selection. */
const CLEAR_VIEW = "clear";

/** The plugin's WebSocket endpoint a skin listens on for changes (manifest.json). */
const CHANGED_ENDPOINT = "changed";

/** The push that has a skin read the Workflow and DYE2's recipes again; `{"what":"skin"}` would have it read only `skin`. */
const RECIPES_CHANGED = { what: "workflow" } as const;

/** The push that has a skin read only `skin`, as the Clear button shows or hides. */
const SKIN_CHANGED = { what: "skin" } as const;

/** How long `skin` waits for DYE2's selection before answering without the Clear button: Streamline waits 2 s for the whole answer. */
const SKIN_READ_MS = 1_000;

/** How long the Clear button's page waits for DYE2 to clear its selection before returning to the dashboard anyway. */
const CLEAR_MS = 3_000;

/** The longest text Streamline shows on a header button (`CAPS.text` in streamline-js:src/modules/plugin-surfaces.js). */
const TEXT_MAX = 40;

/**
 * Answers a request to one of the plugin's HTTP endpoints: `skin` and `ui`
 * to a GET, and nothing else.
 */
export async function answerHttp(request: HttpRequest, log: (message: string) => void): Promise<HttpAnswer> {
  if (request.endpoint !== SKIN_ENDPOINT && request.endpoint !== UI_ENDPOINT) return json(404, { error: "Not found" });
  if (request.method !== "GET") return { ...json(405, { error: "Only GET is answered" }), headers: { "Content-Type": "application/json", Allow: "GET" } };
  if (request.endpoint === SKIN_ENDPOINT) return json(200, { version: 1, surfaces: await clearButton(), live: { endpoint: CHANGED_ENDPOINT } });
  if (request.query.view !== CLEAR_VIEW) return json(404, { error: "Not found" });
  await clearSelection(log);
  const returnTo = request.query.returnTo;
  // No page to go back to: the browser stays where it is.
  if (typeof returnTo !== "string" || !isPageUrl(returnTo)) return { status: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  return { status: 303, headers: { Location: returnTo, "Cache-Control": "no-store" }, body: "" };
}

/** The Clear button while DYE2 has a recipe or favourite selected, as a list of surfaces; none where it has none, answers 404, or fails or is slow to answer. */
async function clearButton(): Promise<unknown[]> {
  const name = await within(SKIN_READ_MS, readSelectedName().catch(() => null), null);
  if (name === null) return [];
  const text = `Unload ${name}`;
  return [
    {
      id: "clear",
      kind: "header-button",
      label: "Clear",
      text: text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text,
      action: { type: "open", view: CLEAR_VIEW, presentation: "page" },
    },
  ];
}

/** Clears DYE2's selection, whatever it names, once: a 404, a refusal or no answer in time is logged, and not tried again. */
async function clearSelection(log: (message: string) => void): Promise<void> {
  const cleared = postSelection(null).then(
    (done) => (done === "done" ? null : "DYE2 is not loaded"),
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  const problem = await within(CLEAR_MS, cleared, `DYE2 did not answer within ${CLEAR_MS / 1000} s`);
  if (problem !== null) log(`Could not clear DYE2's selection for the Clear button: ${problem}`);
}

/** Resolves as the work does, or with `late` once `ms` pass first. */
function within<T>(ms: number, work: Promise<T>, late: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(late), ms);
    void work.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
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

/**
 * Tells the skins listening on `changed` to read `skin` again, on each push
 * from DYE2: the Clear button may show or hide. A push Decaid refuses is
 * logged.
 */
export function tellSkinsOfSelection(host: PluginHost, log: (message: string) => void): () => void {
  return () => {
    try {
      host.emit(CHANGED_ENDPOINT, SKIN_CHANGED);
    } catch (error) {
      log(`Could not tell skins that DYE2's selection changed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
