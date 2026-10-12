import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { DecaidAnswer } from "./decaid-beans.js";
import type { DecaidApi, SimulatedTablet } from "./simulated-tablet.js";

// DYE2 v0.1.19 and Streamline v0.2.13 on a simulated tablet, as far as they
// write DYE2's recipes, baskets and tools and the Workflow: each helper
// replays a step recorded from the real apps on Decaid's Linux release
// (fixtures/decaid/dye2-v0.1.19/, whose README lists the steps) through the
// tablet's API, as they call it. The plugin is not told of it, as of
// anything else on the tablet (`SimulatedTablet.callApi`).
//
// DYE2 keeps each list whole under one key of Decaid's store, `recipes`,
// `baskets` and `equipment` (its tools) under `dye2.reaplugin`. Each save
// reads the list, changes one item and posts the list back: DYE2's pages put
// the item in as `{...existing, ...item}` (`kvUpsert` in
// dye2:dye2-plugin/src/utils/dev-api.ts), or leave it out to delete a tool,
// and Streamline's auto-save merges the fields it changed into the recipe's
// `dashboardVariables` (`saveItemFields` in
// streamline-js:src/modules/dyeStrip.js). The helpers do the same with the
// items the recording changed, so they work on whatever the tablet holds,
// and on the recorded list give what was recorded. A recipe is applied in
// one `PUT /workflow` of the whole Workflow, DYE2's dashboard and
// Streamline's DYE strip each merging the recipe into the Workflow they read;
// Streamline first keeps the steam, hot water and flush values it sets in
// its own namespace of the store (simulated-streamline.ts). Those writes are
// replayed as recorded.
//
// The recorded records name the recording's beans, grinder and profiles by
// their ids: load the tablet with `dye2Library()` for those ids to be the
// tablet's.

/** DYE2's namespace in Decaid's store. */
export const DYE2_NAMESPACE = "dye2.reaplugin";

/** The keys DYE2 keeps its lists under: recipes, baskets, and its tools as `equipment`. */
export type Dye2Key = "recipes" | "baskets" | "equipment";

/** A request DYE2 or Streamline sent, and what Decaid answered. */
export interface Dye2Exchange {
  request: { method: "GET" | "POST" | "PUT" | "DELETE"; path: string; body?: unknown };
  response: { status: number; body: unknown };
}

type Record_ = Record<string, unknown>;

/** The recorded steps of each file, by name: the exchanges of one action in DYE2 or Streamline. */
export interface Dye2Recordings {
  /** DYE2's equipment page: creating three tools, editing one and deleting another. */
  tools: Record<"createWdtTool" | "createPuckScreen" | "createSpareTamper" | "editWdtTool" | "deleteSpareTamper", Dye2Exchange[]>;
  /** DYE2's baskets page: creating two baskets and editing one. */
  baskets: Record<"create18gBasket" | "create20gBasket" | "edit18gBasket", Dye2Exchange[]>;
  /** DYE2's recipe editor: saving slots 1 and 2, editing slot 1, and saving slot 3 with every field blank. */
  recipes: Record<"saveSlot1" | "saveSlot2" | "editSlot1" | "saveBlankSlot3", Dye2Exchange[]>;
  /** DYE2's dashboard: applying each recipe, slot 1 again, then picking a basket for the next Shot. */
  "dye2-applies": Record<"applySlot1" | "applySlot2" | "applyBlankSlot3" | "applySlot1Again" | "pickBasket", Dye2Exchange[]>;
  /** Streamline's DYE strip applying slot 2, its auto-save of four changes into it, then slot 1 applied and a change it does not save. */
  streamline: Record<
    "applySlot2" | "autoSaveDose" | "autoSaveGrind" | "autoSaveHotWater" | "autoSaveSteam" | "applySlot1" | "noAutoSaveAfterLibraryProfile",
    Dye2Exchange[]
  >;
}

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/decaid/dye2-v0.1.19");

function readFixture<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(fixtures, `${file}.json`), "utf8")) as T;
}

/** The recorded steps of one file. */
export function dye2Recording<File extends keyof Dye2Recordings>(file: File): Dye2Recordings[File] {
  return readFixture(file);
}

/** What Decaid's store answered a key never written, a POST, a read, a DELETE and a DELETE of a key it no longer held. */
export function dye2StoreExchanges(): Dye2Exchange[] {
  return readFixture("store");
}

/** DYE2's three lists as the recording left them, after every step. */
export function dye2Keys(): Record<Dye2Key, Record_[]> {
  return readFixture("keys");
}

/**
 * The Shot pulled on the recording's simulated machine after a basket was
 * picked on DYE2's dashboard (its Workflow context's extras name the basket),
 * as Decaid stored it, or as it was after DYE2's Edit Shot page gave it a
 * basket and tools in its annotation's extras. Its measurements are trimmed.
 */
export function dye2Shot(which: "pulled" | "edited"): Record_ {
  return (readFixture<Record<string, Dye2Exchange>>("shot")[which]!.response.body) as Record_;
}

/**
 * The library and Workflow of the recording's tablet when DYE2 started:
 * two beans, a batch of each and a grinder, the two bundled profiles its
 * recipes use, and Decaid's default Workflow. Merge it into a tablet's API.
 */
export function dye2Library(): DecaidApi {
  const library = readFixture<Record<string, unknown>>("library");
  return {
    "/beans": library.beans,
    "/bean-batches": library.beanBatches,
    "/grinders": library.grinders,
    "/profiles": library.profiles,
    "/workflow": library.workflow,
  };
}

/** The list DYE2 keeps at that key on the tablet, as `GET /store/dye2.reaplugin/{key}` answers it: null if never written. */
export function dye2List(tablet: SimulatedTablet, key: Dye2Key): unknown {
  return tablet.storeValue(DYE2_NAMESPACE, key);
}

/**
 * Saves as a DYE2 page did in that recorded step, such as the recipe editor
 * saving slot 1 (`dye2Recording("recipes").saveSlot1`), a basket saved or a
 * tool created, edited or deleted: reads the list from the tablet, puts in
 * each item the step added or changed, over the tablet's item with its id,
 * and leaves out each item it removed, then posts the list back. `change`
 * alters the items put in, for a test to derive a save of its own, which it
 * names. Resolves with the list posted.
 */
export async function saveInDye2(tablet: SimulatedTablet, step: Dye2Exchange[], change: (item: Record_) => Record_ = (item) => item): Promise<Record_[]> {
  return writeList(tablet, step, (existing, recorded) => ({ ...existing, ...change(recorded) }));
}

/**
 * Streamline's auto-save in that recorded step: replays the Workflow change
 * the barista made and the values Streamline kept for it, then reads the
 * recipes from the tablet and merges the fields the step changed into the
 * applied recipe's `dashboardVariables`, and posts the list back. Resolves
 * with the list posted, or undefined for a step that saved nothing.
 */
export async function autoSaveInStreamline(tablet: SimulatedTablet, step: Dye2Exchange[]): Promise<Record_[] | undefined> {
  const posted = step.findIndex(isListWrite);
  await replayWrites(tablet, posted === -1 ? step : step.slice(0, posted));
  if (posted === -1) return undefined;
  return writeList(tablet, step, (existing, recorded, before) => {
    const changed = (record: Record_ | undefined) => (record?.dashboardVariables ?? {}) as Record_;
    const fields = Object.fromEntries(Object.entries(changed(recorded)).filter(([field, value]) => !isDeepStrictEqual(changed(before)[field], value)));
    return { ...existing, dashboardVariables: { ...changed(existing), ...fields } };
  });
}

/**
 * Replays the writes of that recorded step to the Workflow and to
 * Streamline's remembered values, in order, as recorded: a recipe applied on
 * DYE2's dashboard (`dye2Recording("dye2-applies").applySlot1`) or Streamline's
 * DYE strip (`dye2Recording("streamline").applySlot2`), or a basket picked for
 * the next Shot. Resolves with what Decaid answered each.
 */
export async function replayWrites(tablet: SimulatedTablet, step: Dye2Exchange[]): Promise<DecaidAnswer[]> {
  const answers: DecaidAnswer[] = [];
  for (const { request } of step) {
    if (request.method === "GET" || isListWrite({ request } as Dye2Exchange)) continue;
    answers.push(await tablet.callApi(request.method, request.path, request.body));
  }
  return answers;
}

/** A write of one of DYE2's lists. */
function isListWrite({ request }: Dye2Exchange): boolean {
  return request.method === "POST" && request.path.startsWith(`/store/${DYE2_NAMESPACE}/`);
}

/**
 * Writes the step's list as its writer did, read-modify-write: each item the
 * step changed or added is put in as `merge` makes it from the tablet's item
 * with its id (undefined for a new one), the item recorded and the item the
 * recorded writer read, and each it removed is left out.
 */
async function writeList(
  tablet: SimulatedTablet,
  step: Dye2Exchange[],
  merge: (existing: Record_ | undefined, recorded: Record_, before: Record_ | undefined) => Record_,
): Promise<Record_[]> {
  const index = step.findIndex(isListWrite);
  if (index === -1) throw new Error("The step writes none of DYE2's lists");
  const { path: route, body } = step[index]!.request;
  const read = step.slice(0, index).filter(({ request }) => request.method === "GET" && request.path === route).at(-1);
  const before = asList(read?.response.body);
  const after = asList(body);
  const byId = (list: Record_[], id: unknown) => list.find((item) => item.id === id);
  const { status, body: current } = await tablet.callApi("GET", route);
  if (status !== 200) throw new Error(`Decaid answered ${status} reading ${route}`);
  let list = asList(current);
  for (const item of before) if (!byId(after, item.id)) list = list.filter((kept) => kept.id !== item.id);
  for (const item of after) {
    const previous = byId(before, item.id);
    if (isDeepStrictEqual(previous, item)) continue;
    const existing = byId(list, item.id);
    const merged = merge(existing, item, previous);
    list = existing ? list.map((kept) => (kept === existing ? merged : kept)) : [...list, merged];
  }
  const written = await tablet.callApi("POST", route, list);
  if (written.status !== 200) throw new Error(`Decaid answered ${written.status} writing ${route}`);
  return list;
}

/** A list as DYE2 and Streamline read one (`kvGetArray`, `getDye2KvArray`): anything but an array is empty. */
function asList(value: unknown): Record_[] {
  return Array.isArray(value) ? (value as Record_[]) : [];
}
