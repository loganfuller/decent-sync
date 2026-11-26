import {
  DYE2_NAMESPACE,
  MAX_BARISTA_LENGTH,
  MAX_SCANNED_TEXT_LENGTH,
  MAX_SHOTS_PAGE,
  MAX_SHOT_RATING,
  MAX_SKIN_NOTE_LENGTH,
  type NotServed,
  type SkinQuestion,
  type SkinRecipe,
  type SkinRefusal,
  dye2GlobalIdOf,
  dye2Records,
  globalIdOf,
  isGlobalId,
  isShotNote,
  isShotRating,
  shotRatingAndNote,
} from "@decent-sync/protocol";
import { readCollection, request as askDecaid } from "./decaid.js";
import type { HttpAnswer, HttpRequest, PluginHost } from "./host.js";
import type { ReferenceCopies } from "./reference-copies.js";
import { type Asked, SKIN_REQUEST_MS, type SkinRequests, type Unanswered } from "./skin-requests.js";

// What the plugin serves a Skin of what the server holds (ADR-0030,
// milestone 8): HTTP endpoints of its own on the tablet, each declared in
// manifest.json, which a Skin calls at /api/v1/plugins/{plugin id}/{endpoint}.
// The plugin asks the server over its connection (skin-requests.ts) and
// answers the Skin in the same call: Decaid awaits a promise from a plugin's
// handler, for up to 30 s (`__dispatchPluginHttp` and `registerPendingHttp`
// in decaid:lib/src/plugins/plugin_manager.dart, the same at v0.9.1 and
// v0.9.2). Decaid checks no caller, so anything on the tablet's network can
// call these, as it can Decaid's own API. site/src/content/docs/technical/skin-authors.md describes them for
// a Skin's author. All read but three. A PUT to `reference` chooses a Recipe's
// Reference Shot (ticket #511), which the server does or refuses, never the
// plugin later. A PUT to `shot` edits a Shot's rating and note (ticket #515,
// ADR-0031): the tablet's own Shot through Decaid, with or without the
// server, and any other through the server, now or not at all. A PUT to
// `scan` has the server match the text of a scanned QR code to a Bean Batch
// and bring that batch to the Machine's Location (ticket #708), now or not at
// all.
//
// They are apart from the `skin` endpoint and the `changed` push Streamline
// reads (skins.ts), which stay as they were: Streamline reads any push on
// `changed` as a change to the Workflow, so what a Skin is told of here goes
// out on an endpoint of its own.

/** The plugin's HTTP endpoint a Skin asks whether its Machine is served (manifest.json). */
const STATUS_ENDPOINT = "status";

/** The plugin's HTTP endpoint a Skin reads a page of its Location's Shots from (manifest.json). */
const SHOTS_ENDPOINT = "shots";

/** The plugin's HTTP endpoint a Skin reads one of those Shots whole from, and edits a Shot's rating and note through (manifest.json). */
const SHOT_ENDPOINT = "shot";

/** The plugin's HTTP endpoint a Skin reads a Recipe's Reference Shot from, and chooses it through (manifest.json). */
const REFERENCE_ENDPOINT = "reference";

/** The plugin's HTTP endpoint a Skin sends the text of a scanned QR code to, to have its Bean Batch brought to the Machine's Location (manifest.json). */
const SCAN_ENDPOINT = "scan";

/** The plugin's WebSocket endpoint a Skin listens on for what changed (manifest.json). */
const CHANGES_ENDPOINT = "changes";

/**
 * The longest `cursor` or `id` the server is asked with: longer than any
 * cursor it gives or any Shot's id, and short enough that a request never
 * passes a frame, whatever a Skin sends.
 */
const MAX_ASKED_LENGTH = 2048;

/** Why an endpoint refuses a request: one of these codes, each with its HTTP status and a sentence. */
export type RefusalCode = Unanswered | NotServed | "noSuchShot" | "noSuchRecipe" | "notAtThisLocation" | "archived" | "recipesUnread" | "shotUnwritten" | "invalidRequest";

const REFUSALS: Readonly<Record<RefusalCode, { status: number; message: string }>> = {
  unreachable: { status: 503, message: "The Decent Sync server can't be reached from this tablet right now." },
  serverTooOld: {
    status: 503,
    message: "The Decent Sync server this tablet is connected to is a release too old to ask this. It can be asked once it is upgraded.",
  },
  captureOnly: {
    status: 409,
    message: "This Machine is a Capture-only Machine: it is at no Location, or its sharing is off, so it takes no part in the Library.",
  },
  hardwareMismatch: {
    status: 409,
    message: "The machine connected to this tablet is not the one this tablet's token was issued for, so the server serves it nothing until an Admin settles which Machine it is.",
  },
  noSuchShot: { status: 404, message: "No Shot at this Machine's Location has that id." },
  noSuchRecipe: { status: 404, message: "No DYE2 recipe on this tablet with that id is a Recipe of this Machine's Location." },
  notAtThisLocation: { status: 403, message: "That Recipe belongs to another Location than this Machine's, so its Reference Shot can't be chosen on this tablet." },
  archived: { status: 409, message: "That Recipe is Archived. Its Reference Shot can be chosen once it is restored." },
  recipesUnread: { status: 500, message: "DYE2's recipes can't be read on this tablet right now." },
  // Each says what Decaid answered in a sentence of its own (`editShot`).
  shotUnwritten: { status: 500, message: "Decaid didn't take the edit of this tablet's own Shot." },
  // Each says what is wrong with it in a sentence of its own (`invalid`).
  invalidRequest: { status: 400, message: "The request is not one this endpoint answers." },
};

/**
 * Answers a request to one of the endpoints a Skin reads what the server
 * holds from, and chooses a Recipe's Reference Shot, edits a Shot's rating
 * and note and has a scanned Bean Batch brought through, or undefined for
 * any other endpoint, as those Streamline reads (skins.ts). Each is answered whether or not the plugin
 * connects: a Skin is then told the server can't be reached, or, reading a
 * Recipe's Reference Shot, answered from the tablet's copy (`references`)
 * where it holds one, or, editing its tablet's own Shot, answered by
 * Decaid.
 */
export function answerSkin(request: HttpRequest, requests: SkinRequests | undefined, references: ReferenceCopies | undefined): Promise<HttpAnswer> | undefined {
  switch (request.endpoint) {
    case STATUS_ENDPOINT:
      return answerStatus(request, requests);
    case SHOTS_ENDPOINT:
      return answerShots(request, requests);
    case SHOT_ENDPOINT:
      return answerShot(request, requests);
    case REFERENCE_ENDPOINT:
      return answerReference(request, requests, references);
    case SCAN_ENDPOINT:
      return answerScan(request, requests);
    default:
      return undefined;
  }
}

/**
 * Answers a request to `status`: whether the plugin is connected to the
 * server, whether its Machine is served, its Machine and Location by id
 * and name, and whether it can match scanned text now (`scan`, ticket
 * #708): it is connected to a server that can be asked to, which the
 * previous release's can't. A served Machine answers 200. Any other answers its refusal, the
 * one every other endpoint would give then: that HTTP status, with the
 * refusal's `code` and `message` beside the same fields. While the plugin is
 * not connected it answers at once, asking nothing.
 */
async function answerStatus(request: HttpRequest, requests: SkinRequests | undefined): Promise<HttpAnswer> {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const asked = await ask(requests, { ask: "status" });
  const scan = requests?.bringsBatches ?? false;
  // Still connected where the server did not answer in time.
  const unanswered = { connected: requests?.connected ?? false, served: false, machine: null, location: null, scan };
  if ("unanswered" in asked) return refusal(asked.unanswered, unanswered);
  // An answer to another ask, which the server never gives a request for the status.
  if (asked.answer.ask !== "status") return refusal("unreachable", unanswered);
  const { served, notServed, machine, location } = asked.answer.result;
  const status = { connected: true, served, machine, location, scan };
  return notServed === undefined ? json(200, status) : refusal(notServed, status);
}

/**
 * Answers a request to `shots`: a page of the Shots at the Machine's
 * Location, newest first, whichever Machine pulled them, as the server
 * lists them (`SkinShots` in protocol/). The query's `limit` is how many the
 * page may hold, from 1 to MAX_SHOTS_PAGE, which it is without one, and its
 * `cursor` the `nextCursor` of the page before. The request follows what the
 * tablet has still to report, so a Shot just pulled here is in its answer.
 */
async function answerShots(request: HttpRequest, requests: SkinRequests | undefined): Promise<HttpAnswer> {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const { limit, cursor } = request.query;
  if (limit !== undefined && !(/^\d{1,3}$/.test(limit) && Number(limit) >= 1 && Number(limit) <= MAX_SHOTS_PAGE)) {
    return invalid(`Give limit as a whole number from 1 to ${MAX_SHOTS_PAGE}.`);
  }
  if (cursor !== undefined && !askable(cursor)) return refused("invalidCursor");
  return answered(await ask(requests, { ask: "shots", limit: limit === undefined ? MAX_SHOTS_PAGE : Number(limit), ...(cursor !== undefined && { cursor }) }));
}

/**
 * Answers a request to `shot`: the Shot the query's `id` names, whole, with
 * its measurements, in the shape Decaid gives a tablet's own Shot
 * (`SkinShot` in protocol/), where it is one of the Shots at the Machine's
 * Location. Any other is refused as no such Shot, whether or not the server
 * holds it.
 *
 * A PUT edits the Shot's rating and note (`editShot`).
 */
async function answerShot(request: HttpRequest, requests: SkinRequests | undefined): Promise<HttpAnswer> {
  if (request.method === "PUT") return editShot(request, requests);
  if (request.method !== "GET") return methodNotAllowed("GET", "PUT");
  const { id } = request.query;
  if (!askable(id) || id === "") return invalid(NAME_THE_SHOT);
  return answered(await ask(requests, { ask: "shot", shotId: id }));
}

/** What a request to `shot` that names no Shot is told. */
const NAME_THE_SHOT = "Give the Shot's id as id.";

/**
 * Answers a PUT to `shot` (ticket #515, ADR-0031): sets the rating, the
 * note or both of the Shot the query's `id` names, as the body's `rating`
 * and `note` give them, leaving alone whichever it doesn't carry, and
 * answers with the Shot's rating and note as they then are
 * (`SkinShotEdited` in protocol/). A Skin edits every Shot this one way,
 * and needn't know where a Shot is held:
 *
 * - **A Shot this tablet holds** is written through Decaid's own Shot
 *   update, at once, whether or not the plugin is connected, or its Machine
 *   served. Decaid then reports the Shot as updated, which reaches the
 *   server as any edit made on the tablet does (shots.ts): with no person,
 *   and no edit kept. It is the update the plugin sends for an edit made
 *   through the server (shot-edits.ts): only the fields given, in the
 *   Shot's annotations.
 * - **Any other,** which Decaid answers it doesn't hold, the server is
 *   asked to edit (`ask: "editShot"`): one of the Shots at the Machine's
 *   Location, which it applies at once, keeps with the Machine and tablet
 *   it was made on, and writes to the tablet that holds the Shot. It is
 *   made as the server is asked or not at all: while the server can't be
 *   asked it is refused, as unreachable or too old to ask, and nothing is
 *   kept to send later. It goes at once, behind nothing the tablet has
 *   still to report (FOLLOWS_REPORTS in skin-requests.ts).
 *
 * The update is sent to Decaid without reading the Shot first, so nothing
 * changes there between a read and the write: Decaid says whether it holds
 * the Shot as it writes it.
 */
async function editShot(request: HttpRequest, requests: SkinRequests | undefined): Promise<HttpAnswer> {
  const { id } = request.query;
  if (!askable(id) || id === "") return invalid(NAME_THE_SHOT);
  const fields = readEdit(request.body);
  if (typeof fields === "string") return invalid(fields);
  const annotations = { ...(fields.rating !== undefined && { enjoyment: fields.rating }), ...(fields.note !== undefined && { espressoNotes: fields.note }) };
  let held;
  try {
    held = await askDecaid("PUT", `/shots/${encodeURIComponent(id)}`, { annotations });
  } catch (error) {
    return refusal("shotUnwritten", {}, `Decaid didn't answer the edit of this tablet's own Shot: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (held.status === 404) return answered(await ask(requests, { ask: "editShot", shotId: id, ...fields }));
  if (!held.ok) return refusal("shotUnwritten", {}, `Decaid refused the edit of this tablet's own Shot (${held.status}).`);
  try {
    // Decaid answers with the Shot as it now holds it.
    return json(200, shotRatingAndNote(JSON.parse(held.text)));
  } catch {
    return refusal("shotUnwritten", {}, "Decaid took the edit of this tablet's own Shot, and answered with no Shot to read it from.");
  }
}

/**
 * The fields an edit sets, from a request's body, as the REST API's route
 * reads them (`readShotEdit` in server/src/shots/shot-edits.ts): `rating`,
 * `note` or both; or, as text, what is wrong with it. Checked here whichever
 * holds the Shot, so one call is refused one way: Decaid itself would take
 * a null, and a longer note.
 */
function readEdit(body: unknown): { rating?: number; note?: string } | string {
  const NOTHING_TO_SET = "Give the Shot's rating, its note or both in a JSON body.";
  if (typeof body !== "object" || body === null || Array.isArray(body)) return NOTHING_TO_SET;
  const { rating, note, ...others } = body as Record<string, unknown>;
  const other = Object.keys(others)[0];
  // The name is a Skin's, so no more of it is repeated than a field's name is long.
  if (other !== undefined) return `Only a Shot's rating and note can be set: ${JSON.stringify(other.slice(0, 40))} is neither.`;
  if (rating !== undefined && !isShotRating(rating)) return `Give rating as a number from 0 to ${MAX_SHOT_RATING}, where 0 is unrated.`;
  if (note !== undefined && !(isShotNote(note) && note.length <= MAX_SKIN_NOTE_LENGTH)) {
    return `Give note as text of at most ${MAX_SKIN_NOTE_LENGTH} characters, where empty is none, without a NUL or an unpaired surrogate.`;
  }
  if (rating === undefined && note === undefined) return NOTHING_TO_SET;
  return { ...(rating !== undefined && { rating }), ...(note !== undefined && { note }) };
}

/**
 * Answers a request to `reference`: the Reference Shot of the Recipe the
 * query's `recipe` names, by the id of its DYE2 record on this tablet, which
 * the Workflow names and each of the tablet's Shots records
 * (`context.extras.dye.recipeId`). The plugin turns it into the Recipe's own
 * id, which the record carries (ADR-0006): a record that carries none is no
 * Recipe of the Library's, and is refused as no such Recipe, as an id no
 * record has is.
 *
 * The answer is the server's (`SkinReference` in protocol/): the Recipe,
 * and its Reference Shot whole, as `shot` gives one, with its rating and
 * note and whether its Profile differs from the Recipe's, or null where it
 * has none; with `source`, "server". While the server can't be asked, it is
 * the tablet's copy, which it keeps for each Recipe in a slot
 * (reference-copies.ts), with `source`, "tablet"; a Recipe it keeps no copy
 * for, as one in no slot, is then refused as the server is: unreachable, or
 * too old to ask.
 *
 * A PUT chooses the Recipe's Reference Shot (`chooseReference`).
 */
async function answerReference(request: HttpRequest, requests: SkinRequests | undefined, references: ReferenceCopies | undefined): Promise<HttpAnswer> {
  if (request.method === "PUT") return chooseReference(request, requests);
  if (request.method !== "GET") return methodNotAllowed("GET", "PUT");
  const { recipe } = request.query;
  if (!askable(recipe) || recipe === "") return invalid(NAME_THE_RECIPE);
  const recipeId = await recipeIdOf(recipe);
  if (recipeId === undefined) return refusal("recipesUnread");
  if (recipeId === null) return refusal("noSuchRecipe");
  const asked = await ask(requests, { ask: "reference", recipeId });
  if (!("unanswered" in asked)) return "refused" in asked.answer ? refused(asked.answer.refused) : json(200, { ...asked.answer.result, source: "server" });
  const copy = await references?.read(recipeId);
  return copy ? json(200, { ...copy, source: "tablet" }) : refusal(asked.unanswered);
}

/**
 * Answers a PUT to `reference` (ticket #511, ADR-0030): makes the Shot the
 * body's `shotId` names the Reference Shot of the Recipe the query's
 * `recipe` names, as a read names it, by the id of its DYE2 record on this
 * tablet. The server makes the choice, as it does one made in the
 * management interface, for a Recipe of the Machine's Location and a Shot
 * this tablet may read whole, and the answer is the Recipe's Reference Shot
 * as it then is, as a read is answered from the server.
 *
 * A request names a Shot: a tablet can't clear a Reference Shot. And a
 * choice is never kept for later: while the server can't be asked it is
 * refused, as unreachable or too old to ask, and the tablet's copy is no
 * answer to it. The request follows what the tablet has still to report, so
 * a Shot pulled seconds ago is chosen once the server has stored it.
 */
async function chooseReference(request: HttpRequest, requests: SkinRequests | undefined): Promise<HttpAnswer> {
  const { recipe } = request.query;
  if (!askable(recipe) || recipe === "") return invalid(NAME_THE_RECIPE);
  const shotId = typeof request.body === "object" && request.body !== null ? (request.body as { shotId?: unknown }).shotId : undefined;
  if (!askable(shotId) || shotId === "") return invalid("Give the Shot's id as shotId in a JSON body. A tablet can't clear a Reference Shot.");
  const recipeId = await recipeIdOf(recipe);
  if (recipeId === undefined) return refusal("recipesUnread");
  if (recipeId === null) return refusal("noSuchRecipe");
  const asked = await ask(requests, { ask: "chooseReference", recipeId, shotId });
  if ("unanswered" in asked) return refusal(asked.unanswered);
  if (!("refused" in asked.answer)) return json(200, { ...asked.answer.result, source: "server" });
  // A tablet may choose more than its Location's Shots: the Reference Shots of its Location's Recipes too.
  return asked.answer.refused === "noSuchShot" ? refusal("noSuchShot", {}, "No Shot this tablet may read whole has that id.") : refused(asked.answer.refused);
}

/** What a request to `reference` that names no Recipe is told. */
const NAME_THE_RECIPE = "Give the id of the Recipe's DYE2 record on this tablet as recipe.";

/**
 * The Recipe's own id that the DYE2 recipe with this record id on the
 * tablet carries, null where no record has the id or it carries none, and
 * undefined where DYE2's recipes can't be read, or are in a shape that is
 * not recognised. A tablet without DYE2 has no recipes.
 */
async function recipeIdOf(recordId: string): Promise<string | null | undefined> {
  const reading = await readCollection(`/store/${DYE2_NAMESPACE}/recipes`, null, true);
  // A list in a shape that is not recognised is never read as DYE2's recipes (ADR-0005).
  const records = reading.kind === "value" ? dye2Records(reading.value) : null;
  return records === null ? undefined : dye2GlobalIdOf(records.find((record) => record.id === recordId));
}

/**
 * Answers a PUT to `scan` (ticket #708, ADR-0030): has the server match the
 * text a scanned QR code held, the body's `text`, to a Bean Batch, and bring
 * that batch to the Machine's Location; or bring the one batch the body's
 * `match` names, by the id an earlier answer listed it with. The Skin read
 * the code: the plugin and the server decode nothing. A request takes no
 * weight.
 *
 * The answer's `outcome` says what came of it. `moved`, `added` and
 * `alreadyThere` are of one batch, which is at the Machine's Location now:
 * moved there, all of it, from the one other Location it was at, added there
 * with no weight moved, or there already. The plugin answers those only once
 * this tablet's Decaid lists the batch, not archived, under a bean that is
 * not, with the tablet's own ids for the batch and its bean (`batchId`,
 * `beanId`), so a Skin can select it: the server writes the tablet's
 * records as it brings the batch, and the plugin reads Decaid's list until
 * it holds it, or the request's time is up. `several` lists the batches the
 * text matched, and `noMatch` says it matched none: nothing changed, and the
 * server's answer is passed on as it is.
 *
 * It is made as the server is asked or not at all: while the server can't
 * be asked it is refused at once, as unreachable or too old to ask, before
 * Decaid is asked anything, and nothing is kept to send later. It goes at
 * once, behind nothing the tablet has still to report (FOLLOWS_REPORTS in
 * skin-requests.ts). One refused as unreachable after it was sent, as when
 * the server's answer or the tablet's record did not come in time, may
 * still have brought the batch.
 *
 * The batch's history credits the barista the tablet's Workflow names as
 * the Skin asks, beside the Machine and tablet, which the plugin reads from
 * Decaid (`workflowBarista`).
 */
async function answerScan(request: HttpRequest, requests: SkinRequests | undefined): Promise<HttpAnswer> {
  if (request.method !== "PUT") return methodNotAllowed("PUT");
  const asking = readScan(request.body);
  if (typeof asking === "string") return invalid(asking);
  if (!requests?.connected) return refusal("unreachable");
  if (!requests.bringsBatches) return refusal("serverTooOld");
  // The request's time, from when the Skin asked: the Workflow's read, the server's answer and the tablet's record all come within it.
  const deadline = Date.now() + SKIN_REQUEST_MS;
  const barista = await workflowBarista();
  const left = deadline - Date.now();
  // Not sent once its time is up, so the server brings nothing for a request already refused.
  if (left <= 0) return refusal("unreachable");
  const asked = await requests.ask({ ask: "bringBatch", ...asking, ...(barista !== null && { barista }) }, left);
  if ("unanswered" in asked) return refusal(asked.unanswered);
  if ("refused" in asked.answer) return refused(asked.answer.refused);
  // An answer to another ask, which the server never gives this request.
  if (asked.answer.ask !== "bringBatch") return refusal("unreachable");
  const brought = asked.answer.result;
  if (brought.outcome === "several" || brought.outcome === "noMatch") return json(200, brought);
  const held = await heldOnTablet(brought.batchId, () => Date.now() >= deadline);
  if (held) return json(200, { outcome: brought.outcome, ...held });
  return refusal("unreachable", {}, "The server found the Bean Batch, but this tablet did not hold it in time. It may still arrive: ask again.");
}

/**
 * What a request to `scan` asks the server, from its body: the `text` a
 * scanned code held, or the `match` a barista chose, the id an earlier
 * answer listed a batch with; or, as text, what is wrong with it. The text
 * is whatever a code held, trimmed by the server, of at most
 * MAX_SCANNED_TEXT_LENGTH and such that PostgreSQL stores it, so a request
 * never passes a frame and the server can compare it with what it holds.
 */
function readScan(body: unknown): { text: string } | { batchId: string } | string {
  const NOTHING_TO_MATCH = "Give the text the scanned code held as text, or the id of a batch from an earlier answer's matches as match, in a JSON body.";
  if (typeof body !== "object" || body === null || Array.isArray(body)) return NOTHING_TO_MATCH;
  const { text, match } = body as { text?: unknown; match?: unknown };
  if (text !== undefined && match !== undefined) return "Give text or match, not both.";
  if (match !== undefined) return isGlobalId(match) ? { batchId: match.toLowerCase() } : "Give match as the id of a batch from an earlier answer's matches.";
  if (text === undefined) return NOTHING_TO_MATCH;
  if (!(isShotNote(text) && text.length <= MAX_SCANNED_TEXT_LENGTH)) {
    return `Give text as the text the scanned code held, of at most ${MAX_SCANNED_TEXT_LENGTH} characters, without a NUL or an unpaired surrogate.`;
  }
  return { text };
}

/**
 * The barista the tablet's Workflow names now (`context.baristaName`), as
 * each Shot records one, trimmed; or null where it names none, where Decaid
 * doesn't give the Workflow, and for a name the server would not take:
 * longer than MAX_BARISTA_LENGTH, or one PostgreSQL would not store. A scan
 * is then credited to the Machine and tablet alone, rather than refused.
 */
async function workflowBarista(): Promise<string | null> {
  try {
    const answer = await askDecaid("GET", "/workflow");
    if (!answer.ok) return null;
    const workflow = JSON.parse(answer.text) as { context?: { baristaName?: unknown } | null } | null;
    const name = workflow?.context?.baristaName;
    const barista = typeof name === "string" ? name.trim() : "";
    return barista !== "" && barista.length <= MAX_BARISTA_LENGTH && isShotNote(barista) ? barista : null;
  } catch {
    return null;
  }
}

/** How long the plugin waits before it reads Decaid's batches again, while one the server brought is still to reach the tablet. */
const HELD_POLL_MS = 250;

/**
 * The tablet's own ids for the Bean Batch with that id of its own and for
 * its bean, once Decaid lists the batch as one to offer: not archived, of a
 * bean it holds that is not archived, which is what its list without
 * archived ones holds (`GET /bean-batches`). Read again every HELD_POLL_MS
 * until it does, as the server's writes of the bean and the batch arrive
 * and are carried out (`LibraryWrites`), which they are not while the
 * Machine pulls a Shot; null where it still doesn't once `timeUp` says the
 * request's time is.
 */
async function heldOnTablet(batchId: string, timeUp: () => boolean): Promise<{ batchId: string; beanId: string } | null> {
  for (;;) {
    const reading = await readCollection("/bean-batches", null);
    const records: unknown[] = reading.kind === "value" && Array.isArray(reading.value) ? reading.value : [];
    for (const record of records) {
      if (typeof record !== "object" || record === null) continue;
      const { id, beanId, archived } = record as { id?: unknown; beanId?: unknown; archived?: unknown };
      if (globalIdOf(record) === batchId && archived !== true && typeof id === "string" && typeof beanId === "string") return { batchId: id, beanId };
    }
    if (timeUp()) return null;
    await new Promise<void>((resolve) => setTimeout(() => resolve(), HELD_POLL_MS));
  }
}

/** Whether a value of the query is text the server may be asked with. */
function askable(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_ASKED_LENGTH;
}

/** Asks the server, where the plugin has a connection to ask on. */
function ask(requests: SkinRequests | undefined, question: SkinQuestion): Promise<Asked> {
  return requests ? requests.ask(question) : Promise.resolve({ unanswered: "unreachable" });
}

/** What a Skin is answered once the server was asked: the result as the server gave it, or the refusal. */
function answered(asked: Asked): HttpAnswer {
  if ("unanswered" in asked) return refusal(asked.unanswered);
  return "refused" in asked.answer ? refused(asked.answer.refused) : json(200, asked.answer.result);
}

/** The server's refusal, as a Skin is told it. */
function refused(code: SkinRefusal): HttpAnswer {
  return code === "invalidCursor" ? invalid("Give cursor as the nextCursor of the page before, or leave it out for the first page.") : refusal(code);
}

/** An endpoint's refusal: its HTTP status, with its `code` and `message` after what else the answer holds. */
function refusal(code: RefusalCode, body: Record<string, unknown> = {}, message = REFUSALS[code].message): HttpAnswer {
  return json(REFUSALS[code].status, { ...body, code, message });
}

/** The refusal of a request the endpoint can't read, saying what is wrong with it. */
function invalid(message: string): HttpAnswer {
  return refusal("invalidRequest", {}, message);
}

/** The answer to a method an endpoint doesn't take, naming those it does. */
function methodNotAllowed(...allowed: string[]): HttpAnswer {
  const error = `Only ${allowed.join(" and ")} ${allowed.length === 1 ? "is" : "are"} answered`;
  return { ...json(405, { error }), headers: { "Content-Type": "application/json", Allow: allowed.join(", ") } };
}

function json(status: number, body: unknown): HttpAnswer {
  return { status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/**
 * Tells the Skins listening on `changes` that the tablet's copy of a
 * Recipe's Reference Shot changed, naming the Recipe as an answer does: by
 * its id and name, and by the id of this tablet's DYE2 record of it, as the
 * server knew it. A Skin drawing that Recipe's reference reads it again. It
 * never throws: a push Decaid refuses is logged.
 */
export function tellReference(host: PluginHost, log: (message: string) => void, recipe: SkinRecipe): void {
  try {
    host.emit(CHANGES_ENDPOINT, { what: "reference", recipe });
  } catch (error) {
    log(`Could not tell Skins that a Recipe's Reference Shot changed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Tells the Skins listening on `changes` that a write of the plugin's
 * archived the tablet's record of a Bean Batch, or brought it back, naming
 * the record by Decaid's id. The push carries no state: a Skin showing that
 * batch reads Decaid's record again. Interim, until Decaid tells of a
 * batch's record changing itself, asked for in decentespresso/decaid#1271
 * (`AI_PROTOCOL_NOTES.md`, Requests for a Skin). It never throws: a push
 * Decaid refuses is logged.
 */
export function tellBatch(host: PluginHost, log: (message: string) => void, batch: string): void {
  try {
    host.emit(CHANGES_ENDPOINT, { what: "batch", batch });
  } catch (error) {
    log(`Could not tell Skins that a Bean Batch was archived or brought back: ${error instanceof Error ? error.message : String(error)}`);
  }
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
