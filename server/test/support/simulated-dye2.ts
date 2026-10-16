import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { DecaidAnswer } from "./decaid-beans.js";
import { DYE2_SELECTION_ROUTE, type DecaidApi, type SimulatedTablet, derivedDe1Pro } from "./simulated-tablet.js";

// DYE2 v0.1.19 and Streamline v0.2.13 on a simulated tablet, as far as they
// write DYE2's recipes, baskets and tools and the Workflow: each helper
// replays a step recorded from the real apps on Decaid's Linux release
// (fixtures/decaid/dye2-v0.1.19/, whose README lists the steps) through the
// tablet's API, as they call it. The plugin is not told of it, as of
// anything else on the tablet (`SimulatedTablet.callApi`).
//
// DYE2 keeps each list whole under one key of Decaid's store, `recipes`,
// `baskets` and `equipment` (its tools) under `dye2.reaplugin`. Each save
// reads the list, changes one item and posts the list back. DYE2's pages put
// the item in as `{...existing, ...item}` (`kvUpsert` in
// dye2:dye2-plugin/src/utils/dev-api.ts), leave it out to delete a tool, and
// write nothing for a new tool whose name the list holds already
// (`createEquipment`). Streamline's auto-save merges into the applied
// recipe's `dashboardVariables` the fields it reads from the barista's
// Workflow change (`recipeAutoSaveFields` and `saveItemFields` in
// streamline-js:src/modules/dyeStrip.js), and saves nothing if the list no
// longer holds the recipe. The helpers do the same with the items the
// recording changed and the Workflow changes it made, so they work on
// whatever the tablet holds, and on the recorded list give what was
// recorded. A recipe is applied in
// one `PUT /workflow` of the whole Workflow, DYE2's dashboard and
// Streamline's DYE strip each merging the recipe into the Workflow they read;
// Streamline first keeps the steam, hot water and flush values it sets in
// its own namespace of the store (simulated-streamline.ts). Those writes are
// replayed as recorded.
//
// The recorded records name the recording's beans, grinder and profiles by
// their ids: load the tablet with `dye2Library()` for those ids to be the
// tablet's.
//
// Those helpers replay DYE2 v0.1.19 and Streamline v0.2.13, which select
// nothing, for tests written before DYE2 selected recipes: `applyInDye2`
// and `applyInStreamline` apply without selecting, and `withDye2Selection`
// serves DYE2's `selection` endpoint alone, without DYE2's recording. DYE2
// v0.1.20 itself, selecting, recording, pushing and restoring, is
// `SimulatedDye2` below, with its dashboard (`openDye2Dashboard`) and
// Streamline v0.2.14's strip, tiles and wake (simulated-streamline.ts).

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
  /** DYE2's recipe editor: saving slots 1 and 2, editing slot 1, and saving slot 3 with only its name typed, its other fields blank. */
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

/**
 * The recording's tablet, with this serial: its library and Workflow
 * (dye2Library()), and DYE2's baskets and tools as the recording left them,
 * but no recipes. Its beans' names start with `scenario`, as Beans are matched
 * by roaster and name across a test file's tests.
 */
export function recordedDye2Tablet(serial: string, scenario: string): DecaidApi {
  const library = dye2Library();
  const keys = dye2Keys();
  return {
    ...dye2NeverUsed(serial),
    ...library,
    "/beans": (library["/beans"] as Record_[]).map((bean) => ({ ...bean, name: `${scenario} ${String(bean.name)}` })),
    [`/store/${DYE2_NAMESPACE}/baskets`]: keys.baskets,
    [`/store/${DYE2_NAMESPACE}/equipment`]: keys.equipment,
  };
}

/**
 * The tablet's API with DYE2 v0.1.20's `selection` endpoint, nothing
 * selected, which the simulated tablet then answers as DYE2 does
 * (`answerDye2Selection` in simulated-tablet.ts).
 */
export function withDye2Selection(api: DecaidApi): DecaidApi {
  return { ...api, [DYE2_SELECTION_ROUTE]: null };
}

/**
 * DYE2's selected recipe or favourite on the tablet, its kind and id: null
 * for none. On a tablet with a simulated DYE2 v0.1.20 (`SimulatedDye2`),
 * its selection whether or not it is loaded; `tablet.dye2.selected()` has
 * its fingerprint and brew temperature too.
 */
export function dye2Selection(tablet: SimulatedTablet): unknown {
  if (tablet.dye2) {
    const selected = tablet.dye2.selected();
    return selected ? { kind: selected.kind, id: selected.id } : null;
  }
  return tablet.dye2Selected() ?? null;
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
 * Streamline's auto-save in that recorded step: replays the Workflow change
 * the barista made and the values Streamline kept for it, then, if
 * Streamline saved it, reads the recipes from the tablet, merges into the
 * applied recipe's `dashboardVariables` the fields Streamline reads from the
 * change and the Workflow Decaid answered (`recipeAutoSaveFields`), and posts
 * the list back. The applied recipe is the one the recording saved into,
 * whatever the tablet applied since: Streamline saves into the recipe it
 * last applied, and stops once Decaid answers a change with a profile that
 * does not match the one it applied (`handleWorkflowUpdatedForAutoSave`),
 * which the helper does not check, so a test replays an auto-save only
 * after replaying Streamline applying that recipe and while the Workflow's
 * profile is still the one applied. Nor does it wait out Streamline's 1.5 s
 * debounce, which merges changes made within it into one save.
 * Resolves with the list posted, or undefined for a step that saved nothing,
 * a Workflow change Decaid refused, after which Streamline's listener never
 * runs (`updateWorkflow` in streamline-js:src/modules/api.js), or a recipe
 * the tablet no longer holds.
 */
export async function autoSaveInStreamline(tablet: SimulatedTablet, step: Dye2Exchange[]): Promise<Record_[] | undefined> {
  const posted = step.findIndex(isListWrite);
  const replayed = posted === -1 ? step : step.slice(0, posted);
  const answers = await replayWrites(tablet, replayed);
  if (posted === -1) return undefined;
  const writes = replayed.filter(({ request }) => request.method !== "GET");
  const change = writes.findIndex(({ request }) => request.method === "PUT" && request.path === "/workflow");
  const answer = answers[change];
  if (answer?.status !== 200) return undefined;
  const fields = recipeAutoSaveFields(writes[change]!.request.body as Record_, answer.body as Record_);
  let saved = false;
  const list = await writeList(tablet, step, (existing) => {
    if (!existing) return undefined;
    saved = true;
    return { ...existing, dashboardVariables: { ...((existing.dashboardVariables ?? {}) as Record_), ...fields } };
  });
  return saved ? list : undefined;
}

/**
 * The fields of a recipe's `dashboardVariables` Streamline saves from a
 * Workflow change it sent and the Workflow Decaid answered
 * (`recipeAutoSaveFields` in streamline-js:src/modules/dyeStrip.js at
 * v0.2.13): each set from the answer, or else from what was sent.
 */
function recipeAutoSaveFields(sent: Record_, answered: Record_): Record_ {
  const part = (workflow: Record_, name: string) => (workflow[name] ?? {}) as Record_;
  const fields: Record_ = {};
  const context = part(sent, "context");
  const answeredContext = part(answered, "context");
  if (context.targetDoseWeight != null) fields.dose = answeredContext.targetDoseWeight ?? context.targetDoseWeight;
  if (context.targetYield != null) fields.drink = answeredContext.targetYield ?? context.targetYield;
  if (context.grinderSetting != null) {
    const grind = parseFloat(String(answeredContext.grinderSetting ?? context.grinderSetting));
    if (Number.isFinite(grind)) fields.grind = grind;
  }
  const firstStep = (workflow: Record_) => ((part(workflow, "profile").steps as Record_[] | undefined)?.[0] ?? {}) as Record_;
  if (firstStep(sent).temperature != null) {
    const temperature = parseFloat(String(firstStep(answered).temperature ?? firstStep(sent).temperature));
    if (Number.isFinite(temperature)) fields.brewC = temperature;
  }
  const steam = part(sent, "steamSettings");
  if (steam.duration != null) Object.assign(fields, { steamMode: "time", steamTimeS: part(answered, "steamSettings").duration ?? steam.duration });
  else if (steam.flow != null) Object.assign(fields, { steamMode: "flow", steamFlowMls: part(answered, "steamSettings").flow ?? steam.flow });
  const hotWater = part(sent, "hotWaterData");
  if (hotWater.volume != null) Object.assign(fields, { hotWaterMode: "vol", hotWaterMl: part(answered, "hotWaterData").volume ?? hotWater.volume });
  else if (hotWater.targetTemperature != null) {
    Object.assign(fields, { hotWaterMode: "temp", hotWaterTempC: part(answered, "hotWaterData").targetTemperature ?? hotWater.targetTemperature });
  }
  if (part(sent, "rinseData").duration != null) fields.flushS = part(answered, "rinseData").duration ?? part(sent, "rinseData").duration;
  return fields;
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

/** Whether the step writes DYE2's tools. */
function isToolList(step: Dye2Exchange[]): boolean {
  return step.some(({ request }) => isListWrite({ request } as Dye2Exchange) && request.path === `/store/${DYE2_NAMESPACE}/equipment`);
}

/** A write of one of DYE2's lists. */
function isListWrite({ request }: Dye2Exchange): boolean {
  return request.method === "POST" && request.path.startsWith(`/store/${DYE2_NAMESPACE}/`);
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
 * and Streamline saving into a recipe the list no longer holds write
 * nothing. Resolves with the list.
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

/**
 * Applies the tablet's recipe in that slot as DYE2's dashboard does when a
 * barista taps its pill (`applyRecipe` in dye2:dye2-plugin/src/pages/dashboard.ts
 * at v0.1.19), from what the tablet holds: reads the Workflow, sets the
 * recipe's dose, yield (or its dose times its ratio), grind setting, RPM,
 * Grinder where the tablet holds it, barista and drinker where it names one,
 * its Profile, whole from its `profileSnapshot` where that has steps and
 * otherwise from the tablet's profiles, hidden ones included, and its steam,
 * hot water and flush values of their modes, then sends the whole Workflow
 * in one `PUT /workflow`. `copy` is the recipe as a page read it earlier,
 * which it applies instead of the tablet's, as the dashboard reads its
 * recipes once, when it opens. Resolves with what Decaid answered.
 */
export async function applyInDye2(tablet: SimulatedTablet, slot: string, copy?: Record_): Promise<DecaidAnswer> {
  const recipe = copy ?? recipeIn(tablet, slot);
  const live = (await tablet.callApi("GET", "/workflow")).body as Record_;
  const dv = (recipe.dashboardVariables ?? {}) as Record_;
  const context: Record_ = { ...((live.context ?? {}) as Record_) };
  if (dv.dose != null) context.targetDoseWeight = dv.dose;
  if (dv.drink != null) context.targetYield = dv.drink;
  else if (dv.ratio != null && dv.dose != null) context.targetYield = Math.round((dv.dose as number) * (dv.ratio as number) * 10) / 10;
  if (dv.grind != null) context.grinderSetting = dv.grind;
  if (dv.rpm != null) context.extras = { ...((context.extras ?? {}) as Record_), rpm: dv.rpm };
  const grinders = asList((await tablet.callApi("GET", "/grinders")).body);
  const grinder = dv.grinderId ? grinders.find((candidate) => candidate.id === dv.grinderId) : undefined;
  if (grinder) Object.assign(context, { grinderId: grinder.id, grinderModel: grinder.model ?? grinder.name });
  if (recipe.barista) context.baristaName = recipe.barista;
  if (recipe.drinker) context.drinkerName = recipe.drinker;
  live.context = context;
  if (recipe.profileId || recipe.profileTitle) live.profile = await fullProfile(tablet, recipe.profileSnapshot, recipe.profileId, recipe.profileTitle);
  mergeLiveSettings(live, dv);
  return tablet.callApi("PUT", "/workflow", live);
}

/**
 * Applies the tablet's recipe in that slot as Streamline's DYE strip does
 * when a barista taps it (`applyRecipe` in streamline-js:src/modules/dyeStrip.js
 * at v0.2.13), from what the tablet holds: reads the Workflow, merges into it
 * the recipe's embedded `workflow`, its context over the Workflow's and its
 * Profile whole, from the tablet's profiles where it carries no steps, and
 * the recipe's steam, hot water and flush values of their modes, then sends
 * the whole Workflow in one `PUT /workflow`. The values Streamline keeps of
 * those settings in its own namespace are not set here. `copy` is the recipe
 * as the strip read it earlier, which it applies instead of the tablet's, as
 * the strip keeps the recipes it read until the page is shown again.
 * Resolves with what Decaid answered.
 */
export async function applyInStreamline(tablet: SimulatedTablet, slot: string, copy?: Record_): Promise<DecaidAnswer> {
  const recipe = copy ?? recipeIn(tablet, slot);
  const live = (await tablet.callApi("GET", "/workflow")).body as Record_;
  const workflow = (recipe.workflow ?? {}) as Record_;
  live.context = { ...((live.context ?? {}) as Record_), ...((workflow.context ?? {}) as Record_) };
  const profile = workflow.profile as Record_ | undefined;
  if (profile) live.profile = await fullProfile(tablet, profile, profile.id, profile.title);
  mergeLiveSettings(live, (recipe.dashboardVariables ?? {}) as Record_);
  return tablet.callApi("PUT", "/workflow", live);
}

/** The tablet's recipe in that slot. */
function recipeIn(tablet: SimulatedTablet, slot: string): Record_ {
  const recipe = asList(dye2List(tablet, "recipes")).find((candidate) => candidate.id === slot);
  if (!recipe) throw new Error(`The tablet holds no recipe in slot ${slot}`);
  return recipe;
}

/** A profile with its steps, as DYE2 and Streamline load one: as given where it has steps, or else the tablet's record of its id, hidden ones included, or else its id and title alone. */
async function fullProfile(tablet: SimulatedTablet, profile: unknown, id: unknown, title: unknown): Promise<Record_> {
  if (profile && typeof profile === "object" && Array.isArray((profile as Record_).steps)) return profile as Record_;
  const record = asList((await tablet.callApi("GET", "/profiles?includeHidden=true")).body).find((candidate) => candidate.id === id);
  return record?.profile && typeof record.profile === "object" ? (record.profile as Record_) : { id, title };
}

/** Merges a recipe's steam, hot water and flush values of their modes into the Workflow's own, as both apps do. */
function mergeLiveSettings(live: Record_, dv: Record_): void {
  if (live.steamSettings && (dv.steamTimeS != null || dv.steamFlowMls != null)) {
    const steam = { ...(live.steamSettings as Record_) };
    if (dv.steamMode === "time" && dv.steamTimeS != null) steam.duration = dv.steamTimeS;
    if (dv.steamMode === "flow" && dv.steamFlowMls != null) steam.flow = dv.steamFlowMls;
    live.steamSettings = steam;
  }
  if (live.hotWaterData && (dv.hotWaterMl != null || dv.hotWaterTempC != null)) {
    const hotWater = { ...(live.hotWaterData as Record_) };
    if (dv.hotWaterMode === "vol" && dv.hotWaterMl != null) hotWater.volume = dv.hotWaterMl;
    if (dv.hotWaterMode === "temp" && dv.hotWaterTempC != null) hotWater.targetTemperature = dv.hotWaterTempC;
    live.hotWaterData = hotWater;
  }
  if (live.rinseData && dv.flushS != null) live.rinseData = { ...(live.rinseData as Record_), duration: dv.flushS };
}

// ---- DYE2 v0.1.20 running on the tablet: its selected recipe, its recording into it, its pushes and its dashboard.
//
// From v0.1.20 DYE2 keeps one selected recipe or favourite
// (dye2:dye2-plugin/src/utils/workflow-record.ts, ported below with
// attribution, and `handleSelection` and `onEvent` in
// dye2:dye2-plugin/src/plugin.ts), checked against what DYE2 v0.1.20 was
// recorded doing (fixtures/decaid/dye2-v0.1.20/, whose README says what they
// show). `SimulatedDye2` runs it beside the plugin on a tablet loaded with
// it (`SimulatedTabletOptions.dye2`): Decaid lists it at `GET /plugins`,
// routes `/plugins/dye2.reaplugin/{endpoint}` to it while it is loaded and
// answers 404 otherwise, gives it every `workflowUpdated` and `shotStored`,
// whoever changed the Workflow, the plugin's own `PUT /workflow` included,
// and opens sockets on its `changed` endpoint. Its timers are the tablet's,
// so `timeScale` speeds its 1.5 s wait and 3 s echo window as it speeds the
// plugin's; they stop as the tablet unloads, so a record DYE2 had pending
// then is lost. Its own storage is its key `selection` in Decaid's store
// under `dye2.reaplugin`, as `host.storage` keeps it.

/** DYE2's selected recipe or favourite, as `GET .../selection` answers it (`Selection` in workflow-record.ts). */
export interface Dye2Selected {
  kind: "recipe" | "favourite";
  id: string;
  profileFingerprint: string | null;
  armedBrewC: number | null;
}

/** Whether DYE2 is installed, and loaded: `disabled` is unloaded and not loaded at start, as `POST .../disable` leaves it; `unloaded` unloaded but loaded at start, as Decaid's settings or a failed load leave it. */
export type Dye2State = "loaded" | "unloaded" | "disabled" | "absent";

/** DYE2's wait before it records (DEBOUNCE_MS), and the window in which it takes a Workflow with its selection's values as its own apply's echo (ECHO_WINDOW_MS). */
const DYE2_DEBOUNCE_MS = 1500;
const DYE2_ECHO_WINDOW_MS = 3000;

/** The list each kind of item is kept in, and the part of an item holding its dashboard values (TARGETS). */
const DYE2_TARGETS = {
  recipe: { key: "recipes", field: "dashboardVariables" },
  favourite: { key: "autoFavourites", field: "snapshot" },
} as const;

const fixtures020 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/decaid/dye2-v0.1.20");

/** A file recorded from DYE2 v0.1.20 and Streamline v0.2.14 (fixtures/decaid/dye2-v0.1.20/). */
export function dye2V020Recording<T = Record<string, unknown>>(file: "library" | "plugins" | "dashboard" | "recording" | "restore" | "streamline" | "fingerprints"): T {
  return JSON.parse(fs.readFileSync(path.join(fixtures020, `${file}.json`), "utf8")) as T;
}

/**
 * The v0.1.20 recording's tablet, with this serial: its beans, batches,
 * grinder, profiles and Workflow, and DYE2's baskets and two recipes, slot
 * 1 on `Adaptive v3` and slot 2 on `Classic Italian espresso`, as the
 * recording made them. Its beans' names start with `scenario` where one is
 * given, as Beans are matched by roaster and name across a test file's tests.
 */
export function recordedDye2V020Tablet(serial: string, scenario?: string): DecaidApi {
  const library = dye2V020Recording<Record<string, unknown>>("library");
  return {
    ...dye2NeverUsed(serial),
    "/beans": (library.beans as Record_[]).map((bean) => (scenario === undefined ? bean : { ...bean, name: `${scenario} ${String(bean.name)}` })),
    "/bean-batches": library.beanBatches,
    "/grinders": library.grinders,
    "/profiles": library.profiles,
    "/workflow": library.workflow,
    [`/store/${DYE2_NAMESPACE}/recipes`]: library.recipes,
    [`/store/${DYE2_NAMESPACE}/baskets`]: library.baskets,
  };
}

/**
 * A profile as DYE2 fingerprints it to tell a change of profile
 * (`profileFingerprint` in workflow-record.ts): its title, target weight and
 * volume, tank temperature and steps, but each step's temperature.
 */
export function dye2ProfileFingerprint(profile: unknown): string | null {
  if (!profile || typeof profile !== "object") return null;
  const record = profile as Record_;
  const steps = Array.isArray(record.steps) ? (record.steps as Record_[]).map(({ temperature: _, ...rest }) => rest) : record.steps;
  return JSON.stringify({ title: record.title, target_weight: record.target_weight, target_volume: record.target_volume, tank_temperature: record.tank_temperature, steps });
}

function dye2Number(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const parsed = parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function dye2Put(out: Record_, key: string, value: unknown): void {
  if (value !== undefined && value !== null) out[key] = value;
}

/** Everything the Workflow says that a recipe could hold, in `dashboardVariables` names (`recipeFields`). */
function dye2RecipeFields(workflow: Record_): Record_ {
  const out: Record_ = {};
  const context = (workflow.context ?? {}) as Record_;
  dye2Put(out, "dose", context.targetDoseWeight);
  dye2Put(out, "drink", context.targetYield);
  dye2Put(out, "grind", dye2Number(context.grinderSetting));
  const steps = (workflow.profile as Record_ | undefined)?.steps as Record_[] | undefined;
  dye2Put(out, "brewC", dye2Number(steps?.[0]?.temperature));
  const part = (name: string) => (workflow[name] ?? {}) as Record_;
  dye2Put(out, "steamTimeS", part("steamSettings").duration);
  dye2Put(out, "steamFlowMls", part("steamSettings").flow);
  dye2Put(out, "hotWaterMl", part("hotWaterData").volume);
  dye2Put(out, "hotWaterTempC", part("hotWaterData").targetTemperature);
  dye2Put(out, "flushS", part("rinseData").duration);
  return out;
}

/** A favourite's snapshot fields: dose, yield and grind only (`favouriteFields`). */
function dye2FavouriteFields(workflow: Record_): Record_ {
  const out: Record_ = {};
  const context = (workflow.context ?? {}) as Record_;
  dye2Put(out, "dose", context.targetDoseWeight);
  dye2Put(out, "drink", context.targetYield);
  dye2Put(out, "grindSetting", dye2Number(context.grinderSetting));
  return out;
}

/** The entries of `patch` that differ from `stored`, compared numerically where both are numbers (`changedFields`). */
function dye2ChangedFields(patch: Record_, stored: Record_ | undefined): Record_ {
  const out: Record_ = {};
  for (const [key, value] of Object.entries(patch)) {
    const current = stored?.[key];
    const same = current === value || (current != null && value != null && Number.isFinite(Number(current)) && Number(current) === Number(value));
    if (!same) out[key] = value;
  }
  return out;
}

/**
 * What DYE2 writes onto the item for the Workflow (`itemPatch`): only fields
 * the item holds, the steam and hot water values of its modes only, the
 * brew temperature only once it moved off `armedBrewC`, and only those that
 * differ.
 */
export function dye2ItemPatch(kind: Dye2Selected["kind"], item: Record_, workflow: Record_, armedBrewC: number | null = null): Record_ {
  const stored = (item[DYE2_TARGETS[kind].field] ?? {}) as Record_;
  const all = kind === "recipe" ? dye2RecipeFields(workflow) : dye2FavouriteFields(workflow);
  const skip = new Set<string>();
  if (stored.steamMode === "time") skip.add("steamFlowMls");
  else if (stored.steamMode === "flow") skip.add("steamTimeS");
  if (stored.hotWaterMode === "vol") skip.add("hotWaterTempC");
  else if (stored.hotWaterMode === "temp") skip.add("hotWaterMl");
  const known: Record_ = {};
  for (const key of Object.keys(all)) {
    if (stored[key] == null || skip.has(key)) continue;
    if (key === "brewC" && (armedBrewC == null || all.brewC === armedBrewC)) continue;
    known[key] = all[key];
  }
  return dye2ChangedFields(known, stored);
}

/** The values DYE2 compares to tell its own apply's echo (`echoKey`). */
function dye2EchoKey(workflow: Record_): string {
  return JSON.stringify([dye2RecipeFields(workflow), dye2FavouriteFields(workflow)]);
}

function dye2LiveBrewC(workflow: Record_): number | null {
  const value = dye2RecipeFields(workflow).brewC;
  return typeof value === "number" ? value : null;
}

/** DYE2's entry in `GET /plugins` as recorded while it was loaded (plugins.json), its `loaded` and `autoLoad` set by `listing()`. */
function recordedDye2Listing(): Record_ {
  const { loaded } = dye2V020Recording<{ loaded: { listed: Record_[] } }>("plugins");
  return loaded.listed[0]!;
}

/**
 * DYE2 v0.1.20 on a simulated tablet: pass it as the tablet's `dye2`. It
 * starts as `state` says, `loaded` by default, having restored whatever
 * DYE2's store key `selection` held as it loaded, before the plugin did.
 */
export class SimulatedDye2 {
  readonly id = DYE2_NAMESPACE;
  /** What DYE2 logged, as `host.log` would. */
  readonly logs: string[] = [];
  /** Each push DYE2 made on its `changed` endpoint, in order, whether or not a socket heard it. */
  readonly pushes: unknown[] = [];
  /** Each `POST .../selection` DYE2 was asked, in order, by whoever: `{ kind, id }`, or null for a clear. */
  readonly asked: ({ kind: string; id: string } | null)[] = [];
  /** Each record DYE2 wrote into an item, in order: the item's kind and id, and the fields it wrote. */
  readonly recorded: { kind: Dye2Selected["kind"]; id: string; patch: Record_ }[] = [];
  private tablet: SimulatedTablet | undefined;
  private installed: boolean;
  private loadedNow: boolean;
  private autoLoad: boolean;
  /** Each load of DYE2 is a generation, as Decaid's; work begun under one is dropped by the next. */
  private generation = 0;
  private selection: Dye2Selected | null = null;
  private cancelRecord: (() => void) | undefined;
  private suppressed: { values: string; at: number } | undefined;
  private restoreHeld: Promise<void> | undefined;
  /** Whether DYE2 had already restored its selection once a tablet was attached, as one loaded before the plugin had. */
  private started = false;

  constructor({ state = "loaded" }: { state?: Dye2State } = {}) {
    this.installed = state !== "absent";
    this.loadedNow = state === "loaded";
    this.autoLoad = state === "loaded" || state === "unloaded";
  }

  /** The tablet DYE2 runs on; a later load of the plugin on the same tablet attaches it again, its selection kept. */
  attach(tablet: SimulatedTablet): void {
    this.tablet = tablet;
    if (this.started) return;
    this.started = true;
    if (this.loadedNow) this.restoreSelection(tablet.storeValue(DYE2_NAMESPACE, "selection"));
  }

  /** DYE2's selected recipe or favourite, as `GET .../selection` answers it while DYE2 is loaded: null for none. */
  selected(): Dye2Selected | null {
    return this.selection ? { ...this.selection } : null;
  }

  /** Whether DYE2 is loaded. */
  get loaded(): boolean {
    return this.loadedNow;
  }

  /**
   * Loads DYE2, as Decaid does at start, on `POST .../enable` or on a reload:
   * it selects nothing until, in a later turn, it has read its store key
   * `selection` (`onLoad`, then `onEvent(storageRead)`), which it restores
   * unless it selected something meanwhile, a stored `{}` or `null` as none;
   * and it refreshes its recent favourites, pushing once that is done. The
   * value restored is the one stored as the load began. Resolves once DYE2
   * has restored it, as Decaid answers `POST .../enable` (recorded in
   * restore.json): `holdRestore` holds that too.
   */
  load(): Promise<void> {
    if (!this.installed) throw new Error("DYE2 is not installed on the tablet");
    if (this.loadedNow) this.unload();
    this.loadedNow = true;
    const generation = ++this.generation;
    const stored = this.storeRead();
    this.refreshRecents();
    return (async () => {
      await this.restoreHeld;
      await new Promise((resolve) => setImmediate(resolve));
      if (generation === this.generation && !this.selection) this.restoreSelection(stored);
    })();
  }

  /**
   * Unloads DYE2, as Decaid's settings or a failed update do: its endpoints
   * answer 404 and its selection and pending record are dropped. Sockets open
   * on `changed` stay open, as Decaid's do, and hear the next load's pushes.
   */
  unload(): void {
    this.generation++;
    this.loadedNow = false;
    this.cancelPending();
    this.selection = null;
    this.suppressed = undefined;
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

  /** DYE2 unloaded and loaded again, as an update of it or Decaid restarting does; resolves as `load` does. */
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

  /**
   * Holds DYE2's restore of its stored selection on each load until the
   * function returned is called, so a test sees DYE2 loaded with nothing
   * selected, as in the moment before its storage answers.
   */
  holdRestore(): () => void {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.restoreHeld = held;
    return () => {
      if (this.restoreHeld === held) this.restoreHeld = undefined;
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
   * it does not declare, 400 for its socket, and its `selection` and `skin`
   * as DYE2 answers them. Its pages are not simulated: use
   * `openDye2Dashboard`.
   */
  async answer(method: string, route: string, body: unknown): Promise<DecaidAnswer> {
    const endpoint = decodeURIComponent(route.slice(`/plugins/${DYE2_NAMESPACE}/`.length));
    if (!this.loadedNow) return { status: 404, body: { error: `plugin with ${DYE2_NAMESPACE} not loaded` } };
    const type = this.socketEndpoint(endpoint);
    if (type === undefined) return { status: 404, body: { error: `endpoint ${endpoint} not available` } };
    if (type === "websocket") return { status: 400, body: { error: `endpoint ${endpoint} is not a http type` } };
    if (endpoint === "skin") return { status: 200, body: { version: 1, surfaces: [], live: { endpoint: "changed" } } };
    if (endpoint === "selection") return this.handleSelection(method, body);
    throw new Error(`The simulated DYE2 does not answer its ${endpoint} endpoint`);
  }

  /** Decaid tells DYE2 of a change of the Workflow (`onEvent(workflowUpdated)`). */
  workflowUpdated(workflow: Record_): void {
    if (this.loadedNow) this.scheduleWorkflowRecord(workflow);
  }

  /** Decaid tells DYE2 a Shot was stored (`onEvent(shotStored)`): it refreshes its recent favourites, and pushes. */
  shotStored(): void {
    if (this.loadedNow) this.refreshRecents();
  }

  /** `handleSelection` in plugin.ts. */
  private async handleSelection(method: string, body: unknown): Promise<DecaidAnswer> {
    if (method === "GET") return { status: 200, body: this.selected() };
    const asked = (body ?? null) as { kind?: unknown; id?: unknown } | null;
    if (!asked || !asked.kind) {
      this.asked.push(null);
      this.clearSelection();
      return { status: 200, body: null };
    }
    this.asked.push({ kind: String(asked.kind), id: String(asked.id) });
    const generation = this.generation;
    const read = await this.api("GET", "/workflow");
    const workflow = read.status === 200 ? (read.body as Record_) : null;
    if (generation !== this.generation) return { status: 404, body: { error: `plugin with ${DYE2_NAMESPACE} not loaded` } };
    const selected = this.armSelection(asked, workflow);
    if (selected) this.announce();
    return { status: 200, body: selected ? { ...selected } : null };
  }

  /** `armSelection`: selects the item on the Workflow, its fingerprint and first step temperature, and takes the Workflow as its echo; a `recent:` id or no kind clears. */
  private armSelection(asked: { kind?: unknown; id?: unknown }, workflow: Record_ | null): Dye2Selected | null {
    const { kind, id } = asked;
    if ((kind !== "recipe" && kind !== "favourite") || id == null || id === "" || String(id).startsWith("recent:")) {
      this.clearSelection();
      return null;
    }
    this.setSelection({
      kind,
      id: String(id),
      profileFingerprint: dye2ProfileFingerprint(workflow?.profile),
      armedBrewC: workflow ? dye2LiveBrewC(workflow) : null,
    });
    if (workflow) this.suppressed = { values: dye2EchoKey(workflow), at: this.now() };
    return this.selection;
  }

  private clearSelection(): void {
    this.setSelection(null);
  }

  /** `restoreSelection`: a stored selection taken back as it was, anything else, `{}` included, as none; nothing is stored. */
  private restoreSelection(raw: unknown): void {
    const stored = raw as Record_ | null;
    this.selection =
      stored && (stored.kind === "recipe" || stored.kind === "favourite") && stored.id != null && !String(stored.id).startsWith("recent:")
        ? {
            kind: stored.kind,
            id: String(stored.id),
            profileFingerprint: (stored.profileFingerprint as string | null | undefined) || null,
            armedBrewC: typeof stored.armedBrewC === "number" ? stored.armedBrewC : null,
          }
        : null;
  }

  /** `setSel`: what was pending belongs to the previous selection; the new one is stored. */
  private setSelection(next: Dye2Selected | null): void {
    this.cancelPending();
    this.selection = next;
    this.persist();
  }

  /** `updateSelection`: changes the selection in place, and stores it. */
  private updateSelection(selection: Dye2Selected, changes: Partial<Dye2Selected>): void {
    Object.assign(selection, changes);
    if (this.selection === selection) this.persist();
  }

  /**
   * `persistSelection`: DYE2's selection written to its storage, which is
   * its key `selection` in Decaid's store. A clear writes `null`, which
   * Decaid's plugin storage refuses, so the key keeps the selection cleared.
   */
  private persist(): void {
    if (this.selection === null) {
      this.logs.push("storage write of null refused");
      return;
    }
    void this.api("POST", `/store/${DYE2_NAMESPACE}/selection`, this.selection);
  }

  private storeRead(): unknown {
    return this.tablet?.storeValue(DYE2_NAMESPACE, "selection") ?? null;
  }

  private cancelPending(): void {
    this.cancelRecord?.();
    this.cancelRecord = undefined;
  }

  /** `scheduleWorkflowRecord`: drift clears at once, its own apply's echo is ignored, and anything else is recorded after DYE2's wait, the latest Workflow winning. */
  private scheduleWorkflowRecord(workflow: Record_): void {
    const selection = this.selection;
    if (!selection) return;
    const fingerprint = dye2ProfileFingerprint(workflow.profile);
    if (selection.profileFingerprint && fingerprint && fingerprint !== selection.profileFingerprint) {
      this.clearSelection();
      return;
    }
    const now = this.now();
    if (this.suppressed && now - this.suppressed.at < DYE2_ECHO_WINDOW_MS && this.suppressed.values === dye2EchoKey(workflow)) return;
    if (!selection.profileFingerprint) this.updateSelection(selection, { profileFingerprint: fingerprint });
    this.cancelPending();
    const generation = this.generation;
    this.cancelRecord = this.tablet!.schedule(() => {
      this.cancelRecord = undefined;
      if (this.selection !== selection || generation !== this.generation) return;
      this.recordWorkflow(workflow, selection)
        .then((wrote) => {
          if (wrote && generation === this.generation) this.announce();
        })
        .catch((error: unknown) => this.logs.push(`workflow record failed: ${String(error)}`));
    }, DYE2_DEBOUNCE_MS);
  }

  /**
   * `recordWorkflow`: reads the list again, writes the item's changed
   * fields, keeping its embedded `workflow.context` in step for the dose,
   * yield and grind, and rebases `armedBrewC` on the Workflow. Resolves
   * with whether it wrote.
   */
  private async recordWorkflow(workflow: Record_, armed: Dye2Selected): Promise<boolean> {
    const { key, field } = DYE2_TARGETS[armed.kind];
    const route = `/store/${DYE2_NAMESPACE}/${key}`;
    const read = await this.api("GET", route);
    if (read.status !== 200) throw new Error(`HTTP ${read.status} reading ${key}`);
    const list = asList(read.body);
    const index = list.findIndex((item) => item && String(item.id) === armed.id);
    if (index === -1) return false;
    const item = list[index]!;
    const patch = dye2ItemPatch(armed.kind, item, workflow, armed.armedBrewC);
    const live = dye2LiveBrewC(workflow);
    if (live !== armed.armedBrewC) this.updateSelection(armed, { armedBrewC: live });
    if (Object.keys(patch).length === 0) return false;
    const next: Record_ = { ...item, [field]: { ...((item[field] ?? {}) as Record_), ...patch } };
    const embedded = item.workflow as Record_ | undefined;
    if (embedded?.context) {
      const context: Record_ = { ...(embedded.context as Record_) };
      if ("dose" in patch) context.targetDoseWeight = patch.dose;
      if ("drink" in patch) context.targetYield = patch.drink;
      const grind = "grind" in patch ? patch.grind : patch.grindSetting;
      if (grind !== undefined) context.grinderSetting = String(grind);
      next.workflow = { ...embedded, context };
    }
    const written = await this.api("POST", route, list.map((kept, at) => (at === index ? next : kept)));
    if (written.status !== 200) throw new Error(`HTTP ${written.status} writing ${key}`);
    this.recorded.push({ kind: armed.kind, id: armed.id, patch });
    return true;
  }

  /** `refreshRecents`: the recent favourites recomputed in later turns, then a push. Recent favourites themselves are not simulated. */
  private refreshRecents(): void {
    const generation = this.generation;
    setImmediate(() =>
      setImmediate(() => {
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

  private now(): number {
    return this.tablet!.readClock();
  }

  private api(method: "GET" | "POST" | "PUT" | "DELETE", route: string, body?: unknown): Promise<DecaidAnswer> {
    if (!this.tablet) throw new Error("DYE2 is attached to no tablet");
    return this.tablet.callApi(method, route, body);
  }
}

/**
 * DYE2 v0.1.20's dashboard page opened on the tablet
 * (dye2:dye2-plugin/src/pages/dashboard.ts): it reads the Workflow, the
 * grinders, the profiles, hidden ones included, and the recipes once, as it
 * opens (`initializeDyeDashboard`), and keeps that Workflow as its copy,
 * which every change made on it changes and sends whole with `PUT
 * /workflow`, Decaid merging it into the Workflow: so each send puts back
 * whatever the copy holds that changed elsewhere since the page opened, and
 * leaves what the copy lacks.
 */
export async function openDye2Dashboard(tablet: SimulatedTablet): Promise<Dye2Dashboard> {
  const read = async (route: string) => {
    const { status, body } = await tablet.callApi("GET", route);
    return status === 200 ? body : null;
  };
  const [workflow, grinders, profiles, recipes] = await Promise.all([read("/workflow"), read("/grinders"), read("/profiles?includeHidden=true"), read(`/store/${DYE2_NAMESPACE}/recipes`)]);
  return new Dye2Dashboard(tablet, (workflow ?? null) as Record_ | null, asList(grinders), asList(profiles), asList(recipes));
}

/** What a recipe or favourite applied on DYE2's dashboard sent: its `PUT /workflow`, then, once Decaid took it, its `POST .../selection`. */
export interface Dye2Applied {
  workflow: DecaidAnswer;
  selection?: DecaidAnswer;
}

export class Dye2Dashboard {
  constructor(
    private readonly tablet: SimulatedTablet,
    /** The page's copy of the Workflow (`currentWorkflow`), null if its read failed. */
    public workflow: Record_ | null,
    private readonly grinders: Record_[],
    private readonly profiles: Record_[],
    /** The recipes the page read as it opened. */
    readonly recipes: Record_[],
  ) {}

  /**
   * Taps the pill of the recipe in that slot, as the page read it, or the
   * recipe given: `applyRecipe` puts into the page's copy its dose, yield
   * (or its dose times its ratio), grind setting, RPM, Grinder where the
   * page's list holds it, barista and drinker where it names one, its
   * Profile, whole from its `profileSnapshot` where that has steps and
   * otherwise from the profiles, and its steam, hot water and flush values
   * of their modes; the copy is sent, then the recipe selected
   * (`postSelection`), only if Decaid took the Workflow.
   */
  async applyRecipe(recipe: string | Record_): Promise<Dye2Applied> {
    const item = typeof recipe === "string" ? this.recipes.find((candidate) => candidate.id === recipe) : recipe;
    if (!item) throw new Error(`The dashboard read no recipe in slot ${String(recipe)}`);
    const live = (this.workflow ??= {});
    const dv = (item.dashboardVariables ?? {}) as Record_;
    const context: Record_ = { ...((live.context ?? {}) as Record_) };
    if (dv.dose != null) context.targetDoseWeight = dv.dose;
    if (dv.drink != null) context.targetYield = dv.drink;
    else if (dv.ratio != null && dv.dose != null) context.targetYield = Math.round((dv.dose as number) * (dv.ratio as number) * 10) / 10;
    if (dv.grind != null) context.grinderSetting = dv.grind;
    if (dv.rpm != null) context.extras = { ...((context.extras ?? {}) as Record_), rpm: dv.rpm };
    const grinder = dv.grinderId ? this.grinders.find((candidate) => candidate.id === dv.grinderId) : undefined;
    if (grinder) Object.assign(context, { grinderId: grinder.id, grinderModel: grinder.model ?? grinder.name });
    if (item.barista) context.baristaName = item.barista;
    if (item.drinker) context.drinkerName = item.drinker;
    live.context = context;
    if (item.profileId || item.profileTitle) live.profile = await this.profile(item.profileSnapshot, item.profileId, item.profileTitle);
    mergeLiveSettings(live, dv);
    return this.sendAndSelect("recipe", item.id);
  }

  /**
   * Applies a favourite (`applyAutoFavourite`): a saved one chosen on the
   * Auto Favourites page, or a recent one's pill, its `snapshot` put into the
   * copy as its `copyMask` allows, and a recent one's own Workflow context
   * and profile; the copy is sent, then the favourite selected, or, for a
   * recent one, whose id is not stable, the selection cleared with `{}`.
   */
  async applyFavourite(favourite: Record_): Promise<Dye2Applied> {
    const live = (this.workflow ??= {});
    const snapshot = (favourite.snapshot ?? {}) as Record_;
    const mask = (favourite.copyMask ?? {}) as Record_;
    const on = (key: string) => mask[key] !== false;
    const context: Record_ = { ...((live.context ?? {}) as Record_) };
    const extras = () => (context.extras ?? {}) as Record_;
    if (on("dose") && snapshot.dose != null) context.targetDoseWeight = snapshot.dose;
    if (on("drink") && snapshot.drink != null) context.targetYield = snapshot.drink;
    if (on("grindSetting")) {
      if (snapshot.grindSetting != null) context.grinderSetting = String(snapshot.grindSetting);
      if (snapshot.rpm != null) context.extras = { ...extras(), rpm: snapshot.rpm };
    }
    if (on("grinder")) {
      if (snapshot.grinderId) context.grinderId = snapshot.grinderId;
      if (snapshot.grinderModel) context.grinderModel = snapshot.grinderModel;
    }
    if (on("beans")) {
      if (snapshot.beanBatchId) context.beanBatchId = snapshot.beanBatchId;
      if (snapshot.coffeeName) context.coffeeName = snapshot.coffeeName;
      if (snapshot.coffeeRoaster) context.coffeeRoaster = snapshot.coffeeRoaster;
    }
    if (on("roastDate") && snapshot.roastDate) context.roastDate = snapshot.roastDate;
    if (on("barista") && snapshot.barista) context.baristaName = snapshot.barista;
    if (on("drinker") && snapshot.drinker) context.drinkerName = snapshot.drinker;
    if (on("note") && snapshot.note) context.extras = { ...extras(), note: snapshot.note };
    const recorded = (favourite.workflow ?? undefined) as Record_ | undefined;
    if (favourite.auto && recorded?.context) {
      const own = recorded.context as Record_;
      if (on("beans")) for (const key of ["beanBatchId", "coffeeName", "coffeeRoaster"]) context[key] = own[key] ?? null;
      if (on("grinder")) for (const key of ["grinderId", "grinderModel"]) context[key] = own[key] ?? null;
    }
    live.context = context;
    if (on("profile") && (snapshot.profileId || snapshot.profileTitle)) live.profile = await this.profile(snapshot.profileSnapshot, snapshot.profileId, snapshot.profileTitle);
    if (favourite.auto && recorded?.profile) live.profile = recorded.profile;
    return this.sendAndSelect("favourite", favourite.id);
  }

  /**
   * A barista's change on one of the page's dials (`setupDoseControls`),
   * once its 500 ms wait is over: the value put into the copy, the grind as
   * text and the RPM in `extras`, and the whole copy sent.
   */
  async tap(dial: "dose" | "drink" | "grind" | "rpm", value: number): Promise<DecaidAnswer> {
    if (!this.workflow) throw new Error("The dashboard read no Workflow");
    const context = { ...((this.workflow.context ?? {}) as Record_) };
    if (dial === "dose") context.targetDoseWeight = value;
    if (dial === "drink") context.targetYield = value;
    if (dial === "grind") context.grinderSetting = String(value);
    if (dial === "rpm") context.extras = { ...((context.extras ?? {}) as Record_), rpm: value };
    this.workflow.context = context;
    return this.tablet.callApi("PUT", "/workflow", this.workflow);
  }

  /** Done (`setupBottomButtons`): the copy sent once more, as the page leaves; undefined if it read no Workflow. */
  async done(): Promise<DecaidAnswer | undefined> {
    return this.workflow ? this.tablet.callApi("PUT", "/workflow", this.workflow) : undefined;
  }

  private async sendAndSelect(kind: Dye2Selected["kind"], id: unknown): Promise<Dye2Applied> {
    const workflow = await this.tablet.callApi("PUT", "/workflow", this.workflow);
    if (workflow.status !== 200) return { workflow };
    const body = id != null && !String(id).startsWith("recent:") ? { kind, id: String(id) } : {};
    return { workflow, selection: await this.tablet.callApi("POST", `/plugins/${DYE2_NAMESPACE}/selection`, body) };
  }

  /** A profile as the page loads one (`resolveFullProfile`): the snapshot where it has steps, else the record of its id, from the profiles read or read again, else its id and title alone. */
  private async profile(snapshot: unknown, id: unknown, title: unknown): Promise<Record_> {
    if (snapshot && typeof snapshot === "object" && Array.isArray((snapshot as Record_).steps)) return snapshot as Record_;
    if (!id) return { id, title };
    const cached = this.profiles.find((record) => record.id === id);
    if (cached?.profile) return cached.profile as Record_;
    const fresh = asList((await this.tablet.callApi("GET", "/profiles?includeHidden=true")).body).find((record) => record.id === id);
    return fresh?.profile ? (fresh.profile as Record_) : { id, title };
  }
}
