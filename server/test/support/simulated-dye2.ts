import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { DecaidAnswer } from "./decaid-beans.js";
import { type DecaidApi, type SimulatedTablet, derivedDe1Pro } from "./simulated-tablet.js";

// DYE2 `main` at 2cf631c and Streamline `main` at c006dac on a simulated
// tablet, checked against what they were recorded doing on Decaid v0.9.0's
// Linux release (fixtures/decaid/dye2-2cf631c/, whose README lists the steps
// and says what they show). The plugin is not told of them, as of anything
// else on the tablet (`SimulatedTablet.callApi`).
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
// The recorded records name the recording's beans, grinders and profiles by
// their ids: load the tablet with `dye2Library()` for those ids to be the
// tablet's.
//
// DYE2 itself, selecting a recipe or favourite, recording the Workflow's
// changes into it, marking the Workflow with it, pushing and restoring it,
// is `SimulatedDye2` below, with its dashboard (`openDye2Dashboard`).
// Streamline's DYE strip, tiles, wake and post-shot clear are
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
}

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/decaid/dye2-2cf631c");

function readFixture<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(fixtures, `${file}.json`), "utf8")) as T;
}

/** The recorded steps of one of DYE2's pages. */
export function dye2Recording<File extends keyof Dye2Recordings>(file: File): Dye2Recordings[File] {
  return readFixture(file);
}

/** Another file of the recording (fixtures/decaid/dye2-2cf631c/): its library, DYE2's selection, recording and restore, Streamline's strip, and the fingerprints. */
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
 * Workflow, its simulated machine's settings, and DYE2's baskets, its three
 * recipes (slot 1 on `Adaptive v3`, slot 2 on `Classic Italian espresso`
 * and the blank slot 3) and its stored selection, `{}`. Its beans' names
 * start with `scenario` where one is given.
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
    [`/store/${DYE2_NAMESPACE}/selection`]: library.storedSelection,
  };
}

/**
 * DYE2's selected recipe or favourite on the tablet, its kind and id: null
 * for none, on a tablet with a simulated DYE2 (`SimulatedDye2`), whether or
 * not it is loaded; `tablet.dye2.selected()` has the rest of it.
 */
export function dye2Selection(tablet: SimulatedTablet): unknown {
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

// ---- DYE2 running on the tablet: its selected recipe, its recording into it, its marker, its pushes and its dashboard.
//
// DYE2 keeps one selected recipe or favourite
// (dye2:dye2-plugin/src/utils/workflow-record.ts at 2cf631c, ported below
// with attribution, and `handleSelection`, the selection listener and
// `onEvent` in dye2:dye2-plugin/src/plugin.ts). `SimulatedDye2` runs it
// beside the plugin on a tablet loaded with it (`SimulatedTabletOptions.dye2`):
// Decaid lists it at `GET /plugins`, routes `/plugins/dye2.reaplugin/{endpoint}`
// to it while it is loaded and answers 404 otherwise, gives it every
// `workflowUpdated` and `shotStored`, whoever changed the Workflow, the
// plugin's own `PUT /workflow` included, and opens sockets on its `changed`
// endpoint. Its timers are the tablet's, so `timeScale` speeds its 1.5 s
// wait and 3 s echo window as it speeds the plugin's; they stop as the tablet
// unloads, so a record DYE2 had pending then is lost. Its own storage is its
// key `selection` in Decaid's store under `dye2.reaplugin`, as `host.storage`
// keeps it. It reads the DE1's flush temperature and flow from `GET
// /machine/settings` where the tablet answers it (`withMachineSettings`).

/** DYE2's selected recipe or favourite, as `GET .../selection` answers it (`Selection` in workflow-record.ts). */
export interface Dye2Selected {
  kind: "recipe" | "favourite";
  id: string;
  profileFingerprint: string | null;
  armedBrewC: number | null;
  /** The Workflow's batch and grinder when selected, "" for none, null for unknown. */
  armedBeanBatchId: string | null;
  armedGrinderId: string | null;
  /** The Workflow's steam, hot water and flush settings when selected, by `dashboardVariables` name; null for unknown. */
  armedMachine: Record_ | null;
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

/** The two settings DYE2 reads from the DE1's settings rather than the Workflow, and their `GET /machine/settings` names (DE1_ONLY). */
const DE1_ONLY: Readonly<Record<string, string>> = { flushTempC: "flushTemp", flushFlowMls: "flushFlow" };

/**
 * A profile as DYE2 fingerprints it to tell a change of profile
 * (`profileFingerprint` in workflow-record.ts): its title, tank temperature
 * and steps, but each step's temperature; its target weight and volume are
 * the yield, which a change of keeps the selection (dye2#18).
 */
export function dye2ProfileFingerprint(profile: unknown): string | null {
  if (!profile || typeof profile !== "object") return null;
  const record = profile as Record_;
  const steps = Array.isArray(record.steps) ? (record.steps as Record_[]).map(({ temperature: _, ...rest }) => rest) : record.steps;
  return JSON.stringify({ title: record.title, tank_temperature: record.tank_temperature, steps });
}

/** `idOf`: null, undefined and "" all as "". */
function idOf(value: unknown): string {
  return value == null ? "" : String(value);
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
  const extras = (context.extras ?? {}) as Record_;
  dye2Put(out, "rpm", dye2Number(extras.rpm));
  dye2Put(out, "basketId", extras.basketId);
  dye2Put(out, "basketName", extras.basketName);
  const steps = (workflow.profile as Record_ | undefined)?.steps as Record_[] | undefined;
  dye2Put(out, "brewC", dye2Number(steps?.[0]?.temperature));
  for (const [key, [part, field]] of Object.entries(MACHINE_MAP)) dye2Put(out, key, ((workflow[part] ?? {}) as Record_)[field]);
  return out;
}

/** A copy of the Workflow with the DE1-only settings laid over it from a `GET /machine/settings` body (`withMachineSettings`). */
function withMachineSettings(workflow: Record_, de1: Record_ | null): Record_ {
  if (!de1) return workflow;
  const out: Record_ = { ...workflow };
  for (const [name, key] of Object.entries(DE1_ONLY)) {
    if (de1[key] == null) continue;
    const [part, field] = MACHINE_MAP[name]!;
    out[part] = { ...((out[part] ?? {}) as Record_), [field]: de1[key] };
  }
  return out;
}

/** The machine settings of the Workflow that have a value: the baseline DYE2 keeps as it selects (`machineFields`). */
function dye2MachineFields(workflow: Record_): Record_ {
  const all = dye2RecipeFields(workflow);
  return Object.fromEntries(Object.keys(MACHINE_MAP).filter((key) => all[key] !== undefined).map((key) => [key, all[key]]));
}

/** A favourite's snapshot fields: dose, yield, grind and RPM only (`favouriteFields`). */
function dye2FavouriteFields(workflow: Record_): Record_ {
  const out: Record_ = {};
  const context = (workflow.context ?? {}) as Record_;
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
 * What DYE2 writes onto the item for the Workflow (`itemPatch`): the fields
 * the item holds that differ, the brew temperature only once it moved off
 * `armedBrewC`, a machine setting the item does not hold once it moved off
 * its value in `armedMachine`, and the Basket's id and name together.
 */
export function dye2ItemPatch(kind: Dye2Selected["kind"], item: Record_, workflow: Record_, armedBrewC: number | null = null, armedMachine: Record_ | null = null): Record_ {
  const stored = (item[DYE2_TARGETS[kind].field] ?? {}) as Record_;
  const all = kind === "recipe" ? dye2RecipeFields(workflow) : dye2FavouriteFields(workflow);
  const moved = (key: string) => !!armedMachine && key in MACHINE_MAP && armedMachine[key] !== undefined && !sameValue(armedMachine[key], all[key]);
  const known: Record_ = {};
  for (const key of Object.keys(all)) {
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

/** The values DYE2 compares to tell its own apply's echo, the DE1-only pair left out (`echoKey`). */
function dye2EchoKey(workflow: Record_): string {
  const fields = dye2RecipeFields(workflow);
  for (const key of Object.keys(DE1_ONLY)) delete fields[key];
  return JSON.stringify([fields, dye2FavouriteFields(workflow)]);
}

function dye2LiveBrewC(workflow: Record_): number | null {
  const value = dye2RecipeFields(workflow).brewC;
  return typeof value === "number" ? value : null;
}

/** Which item a selection names, as the listener and the marker compare it: `kind:id`, or null. */
const selectionKey = (selection: Dye2Selected | null) => (selection ? `${selection.kind}:${selection.id}` : null);

/** DYE2's entry in `GET /plugins` as recorded while it was loaded (plugins.json), its `loaded` and `autoLoad` set by `listing()`. */
function recordedDye2Listing(): Record_ {
  const { loaded } = dye2MainRecording<{ loaded: { listed: Record_[] } }>("plugins");
  return loaded.listed[0]!;
}

/**
 * DYE2 on a simulated tablet: pass it as the tablet's `dye2`. It starts as
 * `state` says, `loaded` by default, having restored whatever DYE2's store
 * key `selection` held as it loaded, before the plugin did.
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
  /** Each selection marker DYE2 wrote into the Workflow's `context.extras.dye.selection`, in order. */
  readonly marked: ({ kind: string; id: string } | null)[] = [];
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
  /** The item last pushed for (`announcedSelection`) and last marked in the Workflow (`markedKey`), and the marker writes in turn (`markChain`): each load's own. */
  private announcedSelection: string | null = null;
  private markedKey: string | null = null;
  private markChain: Promise<void> = Promise.resolve();
  /** Whether DYE2 had already restored its selection once a tablet was attached, as one loaded before the plugin had. */
  private started = false;
  private refusedSelections = 0;

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
    return this.selection ? structuredClone(this.selection) : null;
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
    this.announcedSelection = null;
    this.markedKey = null;
    this.markChain = Promise.resolve();
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

  /**
   * Decaid answers the next `count` `POST .../selection` 503 without
   * reaching DYE2, as a request it could not hand on, so a test sees a
   * selection fail.
   */
  refuseSelections(count: number): void {
    this.refusedSelections = count;
  }

  /** Resolves once the selection marker writes DYE2 has begun are done. */
  async markersWritten(): Promise<void> {
    await this.markChain;
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
    if (endpoint === "selection" && method !== "GET" && this.refusedSelections > 0) {
      this.refusedSelections--;
      return { status: 503, body: { error: "Refused for the test" } };
    }
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

  /** `handleSelection` in plugin.ts: the Workflow read, with the DE1's flush settings over it, to select on. */
  private async handleSelection(method: string, body: unknown): Promise<DecaidAnswer> {
    if (method === "GET") return { status: 200, body: this.selected() };
    const asked = (body ?? null) as { kind?: unknown; id?: unknown } | null;
    if (!asked || !asked.kind) {
      this.asked.push(null);
      this.setSelection(null);
      return { status: 200, body: null };
    }
    this.asked.push({ kind: String(asked.kind), id: String(asked.id) });
    const generation = this.generation;
    const read = await this.api("GET", "/workflow");
    let workflow = read.status === 200 ? (read.body as Record_) : null;
    if (workflow) workflow = withMachineSettings(workflow, await this.readMachineSettings());
    if (generation !== this.generation) return { status: 404, body: { error: `plugin with ${DYE2_NAMESPACE} not loaded` } };
    const selected = this.armSelection(asked, workflow);
    return { status: 200, body: selected ? structuredClone(selected) : null };
  }

  /** `readMachineSettings`: `GET /machine/settings`, or null on any failure. */
  private async readMachineSettings(): Promise<Record_ | null> {
    const { status, body } = await this.api("GET", "/machine/settings");
    return status === 200 && body && typeof body === "object" ? (body as Record_) : null;
  }

  /** `armSelection`: selects the item on the Workflow, with its fingerprint, brew temperature, batch, grinder and machine settings, and takes the Workflow as its echo; a `recent:` id or no kind clears. */
  private armSelection(asked: { kind?: unknown; id?: unknown }, workflow: Record_ | null): Dye2Selected | null {
    const { kind, id } = asked;
    if ((kind !== "recipe" && kind !== "favourite") || id == null || id === "" || String(id).startsWith("recent:")) {
      this.setSelection(null);
      return null;
    }
    const context = (workflow?.context ?? {}) as Record_;
    this.setSelection({
      kind,
      id: String(id),
      profileFingerprint: dye2ProfileFingerprint(workflow?.profile),
      armedBrewC: workflow ? dye2LiveBrewC(workflow) : null,
      armedBeanBatchId: workflow ? idOf(context.beanBatchId) : null,
      armedGrinderId: workflow ? idOf(context.grinderId) : null,
      armedMachine: workflow ? dye2MachineFields(workflow) : null,
    });
    if (workflow) this.suppressed = { values: dye2EchoKey(workflow), at: this.now() };
    return this.selection;
  }

  /** `restoreSelection`: a stored selection taken back as it was, anything else, `{}` included, as none, and taken as marked; nothing is stored or pushed. */
  private restoreSelection(raw: unknown): void {
    const stored = raw as Record_ | null;
    this.selection =
      stored && (stored.kind === "recipe" || stored.kind === "favourite") && stored.id != null && !String(stored.id).startsWith("recent:")
        ? {
            kind: stored.kind,
            id: String(stored.id),
            profileFingerprint: (stored.profileFingerprint as string | null | undefined) || null,
            armedBrewC: typeof stored.armedBrewC === "number" ? stored.armedBrewC : null,
            armedBeanBatchId: typeof stored.armedBeanBatchId === "string" ? stored.armedBeanBatchId : null,
            armedGrinderId: typeof stored.armedGrinderId === "string" ? stored.armedGrinderId : null,
            armedMachine: stored.armedMachine && typeof stored.armedMachine === "object" ? (stored.armedMachine as Record_) : null,
          }
        : null;
    this.markedKey = selectionKey(this.selection);
    this.announcedSelection = this.markedKey;
  }

  /** `setSel`: what was pending belongs to the previous selection; the new one is told to the listener. */
  private setSelection(next: Dye2Selected | null): void {
    this.cancelPending();
    this.selection = next;
    this.selectionChanged(next);
  }

  /** `updateSelection`: changes the selection in place, and tells the listener. */
  private updateSelection(selection: Dye2Selected, changes: Partial<Dye2Selected>): void {
    Object.assign(selection, changes);
    if (this.selection === selection) this.selectionChanged(selection);
  }

  /**
   * The selection listener in plugin.ts: the selection stored, `{}` for
   * none, the Workflow marked with it, and a push, only when which item is
   * selected changed.
   */
  private selectionChanged(selection: Dye2Selected | null): void {
    void this.api("POST", `/store/${DYE2_NAMESPACE}/selection`, selection ?? {});
    this.syncSelectionMarker().catch((error: unknown) => this.logs.push(`selection marker failed: ${String(error)}`));
    const key = selectionKey(selection);
    if (key === this.announcedSelection) return;
    this.announcedSelection = key;
    this.announce();
  }

  /**
   * `syncSelectionMarker`: the selected item written into the Workflow as
   * `context.extras.dye.selection`, `{ kind, id }` or null, by `PUT
   * /workflow`, one write after another, each only if the item differs from
   * the one last marked.
   */
  private syncSelectionMarker(): Promise<void> {
    const generation = this.generation;
    const run = this.markChain.then(async () => {
      if (generation !== this.generation) return;
      const key = selectionKey(this.selection);
      if (key === this.markedKey) return;
      const marker = this.selection ? { kind: this.selection.kind, id: this.selection.id } : null;
      const answer = await this.api("PUT", "/workflow", { context: { extras: { dye: { v: 1, selection: marker } } } });
      if (answer.status !== 200) throw new Error(`HTTP ${answer.status} writing selection marker`);
      this.marked.push(marker);
      this.markedKey = key;
    });
    this.markChain = run.catch(() => {});
    return run;
  }

  private storeRead(): unknown {
    return this.tablet?.storeValue(DYE2_NAMESPACE, "selection") ?? null;
  }

  private cancelPending(): void {
    this.cancelRecord?.();
    this.cancelRecord = undefined;
  }

  /**
   * `scheduleWorkflowRecord`: a change of profile, or of the batch or grinder
   * the selection was made on, clears it at once, its own apply's echo is
   * ignored, the baselines it lacks are adopted, and anything else is
   * recorded after DYE2's wait, the latest Workflow winning.
   */
  private scheduleWorkflowRecord(workflow: Record_): void {
    const selection = this.selection;
    if (!selection) return;
    const fingerprint = dye2ProfileFingerprint(workflow.profile);
    const context = (workflow.context ?? {}) as Record_;
    const profileDrifted = !!(selection.profileFingerprint && fingerprint && fingerprint !== selection.profileFingerprint);
    const contextDrifted =
      (!!selection.armedBeanBatchId && selection.armedBeanBatchId !== idOf(context.beanBatchId)) || (!!selection.armedGrinderId && selection.armedGrinderId !== idOf(context.grinderId));
    if (profileDrifted || contextDrifted) {
      this.setSelection(null);
      return;
    }
    const now = this.now();
    if (this.suppressed && now - this.suppressed.at < DYE2_ECHO_WINDOW_MS && this.suppressed.values === dye2EchoKey(workflow)) return;
    if (!selection.profileFingerprint) this.updateSelection(selection, { profileFingerprint: fingerprint });
    if (!selection.armedMachine) this.updateSelection(selection, { armedMachine: dye2MachineFields(workflow) });
    if (!selection.armedBeanBatchId || !selection.armedGrinderId) {
      this.updateSelection(selection, {
        armedBeanBatchId: selection.armedBeanBatchId || idOf(context.beanBatchId),
        armedGrinderId: selection.armedGrinderId || idOf(context.grinderId),
      });
    }
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
   * fields, keeping its embedded `workflow` in step (its context's dose,
   * yield, grind, RPM and Basket, its machine settings, and its profile at a
   * recorded brew temperature), and rebases `armedBrewC` on the Workflow.
   * The DE1's flush settings are read first where the item holds one or the
   * selection's baseline has one. Resolves with whether it wrote.
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
    const stored = (item[field] ?? {}) as Record_;
    const wantsDe1 = Object.keys(DE1_ONLY).some((name) => stored[name] != null || (armed.armedMachine && armed.armedMachine[name] !== undefined));
    const full = wantsDe1 ? withMachineSettings(workflow, await this.readMachineSettings()) : workflow;
    const patch = dye2ItemPatch(armed.kind, item, full, armed.armedBrewC, armed.armedMachine);
    const live = dye2LiveBrewC(workflow);
    if (live !== armed.armedBrewC) this.updateSelection(armed, { armedBrewC: live });
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

// ---- DYE2's dashboard page (dye2:dye2-plugin/src/pages/dashboard.ts at 2cf631c).

/** The context fields DYE2 flags for Streamline's post-shot clear (`DYE_TOP_KEYS`, `DYE_EXTRAS_KEYS` in dev-api.ts). */
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

/** The machine settings a recipe holds, as the Workflow's partial parts (`recipeMachineSettings` in dev-api.ts). */
function recipeMachineSettings(dv: Record_): Record<string, Record_> {
  const out: Record<string, Record_> = {};
  for (const [name, [part, field]] of Object.entries(MACHINE_MAP)) if (dv[name] != null) (out[part] ??= {})[field] = dv[name];
  return out;
}

/** A copy of the profile with its first step at `first` and the others moved by as much, each at `first` with no first step to move from (`profileAtBrewTemp` in dev-api.ts). */
function profileAtBrewTemp(profile: Record_, first: unknown): Record_ {
  if (!Array.isArray(profile.steps)) return profile;
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

/**
 * DYE2's dashboard page opened on the tablet: it reads the Workflow, the
 * grinders, the profiles, hidden ones included, and the recipes once, as it
 * opens (`initializeDyeDashboard`), and keeps that Workflow as its copy,
 * which every change made on it changes and sends whole with `PUT
 * /workflow`, without the copy's `extras.dye.selection`, which is DYE2's
 * (`updateWorkflow` in dev-api.ts), Decaid merging it into the Workflow: so
 * each send puts back whatever the copy holds that changed elsewhere since
 * the page opened, and leaves what the copy lacks.
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
  /** The body of the page's last `PUT /workflow`. */
  lastSent: Record_ | undefined;

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
   * recipe given: it reads the recipes again and applies the tablet's record
   * of it where it holds one (dye2#28). `applyRecipe` puts into the page's
   * copy its dose, yield (or its dose times its ratio), grind setting, RPM,
   * Grinder where the page's list holds it, its Bean's coffee, roaster and
   * batch where it names a Bean, null for those it lacks, its barista and
   * drinker where it names one, flagging each in `extras.dye` (`markDye`),
   * its Profile, whole from its `profileSnapshot` where that has steps and
   * otherwise from the profiles, at its brew temperature (`profileAtBrewTemp`),
   * and every machine setting it holds, laid over the copy's parts; the copy
   * is sent, then the recipe selected (`postSelection`), only if Decaid took
   * the Workflow.
   */
  async applyRecipe(recipe: string | Record_): Promise<Dye2Applied> {
    const item = typeof recipe === "string" ? this.recipes.find((candidate) => candidate.id === recipe) : recipe;
    if (!item) throw new Error(`The dashboard read no recipe in slot ${String(recipe)}`);
    const reread = await this.tablet.callApi("GET", `/store/${DYE2_NAMESPACE}/recipes`);
    const fresh = (reread.status === 200 ? asList(reread.body).find((candidate) => candidate && candidate.id === item.id) : undefined) ?? item;
    const live = (this.workflow ??= {});
    const dv = (fresh.dashboardVariables ?? {}) as Record_;
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
      Object.assign(context, { grinderId: grinder.id, grinderModel: grinder.model ?? grinder.name });
      wrote.push("grinderId", "grinderModel");
    }
    if (fresh.beanId || fresh.beanName) {
      Object.assign(context, { coffeeName: fresh.beanName || null, coffeeRoaster: fresh.beanRoaster || null, beanBatchId: fresh.beanBatchId || null });
      wrote.push("coffeeName", "coffeeRoaster", "beanBatchId");
    }
    if (fresh.barista) {
      context.baristaName = fresh.barista;
      wrote.push("baristaName");
    }
    if (fresh.drinker) {
      context.drinkerName = fresh.drinker;
      wrote.push("drinkerName");
    }
    live.context = markDye(context, wrote);
    if (fresh.profileId || fresh.profileTitle) live.profile = await this.profile(fresh.profileSnapshot, fresh.profileId, fresh.profileTitle);
    if (dv.brewC != null && live.profile) live.profile = profileAtBrewTemp(live.profile as Record_, dv.brewC);
    for (const [part, values] of Object.entries(recipeMachineSettings(dv))) if (live[part]) live[part] = { ...(live[part] as Record_), ...values };
    return this.sendAndSelect("recipe", fresh.id);
  }

  /**
   * Applies a favourite (`applyAutoFavourite`): a saved one chosen on the
   * Auto Favourites page, or a recent one's pill, its `snapshot` put into the
   * copy as its `copyMask` allows, and a recent one's own Workflow context
   * and profile, flagging what it wrote in `extras.dye`; the copy is sent,
   * then the favourite selected, or, for a recent one, whose id is not
   * stable, the selection cleared with `{}`.
   */
  async applyFavourite(favourite: Record_): Promise<Dye2Applied> {
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
    live.context = markDye(context, wrote);
    if (on("profile") && (snapshot.profileId || snapshot.profileTitle)) live.profile = await this.profile(snapshot.profileSnapshot, snapshot.profileId, snapshot.profileTitle);
    if (favourite.auto && recorded?.profile) live.profile = recorded.profile;
    return this.sendAndSelect("favourite", favourite.id);
  }

  /**
   * A barista's change on one of the page's dials (`setupDoseControls`),
   * once its 500 ms wait is over: the value put into the copy, the grind as
   * text and the RPM in `extras`, flagged (`markDye`), and the whole copy
   * sent.
   */
  async tap(dial: "dose" | "drink" | "grind" | "rpm", value: number): Promise<DecaidAnswer> {
    if (!this.workflow) throw new Error("The dashboard read no Workflow");
    const context = { ...((this.workflow.context ?? {}) as Record_) };
    if (dial === "dose") context.targetDoseWeight = value;
    if (dial === "drink") context.targetYield = value;
    if (dial === "grind") context.grinderSetting = String(value);
    if (dial === "rpm") markDye(Object.assign(context, { extras: { ...((context.extras ?? {}) as Record_), rpm: value } }), ["rpm"]);
    this.workflow.context = context;
    return this.send();
  }

  /** Done (`setupBottomButtons`): the copy sent once more, as the page leaves; undefined if it read no Workflow. */
  async done(): Promise<DecaidAnswer | undefined> {
    return this.workflow ? this.send() : undefined;
  }

  /** `updateWorkflow` in dev-api.ts: the copy sent without its `extras.dye.selection`. */
  private send(): Promise<DecaidAnswer> {
    const body = structuredClone(this.workflow ?? {});
    const dye = ((body.context as Record_ | undefined)?.extras as Record_ | undefined)?.dye as Record_ | undefined;
    if (dye && "selection" in dye) delete dye.selection;
    this.lastSent = body;
    return this.tablet.callApi("PUT", "/workflow", body);
  }

  private async sendAndSelect(kind: Dye2Selected["kind"], id: unknown): Promise<Dye2Applied> {
    const workflow = await this.send();
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
