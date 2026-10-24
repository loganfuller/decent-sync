import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { DecaidAnswer } from "./decaid-beans.js";
import { type DecaidApi, type SimulatedTablet, derivedDe1Pro } from "./simulated-tablet.js";

// DYE2 v0.1.26 and Streamline `main` at cec5664 on a simulated tablet, built
// from their source at those builds (dye2:dye2-plugin/src/,
// streamline-js:src/modules/). The plugin is not told of them, as of
// anything else on the tablet (`SimulatedTablet.callApi`).
//
// DYE2 keeps each list whole under one key of Decaid's store, `recipes`,
// `baskets` and `equipment` (its tools) under `dye2.reaplugin`. Each save
// reads the list, changes one item and posts the list back. DYE2's pages put
// the item in as `{...existing, ...item}` (`kvUpsert` in
// dye2:dye2-plugin/src/utils/dev-api.ts), leave it out to delete a tool, and
// write nothing for a new tool whose name the list holds already
// (`createEquipment`). `saveInDye2` does the same with the items a recorded
// save changed, so it works on whatever the tablet holds, and on the
// recorded list gives what was recorded; `replayWrites` replays a recorded
// step's Workflow writes.
//
// The recorded data (fixtures/decaid/dye2-2cf631c/, recorded from the builds
// supported before) names the recording's beans, grinders and profiles by
// their ids: load the tablet with `dye2Library()` for those ids to be the
// tablet's.
//
// DYE2 itself, the recipe id it reads from the Workflow and clears on a
// profile change, its derived selection, its `record` and `save-recipe`, its
// migrations and pushes, is `SimulatedDye2` below; its pages are
// `openDye2Dashboard`, `selectRecipeInDye2` and `openDye2RecipeEditor`.
// Streamline's DYE strip, tiles, wake and remembered values are
// simulated-streamline.ts.

/** DYE2's namespace in Decaid's store. */
export const DYE2_NAMESPACE = "dye2.reaplugin";

/** The keys DYE2 keeps its lists under: recipes, baskets, and its tools as `equipment`. */
export type Dye2Key = "recipes" | "baskets" | "equipment";

/** A request DYE2 or Streamline sent, and what Decaid answered. */
export interface Dye2Exchange {
  request: { method: "GET" | "POST" | "PUT" | "DELETE"; path: string; body?: unknown };
  /** `injected` marks an answer the recording gave in Decaid's stead. */
  response: { status: number; body: unknown; injected?: boolean };
}

/**
 * A recorded step of a selection's life: its exchanges, the reads made once
 * DYE2 would have recorded (`after`), the pushes heard on DYE2's `changed`
 * socket meanwhile, and the context of each Workflow Decaid sent plugins in
 * a `workflowUpdated` (`events`).
 */
export interface Dye2Step {
  exchanges: Dye2Exchange[];
  after: Dye2Exchange[];
  pushes: unknown[];
  events: (Record<string, unknown> | null)[];
}

type Record_ = Record<string, unknown>;

/** The recorded steps of each file, by name. */
export interface Dye2Recordings {
  /** DYE2's equipment page: creating three tools, editing one and deleting another. */
  tools: Record<"createWdtTool" | "createPuckScreen" | "createSpareTamper" | "editWdtTool" | "deleteSpareTamper", Dye2Exchange[]>;
  /** DYE2's baskets page: creating two baskets and editing one. */
  baskets: Record<"create18gBasket" | "create20gBasket" | "edit18gBasket", Dye2Exchange[]>;
  /** DYE2's recipe editor: saving slots 1 and 2, editing slot 1, and saving slot 3 with only its name typed, its other fields blank. */
  recipes: Record<"saveSlot1" | "saveSlot2" | "editSlot1" | "saveBlankSlot3", Dye2Exchange[]>;
  /** DYE2's dashboard: applying, and so selecting, each recipe, slot 1 again, then picking a basket for the next Shot. */
  "dye2-applies": Record<"applySlot1" | "applySlot2" | "applyBlankSlot3" | "applySlot1Again" | "pickBasket", Dye2Step>;
  /**
   * Recorded on a Decaid of its own (`library`): DYE2's recipe editor saving
   * slot 1 with every machine setting, then editing them, switching a mode
   * alone, setting the steam temperature Off and back on, and blanking the
   * milk stop; the Workflow's steam turned off, slot 1 applied on DYE2's
   * dashboard, and a Workflow change once it is selected.
   */
  "machine-settings": Record<"saveMachineSettings" | "editMachineSettings" | "switchModeOnly" | "steamOff" | "steamBackOn" | "clearMilkStopTyped" | "clearMilkStop", Dye2Exchange[]> &
    Record<"steamOffInWorkflow" | "applyMachineSettings" | "changeAfterApply", Dye2Step> & { library: Record_ };
}

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/decaid/dye2-2cf631c");

function readFixture<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(fixtures, `${file}.json`), "utf8")) as T;
}

/** The recorded steps of one of DYE2's pages. */
export function dye2Recording<File extends keyof Dye2Recordings>(file: File): Dye2Recordings[File] {
  return readFixture(file);
}

/** Another file of the recording (fixtures/decaid/dye2-2cf631c/): its library, DYE2's listing, and the Shot it pulled. */
export function dye2MainRecording<T = Record<string, unknown>>(file: "library" | "plugins" | "dashboard" | "recording" | "restore" | "streamline" | "fingerprints" | "shot"): T {
  return readFixture(file);
}

/** What Decaid's store answered a key never written, a POST, a read, a DELETE and a DELETE of a key it no longer held. */
export function dye2StoreExchanges(): Dye2Exchange[] {
  return readFixture("store");
}

/** DYE2's three lists as the recording left them once its pages' steps were done, before its selection's. */
export function dye2Keys(): Record<Dye2Key, Record_[]> {
  return readFixture("keys");
}

/**
 * The library and Workflow of the recording's tablet when DYE2 started:
 * two beans, a batch of each and two grinders, the two bundled profiles its
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

/**
 * The library and Workflow of the tablet machine-settings.json was recorded
 * on, a Decaid of its own, before DYE2 wrote anything: its beans, batches and
 * grinders, made as for the other files but under ids of their own,
 * `Adaptive v3`, Decaid's default Workflow and the simulated machine's
 * settings. Merge it into a tablet's API.
 */
export function dye2MachineSettingsLibrary(): DecaidApi {
  const { library } = dye2Recording("machine-settings");
  return {
    "/beans": library.beans,
    "/bean-batches": library.beanBatches,
    "/grinders": library.grinders,
    "/profiles": library.profiles,
    "/workflow": library.workflow,
    "/machine/settings": library.machineSettings,
  };
}

/**
 * Derived from derivedDe1Pro(): the tablet with this serial, its Decaid
 * holding no beans, bean batches, grinders or profiles, and DYE2's keys never
 * written, as on a tablet where DYE2 was never used.
 */
export function dye2NeverUsed(serial: string): DecaidApi {
  const api: DecaidApi = { ...derivedDe1Pro({ serial }), "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [] };
  for (const key of ["recipes", "baskets", "equipment"] as const) delete api[`/store/${DYE2_NAMESPACE}/${key}`];
  return api;
}

/** The beans with their names starting with `scenario`, where one is given, as Beans are matched by roaster and name across a test file's tests. */
function scenarioBeans(beans: unknown, scenario: string | undefined): Record_[] {
  return (beans as Record_[]).map((bean) => (scenario === undefined ? bean : { ...bean, name: `${scenario} ${String(bean.name)}` }));
}

/**
 * The recording's tablet, with this serial, as DYE2's pages found it: its
 * library and Workflow (dye2Library()), and DYE2's baskets and tools as its
 * pages' steps left them, but no recipes. Its beans' names start with
 * `scenario`.
 */
export function recordedDye2Tablet(serial: string, scenario: string): DecaidApi {
  const library = dye2Library();
  const keys = dye2Keys();
  return {
    ...dye2NeverUsed(serial),
    ...library,
    "/beans": scenarioBeans(library["/beans"], scenario),
    [`/store/${DYE2_NAMESPACE}/baskets`]: keys.baskets,
    [`/store/${DYE2_NAMESPACE}/equipment`]: keys.equipment,
  };
}

/**
 * The recording's tablet, with this serial, as its selection's steps began
 * (plugins.json onwards): its beans, batches, grinders, profiles and
 * Workflow, its simulated machine's settings, and DYE2's baskets and its
 * three recipes (slot 1 on `Adaptive v3`, slot 2 on `Classic Italian
 * espresso` and the blank slot 3), ids `1` to `3` and no `stripSlot` key, and
 * none of DYE2's migration flags, so a `SimulatedDye2` migrates them as it
 * loads. Its beans' names start with `scenario` where one is given.
 */
export function recordedDye2MainTablet(serial: string, scenario?: string): DecaidApi {
  const library = readFixture<Record<string, unknown>>("library");
  return {
    ...dye2NeverUsed(serial),
    "/beans": scenarioBeans(library.beans, scenario),
    "/bean-batches": library.beanBatches,
    "/grinders": library.grinders,
    "/profiles": library.profiles,
    "/workflow": library.selectionWorkflow,
    "/machine/settings": library.machineSettings,
    [`/store/${DYE2_NAMESPACE}/recipes`]: library.recipes,
    [`/store/${DYE2_NAMESPACE}/baskets`]: library.baskets,
  };
}

/** DYE2's one-time migrations marked done in its store, as on a tablet where DYE2 v0.1.26 has loaded once: merge into a tablet's API so a `SimulatedDye2` runs none. */
export function dye2Migrated(): DecaidApi {
  return Object.fromEntries(["selectionMigrated", "recipesMigrated", "favSlotsMigrated", "favProfilesMigrated"].map((key) => [`/store/${DYE2_NAMESPACE}/${key}`, true]));
}

/**
 * DYE2's derived selection on a tablet with a simulated DYE2, its kind and
 * id: null for none, or while DYE2 is not loaded; `tablet.dye2.selected()`
 * has the rest of it.
 */
export function dye2Selection(tablet: SimulatedTablet): { kind: string; id: string } | null {
  const selected = tablet.dye2?.selected();
  return selected ? { kind: selected.kind, id: selected.id } : null;
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
 * keeping that item's `createdAt` as DYE2's edits of a basket or tool do
 * (`updateBasket`, `updateEquipment`), and leaves out each item it removed,
 * then posts the list back. Every field of the recorded item replaces the
 * tablet's, as a DYE2 page opened on the recording's values would save it,
 * so a field the tablet holds otherwise, such as a name the server changed,
 * is put back. `change` alters each item the step put in or removed, its id
 * included, so that a test derives a save of its own, which it names, such
 * as the same edit made from the tablet's own item, or of the tool another
 * tablet holds under its own id. Resolves with the list.
 */
export async function saveInDye2(tablet: SimulatedTablet, step: Dye2Exchange[], change: (item: Record_) => Record_ = (item) => item): Promise<Record_[]> {
  return writeList(
    tablet,
    step,
    (existing, item, before, list) => {
      const named = (tool: Record_) => String(tool.name).toLowerCase() === String(item.name).toLowerCase();
      if (!before && isToolList(step) && list.some(named)) return undefined;
      return { ...existing, ...item, ...(before && existing && "createdAt" in existing ? { createdAt: existing.createdAt } : {}) };
    },
    change,
  );
}

/**
 * Replays the Workflow writes and Streamline's remembered values of that
 * recorded step, in order, as recorded, its writes of DYE2's lists and its
 * selection left out: such as a basket picked for the next Shot
 * (`dye2Recording("dye2-applies").pickBasket`). Resolves with what Decaid
 * answered each.
 */
export async function replayWrites(tablet: SimulatedTablet, step: Dye2Exchange[] | Pick<Dye2Step, "exchanges">): Promise<DecaidAnswer[]> {
  const exchanges = Array.isArray(step) ? step : step.exchanges;
  const answers: DecaidAnswer[] = [];
  for (const { request } of exchanges) {
    if (request.method === "GET" || isListWrite({ request } as Dye2Exchange) || request.path.startsWith(`/plugins/${DYE2_NAMESPACE}/`)) continue;
    answers.push(await tablet.callApi(request.method, request.path, request.body));
  }
  return answers;
}

/** Whether the step writes DYE2's tools. */
function isToolList(step: Dye2Exchange[]): boolean {
  return step.some(({ request }) => isListWrite({ request } as Dye2Exchange) && request.path === `/store/${DYE2_NAMESPACE}/equipment`);
}

/** A write of one of DYE2's lists. */
function isListWrite({ request }: Dye2Exchange): boolean {
  return request.method === "POST" && /^\/store\/dye2\.reaplugin\/(recipes|baskets|equipment)$/.test(request.path);
}

/**
 * Writes the step's list as its writer did, read-modify-write: each item the
 * step changed or added, as `retarget` makes it, is put in as `merge` makes
 * it from the tablet's item with its id (undefined for a new one), that item,
 * the item the recorded writer read (undefined for a new one) and the list
 * read, or left as it is where `merge` gives undefined, and each it removed
 * is left out, found by the id `retarget` gives it.
 * Posts the list back unless `merge` left every item it was given as it is
 * and the step removed none, as DYE2 creating a tool the list names already
 * writes nothing. Resolves with the list.
 */
async function writeList(
  tablet: SimulatedTablet,
  step: Dye2Exchange[],
  merge: (existing: Record_ | undefined, item: Record_, before: Record_ | undefined, list: Record_[]) => Record_ | undefined,
  retarget: (item: Record_) => Record_ = (item) => item,
): Promise<Record_[]> {
  const index = step.findIndex(isListWrite);
  if (index === -1) throw new Error("The step writes none of DYE2's lists");
  const { path: route, body } = step[index]!.request;
  const recordedRead = step.slice(0, index).filter(({ request }) => request.method === "GET" && request.path === route).at(-1);
  const before = asList(recordedRead?.response.body);
  const after = asList(body);
  const byId = (list: Record_[], id: unknown) => list.find((item) => item.id === id);
  const { status, body: current } = await tablet.callApi("GET", route);
  if (status !== 200) throw new Error(`Decaid answered ${status} reading ${route}`);
  let list = asList(current);
  let changed = false;
  for (const item of before) {
    if (byId(after, item.id)) continue;
    const { id } = retarget(item);
    list = list.filter((kept) => kept.id !== id);
    changed = true;
  }
  for (const item of after) {
    const previous = byId(before, item.id);
    if (isDeepStrictEqual(previous, item)) continue;
    const target = retarget(item);
    const existing = byId(list, target.id);
    const merged = merge(existing, target, previous, list);
    if (merged === undefined) continue;
    list = existing ? list.map((kept) => (kept === existing ? merged : kept)) : [...list, merged];
    changed = true;
  }
  if (!changed) return list;
  const written = await tablet.callApi("POST", route, list);
  if (written.status !== 200) throw new Error(`Decaid answered ${written.status} writing ${route}`);
  return list;
}

/** A list as DYE2 and Streamline read one (`kvGetArray`, `getDye2KvArray`): anything but an array is empty. */
function asList(value: unknown): Record_[] {
  return Array.isArray(value) ? (value as Record_[]) : [];
}

// ---- DYE2 running on the tablet (dye2:dye2-plugin/src/plugin.ts at v0.1.26).
//
// DYE2 stores no selection: the recipe being dialled in is the Workflow's
// `context.extras.dye.recipeId` (`recipeIdOf` in utils/workflow-record.ts),
// which its dashboard, its Select Recipe page and Streamline's strip set as
// they apply a recipe. On each `workflowUpdated` (`trackWorkflow`, one at a
// time) it checks that id against a baseline it keeps in memory, the profile
// fingerprint, brew temperature and machine settings the Workflow held when
// the id first appeared (`workflowChanged`): a profile moved off the
// baseline's clears the id, with `PUT /workflow {"context":{"extras":{"dye":
// {"recipeId":null}}}}`, whatever else the same PUT sent. Nothing clears it
// on another batch or grinder. A load loses the baseline; as it loads DYE2
// looks at the Workflow once (`onLoad`'s `trackWorkflow(wf, true)`), and with
// no baseline compares the recipe record's own profile (`idProfileChanged`).
// It then mirrors the selection it derives (`deriveSelection`: the recipe the
// id names, else a favourite or recent matching the Workflow) to its store
// key `selection`, `{}` for none, and pushes `{"what":"workflow"}` on its
// `changed` socket, only when the selection or its `modified` changed
// (`mirror`). `GET .../selection` answers it derived afresh; `POST` writes
// `recipeId` (`handleSelection`, a compat shim). Nothing is written into a
// recipe unless asked: `POST .../record` (`handleRecord`, Streamline's "Save
// changes") writes what the Workflow holds otherwise (`recordWorkflow` and
// `itemPatch`, against the baseline's `armedBrewC` and `armedMachine`), and
// `POST .../save-recipe` (`handleSaveRecipe`) makes a recipe of the Workflow
// and puts its id in it. As it loads, DYE2 runs its one-time migrations,
// each once its store flag says it has not (`selectionMigrated`: `migrate`;
// `recipesMigrated`: `migrateRecipeSlots`, `dropSuggestedRecipes` and
// `dedupeRecipeSlots`), and refreshes its recent favourites, pushing once
// done, as it does after each Shot (`refreshRecents`); recent favourites
// themselves are not simulated, nor the favourite migrations' changes.
//
// `SimulatedDye2` runs it beside the plugin on a tablet loaded with it
// (`SimulatedTabletOptions.dye2`): Decaid lists it at `GET /plugins`, routes
// `/plugins/dye2.reaplugin/{endpoint}` to it while it is loaded and answers
// 404 otherwise, gives it every `workflowUpdated` and `shotStored`, whoever
// changed the Workflow, the plugin's own `PUT /workflow` included, and opens
// sockets on its `changed` endpoint. It loads as the tablet starts, as
// Decaid loads its plugins. Its storage (`host.storage`) is its keys in
// Decaid's store under `dye2.reaplugin`. It reads the DE1's flush
// temperature and flow from `GET /machine/settings` where the tablet answers
// it (`withMachineSettings`).

/** DYE2's derived selection, as `GET .../selection` answers it and its store key `selection` mirrors it (`Derived` in workflow-record.ts). */
export interface Dye2Derived {
  kind: "recipe" | "favourite";
  id: string;
  /** The Workflow holds a recipe's field otherwise (`recipeModified`); always false for a favourite. */
  modified: boolean;
  /** A recent favourite. */
  auto?: true;
}

/** The baseline DYE2 keeps in memory for the recipe the Workflow names (`baseline` in plugin.ts, a `Selection`). */
export interface Dye2Baseline {
  kind: "recipe";
  id: string;
  profileFingerprint: string | null;
  armedBrewC: number | null;
  armedBeanBatchId: null;
  armedGrinderId: null;
  /** The Workflow's steam, hot water and flush settings, with the DE1's flush pair over them, when the id first appeared, by `dashboardVariables` name. */
  armedMachine: Record_ | null;
}

/** Whether DYE2 is installed, and loaded: `disabled` is unloaded and not loaded at start, as `POST .../disable` leaves it; `unloaded` unloaded but loaded at start, as Decaid's settings or a failed load leave it. */
export type Dye2State = "loaded" | "unloaded" | "disabled" | "absent";

/** DYE2's HTTP endpoints a test can hold or fail. */
export type Dye2Endpoint = "selection" | "record" | "save-recipe";

/** The Workflow field DYE2 reads the recipe being dialled in from (`recipeIdOf`). */
export const DYE2_RECIPE_ID_PATH = ["context", "extras", "dye", "recipeId"] as const;

/** The endpoints DYE2's manifest at v0.1.26 declares (dye2:dye2.reaplugin/manifest.json), all `http` but `changed`. */
const DYE2_ENDPOINTS = [
  "dashboard",
  "grinders",
  "baskets",
  "equipment",
  "grinder-picker",
  "basket-picker",
  "bean-picker",
  "roasters",
  "add-bean",
  "profile-picker",
  "edit-shot",
  "auto-favs",
  "auto-fav-edit",
  "recipe-edit",
  "select-recipe",
  "bc-import",
  "recent-favs",
  "selection",
  "record",
  "save-recipe",
  "skin",
  "changed",
  "plotly",
];

/** The version DYE2's manifest at v0.1.26 still names, which `GET /plugins` lists. */
const DYE2_MANIFEST_VERSION = "0.1.24";

/** An empty baseline, for a record made without one (`EMPTY_BASELINE` in plugin.ts). */
const EMPTY_BASELINE: Dye2Baseline = { kind: "recipe", id: "", profileFingerprint: null, armedBrewC: null, armedBeanBatchId: null, armedGrinderId: null, armedMachine: null };

/** The list each kind of item is kept in, and the part of an item holding its dashboard values (TARGETS). */
const DYE2_TARGETS = {
  recipe: { key: "recipes", field: "dashboardVariables" },
  favourite: { key: "autoFavourites", field: "snapshot" },
} as const;

/** Every machine setting a recipe can hold: its `dashboardVariables` name, and the Workflow part and field it is (MACHINE_MAP). */
const MACHINE_MAP: Readonly<Record<string, readonly [string, string]>> = {
  steamTempC: ["steamSettings", "targetTemperature"],
  steamTimeS: ["steamSettings", "duration"],
  steamFlowMls: ["steamSettings", "flow"],
  steamStopAtTempC: ["steamSettings", "stopAtTemperature"],
  hotWaterTempC: ["hotWaterData", "targetTemperature"],
  hotWaterTimeS: ["hotWaterData", "duration"],
  hotWaterMl: ["hotWaterData", "volume"],
  hotWaterFlowMls: ["hotWaterData", "flow"],
  flushTempC: ["rinseData", "targetTemperature"],
  flushS: ["rinseData", "duration"],
  flushFlowMls: ["rinseData", "flow"],
};

/** The steam settings, all withheld while steam is off (STEAM_KEYS, dye2#30). */
const STEAM_KEYS = ["steamTempC", "steamTimeS", "steamFlowMls", "steamStopAtTempC"];

/** The two settings DYE2 reads from the DE1's settings rather than the Workflow, and their `GET /machine/settings` names (DE1_ONLY). */
const DE1_ONLY: Readonly<Record<string, string>> = { flushTempC: "flushTemp", flushFlowMls: "flushFlow" };

/**
 * A profile as DYE2 fingerprints it to tell a change of profile
 * (`profileFingerprint` in workflow-record.ts): its title, tank temperature
 * and steps, but each step's temperature, and a step limiter of value 0 as
 * none (dye2#32); its target weight and volume are the yield.
 */
export function dye2ProfileFingerprint(profile: unknown): string | null {
  if (!profile || typeof profile !== "object") return null;
  const record = profile as Record_;
  const steps = Array.isArray(record.steps)
    ? (record.steps as Record_[]).map(({ temperature: _, limiter, ...rest }) => ({
        ...rest,
        limiter: limiter && Number((limiter as Record_).value) !== 0 ? limiter : null,
      }))
    : record.steps;
  return JSON.stringify({ title: record.title, tank_temperature: record.tank_temperature, steps });
}

/** The recipe id the Workflow names (`recipeIdOf`): null for none or "", else as text. */
export function dye2RecipeIdOf(workflow: unknown): string | null {
  const id = ((((workflow as Record_ | null | undefined)?.context as Record_ | undefined)?.extras as Record_ | undefined)?.dye as Record_ | undefined)?.recipeId;
  return id == null || id === "" ? null : String(id);
}

function dye2Number(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const parsed = parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function dye2Put(out: Record_, key: string, value: unknown): void {
  if (value !== undefined && value !== null) out[key] = value;
}

/** Decaid reads a steam target below 135 as off (`steamOff`). */
function steamOff(workflow: Record_ | null | undefined): boolean {
  const temperature = Number(((workflow?.steamSettings ?? {}) as Record_).targetTemperature);
  return Number.isFinite(temperature) && temperature < 135;
}

/** Everything the Workflow says that a recipe could hold, in `dashboardVariables` names (`recipeFields`). */
export function dye2RecipeFields(workflow: Record_): Record_ {
  const out: Record_ = {};
  const context = (workflow?.context ?? {}) as Record_;
  dye2Put(out, "dose", context.targetDoseWeight);
  dye2Put(out, "drink", context.targetYield);
  dye2Put(out, "grind", dye2Number(context.grinderSetting));
  const extras = (context.extras ?? {}) as Record_;
  dye2Put(out, "rpm", dye2Number(extras.rpm));
  dye2Put(out, "basketId", extras.basketId);
  dye2Put(out, "basketName", extras.basketName);
  const steps = (workflow?.profile as Record_ | undefined)?.steps as Record_[] | undefined;
  dye2Put(out, "brewC", dye2Number(steps?.[0]?.temperature));
  for (const [key, [part, field]] of Object.entries(MACHINE_MAP)) dye2Put(out, key, ((workflow?.[part] ?? {}) as Record_)[field]);
  return out;
}

/** `recipeFields` but the steam settings while steam is off (`ownedRecipeFields`). */
function ownedRecipeFields(workflow: Record_): Record_ {
  const out = dye2RecipeFields(workflow);
  if (steamOff(workflow)) for (const key of STEAM_KEYS) delete out[key];
  return out;
}

/** A copy of the Workflow with the DE1-only settings laid over it from a `GET /machine/settings` body (`withMachineSettings`). */
function withMachineSettings(workflow: Record_, de1: Record_ | null): Record_ {
  if (!workflow || !de1) return workflow;
  const out: Record_ = { ...workflow };
  for (const [name, key] of Object.entries(DE1_ONLY)) {
    if (de1[key] == null) continue;
    const [part, field] = MACHINE_MAP[name]!;
    out[part] = { ...((out[part] ?? {}) as Record_), [field]: de1[key] };
  }
  return out;
}

/** The machine settings of the Workflow that have a value: the baseline's `armedMachine` (`machineFields`). */
function dye2MachineFields(workflow: Record_): Record_ {
  const all = dye2RecipeFields(workflow);
  return Object.fromEntries(Object.keys(MACHINE_MAP).filter((key) => all[key] !== undefined).map((key) => [key, all[key]]));
}

/** A favourite's snapshot fields: dose, yield, grind and RPM only (`favouriteFields`). */
function dye2FavouriteFields(workflow: Record_ | undefined): Record_ {
  const out: Record_ = {};
  const context = (workflow?.context ?? {}) as Record_;
  dye2Put(out, "dose", context.targetDoseWeight);
  dye2Put(out, "drink", context.targetYield);
  dye2Put(out, "grindSetting", dye2Number(context.grinderSetting));
  dye2Put(out, "rpm", dye2Number((context.extras as Record_ | undefined)?.rpm));
  return out;
}

/** `sameValue`: equal, or both numbers equal, but two strings only exactly. */
function sameValue(current: unknown, value: unknown): boolean {
  return (
    current === value ||
    (current != null && value != null && !(typeof current === "string" && typeof value === "string") && Number.isFinite(Number(current)) && Number(current) === Number(value))
  );
}

/** The entries of `patch` that differ from `stored` (`changedFields`). */
function dye2ChangedFields(patch: Record_, stored: Record_ | undefined): Record_ {
  return Object.fromEntries(Object.entries(patch).filter(([key, value]) => !sameValue(stored?.[key], value)));
}

/**
 * What DYE2's record writes onto the item for the Workflow (`itemPatch`):
 * the fields the item holds that differ, the brew temperature only once it
 * moved off `armedBrewC`, a machine setting the item does not hold once it
 * moved off its value in `armedMachine` (`movedSinceArming`), no steam
 * setting while steam is off, and the Basket's id and name together.
 */
export function dye2ItemPatch(kind: Dye2Derived["kind"], item: Record_, workflow: Record_, armedBrewC: number | null = null, armedMachine: Record_ | null = null): Record_ {
  const stored = (item[DYE2_TARGETS[kind].field] ?? {}) as Record_;
  const all = kind === "recipe" ? dye2RecipeFields(workflow) : dye2FavouriteFields(workflow);
  const off = steamOff(workflow);
  const moved = (key: string) => !!armedMachine && key in MACHINE_MAP && armedMachine[key] !== undefined && !sameValue(armedMachine[key], all[key]);
  const known: Record_ = {};
  for (const key of Object.keys(all)) {
    if (off && STEAM_KEYS.includes(key)) continue;
    if (stored[key] == null && !moved(key)) continue;
    if (key === "brewC" && (armedBrewC == null || all.brewC === armedBrewC)) continue;
    known[key] = all[key];
  }
  const patch = dye2ChangedFields(known, stored);
  if ("basketId" in patch || "basketName" in patch) for (const key of ["basketId", "basketName"]) if (all[key] !== undefined) patch[key] = all[key];
  return patch;
}

/** A copy of the profile with its first step at `brewC` and the others moved by as much (`profileAtBrewC`); null with nothing to shift. */
function profileAtBrewC(profile: Record_ | undefined, brewC: unknown): Record_ | null {
  if (brewC == null || brewC === "") return null;
  const target = Number(brewC);
  if (!profile || !Array.isArray(profile.steps) || !Number.isFinite(target)) return null;
  const steps = profile.steps as Record_[];
  const origin = steps[0]?.temperature;
  const shift = typeof origin === "number" && Number.isFinite(origin) ? target - origin : null;
  return {
    ...profile,
    steps: steps.map((step) => ({
      ...step,
      temperature: shift != null && typeof step.temperature === "number" && Number.isFinite(step.temperature) ? Math.round((step.temperature + shift) * 100) / 100 : target,
    })),
  };
}

/** The entries of `fields` that `stored` holds (`heldFields`). */
function heldFields(fields: Record_, stored: Record_ | undefined): Record_ {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => stored?.[key] != null));
}

/** A recipe's own profile: its embedded Workflow's, else its snapshot (`profileOf`). */
function profileOf(recipe: Record_): unknown {
  return ((recipe.workflow as Record_ | undefined)?.profile ?? null) || recipe.profileSnapshot || null;
}

/** Whether the Workflow holds one of the recipe's fields otherwise, its brew temperature only where it names a profile (`recipeModified`). */
function recipeModified(recipe: Record_, workflow: Record_): boolean {
  const stored = (recipe.dashboardVariables ?? {}) as Record_;
  const held = heldFields(ownedRecipeFields(workflow), stored);
  if (!profileOf(recipe)) delete held.brewC;
  return Object.keys(dye2ChangedFields(held, stored)).length > 0;
}

/** Whether the Workflow's profile differs from the recipe's own, where it names one (`recipeProfileChanged`). */
function recipeProfileChanged(recipe: Record_, workflow: Record_): boolean {
  const mine = dye2ProfileFingerprint(profileOf(recipe));
  const live = dye2ProfileFingerprint(workflow?.profile);
  return !!mine && !!live && mine !== live;
}

/** Whether the profile changed under the recipe: against the baseline, or with none, against the recipe's own (`idProfileChanged`). */
function idProfileChanged(base: Dye2Baseline | null, recipe: Record_ | null, workflow: Record_): boolean {
  if (!base) return !!recipe && recipeProfileChanged(recipe, workflow);
  const live = dye2ProfileFingerprint(workflow?.profile);
  return !!base.profileFingerprint && !!live && live !== base.profileFingerprint;
}

/** A saved favourite against its snapshot, a recent one against its Workflow, never an empty one (`favouriteMatches`). */
function favouriteMatches(favourite: Record_, workflow: Record_): boolean {
  const source = favourite.auto ? dye2FavouriteFields(favourite.workflow as Record_ | undefined) : ((favourite.snapshot ?? {}) as Record_);
  const held = heldFields(dye2FavouriteFields(workflow), source);
  return Object.keys(held).length > 0 && Object.keys(dye2ChangedFields(held, source)).length === 0;
}

/** The selection DYE2 derives from the Workflow (`deriveSelection`): the recipe `recipeId` names where a row has that id, else the first favourite matching, saved before recent. */
export function dye2DeriveSelection(workflow: Record_ | null | undefined, rows: { recipes?: unknown[]; favourites?: unknown[] }): Dye2Derived | null {
  if (!workflow) return null;
  const id = dye2RecipeIdOf(workflow);
  const recipe = id ? (rows.recipes ?? []).find((row) => row && String((row as Record_).id) === id) : undefined;
  if (recipe) return { kind: "recipe", id: id!, modified: recipeModified(recipe as Record_, workflow) };
  const favourites = (rows.favourites ?? []).filter((row): row is Record_ => !!row && (row as Record_).id != null) as Record_[];
  const hit = [...favourites.filter((row) => !row.auto), ...favourites.filter((row) => row.auto)].find((row) => favouriteMatches(row, workflow));
  if (!hit) return null;
  return hit.auto ? { kind: "favourite", id: String(hit.id), modified: false, auto: true } : { kind: "favourite", id: String(hit.id), modified: false };
}

const GENERIC_PROFILE = /^(default|advanced|custom|profile|new|untitled)$/i;

/** The name `save-recipe` gives a recipe it was given none for (`proposeRecipeName`). */
function proposeRecipeName(workflow: Record_, existing: unknown[]): string {
  const word =
    String((workflow.profile as Record_ | undefined)?.title ?? "")
      .trim()
      .split(/\s+/)[0] ?? "";
  const context = (workflow.context ?? {}) as Record_;
  const steam = (workflow.steamSettings ?? {}) as Record_;
  const hotWater = (workflow.hotWaterData ?? {}) as Record_;
  const ratio = Math.round((Number(context.targetYield) / Number(context.targetDoseWeight)) * 100) / 100;
  let drink = "Espresso";
  if (Number(steam.targetTemperature) >= 135 && Number(steam.duration) !== 0) {
    const seconds = Number(steam.duration);
    drink = seconds > 0 && seconds <= 20 ? "Flat White" : seconds > 0 && seconds <= 35 ? "Cappuccino" : "Latte";
  } else if (Number(hotWater.duration) > 0 || Number(hotWater.volume) > 0) drink = "Americano";
  else if (Number.isFinite(ratio) && ratio > 0) drink = ratio < 1.6 ? "Ristretto" : ratio <= 2.4 ? "Espresso" : "Lungo";
  const base = (GENERIC_PROFILE.test(word) ? "" : `${word} `) + drink;
  const taken = (name: string) => existing.some((other) => String(other).toLowerCase() === name.toLowerCase());
  if (!taken(base)) return base;
  const bean = String(context.coffeeName ?? "")
    .trim()
    .split(/\s+/)[0];
  const named = bean ? `${base} ${bean}` : base;
  if (!taken(named)) return named;
  let count = 2;
  while (taken(`${named} ${count}`)) count++;
  return `${named} ${count}`;
}

/** A strip slot asked for: 1 to 5, a numeric string too, else null for none (`explicitRecipeSlot` in utils/recent-favs.ts). */
function explicitRecipeSlot(requested: unknown): number | null {
  if (requested == null || requested === "") return null;
  const slot = Number(requested);
  return [1, 2, 3, 4, 5].includes(slot) ? slot : null;
}

/** A row with id `1` to `5` and no `stripSlot` key given that slot, its id kept; the list itself where none needs it (`migrateRecipeSlots`). */
export function dye2MigrateRecipeSlots(recipes: Record_[]): Record_[] {
  const legacy = (row: Record_) => row && row.stripSlot === undefined && /^[1-5]$/.test(String(row.id));
  if (!recipes.some(legacy)) return recipes;
  return recipes.map((row) => (legacy(row) ? { ...row, stripSlot: Number(row.id) } : row));
}

/** The rows that share a `stripSlot` but the newest by `capturedAt`, the larger id on a tie, taken out of it; the list itself where none share one (`dedupeRecipeSlots`). */
export function dye2DedupeRecipeSlots(recipes: Record_[]): Record_[] {
  const time = (row: Record_) => {
    const parsed = Date.parse(String(row.capturedAt));
    return Number.isFinite(parsed) ? parsed : -Infinity;
  };
  const beats = (a: Record_, b: Record_) => (time(a) !== time(b) ? time(a) > time(b) : String(a.id) > String(b.id));
  const winner = new Map<unknown, Record_>();
  for (const row of recipes) {
    if (!row || row.stripSlot == null) continue;
    const held = winner.get(row.stripSlot);
    if (!held || beats(row, held)) winner.set(row.stripSlot, row);
  }
  const loses = (row: Record_) => !!row && row.stripSlot != null && winner.get(row.stripSlot) !== row;
  if (!recipes.some(loses)) return recipes;
  return recipes.map((row) => (loses(row) ? { ...row, stripSlot: null } : row));
}

/** The rows an earlier DYE2 wrote as `suggested: true` dropped; the list itself where there are none (`dropSuggestedRecipes`). */
function dropSuggestedRecipes(recipes: Record_[]): Record_[] {
  if (!recipes.some((row) => row && row.suggested === true)) return recipes;
  return recipes.filter((row) => !(row && row.suggested === true));
}

/** The one-time healing of DYE2's recipes (`healRecipes` in plugin.ts). */
function healRecipes(rows: Record_[]): Record_[] {
  return dye2DedupeRecipeSlots(dropSuggestedRecipes(dye2MigrateRecipeSlots(rows)));
}

/** DYE2's entry in `GET /plugins`: as recorded while it was loaded (plugins.json), with v0.1.26's version and endpoints, its `loaded` and `autoLoad` set by `listing()`. */
function recordedDye2Listing(): Record_ {
  const { loaded } = dye2MainRecording<{ loaded: { listed: Record_[] } }>("plugins");
  const listed = loaded.listed[0]!;
  return { ...listed, version: DYE2_MANIFEST_VERSION, api: DYE2_ENDPOINTS.map((id) => ({ id, type: id === "changed" ? "websocket" : "http", data: {} })) };
}

/** A turn of the event loop later, as Decaid answers a storage command. */
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * DYE2 on a simulated tablet: pass it as the tablet's `dye2`. It starts as
 * `state` says, `loaded` by default, loading as the tablet starts.
 */
export class SimulatedDye2 {
  readonly id = DYE2_NAMESPACE;
  /** What DYE2 logged, as `host.log` would. */
  readonly logs: string[] = [];
  /** Each push DYE2 made on its `changed` endpoint, in order, whether or not a socket heard it. */
  readonly pushes: unknown[] = [];
  /** Each `POST .../selection` DYE2 was asked, in order, by whoever: the record id it wrote as `recipeId`, null for none. */
  readonly asked: (string | null)[] = [];
  /** Each record DYE2 wrote into a recipe (`handleRecord`), in order: its id, and the fields written. */
  readonly recorded: { id: string; patch: Record_ }[] = [];
  /** Each recipe `save-recipe` made, in order: its id, name and strip slot. */
  readonly saved: { id: string; name: string; stripSlot: number | null }[] = [];
  /** Each `recipeId` DYE2 cleared on a profile change, in order: the record id, and whether it was compared with the recipe's own profile, as after a load. */
  readonly cleared: { id: string; cold: boolean }[] = [];
  private tablet: SimulatedTablet | undefined;
  private installed: boolean;
  private loadedNow: boolean;
  private autoLoad: boolean;
  /** Each load of DYE2 is a generation, as Decaid's; work begun under one is dropped by the next. */
  private generation = 0;
  /** This load's baseline (`baseline`), what it last mirrored (`mirrored`) and its Workflow changes in turn (`chain`). */
  private baselineNow: Dye2Baseline | null = null;
  private mirrored: string | null = null;
  private chain: Promise<void> = Promise.resolve();
  /** Whether DYE2 had loaded once a tablet was attached, as one loaded as Decaid started. */
  private started = false;
  /** What DYE2 is still doing, for `settled()`. */
  private readonly pending = new Set<Promise<unknown>>();
  /** Requests to an endpoint Decaid answers 503 without reaching DYE2, and those it holds until released. */
  private readonly refused = new Map<Dye2Endpoint, number>();
  private readonly held = new Map<Dye2Endpoint, Promise<void>>();

  constructor({ state = "loaded" }: { state?: Dye2State } = {}) {
    this.installed = state !== "absent";
    this.loadedNow = state === "loaded";
    this.autoLoad = state === "loaded" || state === "unloaded";
  }

  /** The tablet DYE2 runs on; DYE2 loads on the first, as Decaid starts, and a later load of the plugin on the same tablet attaches it again, as it was. */
  attach(tablet: SimulatedTablet): void {
    this.tablet = tablet;
    if (this.started) return;
    this.started = true;
    if (this.loadedNow) {
      this.loadedNow = false;
      void this.load();
    }
  }

  /** The selection DYE2 derives from the tablet's Workflow, recipes and favourites now, as `GET .../selection` answers it while DYE2 is loaded, but for a recipe it finds only in the Shots (`resolveRecipeFromHistory`): null for none. */
  selected(): Dye2Derived | null {
    if (!this.tablet || !this.loadedNow) return null;
    return dye2DeriveSelection(this.tablet.workflow(), { recipes: asList(this.tablet.storeValue(DYE2_NAMESPACE, "recipes")), favourites: asList(this.tablet.storeValue(DYE2_NAMESPACE, "autoFavourites")) });
  }

  /** The baseline DYE2 holds in memory for the recipe the Workflow names, null for none. */
  baseline(): Dye2Baseline | null {
    return this.baselineNow ? structuredClone(this.baselineNow) : null;
  }

  /** Whether DYE2 is loaded. */
  get loaded(): boolean {
    return this.loadedNow;
  }

  /**
   * Loads DYE2, as Decaid does at start, on `POST .../enable` or on a reload
   * (`onLoad`), with no baseline: it reads its migration flags, answered in a
   * later turn, and runs each migration not done yet; refreshes its recent
   * favourites, pushing once that is done; and reads the Workflow, checking
   * the recipe it names against the recipe's own profile (`trackWorkflow(wf,
   * true)`). Resolves once all of that is done.
   */
  load(): Promise<void> {
    if (!this.installed) throw new Error("DYE2 is not installed on the tablet");
    if (this.loadedNow) this.unload();
    this.loadedNow = true;
    const generation = ++this.generation;
    this.baselineNow = null;
    this.mirrored = null;
    this.chain = Promise.resolve();
    return this.track(this.onLoad(generation));
  }

  /** Unloads DYE2, as Decaid's settings or a failed update do: its endpoints answer 404 and its baseline and pending work are dropped. Sockets open on `changed` stay open, as Decaid's do, and hear the next load's pushes. */
  unload(): void {
    this.generation++;
    this.loadedNow = false;
    this.baselineNow = null;
  }

  /** `POST .../disable`: unloads DYE2, and leaves it not to load at start (`loaded` and `autoLoad` false). */
  disable(): void {
    this.unload();
    this.autoLoad = false;
  }

  /** `POST .../enable`: DYE2 to load at start, and loaded now; resolves as `load` does. */
  async enable(): Promise<void> {
    this.autoLoad = true;
    if (!this.loadedNow) await this.load();
  }

  /** DYE2 unloaded and loaded again, as each update of it (every Decaid auto-update) or Decaid restarting does; resolves as `load` does. */
  reload(): Promise<void> {
    this.unload();
    return this.load();
  }

  /** Removes DYE2 from the tablet: Decaid lists no DYE2. */
  remove(): void {
    this.unload();
    this.installed = false;
    this.autoLoad = false;
  }

  /** Installs DYE2 and loads it; resolves as `load` does. */
  install(): Promise<void> {
    this.installed = true;
    this.autoLoad = true;
    return this.load();
  }

  /** Resolves once DYE2 has done what it does in reply to everything so far: its loads, its Workflow checks and their writes, its pushes. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /** Decaid answers the next `count` requests to that endpoint 503 without reaching DYE2, as a request it could not hand on. */
  refuse(endpoint: Dye2Endpoint, count = 1): void {
    this.refused.set(endpoint, (this.refused.get(endpoint) ?? 0) + count);
  }

  /** Holds requests to that endpoint, made from now on, before DYE2 handles them, until the function returned is called. */
  hold(endpoint: Dye2Endpoint): () => void {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.held.set(endpoint, held);
    return () => {
      if (this.held.get(endpoint) === held) this.held.delete(endpoint);
      release();
    };
  }

  /** DYE2's entry in `GET /plugins`, or undefined while it is not installed. */
  listing(): Record_ | undefined {
    return this.installed ? { ...recordedDye2Listing(), loaded: this.loadedNow, autoLoad: this.autoLoad } : undefined;
  }

  /** The type of DYE2's endpoint of that name while it is loaded, as Decaid opens a socket on it; undefined otherwise. */
  socketEndpoint(name: string): "http" | "websocket" | undefined {
    if (!this.loadedNow) return undefined;
    const api = (recordedDye2Listing().api ?? []) as { id: string; type: "http" | "websocket" }[];
    return api.find((endpoint) => endpoint.id === name)?.type;
  }

  /** Whether a route of Decaid's API is one of DYE2's endpoints, which Decaid routes to it. */
  answers(route: string): boolean {
    return route.startsWith(`/plugins/${DYE2_NAMESPACE}/`);
  }

  /**
   * What Decaid answers a request to one of DYE2's endpoints
   * (`_handlePluginApiEndpoint` in plugins_handler.dart, then DYE2's
   * `__httpRequestHandler`): 404 while DYE2 is not loaded or for an endpoint
   * it does not declare, 400 for its socket, 500 where its handler throws,
   * and its `selection`, `record`, `save-recipe`, `skin` and `recent-favs`
   * (recent favourites not simulated: `[]`) as DYE2 answers them. Its pages
   * are not simulated: use `openDye2Dashboard`, `selectRecipeInDye2` and
   * `openDye2RecipeEditor`.
   */
  async answer(method: string, route: string, body: unknown): Promise<DecaidAnswer> {
    const endpoint = decodeURIComponent(route.slice(`/plugins/${DYE2_NAMESPACE}/`.length));
    const notLoaded = { status: 404, body: { error: `plugin with ${DYE2_NAMESPACE} not loaded` } };
    if (!this.loadedNow) return notLoaded;
    const type = this.socketEndpoint(endpoint);
    if (type === undefined) return { status: 404, body: { error: `endpoint ${endpoint} not available` } };
    if (type === "websocket") return { status: 400, body: { error: `endpoint ${endpoint} is not a http type` } };
    const refused = this.refused.get(endpoint as Dye2Endpoint) ?? 0;
    if (refused > 0) {
      this.refused.set(endpoint as Dye2Endpoint, refused - 1);
      return { status: 503, body: { error: "Refused for the test" } };
    }
    await this.held.get(endpoint as Dye2Endpoint);
    const generation = this.generation;
    if (!this.loadedNow) return notLoaded;
    const handle = async (): Promise<DecaidAnswer> => {
      switch (endpoint) {
        case "skin":
          return { status: 200, body: { version: 1, surfaces: [], live: { endpoint: "changed" } } };
        case "recent-favs":
          return { status: 200, body: [] };
        case "selection":
          return this.handleSelection(method, body, generation);
        case "record":
          return this.handleRecord(generation);
        case "save-recipe":
          return this.handleSaveRecipe(body, generation);
        default:
          throw new Error(`The simulated DYE2 does not answer its ${endpoint} endpoint`);
      }
    };
    try {
      const answered = await this.track(handle());
      return generation === this.generation ? answered : notLoaded;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("The simulated DYE2")) throw error;
      return { status: 500, body: { error: String(error) } };
    }
  }

  /** Decaid tells DYE2 of a change of the Workflow (`onEvent(workflowUpdated)`): `trackWorkflow`. */
  workflowUpdated(workflow: Record_): void {
    if (this.loadedNow) this.trackWorkflow(workflow, false);
  }

  /** Decaid tells DYE2 a Shot was stored (`onEvent(shotStored)`): it refreshes its recent favourites, and pushes. */
  shotStored(): void {
    if (this.loadedNow) this.refreshRecents();
  }

  /** `onLoad`, then its storage reads answered (`onEvent(storageRead)`). */
  private async onLoad(generation: number): Promise<void> {
    this.refreshRecents();
    const cold = this.liveWorkflow().then((workflow) => {
      if (generation === this.generation) this.trackWorkflow(workflow, true);
    });
    await nextTurn();
    if (generation !== this.generation) return;
    const flag = (key: string) => this.tablet?.storeValue(DYE2_NAMESPACE, key);
    const migrations: Promise<void>[] = [];
    if (!flag("selectionMigrated")) migrations.push(this.migrate());
    if (!flag("recipesMigrated")) migrations.push(this.runMigration("recipesMigrated", () => this.migrateRecipes(), true));
    // Its favourites' slots and profiles are not simulated: their flags are written, and the slots' recent favourites refreshed.
    if (!flag("favSlotsMigrated")) migrations.push(this.runMigration("favSlotsMigrated", async () => {}, true));
    if (!flag("favProfilesMigrated")) migrations.push(this.runMigration("favProfilesMigrated", async () => {}, false));
    await Promise.all([cold, ...migrations]);
    await this.chain;
  }

  /** `migrate`: the stored selection and the Workflow's `extras.dye.selection` cleared, once. */
  private async migrate(): Promise<void> {
    const write = this.storageWrite("selection", {});
    const put = this.putWorkflow({ context: { extras: { dye: { selection: null } } } }).catch((error: unknown) => this.logs.push(`[dye2] selection migration failed: ${String(error)}`));
    await Promise.all([write, put, this.storageWrite("selectionMigrated", true)]);
  }

  /** `runRecipeMigration` and its kin: the migration, its flag written whether or not it failed, then the recent favourites refreshed where it does. */
  private async runMigration(key: string, work: () => Promise<void>, refreshes: boolean): Promise<void> {
    await work().catch((error: unknown) => this.logs.push(`[dye2] ${key} migration failed: ${String(error)}`));
    await this.storageWrite(key, true);
    if (refreshes) this.refreshRecents();
  }

  /** `migrateRecipes`: the recipes healed, read again just before the write, and written only where the fresh copy still needs it. */
  private async migrateRecipes(): Promise<void> {
    const rows = await this.kv("recipes");
    if (healRecipes(rows) === rows) return;
    const fresh = await this.kv("recipes");
    const next = healRecipes(fresh);
    if (next === fresh) return;
    const written = await this.api("POST", `/store/${DYE2_NAMESPACE}/recipes`, next);
    if (written.status !== 200) throw new Error(`HTTP ${written.status} migrating recipes`);
  }

  /** `trackWorkflow`: `workflowChanged` for the Workflow, after those before it; a failure is logged. */
  private trackWorkflow(workflow: Record_ | null, cold: boolean): void {
    const generation = this.generation;
    this.chain = this.chain
      .then(() => (generation === this.generation ? this.workflowChanged(workflow, cold, generation) : undefined))
      .catch((error: unknown) => {
        this.logs.push(`[dye2] selection sync failed: ${String(error)}`);
      });
    this.track(this.chain);
  }

  /**
   * `workflowChanged`: the id cleared where the profile moved off the
   * baseline's, or, with none and `cold`, off the recipe's own; a baseline
   * taken for an id seen first, none kept for no id; then the selection
   * mirrored.
   */
  private async workflowChanged(workflow: Record_ | null, cold: boolean, generation: number): Promise<void> {
    if (!workflow) return;
    const id = dye2RecipeIdOf(workflow);
    let recipes: Record_[] | undefined;
    if (id) {
      recipes = await this.kv("recipes");
      const recipe = await this.recipeFor(id, recipes);
      if (generation !== this.generation) return;
      const known = this.baselineNow && this.baselineNow.id === id ? this.baselineNow : null;
      if ((known || cold) && idProfileChanged(known, recipe, workflow)) {
        await this.putWorkflow({ context: { extras: { dye: { recipeId: null } } } });
        this.cleared.push({ id, cold: !known });
        return;
      }
      if (!this.baselineNow || this.baselineNow.id !== id) {
        const full = withMachineSettings(workflow, await this.readMachineSettings());
        if (generation !== this.generation) return;
        const live = ownedRecipeFields(workflow).brewC;
        this.baselineNow = {
          kind: "recipe",
          id,
          profileFingerprint: dye2ProfileFingerprint(workflow.profile),
          armedBrewC: typeof live === "number" ? live : null,
          armedBeanBatchId: null,
          armedGrinderId: null,
          armedMachine: dye2MachineFields(full),
        };
      }
    } else this.baselineNow = null;
    await this.mirror(workflow, recipes, generation);
  }

  /** `mirror`: the derived selection written to the store key `selection`, `{}` for none, and pushed, only where it or its `modified` changed since the last. */
  private async mirror(workflow: Record_, recipes: Record_[] | undefined, generation: number): Promise<void> {
    const derived = await this.derive(workflow, recipes);
    if (generation !== this.generation) return;
    const key = derived ? `${derived.kind}:${derived.id}:${String(derived.modified)}` : null;
    if (key === this.mirrored) return;
    this.mirrored = key;
    void this.storageWrite("selection", derived ?? {});
    this.announce();
  }

  /** `derive`: the selection derived from the Workflow, the recipes (read unless given), the favourites, and the Shot carrying an id no row has. */
  private async derive(workflow: Record_, known?: Record_[]): Promise<Dye2Derived | null> {
    const [recipes, favourites] = await Promise.all([known ?? this.kv("recipes"), this.kv("autoFavourites")]);
    const history = await this.recipeFor(dye2RecipeIdOf(workflow), recipes);
    return dye2DeriveSelection(workflow, { recipes: history ? [...recipes, history] : recipes, favourites });
  }

  /** `recipeFor`: the row with that id, else the newest of the latest 50 Shots carrying it as a stand-in (`resolveRecipeFromHistory`), else null. */
  private async recipeFor(id: string | null, recipes: Record_[]): Promise<Record_ | null> {
    if (!id) return null;
    const row = recipes.find((recipe) => recipe && String(recipe.id) === id);
    if (row) return row;
    try {
      const { status, body } = await this.api("GET", "/shots?limit=50&order=desc");
      if (status !== 200) return null;
      const items = (Array.isArray(body) ? body : ((body as Record_ | null)?.items ?? [])) as Record_[];
      const shot = items.find((item) => item && dye2RecipeIdOf(item.workflow) === id);
      return shot ? { id, dashboardVariables: dye2RecipeFields(shot.workflow as Record_), workflow: shot.workflow } : null;
    } catch {
      return null;
    }
  }

  /** `handleSelection`: GET the derived selection, null for none; POST writes the body's recipe id as `recipeId`, null for anything but a recipe, then answers the same. */
  private async handleSelection(method: string, body: unknown, generation: number): Promise<DecaidAnswer> {
    if (method !== "GET") {
      const asked = (body ?? null) as Record_ | null;
      const id = asked && asked.kind === "recipe" && asked.id != null ? String(asked.id) : null;
      this.asked.push(id);
      await this.putWorkflow({ context: { extras: { dye: { recipeId: id } } } });
    }
    const workflow = await this.liveWorkflow();
    if (generation !== this.generation) return { status: 200, body: null };
    return { status: 200, body: workflow ? await this.derive(workflow) : null };
  }

  /**
   * `handleRecord`: with a recipe selected, the Workflow, the DE1's flush
   * pair over it, written into it against the baseline for its id, or an
   * empty one (`recordWorkflow`); a push and the selection mirrored again
   * where it wrote. Answers `{saved, kind, id}`, `{saved:false, reason}`
   * with nothing selected but a favourite or nothing, 502 where the Workflow
   * or a list could not be read or written.
   */
  private async handleRecord(generation: number): Promise<DecaidAnswer> {
    let workflow = await this.liveWorkflow();
    if (!workflow) return { status: 502, body: { saved: false, reason: "could not read the workflow" } };
    const derived = await this.derive(workflow);
    if (!derived || derived.kind !== "recipe") return { status: 200, body: { saved: false, reason: "no recipe is selected" } };
    workflow = withMachineSettings(workflow, await this.readMachineSettings());
    try {
      const armed = this.baselineNow && this.baselineNow.id === derived.id ? this.baselineNow : null;
      const wrote = await this.recordWorkflow(workflow, armed ?? { ...EMPTY_BASELINE, id: derived.id });
      if (wrote && generation === this.generation) {
        this.announce();
        await this.mirror(workflow, undefined, generation).catch((error: unknown) => this.logs.push(`[dye2] mirror after record failed: ${String(error)}`));
      }
      return { status: 200, body: { saved: wrote, kind: derived.kind, id: derived.id } };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logs.push(`[dye2] record failed: ${reason}`);
      return { status: 502, body: { saved: false, reason } };
    }
  }

  /**
   * `recordWorkflow`: reads the recipes again, writes the recipe's changed
   * fields (`itemPatch`), keeping its embedded `workflow` in step (its
   * context's dose, yield, grind, RPM and Basket, its machine settings, and
   * its profile at a recorded brew temperature), and rebases `armedBrewC` on
   * the Workflow. The DE1's flush pair is read again where the recipe holds
   * one or the baseline has one. Resolves with whether it wrote.
   */
  private async recordWorkflow(workflow: Record_, armed: Dye2Baseline): Promise<boolean> {
    const { key, field } = DYE2_TARGETS.recipe;
    const route = `/store/${DYE2_NAMESPACE}/${key}`;
    const read = await this.api("GET", route);
    if (read.status !== 200) throw new Error(`HTTP ${read.status} reading ${key}`);
    const list = asList(read.body);
    const index = list.findIndex((item) => item && String(item.id) === armed.id);
    if (index === -1) return false;
    const item = list[index]!;
    const stored = (item[field] ?? {}) as Record_;
    const wantsDe1 = Object.keys(DE1_ONLY).some((name) => stored[name] != null || (armed.armedMachine && armed.armedMachine[name] !== undefined));
    const full = wantsDe1 ? withMachineSettings(workflow, await this.readMachineSettings()) : workflow;
    const patch = dye2ItemPatch("recipe", item, full, armed.armedBrewC, armed.armedMachine);
    const live = dye2RecipeFields(workflow).brewC;
    armed.armedBrewC = typeof live === "number" ? live : null;
    if (Object.keys(patch).length === 0) return false;
    const next: Record_ = { ...item, [field]: { ...stored, ...patch } };
    const embedded = item.workflow as Record_ | undefined;
    if (embedded?.context) {
      const context: Record_ = { ...(embedded.context as Record_) };
      if ("dose" in patch) context.targetDoseWeight = patch.dose;
      if ("drink" in patch) context.targetYield = patch.drink;
      const grind = "grind" in patch ? patch.grind : patch.grindSetting;
      if (grind !== undefined) context.grinderSetting = String(grind);
      for (const name of ["rpm", "basketId", "basketName"]) if (name in patch) context.extras = { ...((context.extras ?? {}) as Record_), [name]: patch[name] };
      next.workflow = { ...embedded, context };
    }
    if (next.workflow) {
      for (const [name, [part, partField]] of Object.entries(MACHINE_MAP)) {
        if (!(name in patch)) continue;
        const current = next.workflow as Record_;
        next.workflow = { ...current, [part]: { ...((current[part] ?? {}) as Record_), [partField]: patch[name] } };
      }
    }
    if ("brewC" in patch && next.workflow) {
      const shifted = profileAtBrewC((next.workflow as Record_).profile as Record_ | undefined, patch.brewC);
      if (shifted) next.workflow = { ...(next.workflow as Record_), profile: shifted };
    }
    const written = await this.api("POST", route, list.map((kept, at) => (at === index ? next : kept)));
    if (written.status !== 200) throw new Error(`HTTP ${written.status} writing ${key}`);
    this.recorded.push({ id: armed.id, patch });
    return true;
  }

  /**
   * `handleSaveRecipe`: a recipe made of the Workflow, the DE1's flush pair
   * over it, under a new `recipe-…` id, named as the body names it or as
   * `proposeRecipeName` does, its `stripSlot` the body's valid `slot` or
   * null, the slot's previous holder kept with `stripSlot: null`; appended to
   * the recipes, then its id written as `recipeId` and a push. Answers `{id,
   * name}`, 502 `{error}` where a read or write failed.
   */
  private async handleSaveRecipe(body: unknown, generation: number): Promise<DecaidAnswer> {
    let workflow = await this.liveWorkflow();
    if (!workflow) return { status: 502, body: { error: "could not read the workflow" } };
    try {
      const recipes = await this.kv("recipes");
      const asked = (body ?? null) as Record_ | null;
      const context = (workflow.context ?? {}) as Record_;
      const name =
        (asked && typeof asked.name === "string" && asked.name.trim()) ||
        proposeRecipeName(
          workflow,
          recipes.map((recipe) => recipe && (recipe.name || recipe.title)),
        );
      const stripSlot = explicitRecipeSlot(asked?.slot);
      const id = `recipe-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      workflow = withMachineSettings(workflow, await this.readMachineSettings());
      // Its own markDye: recipeId and selection stay out.
      const { dye: _, ...extras } = (context.extras ?? {}) as Record_;
      const flags: Record_ = {};
      for (const key of [...DYE_TOP_KEYS, ...DYE_EXTRAS_KEYS]) {
        const value = DYE_TOP_KEYS.includes(key) ? context[key] : extras[key];
        if (value !== undefined) flags[key] = value === null ? null : true;
      }
      if (Object.keys(flags).length > 0) extras.dye = { v: 1, ...flags };
      const dashboardVariables = ownedRecipeFields(workflow);
      if (context.grinderId) {
        dashboardVariables.grinderId = context.grinderId;
        dashboardVariables.grinderModel = context.grinderModel;
      }
      const profile = workflow.profile as Record_ | undefined;
      const row: Record_ = JSON.parse(
        JSON.stringify({
          id,
          stripSlot,
          name,
          title: name,
          barista: context.baristaName,
          drinker: context.drinkerName,
          beanName: context.coffeeName,
          beanRoaster: context.coffeeRoaster,
          beanBatchId: context.beanBatchId,
          profileTitle: profile?.title,
          profileSnapshot: workflow.profile,
          dashboardVariables,
          workflow: { context: { ...context, extras }, profile: workflow.profile, steamSettings: workflow.steamSettings, hotWaterData: workflow.hotWaterData, rinseData: workflow.rinseData },
          capturedAt: new Date().toISOString(),
        }),
      ) as Record_;
      const list = recipes.map((recipe) => (stripSlot != null && recipe && recipe.stripSlot === stripSlot ? { ...recipe, stripSlot: null } : recipe));
      const written = await this.api("POST", `/store/${DYE2_NAMESPACE}/recipes`, [...list, row]);
      if (written.status !== 200) throw new Error(`HTTP ${written.status} writing recipes`);
      this.saved.push({ id, name, stripSlot });
      await this.putWorkflow({ context: { extras: { dye: { v: 1, recipeId: id } } } });
      if (generation === this.generation) this.announce();
      return { status: 200, body: { id, name } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logs.push(`[dye2] save-recipe failed: ${message}`);
      return { status: 502, body: { error: message } };
    }
  }

  /** `refreshRecents`: the recent favourites recomputed in later turns, then a push. Recent favourites themselves are not simulated. */
  private refreshRecents(): void {
    const generation = this.generation;
    this.track(
      nextTurn()
        .then(nextTurn)
        .then(() => {
          if (generation === this.generation && this.loadedNow) this.announce();
        }),
    );
  }

  /** `announce`: a push of `{"what":"workflow"}` on DYE2's `changed` endpoint. */
  private announce(): void {
    const payload = { what: "workflow" };
    this.pushes.push(payload);
    this.tablet?.pushOnSocket(DYE2_NAMESPACE, "changed", payload);
  }

  /** `kv`: one of DYE2's lists, anything but an array, or a failed read, as empty. */
  private async kv(key: string): Promise<Record_[]> {
    const { status, body } = await this.api("GET", `/store/${DYE2_NAMESPACE}/${key}`);
    return status === 200 ? asList(body) : [];
  }

  /** `host.storage` writing one of DYE2's keys. */
  private async storageWrite(key: string, data: unknown): Promise<void> {
    await this.api("POST", `/store/${DYE2_NAMESPACE}/${key}`, data);
  }

  /** `putWorkflow`: a `PUT /workflow`, throwing on anything but 200. */
  private async putWorkflow(body: Record_): Promise<void> {
    const { status } = await this.api("PUT", "/workflow", body);
    if (status !== 200) throw new Error(`HTTP ${status} writing workflow`);
  }

  /** `liveWorkflow`: `GET /workflow`, or null on any failure. */
  private async liveWorkflow(): Promise<Record_ | null> {
    try {
      const { status, body } = await this.api("GET", "/workflow");
      return status === 200 ? (body as Record_) : null;
    } catch (error) {
      this.logs.push(`[dye2] could not read workflow: ${String(error)}`);
      return null;
    }
  }

  /** `readMachineSettings`: `GET /machine/settings`, or null on any failure. */
  private async readMachineSettings(): Promise<Record_ | null> {
    try {
      const { status, body } = await this.api("GET", "/machine/settings");
      return status === 200 && body && typeof body === "object" ? (body as Record_) : null;
    } catch {
      return null;
    }
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    void work.catch(() => {}).finally(() => this.pending.delete(work));
    return work;
  }

  private api(method: "GET" | "POST" | "PUT" | "DELETE", route: string, body?: unknown): Promise<DecaidAnswer> {
    if (!this.tablet) throw new Error("DYE2 is attached to no tablet");
    return this.tablet.callApi(method, route, body);
  }
}

// ---- DYE2's pages (dye2:dye2-plugin/src/pages/dashboard.ts, select-recipe.ts and recipe-edit.ts, and their
// utils/dev-api.ts, at v0.1.26).

/** The context fields DYE2 flags for Streamline (`DYE_TOP_KEYS`, `DYE_EXTRAS_KEYS` in dev-api.ts). */
const DYE_TOP_KEYS = ["beanBatchId", "coffeeName", "coffeeRoaster", "grinderId", "grinderModel", "baristaName", "drinkerName"];
const DYE_EXTRAS_KEYS = ["basketId", "basketName", "rpm", "note"];

/**
 * `markDye` in dev-api.ts: flags in `context.extras.dye` each of `keys` the
 * context holds, true, or null where it holds null; with no `keys`, every
 * field it knows. Changes the context given, and gives it.
 */
export function markDye(context: Record_, keys?: string[]): Record_ {
  const extras = (context.extras ?? {}) as Record_;
  const flags: Record_ = {};
  for (const key of keys ?? [...DYE_TOP_KEYS, ...DYE_EXTRAS_KEYS]) {
    const value = DYE_EXTRAS_KEYS.includes(key) ? extras[key] : context[key];
    if (value !== undefined) flags[key] = value === null ? null : true;
  }
  if (Object.keys(flags).length > 0) context.extras = { ...extras, dye: { ...((extras.dye ?? {}) as Record_), v: 1, ...flags } };
  return context;
}

/** `setRecipeId` in dashboard.ts: the recipe id written into the context's `extras.dye`, null for none. Changes the context given. */
function setRecipeId(context: Record_, id: unknown): void {
  const extras = (context.extras ?? {}) as Record_;
  context.extras = { ...extras, dye: { ...((extras.dye ?? {}) as Record_), v: 1, recipeId: id == null ? null : String(id) } };
}

/** The machine settings a recipe holds, as the Workflow's partial parts (`recipeMachineSettings` in dev-api.ts). */
function recipeMachineSettings(dv: Record_): Record<string, Record_> {
  const out: Record<string, Record_> = {};
  for (const [name, [part, field]] of Object.entries(MACHINE_MAP)) if (dv[name] != null) (out[part] ??= {})[field] = dv[name];
  return out;
}

/** A copy of the profile with its first step at `first` and the others moved by as much, each at `first` with no first step to move from (`profileAtBrewTemp` in dev-api.ts). */
function profileAtBrewTemp(profile: Record_, first: unknown): Record_ {
  if (!profile || !Array.isArray(profile.steps)) return profile;
  const target = Number(first);
  if (!Number.isFinite(target)) return profile;
  const steps = profile.steps as Record_[];
  const round = (value: number) => Math.round(value * 100) / 100;
  const origin = steps[0]?.temperature;
  const temperatures =
    steps.length > 0 && typeof origin === "number" && Number.isFinite(origin)
      ? steps.map(({ temperature }) => (typeof temperature === "number" && Number.isFinite(temperature) ? round(temperature + target - origin) : round(target)))
      : steps.map(() => target);
  return { ...profile, steps: steps.map((step, index) => ({ ...step, temperature: temperatures[index] })) };
}

/** A stored profile worth applying: one with steps (`usableProfileSnapshot` in dev-api.ts). */
function usableProfileSnapshot(profile: unknown): profile is Record_ {
  return !!profile && Array.isArray((profile as Record_).steps) && ((profile as Record_).steps as unknown[]).length > 0;
}

/** A profile record's profile, of the tablet's profiles, hidden ones included, by id; null where none (`resolveFullProfileById` in dev-api.ts). */
async function resolveFullProfileById(tablet: SimulatedTablet, id: unknown): Promise<Record_ | null> {
  if (!id) return null;
  const { status, body } = await tablet.callApi("GET", "/profiles?includeHidden=true");
  const record = status === 200 ? asList(body).find((candidate) => candidate && candidate.id === id) : undefined;
  return (record?.profile as Record_ | undefined) ?? null;
}

/**
 * The ready-to-PUT Workflow a recipe embeds (`buildRecipeWorkflow` in
 * dev-api.ts): its dose, yield, grind, RPM, Grinder, Basket, Bean (its
 * coffee, roaster and batch, null for those it lacks), barista and drinker,
 * flagged (`markDye`), its Profile, from its snapshot where that has steps
 * and otherwise the tablet's record of its id, at its brew temperature, and
 * the machine settings it holds.
 */
async function buildRecipeWorkflow(tablet: SimulatedTablet, recipe: Record_): Promise<Record_> {
  const dv = (recipe.dashboardVariables ?? {}) as Record_;
  const context: Record_ = {};
  const workflow: Record_ = { context };
  if (dv.dose != null) context.targetDoseWeight = dv.dose;
  if (dv.drink != null) context.targetYield = dv.drink;
  else if (dv.ratio != null && dv.dose != null) context.targetYield = Math.round((dv.dose as number) * (dv.ratio as number) * 10) / 10;
  if (dv.grind != null) context.grinderSetting = String(dv.grind);
  if (dv.rpm != null) context.extras = { ...((context.extras ?? {}) as Record_), rpm: dv.rpm };
  if (dv.grinderId) context.grinderId = dv.grinderId;
  if (dv.grinderModel) context.grinderModel = dv.grinderModel;
  if (dv.basketId) context.extras = { ...((context.extras ?? {}) as Record_), basketId: dv.basketId };
  if (dv.basketName) context.extras = { ...((context.extras ?? {}) as Record_), basketName: dv.basketName };
  if (recipe.beanId || recipe.beanName) {
    context.coffeeName = recipe.beanName || null;
    context.coffeeRoaster = recipe.beanRoaster || null;
    context.beanBatchId = recipe.beanBatchId || null;
  }
  if (recipe.barista) context.baristaName = recipe.barista;
  if (recipe.drinker) context.drinkerName = recipe.drinker;
  if (recipe.profileId || recipe.profileTitle) {
    if (usableProfileSnapshot(recipe.profileSnapshot)) workflow.profile = recipe.profileSnapshot;
    else {
      const full = await resolveFullProfileById(tablet, recipe.profileId);
      if (full) workflow.profile = full;
    }
  }
  if (dv.brewC != null && workflow.profile) workflow.profile = profileAtBrewTemp(workflow.profile as Record_, dv.brewC);
  Object.assign(workflow, recipeMachineSettings(dv));
  markDye(context);
  return workflow;
}

/** `kvUpsert` in dev-api.ts: the item laid over the list's item with its id, or appended. Changes the list. */
function kvUpsert(list: Record_[], item: Record_): Record_[] {
  const index = list.findIndex((kept) => kept && kept.id === item.id);
  if (index >= 0) list[index] = { ...list[index], ...item };
  else list.push(item);
  return list;
}

/** `takeSlot` in dev-api.ts: the slot the item takes freed on every other item holding it. Changes the list's items. */
function takeSlot(list: Record_[], field: string, item: Record_): void {
  if (item[field] == null) return;
  for (const kept of list) if (kept && kept.id !== item.id && kept[field] === item[field]) kept[field] = null;
}

/**
 * `recipeChanges` in dev-api.ts: the fields of the form's data that differ
 * from the record as the editor read it, compared as JSON with null and
 * undefined alike, `dashboardVariables` key by key, an undefined value
 * written as null.
 */
function recipeChanges(base: Record_, data: Record_): Record_ {
  const same = (a: unknown, b: unknown) => JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b);
  const diff = (from: Record_ | undefined, to: Record_ | undefined) => {
    const out: Record_ = {};
    for (const key of Object.keys(to ?? {})) if (!same((from ?? {})[key], to![key])) out[key] = to![key] === undefined ? null : to![key];
    return out;
  };
  const { dashboardVariables, ...rest } = data;
  const patch = diff(base, rest);
  const dv = diff(base.dashboardVariables as Record_ | undefined, dashboardVariables as Record_ | undefined);
  if (Object.keys(dv).length > 0) patch.dashboardVariables = dv;
  return patch;
}

/**
 * `updateRecipe` in dev-api.ts: the patch laid over the recipe read afresh
 * (dye2#28), `capturedAt` now, `stripSlot` null for a new row given none,
 * `dashboardVariables` merged, `title` and `subtitle` and the embedded
 * `workflow` derived from the result; upserted, the slot it takes freed on
 * its previous holder (`takeSlot`), and the list posted. Resolves with the
 * recipe saved.
 */
async function updateRecipe(tablet: SimulatedTablet, id: string, patch: Record_): Promise<Record_> {
  const route = `/store/${DYE2_NAMESPACE}/recipes`;
  const read = await tablet.callApi("GET", route);
  if (read.status !== 200 && read.status !== 404) throw new Error(`HTTP ${read.status}`);
  const list = read.status === 200 ? asList(read.body) : [];
  const fresh = list.find((item) => item && item.id === id) ?? {};
  const { dashboardVariables, ...rest } = patch;
  const item: Record_ = { ...fresh, ...rest, id, capturedAt: new Date().toISOString() };
  if (!fresh.id && item.stripSlot === undefined) item.stripSlot = null;
  if (dashboardVariables) item.dashboardVariables = { ...((fresh.dashboardVariables ?? {}) as Record_), ...(dashboardVariables as Record_) };
  item.title = item.name || "Recipe";
  item.subtitle = item.beanName || item.beverage || "";
  item.workflow = await buildRecipeWorkflow(tablet, item);
  kvUpsert(list, item);
  takeSlot(list, "stripSlot", item);
  const written = await tablet.callApi("POST", route, JSON.parse(JSON.stringify(list)));
  if (written.status !== 200) throw new Error(`HTTP ${written.status}`);
  return JSON.parse(JSON.stringify(item)) as Record_;
}

/**
 * `workflowPatch` in dashboard.ts: the parts of `current` that differ from
 * `base`, plain objects compared key by key, anything else as JSON, an
 * undefined value left out and a null kept (dye2#31).
 */
function workflowPatch(base: unknown, current: unknown): Record_ {
  const object = (value: unknown): value is Record_ => !!value && typeof value === "object" && !Array.isArray(value);
  const out: Record_ = {};
  for (const key of Object.keys((current ?? {}) as Record_)) {
    const from = ((base ?? {}) as Record_)[key];
    const to = (current as Record_)[key];
    if (to === undefined) continue;
    if (object(from) && object(to)) {
      const sub = workflowPatch(from, to);
      if (Object.keys(sub).length > 0) out[key] = sub;
    } else if (JSON.stringify(from) !== JSON.stringify(to)) out[key] = to;
  }
  return out;
}

/** What a recipe or favourite applied on DYE2's dashboard sent: Decaid's answer to its `PUT /workflow`, undefined where it had nothing to send. */
export interface Dye2Applied {
  workflow?: DecaidAnswer;
}

/** What opens DYE2's dashboard: nothing, or a return from its Select Recipe page with a recipe confirmed, or from its Auto Favourites page with a favourite. */
export interface Dye2DashboardOpening {
  selectedRecipeId?: string;
  selectedFavouriteId?: string;
}

/**
 * DYE2's dashboard page opened on the tablet (`initializeDyeDashboard`): it
 * reads the Workflow, which it keeps as its copy and as the base its sends
 * are made against (`baseWorkflow`), the grinders, the recipes and the
 * favourites once, as it opens. Opened on a return from Select Recipe or
 * Auto Favourites, it applies the item confirmed there, of the lists it
 * read, over that copy, and sends it (`applied`). Then it reads DYE2's
 * derived selection, which its pills mark. Each send is only what the page
 * changed against its base (`pushWorkflow`, `workflowPatch`, dye2#31),
 * without `extras.dye.selection` (`updateWorkflow` in dev-api.ts); the base
 * moves on only once Decaid took it.
 */
export async function openDye2Dashboard(tablet: SimulatedTablet, opening: Dye2DashboardOpening = {}): Promise<Dye2Dashboard> {
  const read = async (route: string) => {
    const { status, body } = await tablet.callApi("GET", route);
    return status === 200 ? body : null;
  };
  const [workflow, grinders, recipes, favourites] = await Promise.all([read("/workflow"), read("/grinders"), read(`/store/${DYE2_NAMESPACE}/recipes`), read(`/store/${DYE2_NAMESPACE}/autoFavourites`)]);
  const page = new Dye2Dashboard(tablet, (workflow ?? null) as Record_ | null, asList(grinders), asList(recipes), asList(favourites));
  if (opening.selectedFavouriteId) {
    const favourite = page.favourites.find((candidate) => candidate && candidate.id === opening.selectedFavouriteId);
    if (favourite) {
      await page.applyFavouriteToCopy(favourite);
      page.applied = await page.pushWorkflow();
    }
  }
  if (opening.selectedRecipeId) {
    const picked = page.recipes.find((candidate) => candidate && candidate.id === opening.selectedRecipeId);
    if (picked) {
      await page.applyRecipeToCopy(picked);
      page.applied = await page.pushWorkflow();
    }
  }
  await page.refreshDerivedSelection();
  return page;
}

/**
 * DYE2's Select Recipe page (select-recipe.ts): it reads every recipe, in a
 * slot or not, and on CONFIRM of the one with that record id opens the
 * dashboard, which applies it as it opens (`dye_selectedRecipeId`).
 * Resolves with the dashboard, its `applied` the apply's answer.
 */
export async function selectRecipeInDye2(tablet: SimulatedTablet, recordId: string): Promise<Dye2Dashboard> {
  const { status, body } = await tablet.callApi("GET", `/store/${DYE2_NAMESPACE}/recipes`);
  const recipes = status === 200 ? asList(body).filter((recipe) => recipe && recipe.id) : [];
  await tablet.callApi("GET", `/store/${DYE2_NAMESPACE}/shotIndex`);
  if (!recipes.some((recipe) => recipe.id === recordId)) throw new Error(`DYE2's Select Recipe page lists no recipe ${recordId}`);
  return openDye2Dashboard(tablet, { selectedRecipeId: recordId });
}

export class Dye2Dashboard {
  /** The body of the page's last `PUT /workflow`. */
  lastSent: Record_ | undefined;
  /** What the apply the page opened with sent, if it opened with one. */
  applied: Dye2Applied | undefined;
  /** The page's base for what it sends (`baseWorkflow`): the Workflow as last read or sent. */
  private base: Record_ | null;
  /** The tablet's profiles, read on the first apply that needs one (`resolveFullProfile`). */
  private profiles: Record_[] = [];
  /** DYE2's derived selection, as the page last read it (`derivedSel`). */
  private derived: Dye2Derived | null = null;

  constructor(
    private readonly tablet: SimulatedTablet,
    /** The page's copy of the Workflow (`currentWorkflow`), null if its read failed. */
    public workflow: Record_ | null,
    private readonly grinders: Record_[],
    /** The recipes the page read as it opened. */
    readonly recipes: Record_[],
    /** The favourites the page read as it opened, saved and recent. */
    readonly favourites: Record_[],
  ) {
    this.base = workflow ? structuredClone(workflow) : null;
  }

  /**
   * The recipes the page shows as pills, in order (`renderRecipePills`): the
   * recipe DYE2's derived selection names where it is in no slot, then the
   * recipes in a slot and shown on Streamline's dashboard, by slot. Recent
   * favourites come before the recipes but are not listed here.
   */
  recipePills(): Record_[] {
    const selected = this.derived && this.derived.kind === "recipe" ? String(this.derived.id) : null;
    const slotless = selected ? this.recipes.find((recipe) => recipe && String(recipe.id) === selected && recipe.stripSlot == null) : undefined;
    const slotted = this.recipes.filter((recipe) => recipe && recipe.stripSlot != null && recipe.showOnStreamlineDashboard !== false).sort((a, b) => Number(a.stripSlot) - Number(b.stripSlot));
    return [...(slotless ? [slotless] : []), ...slotted];
  }

  /**
   * Taps the pill of the recipe with that record id (`renderRecipePills`'s
   * click): the page reads the Workflow again unless it holds a change not
   * sent (`refreshWorkflow`), reads the recipe again, falling back on the one
   * it read (dye2#28), applies it to its copy (`applyRecipeToCopy`) and sends
   * what changed. Throws where the page shows no such pill: apply one in no
   * slot through `selectRecipeInDye2`.
   */
  async applyRecipe(recordId: string): Promise<Dye2Applied> {
    const item = this.recipePills().find((recipe) => recipe.id === recordId);
    if (!item) throw new Error(`DYE2's dashboard shows no pill of recipe ${recordId}: apply it through selectRecipeInDye2`);
    await this.refreshWorkflow();
    const reread = await this.tablet.callApi("GET", `/store/${DYE2_NAMESPACE}/recipes`);
    const fresh = (reread.status === 200 ? asList(reread.body).find((candidate) => candidate && candidate.id === item.id) : undefined) ?? item;
    await this.applyRecipeToCopy(fresh);
    return this.pushWorkflow();
  }

  /**
   * Applies a favourite as a tap of a recent one's pill does: the Workflow
   * read again unless a change is not sent, the favourite applied to the copy
   * (`applyFavouriteToCopy`), `recipeId` cleared, and what changed sent. A
   * saved favourite is applied as the page opens: `openDye2Dashboard(tablet,
   * { selectedFavouriteId })`.
   */
  async applyFavourite(favourite: Record_): Promise<Dye2Applied> {
    await this.refreshWorkflow();
    await this.applyFavouriteToCopy(favourite);
    return this.pushWorkflow();
  }

  /**
   * A barista's change on one of the page's dials (`setupDoseControls`),
   * once its 500 ms wait is over: the value put into the copy, the grind as
   * text and the RPM in `extras`, flagged (`markDye`), and what changed sent.
   */
  async tap(dial: "dose" | "drink" | "grind" | "rpm", value: number): Promise<DecaidAnswer | undefined> {
    if (!this.workflow) throw new Error("The dashboard read no Workflow");
    const context = (this.workflow.context ??= {}) as Record_;
    if (dial === "dose") context.targetDoseWeight = value;
    if (dial === "drink") context.targetYield = value;
    if (dial === "grind") context.grinderSetting = String(value);
    if (dial === "rpm") {
      context.extras = { ...((context.extras ?? {}) as Record_), rpm: value };
      markDye(context, ["rpm"]);
    }
    return (await this.pushWorkflow()).workflow;
  }

  /**
   * The Clear button (`setupBottomButtons`): the copy's dose, Bean, batch,
   * Grinder, grind, barista, drinker, Basket, RPM and note set to null and
   * their flags with them, the yield kept, nothing sent until Done.
   */
  clear(): void {
    if (!this.workflow) return;
    this.workflow.context = markDye({
      targetDoseWeight: null,
      beanBatchId: null,
      coffeeName: null,
      coffeeRoaster: null,
      grinderId: null,
      grinderModel: null,
      grinderSetting: null,
      baristaName: null,
      drinkerName: null,
      extras: { basketId: null, basketName: null, rpm: null, note: null },
    });
  }

  /** Done (`setupBottomButtons`): what changed sent, as the page leaves; undefined if nothing had. */
  async done(): Promise<DecaidAnswer | undefined> {
    return this.workflow ? (await this.pushWorkflow()).workflow : undefined;
  }

  /** `refreshDerivedSelection`: DYE2's derived selection read, which the pills mark. */
  async refreshDerivedSelection(): Promise<void> {
    const { status, body } = await this.tablet.callApi("GET", `/plugins/${DYE2_NAMESPACE}/selection`);
    const derived = status === 200 ? (body as Dye2Derived | null) : null;
    this.derived = derived && derived.kind ? derived : null;
  }

  /**
   * `applyRecipe` in dashboard.ts, on the page's copy: its dose, yield (or
   * its dose times its ratio), grind setting, RPM, Grinder where the page's
   * grinders hold it, its Bean's coffee, roaster and batch where it names a
   * Bean, null for those it lacks, its barista and drinker where it names
   * one, flagging each in `extras.dye` (`markDye`), its record id as
   * `recipeId` (`setRecipeId`), its Profile, whole from its
   * `profileSnapshot` where that has steps and otherwise from the tablet's
   * profiles, left as it is where neither has it, at its brew temperature,
   * and every machine setting it holds, laid over the copy's parts.
   */
  async applyRecipeToCopy(recipe: Record_): Promise<void> {
    const live = (this.workflow ??= {});
    const dv = (recipe.dashboardVariables ?? {}) as Record_;
    const context: Record_ = { ...((live.context ?? {}) as Record_) };
    const wrote: string[] = [];
    if (dv.dose != null) context.targetDoseWeight = dv.dose;
    if (dv.drink != null) context.targetYield = dv.drink;
    else if (dv.ratio != null && dv.dose != null) context.targetYield = Math.round((dv.dose as number) * (dv.ratio as number) * 10) / 10;
    if (dv.grind != null) context.grinderSetting = dv.grind;
    if (dv.rpm != null) {
      context.extras = { ...((context.extras ?? {}) as Record_), rpm: dv.rpm };
      wrote.push("rpm");
    }
    const grinder = dv.grinderId ? this.grinders.find((candidate) => candidate.id === dv.grinderId) : undefined;
    if (grinder) {
      Object.assign(context, { grinderId: grinder.id, grinderModel: grinder.model || grinder.name });
      wrote.push("grinderId", "grinderModel");
    }
    if (recipe.beanId || recipe.beanName) {
      Object.assign(context, { coffeeName: recipe.beanName || null, coffeeRoaster: recipe.beanRoaster || null, beanBatchId: recipe.beanBatchId || null });
      wrote.push("coffeeName", "coffeeRoaster", "beanBatchId");
    }
    if (recipe.barista) {
      context.baristaName = recipe.barista;
      wrote.push("baristaName");
    }
    if (recipe.drinker) {
      context.drinkerName = recipe.drinker;
      wrote.push("drinkerName");
    }
    markDye(context, wrote);
    setRecipeId(context, recipe.id);
    live.context = context;
    if (recipe.profileId || recipe.profileTitle) {
      if (usableProfileSnapshot(recipe.profileSnapshot)) live.profile = recipe.profileSnapshot;
      else {
        const full = await this.resolveFullProfile(recipe.profileId);
        if (full) live.profile = full;
      }
    }
    if (dv.brewC != null && live.profile) live.profile = profileAtBrewTemp(live.profile as Record_, dv.brewC);
    for (const [part, values] of Object.entries(recipeMachineSettings(dv))) if (live[part]) live[part] = { ...(live[part] as Record_), ...values };
  }

  /**
   * `applyAutoFavourite` in dashboard.ts, on the page's copy: its `snapshot`
   * put in as its `copyMask` allows, a recent one's own Bean and Grinder
   * outright, flagging what it wrote (`markDye`), `recipeId` set to null, and
   * its Profile, a recent one's recorded Profile over it.
   */
  async applyFavouriteToCopy(favourite: Record_): Promise<void> {
    const live = (this.workflow ??= {});
    const snapshot = (favourite.snapshot ?? {}) as Record_;
    const mask = (favourite.copyMask ?? {}) as Record_;
    const on = (key: string) => mask[key] !== false;
    const context: Record_ = { ...((live.context ?? {}) as Record_) };
    const wrote: string[] = [];
    const extras = () => (context.extras ?? {}) as Record_;
    const set = (key: string, value: unknown) => {
      context[key] = value;
      wrote.push(key);
    };
    if (on("dose") && snapshot.dose != null) context.targetDoseWeight = snapshot.dose;
    if (on("drink") && snapshot.drink != null) context.targetYield = snapshot.drink;
    if (on("grindSetting")) {
      if (snapshot.grindSetting != null) context.grinderSetting = String(snapshot.grindSetting);
      if (snapshot.rpm != null) {
        context.extras = { ...extras(), rpm: snapshot.rpm };
        wrote.push("rpm");
      }
    }
    if (on("grinder")) {
      if (snapshot.grinderId) set("grinderId", snapshot.grinderId);
      if (snapshot.grinderModel) set("grinderModel", snapshot.grinderModel);
    }
    if (on("beans")) {
      if (snapshot.beanBatchId) set("beanBatchId", snapshot.beanBatchId);
      if (snapshot.coffeeName) set("coffeeName", snapshot.coffeeName);
      if (snapshot.coffeeRoaster) set("coffeeRoaster", snapshot.coffeeRoaster);
    }
    if (on("roastDate") && snapshot.roastDate) context.roastDate = snapshot.roastDate;
    if (on("barista") && snapshot.barista) set("baristaName", snapshot.barista);
    if (on("drinker") && snapshot.drinker) set("drinkerName", snapshot.drinker);
    if (on("note") && snapshot.note) {
      context.extras = { ...extras(), note: snapshot.note };
      wrote.push("note");
    }
    const recorded = (favourite.workflow ?? undefined) as Record_ | undefined;
    if (favourite.auto && recorded?.context) {
      const own = recorded.context as Record_;
      if (on("beans")) for (const key of ["beanBatchId", "coffeeName", "coffeeRoaster"]) set(key, own[key] ?? null);
      if (on("grinder")) for (const key of ["grinderId", "grinderModel"]) set(key, own[key] ?? null);
    }
    markDye(context, wrote);
    setRecipeId(context, null);
    live.context = context;
    if (on("profile") && (snapshot.profileId || snapshot.profileTitle)) {
      if (usableProfileSnapshot(snapshot.profileSnapshot)) live.profile = snapshot.profileSnapshot;
      else {
        const full = await this.resolveFullProfile(snapshot.profileId);
        if (full) live.profile = full;
      }
    }
    if (favourite.auto && recorded?.profile) live.profile = recorded.profile;
  }

  /** `pushWorkflow`: what the copy changed against the base, without `extras.dye.selection`, sent; the base moved on to the copy once Decaid took it. */
  async pushWorkflow(): Promise<Dye2Applied> {
    if (!this.workflow) return {};
    const patch = workflowPatch(this.base, this.workflow);
    if (Object.keys(patch).length === 0) return {};
    const sent = structuredClone(this.workflow);
    const dye = ((patch.context as Record_ | undefined)?.extras as Record_ | undefined)?.dye as Record_ | undefined;
    if (dye && "selection" in dye) delete dye.selection;
    this.lastSent = patch;
    const answer = await this.tablet.callApi("PUT", "/workflow", patch);
    if (answer.status === 200) this.base = sent;
    return { workflow: answer };
  }

  /** `refreshWorkflow`: the Workflow read again as the copy and the base, unless the copy holds a change not sent. */
  private async refreshWorkflow(): Promise<void> {
    if (!this.workflow || Object.keys(workflowPatch(this.base, this.workflow)).length > 0) return;
    const { status, body } = await this.tablet.callApi("GET", "/workflow");
    if (status !== 200 || !body) return;
    this.workflow = body as Record_;
    this.base = structuredClone(this.workflow);
  }

  /** `resolveFullProfile`: the profiles read on the first apply that needs one, then the record of its id there; null where none. */
  private async resolveFullProfile(id: unknown): Promise<Record_ | null> {
    if (!id) return null;
    const cached = this.profiles.find((record) => record && record.id === id);
    if (cached?.profile) return cached.profile as Record_;
    const { status, body } = await this.tablet.callApi("GET", "/profiles?includeHidden=true");
    if (status === 200) this.profiles = asList(body);
    const record = this.profiles.find((candidate) => candidate && candidate.id === id);
    return (record?.profile as Record_ | undefined) ?? null;
  }
}

/** A field of DYE2's recipe editor's Machine Settings (`MACHINE_FIELDS` in recipe-edit.ts): its `dashboardVariables` name, and whether 0 reads as Off. */
const EDITOR_MACHINE_FIELDS: readonly (readonly [string, boolean])[] = [
  ["steamTempC", true],
  ["steamStopAtTempC", true],
  ["hotWaterTimeS", false],
  ["hotWaterFlowMls", false],
  ["flushTempC", false],
  ["flushFlowMls", false],
];

/** Each pair the editor shows one value of at a time, by mode (`MODE_CFG` in recipe-edit.ts), with the first preset of each mode. */
const EDITOR_PAIRS = {
  steam: { field: { time: "steamTimeS", flow: "steamFlowMls" }, firstPreset: { time: 29, flow: 0.8 } },
  hotWater: { field: { vol: "hotWaterMl", temp: "hotWaterTempC" }, firstPreset: { vol: 75, temp: 80 } },
} as const;

/** A value as a stepper of the editor shows it and its save reads it back (`renderRecipe`, then `num` in `getCurrentRecipeData`): a number, null for blank. */
function stepperValue(value: unknown): number | null {
  if (value == null) return null;
  const parsed = parseFloat(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

/** A Machine Settings value as the editor shows and reads it (`machineFmt`, `machineValues`): 0 or less as Off, which reads as 0, for a field that has Off. */
function machineValue(value: unknown, off: boolean): number | null {
  if (value == null) return null;
  if (off && !((value as number) > 0)) return 0;
  return stepperValue(value);
}

/** A change made on DYE2's recipe editor's form, each field as its control sets it; a number null blanks a stepper, 0 is Off for the steam temperature and milk stop. */
export interface Dye2RecipeEdit {
  name?: string;
  beverage?: string;
  barista?: string;
  drinker?: string;
  dose?: number | null;
  drink?: number | null;
  brewC?: number | null;
  grind?: number | null;
  rpm?: number | null;
  flushS?: number | null;
  /** Steam by time or flow: the mode switched to, the value shown for it. */
  steam?: { mode: "time" | "flow"; value?: number | null };
  /** Hot water by volume or temperature. */
  hotWater?: { mode: "vol" | "temp"; value?: number | null };
  steamTempC?: number | null;
  steamStopAtTempC?: number | null;
  hotWaterTimeS?: number | null;
  hotWaterFlowMls?: number | null;
  flushTempC?: number | null;
  flushFlowMls?: number | null;
  /** A Grinder's chip, by id. */
  grinderId?: string;
  /** A Basket's chip, by id. */
  basketId?: string;
  /** A Bean picked, with its batch and roaster, `batchId` "" for none. */
  bean?: { id: string; name: string; batchId?: string | null; roaster?: string | null };
  /** "Show on Streamline Dashboard". */
  showOnStreamlineDashboard?: boolean;
}

/**
 * DYE2's recipe editor (recipe-edit.ts) opened on the tablet: on the recipe
 * with that record id (`?id=`), or a new one (`?new=1`), with `slot` the
 * strip slot an empty cell of Streamline's strip hands over (`?slot=`). It
 * reads the recipes, the grinders, the baskets, the beans and the profiles
 * as it opens, keeps the record as it read it as the base its save is made
 * against (`recipeBaseline`, dye2#28), and shows it in its form
 * (`renderRecipe`). A new recipe gets a UUID (`newId('recipe')`).
 */
export async function openDye2RecipeEditor(tablet: SimulatedTablet, target: { id?: string; slot?: number } = {}): Promise<Dye2RecipeEditor> {
  const read = async (route: string) => {
    const { status, body } = await tablet.callApi("GET", route);
    return status === 200 ? asList(body) : [];
  };
  const recipes = await read(`/store/${DYE2_NAMESPACE}/recipes`);
  const grinders = await read("/grinders");
  const baskets = await read(`/store/${DYE2_NAMESPACE}/baskets`);
  await read("/beans");
  const profiles = await read("/profiles");
  return new Dye2RecipeEditor(tablet, recipes, grinders, baskets, profiles, target);
}

export class Dye2RecipeEditor {
  /** The record id the editor saves under. */
  readonly id: string;
  /** The strip slot the tabs target (`stripSlot`), null for none. */
  stripSlot: number | null;
  /** The recipe as the page holds it (`recipe`), whose `dashboardVariables` keeps the value of the mode of a pair not shown. */
  private readonly recipe: Record_;
  private readonly baselineRecord: Record_;
  private form: {
    name: string;
    beverage: string;
    barista: string;
    drinker: string;
    beanId: unknown;
    beanName: unknown;
    beanBatchId: unknown;
    beanRoaster: unknown;
    profileId: unknown;
    profileTitle: unknown;
    profileSnapshot: unknown;
    showOnStreamline: boolean;
    dose: number | null;
    drink: number | null;
    ratio: number | null;
    brewC: number | null;
    steamMode: "time" | "flow";
    steam: number | null;
    flushS: number | null;
    hotWaterMode: "vol" | "temp";
    hotWater: number | null;
    machine: Record<string, number | null>;
    grind: number | null;
    rpm: number | null;
    grinderId: unknown;
    basketId: unknown;
    equipmentIds: unknown[];
    equipmentNames: unknown[];
    equipmentCustom: Record_;
  };

  constructor(
    private readonly tablet: SimulatedTablet,
    /** The recipes the editor read as it opened. */
    readonly recipes: Record_[],
    private readonly grinders: Record_[],
    private readonly baskets: Record_[],
    private readonly profiles: Record_[],
    target: { id?: string; slot?: number },
  ) {
    const stored = target.id ? recipes.find((recipe) => recipe && recipe.id === target.id) : undefined;
    this.baselineRecord = structuredClone(stored ?? {});
    this.recipe = stored ? { ...stored } : { id: target.id ?? randomUUID() };
    this.id = String(this.recipe.id);
    this.stripSlot = this.recipe.stripSlot == null ? null : (this.recipe.stripSlot as number);
    if (target.slot !== undefined && Number.isInteger(target.slot) && target.slot >= 1 && target.slot <= 5) {
      this.stripSlot = target.slot;
      this.recipe.stripSlot = target.slot;
    }
    const dv = (this.recipe.dashboardVariables ?? {}) as Record_;
    const steamMode = (dv.steamMode as "time" | "flow" | undefined) || (dv.steamFlowMls != null ? "flow" : dv.steamTimeS != null ? "time" : "flow");
    const hotWaterMode = (dv.hotWaterMode as "vol" | "temp" | undefined) || (dv.hotWaterTempC != null ? "temp" : "vol");
    this.form = {
      name: String(this.recipe.name || ""),
      beverage: String(this.recipe.beverage || ""),
      barista: String(this.recipe.barista || ""),
      drinker: String(this.recipe.drinker || ""),
      beanId: this.recipe.beanId || null,
      beanName: this.recipe.beanName || null,
      beanBatchId: this.recipe.beanBatchId || null,
      beanRoaster: this.recipe.beanRoaster || null,
      profileId: this.recipe.profileId || null,
      profileTitle: this.recipe.profileTitle || null,
      profileSnapshot: this.recipe.profileSnapshot || null,
      showOnStreamline: this.recipe.showOnStreamlineDashboard !== false,
      dose: stepperValue(dv.dose),
      drink: stepperValue(dv.drink),
      ratio: dv.ratio != null ? stepperValue(dv.ratio) : null,
      brewC: stepperValue(dv.brewC),
      steamMode,
      steam: stepperValue(dv[EDITOR_PAIRS.steam.field[steamMode]]),
      flushS: stepperValue(dv.flushS),
      hotWaterMode,
      hotWater: stepperValue(dv[EDITOR_PAIRS.hotWater.field[hotWaterMode]]),
      machine: Object.fromEntries(EDITOR_MACHINE_FIELDS.map(([key, off]) => [key, machineValue(dv[key], off)])),
      grind: stepperValue(dv.grind),
      rpm: stepperValue(dv.rpm),
      grinderId: dv.grinderId || null,
      basketId: dv.basketId || null,
      equipmentIds: Array.isArray(dv.equipmentIds) ? [...(dv.equipmentIds as unknown[])] : [],
      equipmentNames: Array.isArray(dv.equipmentNames) ? [...(dv.equipmentNames as unknown[])] : [],
      equipmentCustom: dv.equipmentCustom && typeof dv.equipmentCustom === "object" ? { ...(dv.equipmentCustom as Record_) } : {},
    };
  }

  /**
   * Changes the form as a barista does: each field set as its control sets
   * it. Switching a pair's mode parks the value shown on the recipe for the
   * mode left (`stashModeValue`) and shows the recipe's value for the mode
   * switched to (`applyMode`), before `value`, where given, is set.
   */
  set(edit: Dye2RecipeEdit): this {
    const form = this.form;
    for (const key of ["name", "beverage", "barista", "drinker"] as const) if (edit[key] !== undefined) form[key] = edit[key]!;
    for (const key of ["dose", "drink", "brewC", "grind", "rpm", "flushS"] as const) if (edit[key] !== undefined) form[key] = edit[key]!;
    for (const [key] of EDITOR_MACHINE_FIELDS) {
      const value = edit[key as keyof Dye2RecipeEdit] as number | null | undefined;
      if (value !== undefined) form.machine[key] = value;
    }
    const held = (this.recipe.dashboardVariables ??= {}) as Record_;
    if (edit.steam) {
      if (edit.steam.mode !== form.steamMode) {
        held[EDITOR_PAIRS.steam.field[form.steamMode]] = form.steam;
        form.steamMode = edit.steam.mode;
        form.steam = stepperValue(held[EDITOR_PAIRS.steam.field[form.steamMode]]);
      }
      if (edit.steam.value !== undefined) form.steam = edit.steam.value;
    }
    if (edit.hotWater) {
      if (edit.hotWater.mode !== form.hotWaterMode) {
        held[EDITOR_PAIRS.hotWater.field[form.hotWaterMode]] = form.hotWater;
        form.hotWaterMode = edit.hotWater.mode;
        form.hotWater = stepperValue(held[EDITOR_PAIRS.hotWater.field[form.hotWaterMode]]);
      }
      if (edit.hotWater.value !== undefined) form.hotWater = edit.hotWater.value;
    }
    if (edit.grinderId !== undefined) form.grinderId = edit.grinderId;
    if (edit.basketId !== undefined) form.basketId = edit.basketId;
    if (edit.bean) {
      if (String(edit.bean.id) !== String(form.beanId)) {
        form.beanBatchId = null;
        form.beanRoaster = edit.bean.roaster ?? null;
      }
      form.beanId = edit.bean.id;
      form.beanName = edit.bean.name || "";
      if (edit.bean.batchId !== undefined) form.beanBatchId = edit.bean.batchId || null;
      if (edit.bean.roaster !== undefined) form.beanRoaster = edit.bean.roaster || null;
    }
    if (edit.showOnStreamlineDashboard !== undefined) form.showOnStreamline = edit.showOnStreamlineDashboard;
    return this;
  }

  /**
   * Taps the chip of the tablet's profile with that id (`renderProfileChips`,
   * then `fillFromProfile`): the profile picked, its snapshot dropped, the
   * yield its target weight (else volume), the dose that yield at the
   * recipe's ratio, else the first ratio preset's (1:2.3), the brew
   * temperature its first step's, and the steam, flush and hot water steppers
   * at their first presets, the hidden mode of each pair at its own.
   */
  pickProfile(profileId: string): this {
    const record = this.profiles.find((candidate) => String(candidate.id) === String(profileId));
    if (!record) throw new Error(`DYE2's recipe editor lists no profile ${profileId}`);
    const form = this.form;
    form.profileId = record.id;
    form.profileTitle = ((record.profile as Record_ | undefined)?.title as string | undefined) || (record.title as string | undefined) || (record.name as string | undefined) || "Untitled";
    form.profileSnapshot = null;
    const profile = ((record.profile ?? record) as Record_) || {};
    const positive = (value: unknown) => {
      const parsed = parseFloat(String(value));
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    };
    const yieldG = positive(profile.target_weight) ?? positive(profile.target_volume);
    const first = Array.isArray(profile.steps) && profile.steps.length > 0 ? parseFloat(String((profile.steps as Record_[])[0]!.temperature)) : NaN;
    const brewC = Number.isFinite(first) ? Math.round(first * 10) / 10 : null;
    if (yieldG == null && brewC == null) return this;
    if (yieldG != null) {
      const ratio = form.ratio ?? 2.3;
      form.drink = Math.round(yieldG * 10) / 10;
      form.dose = Math.round((form.drink / ratio) * 2) / 2;
      form.ratio = ratio;
    }
    if (brewC != null) form.brewC = Math.min(100, Math.max(60, Math.round(brewC)));
    form.steam = EDITOR_PAIRS.steam.firstPreset[form.steamMode];
    form.flushS = 5;
    form.hotWater = EDITOR_PAIRS.hotWater.firstPreset[form.hotWaterMode];
    const held = (this.recipe.dashboardVariables ??= {}) as Record_;
    const otherSteam = form.steamMode === "time" ? "flow" : "time";
    const otherHotWater = form.hotWaterMode === "vol" ? "temp" : "vol";
    held[EDITOR_PAIRS.steam.field[otherSteam]] = EDITOR_PAIRS.steam.firstPreset[otherSteam];
    held[EDITOR_PAIRS.hotWater.field[otherHotWater]] = EDITOR_PAIRS.hotWater.firstPreset[otherHotWater];
    return this;
  }

  /** Taps the tab of that strip slot (`setupSlots`): the recipe to that slot, or out of its slot where the tab tapped is its own (`stripNextTarget`). */
  tapSlot(slot: 1 | 2 | 3 | 4 | 5): this {
    this.stripSlot = this.stripSlot === slot ? null : slot;
    return this;
  }

  /**
   * The form as its save reads it (`getCurrentRecipeData`): each stepper's
   * value, the mode of each pair not shown kept from the recipe, the ratio
   * only while the yield is still the dose at it, the Grinder's model and the
   * Basket's name from the lists read.
   */
  data(): Record_ {
    const form = this.form;
    const held = (this.recipe.dashboardVariables ?? {}) as Record_;
    const ratio = form.ratio != null && form.dose && form.drink != null && Math.abs(form.drink - Math.round(form.dose * form.ratio * 10) / 10) < 0.05 ? form.ratio : undefined;
    return {
      name: form.name,
      beverage: form.beverage,
      barista: form.barista,
      drinker: form.drinker,
      beanId: form.beanId,
      beanName: form.beanName,
      beanBatchId: form.beanBatchId,
      beanRoaster: form.beanRoaster,
      profileId: form.profileId,
      profileTitle: form.profileTitle,
      profileSnapshot: form.profileSnapshot,
      showOnStreamlineDashboard: form.showOnStreamline,
      stripSlot: this.stripSlot,
      dashboardVariables: {
        dose: form.dose,
        drink: form.drink,
        ratio,
        brewC: form.brewC,
        steamMode: form.steamMode,
        steamTimeS: form.steamMode === "time" ? form.steam : held.steamTimeS,
        steamFlowMls: form.steamMode === "flow" ? form.steam : held.steamFlowMls,
        flushS: form.flushS,
        hotWaterMode: form.hotWaterMode,
        hotWaterMl: form.hotWaterMode === "vol" ? form.hotWater : held.hotWaterMl,
        hotWaterTempC: form.hotWaterMode === "temp" ? form.hotWater : held.hotWaterTempC,
        ...form.machine,
        grind: form.grind,
        rpm: form.rpm,
        grinderId: form.grinderId,
        grinderModel: this.grinders.find((grinder) => grinder.id === form.grinderId)?.model,
        basketId: form.basketId,
        basketName: this.baskets.find((basket) => basket.id === form.basketId)?.name,
        equipmentIds: [...form.equipmentIds],
        equipmentNames: [...form.equipmentNames],
        equipmentCustom: { ...form.equipmentCustom },
      },
    };
  }

  /**
   * SAVE RECIPE (`setupFooter`), tapped again to confirm where another recipe
   * holds the slot targeted (`stripSlotHolder`): what the form changed
   * against the record as read (`recipeChanges`) saved over the recipe read
   * afresh (`updateRecipe`), the slot taken from its previous holder. Where
   * DYE2's derived selection names this recipe, its saved `workflow` is then
   * sent whole and `POST .../selection` asked for it (`reapplyIfSelected`).
   * Resolves with the recipe saved and whether it was applied again.
   */
  async save(): Promise<{ saved: Record_; reapplied: boolean; patch: Record_ }> {
    const patch = recipeChanges(this.baselineRecord, this.data());
    const saved = await updateRecipe(this.tablet, this.id, patch);
    return { saved, reapplied: await this.reapplyIfSelected(saved), patch };
  }

  /** `reapplyIfSelected`: the saved recipe's `workflow` sent, then selected, where DYE2's derived selection names it. */
  private async reapplyIfSelected(saved: Record_): Promise<boolean> {
    if (!saved.workflow) return false;
    const { status, body } = await this.tablet.callApi("GET", `/plugins/${DYE2_NAMESPACE}/selection`);
    const derived = status === 200 ? (body as Dye2Derived | null) : null;
    if (!derived || derived.kind !== "recipe" || String(derived.id) !== String(saved.id)) return false;
    const workflow = structuredClone(saved.workflow) as Record_;
    const dye = ((workflow.context as Record_ | undefined)?.extras as Record_ | undefined)?.dye as Record_ | undefined;
    if (dye && "selection" in dye) delete dye.selection;
    await this.tablet.callApi("PUT", "/workflow", workflow);
    await this.tablet.callApi("POST", `/plugins/${DYE2_NAMESPACE}/selection`, { kind: "recipe", id: String(saved.id) });
    return true;
  }
}
