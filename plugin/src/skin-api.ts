import type { NotServed } from "@decent-sync/protocol";
import type { HttpAnswer, HttpRequest, PluginHost } from "./host.js";
import type { SkinRequests, Unanswered } from "./skin-requests.js";

// What the plugin serves a Skin of what the server holds (ADR-0030,
// milestone 8): HTTP endpoints of its own on the tablet, each declared in
// manifest.json, which a Skin calls at /api/v1/plugins/{plugin id}/{endpoint}.
// The plugin asks the server over its connection (skin-requests.ts) and
// answers the Skin in the same call: Decaid awaits a promise from a plugin's
// handler, for up to 30 s (`__dispatchPluginHttp` and `registerPendingHttp`
// in decaid:lib/src/plugins/plugin_manager.dart, the same at v0.9.1 and
// v0.9.2). Decaid checks no caller, so anything on the tablet's network can
// call these, as it can Decaid's own API. docs/PLUGIN.md describes them for
// a Skin's author.
//
// They are apart from the `skin` endpoint and the `changed` push Streamline
// reads (skins.ts), which stay as they were: Streamline reads any push on
// `changed` as a change to the Workflow, so what a Skin is told of here goes
// out on an endpoint of its own.

/** The plugin's HTTP endpoint a Skin asks whether its Machine is served (manifest.json). */
export const STATUS_ENDPOINT = "status";

/** The plugin's WebSocket endpoint a Skin listens on for what changed (manifest.json). */
const CHANGES_ENDPOINT = "changes";

/** Why an endpoint refuses a request: one of these codes, each with its HTTP status and a sentence. */
export type RefusalCode = Unanswered | NotServed;

const REFUSALS: Readonly<Record<RefusalCode, { status: number; message: string }>> = {
  unreachable: { status: 503, message: "The Decent Sync server can't be reached from this tablet right now." },
  serverTooOld: {
    status: 503,
    message: "The Decent Sync server this tablet is connected to is a release too old to ask. It can be asked once it is upgraded.",
  },
  captureOnly: {
    status: 409,
    message: "This Machine is a Capture-only Machine: it is at no Location, or its sharing is off, so it takes no part in the Library.",
  },
  hardwareMismatch: {
    status: 409,
    message: "The machine connected to this tablet is not the one this tablet's token was issued for, so the server serves it nothing until an Admin settles which Machine it is.",
  },
};

/**
 * Answers a request to `status`: whether the plugin is connected to the
 * server, whether its Machine is served, and its Machine and Location by id
 * and name. A served Machine answers 200. Any other answers its refusal, the
 * one every other endpoint would give then: that HTTP status, with the
 * refusal's `code` and `message` beside the same fields. While the plugin is
 * not connected it answers at once, asking nothing.
 */
export async function answerStatus(request: HttpRequest, requests: SkinRequests | undefined): Promise<HttpAnswer> {
  if (request.method !== "GET") return { ...json(405, { error: "Only GET is answered" }), headers: { "Content-Type": "application/json", Allow: "GET" } };
  const asked = requests ? await requests.ask("status") : { unanswered: "unreachable" as const };
  if ("unanswered" in asked) {
    // Still connected where the server is too old to ask, or did not answer in time.
    return refusal(asked.unanswered, { connected: requests?.connected ?? false, served: false, machine: null, location: null });
  }
  const { served, notServed, machine, location } = asked.answer.result;
  const status = { connected: true, served, machine, location };
  return notServed === undefined ? json(200, status) : refusal(notServed, status);
}

/** An endpoint's refusal: its HTTP status, with its `code` and `message` after what else the answer holds. */
function refusal(code: RefusalCode, body: Record<string, unknown> = {}): HttpAnswer {
  const { status, message } = REFUSALS[code];
  return json(status, { ...body, code, message });
}

function json(status: number, body: unknown): HttpAnswer {
  return { status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/**
 * Tells the Skins listening on `changes` that the plugin's connection to the
 * server came or went, so one need not poll `status`. Decaid sends a push
 * only to the sockets open at the time. It never throws: a push Decaid
 * refuses is logged.
 */
export function tellConnection(host: PluginHost, log: (message: string) => void, connected: boolean): void {
  try {
    host.emit(CHANGES_ENDPOINT, { what: "connection", connected });
  } catch (error) {
    log(`Could not tell Skins that the connection to the server ${connected ? "came" : "went"}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
