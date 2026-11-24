import { MAX_SOFTWARE_NAME_LENGTH, type SkinPage } from "@decent-sync/protocol";
import type { HttpAnswer, HttpRequest, PluginHost } from "./host.js";

// The page a Skin shows (ADR-0034, #661): a Skin that supports Reload tells
// the plugin which Skin and version it is each time its page loads, and each
// time its connection to the plugin opens, at the plugin's HTTP endpoint
// `page`, as docs/PLUGIN.md describes for a Skin's author. The plugin keeps
// the latest, reports it as the `skinPage` collection, and asks the Skin to
// reload by a push on `changes`, the socket the Skin listens on for what the
// plugin tells it (skin-api.ts). A Skin that does neither is unaffected: it
// is never pushed anything it does not read, and Reload is not offered for
// it. Kept for the plugin's load, across its connections to the server: a
// load after Decaid loaded the plugin again hears from the Skin once its
// socket opens again.

/** The plugin's HTTP endpoint a Skin reports its page at (manifest.json). */
const PAGE_ENDPOINT = "page";

/** The plugin's WebSocket endpoint a Skin listens on for what changed (manifest.json), where the reload is pushed. */
const CHANGES_ENDPOINT = "changes";

/** The push that asks a Skin to load its page again. */
const RELOAD = { what: "reload" } as const;

/** How far ahead of the tablet's clock a page's load time may be: the Skin and the plugin read the same clock. */
const MAX_AHEAD_MS = 60_000;

/** An ISO 8601 instant with its offset or Z, as `Date.prototype.toISOString` writes one. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** The page a Skin last reported, the endpoint it reports at, and the push that asks it to reload. */
export class SkinPages {
  private page: SkinPage | null = null;
  private readonly listeners = new Set<(page: SkinPage) => void>();

  constructor(
    private readonly host: Pick<PluginHost, "emit">,
    private readonly log: (message: string) => void,
  ) {}

  /** The page last reported in this load, or null. */
  latest(): SkinPage | null {
    return this.page;
  }

  /** Calls `listener` with each page reported from now on, until the function it returns is called. */
  onReport(listener: (page: SkinPage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Answers a request to `page`, or undefined for any other endpoint. A PUT
   * of `{ skinId, version, loadedAt }` is kept, stamped with when it was
   * heard, and answered 204; a body of another shape 400, saying what is
   * wrong with it; any other method 405.
   */
  answer(request: HttpRequest): HttpAnswer | undefined {
    if (request.endpoint !== PAGE_ENDPOINT) return undefined;
    if (request.method !== "PUT") return { ...json(405, { error: "Only PUT is answered" }), headers: { "Content-Type": "application/json", Allow: "PUT" } };
    const body = request.body;
    const fields = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const problems = [
      ...(typeof fields.skinId === "string" && fields.skinId !== "" && fields.skinId.length <= MAX_SOFTWARE_NAME_LENGTH ? [] : ["Give skinId, the Skin's id as Decaid's Skin list names it"]),
      ...(fields.version === undefined || fields.version === null || (typeof fields.version === "string" && fields.version.length <= MAX_SOFTWARE_NAME_LENGTH) ? [] : ["Give version as text, or leave it out"]),
      ...(isLoadTime(fields.loadedAt) ? [] : ["Give loadedAt, when the page loaded, as an ISO 8601 time such as new Date(performance.timeOrigin).toISOString() gives"]),
    ];
    if (problems.length > 0) return json(400, { code: "invalidRequest", message: problems.join(". ") + "." });
    const page: SkinPage = {
      skinId: fields.skinId as string,
      ...(typeof fields.version === "string" && fields.version !== "" ? { version: fields.version } : {}),
      loadedAt: new Date(Date.parse(fields.loadedAt as string)).toISOString(),
      reportedAt: new Date().toISOString(),
    };
    this.page = page;
    for (const listener of [...this.listeners]) {
      try {
        listener(page);
      } catch (error) {
        this.log(`Could not take in a Skin's page report: ${describe(error)}`);
      }
    }
    return { status: 204, headers: {}, body: "" };
  }

  /** Asks the Skins listening on `changes` to load their page again. Throws if Decaid refuses the push. */
  askReload(): void {
    this.host.emit(CHANGES_ENDPOINT, RELOAD);
  }
}

/** Whether a page's load time is an instant no later than a minute ahead of the tablet's clock. */
function isLoadTime(value: unknown): value is string {
  if (typeof value !== "string" || !INSTANT.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= Date.now() + MAX_AHEAD_MS;
}

function json(status: number, body: unknown): HttpAnswer {
  return { status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
