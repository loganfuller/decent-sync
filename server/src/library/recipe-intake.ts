import {
  RECIPE_SETTINGS,
  RECIPE_SETTING_NAMES,
  RECIPE_SHOWN_FIELD,
  RECIPE_SLOT_FIELD,
  STEAM_ON_FROM,
  dye2GlobalIdOf,
  dye2Records,
  profileAtBrewTemperature,
  recipeSlotOf,
  sameValue,
  workflowPatch,
} from "@decent-sync/protocol";
import { isObject } from "./listed.js";
import { type FieldEdits, changedFields } from "./merge.js";

// How a DYE2 recipe record on a tablet maps to a Recipe, both ways
// (ADR-0005). Pure, so module tests can drive it; recipes.ts reads what it
// needs and carries the mapping out.
//
// A Recipe's content is kept in the Library's terms: its Bean, Bean Batch,
// Grinder, Basket and Tools by their global ids, its Profile by Decaid's id,
// its dial, and the steam, hot water and flush settings it holds
// (RECIPE_SETTINGS). A tablet's record names those items by its own ids,
// nests its dial and settings in `dashboardVariables`, and copies names and
// a Workflow from the items it names. So the server compares and writes a record by its fields'
// paths (`recipeView`), a field of its `dashboardVariables` as
// `dashboardVariables.dose`: the paths it writes are the record's view, and
// those a barista edits are taken in as edits of the Recipe's content
// (`libraryValues`), each read through the tablet's map. The rest DYE2
// derives (`title`, `subtitle`, the embedded `workflow`, the names it copies
// and `profileSnapshot`), and the barista and drinker, which a Recipe never
// carries, are written but never taken in. A setting the Recipe holds none
// of is written blank, so applying the record leaves the Machine's own. A
// record's Recipe Slot (`stripSlot`) is its Location's state, not its
// content, and so is whether Streamline's strip shows it
// (`showOnStreamlineDashboard`): a recipe is on the strip exactly while it
// is in a slot (DYE2 v0.1.32), so a record is written shown exactly while
// its Recipe is in one, and a tablet's change of either moves the Recipe,
// a hidden record being in none (`slotMove`, `recipeSlotOf`).

const DV = "dashboardVariables";

/** The paths of a recipe record the server writes, in a record's own field or its `dashboardVariables`. */
const RECIPE_PATHS = [
  "name",
  "beverage",
  "barista",
  "drinker",
  "beanId",
  "beanName",
  "beanBatchId",
  "beanRoaster",
  "profileId",
  "profileTitle",
  "profileSnapshot",
  RECIPE_SHOWN_FIELD,
  RECIPE_SLOT_FIELD,
  `${DV}.dose`,
  `${DV}.drink`,
  `${DV}.ratio`,
  `${DV}.brewC`,
  `${DV}.steamMode`,
  `${DV}.hotWaterMode`,
  ...RECIPE_SETTING_NAMES.map((setting) => `${DV}.${RECIPE_SETTINGS[setting].dye2}`),
  `${DV}.grind`,
  `${DV}.rpm`,
  `${DV}.grinderId`,
  `${DV}.grinderModel`,
  `${DV}.basketId`,
  `${DV}.basketName`,
  `${DV}.equipmentIds`,
  `${DV}.equipmentNames`,
  `${DV}.equipmentCustom`,
  "title",
  "subtitle",
  "workflow",
];

/** A recipe record's fields the server writes, by their paths (`RECIPE_PATHS`). */
export type RecipeView = Record<string, unknown>;

/**
 * The fields of a Recipe's content a barista's change to a record's path
 * edits, each by the path it is read from. The Bean and Profile are read
 * from more than one path (`libraryValues`).
 */
const EDITED: Readonly<Record<string, string>> = {
  name: "name",
  beverage: "beverage",
  [`${DV}.dose`]: "dose",
  [`${DV}.drink`]: "yield",
  [`${DV}.ratio`]: "ratio",
  [`${DV}.brewC`]: "brewTemperature",
  [`${DV}.steamMode`]: "steamMode",
  [`${DV}.hotWaterMode`]: "hotWaterMode",
  [`${DV}.grind`]: "grindSetting",
  [`${DV}.rpm`]: "rpm",
  ...Object.fromEntries(RECIPE_SETTING_NAMES.map((setting) => [`${DV}.${RECIPE_SETTINGS[setting].dye2}`, setting])),
};

/** The path of a recipe record holding its steam temperature, which DYE2's editor saves as 0 for steam off. */
const STEAM_TEMPERATURE_PATH = `${DV}.${RECIPE_SETTINGS.steamTemperature.dye2}`;

/** The paths a barista edits, which are taken in as edits of the Recipe: but those DYE2 derives, the barista and drinker, and the server's own field. */
export const EDITED_PATHS: ReadonlySet<string> = new Set([
  ...Object.keys(EDITED),
  "beanId",
  "beanBatchId",
  "profileId",
  "profileSnapshot",
  `${DV}.grinderId`,
  `${DV}.basketId`,
  `${DV}.equipmentIds`,
  `${DV}.equipmentCustom`,
]);

/** A recipe's record as a tablet reported it, one Decent Sync can take in. */
export interface ReportedRecipe {
  /** Its id on the tablet: its record id, the same on every tablet at its Recipe's Location. */
  localId: string;
  /** The global id its own field carries, if any. */
  globalId: string | null;
  /** When the plugin first read its content, in UTC. */
  updatedAt: Date;
  /** The record, as DYE2 keeps it. */
  record: Record<string, unknown>;
}

/**
 * The records of a reported list of recipes that Decent Sync can take in,
 * each with when the plugin first read it, as it placed it beside the list;
 * none from a list in a shape it does not recognise (`dye2Records`). A
 * record without a time is left out.
 */
export function readReportedRecipes(value: unknown, updatedAt: readonly (string | null)[] | undefined): ReportedRecipe[] {
  const records = dye2Records(value);
  if (records === null) return [];
  return records.flatMap((record, index) => {
    const time = updatedAt?.[index];
    if (!time || typeof record.id !== "string") return [];
    return [{ localId: record.id, globalId: dye2GlobalIdOf(record), updatedAt: new Date(time), record }];
  });
}

/** The value at a path of a record: a field of its own, or of its `dashboardVariables`; undefined for none. */
function valueAt(record: Readonly<Record<string, unknown>>, path: string): unknown {
  if (!path.startsWith(`${DV}.`)) return record[path];
  const variables = record[DV];
  return isObject(variables) ? variables[path.slice(DV.length + 1)] : undefined;
}

/** A recipe record's fields the server writes, by their paths; a field it does not hold is null. */
export function recipeView(record: Readonly<Record<string, unknown>>): RecipeView {
  return Object.fromEntries(RECIPE_PATHS.map((path) => [path, valueAt(record, path) ?? null]));
}

/** A record holding a view's fields at their paths: what a create writes, a null field left out. */
export function recordOf(view: Readonly<RecipeView>): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  const variables: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(view)) {
    if (value === null || value === undefined) continue;
    if (path.startsWith(`${DV}.`)) variables[path.slice(DV.length + 1)] = value;
    else record[path] = value;
  }
  return { ...record, [DV]: variables };
}

/** The tablet's ids for the Library's items, and back: its map (ADR-0006). */
export interface TabletIds {
  /** The tablet's id for its record of an item, by the item's global id; undefined where it holds none. */
  local(kind: MappedKind, itemId: string): string | undefined;
  /** The item a record of the tablet's is, by its id there; undefined where the map holds none. */
  item(kind: MappedKind, localId: string): string | undefined;
}

/** The kinds a recipe names by the tablet's ids for them. */
export type MappedKind = "bean" | "beanBatch" | "grinder" | "basket" | "tool";

/** A tablet's map, as `TabletIds`, from its rows: each kind's records, by item and id there. */
export function tabletIds(rows: readonly { kind: MappedKind; itemId: string; localId: string }[]): TabletIds {
  const locals = new Map(rows.map((row) => [`${row.kind}:${row.itemId.toLowerCase()}`, row.localId]));
  const items = new Map(rows.map((row) => [`${row.kind}:${row.localId}`, row.itemId.toLowerCase()]));
  return {
    local: (kind, itemId) => locals.get(`${kind}:${itemId.toLowerCase()}`),
    item: (kind, localId) => items.get(`${kind}:${localId}`),
  };
}

/** What taking a tablet's record into a Recipe reads besides it. */
export interface IntakeContext {
  ids: TabletIds;
  /** The Grinders of the Recipe's Location, not Archived: a Recipe names only one of them. */
  grinders: ReadonlySet<string>;
  /** Each Bean Batch's Bean, for the Recipe's batch now and the batch a record holds. */
  batchBeans: ReadonlyMap<string, string>;
  /** Each Bean's batch most recently added at the Recipe's Location, still there, or null where none is. */
  latestBatches: ReadonlyMap<string, string | null>;
  /** The Library Profile the record's `profileSnapshot` is (`profileOfSql` in shots/links.ts), for a record naming no `profileId`; null for none. */
  snapshotProfile: string | null;
}

/**
 * The values of a Recipe's content that the paths given of a tablet's
 * record (`fields`) set, in the Library's terms, as edits of `current`, its
 * content now (empty for a new one):
 *
 * - its Bean and Bean Batch, by the tablet's map: the batch the record
 *   holds with its Bean, as DYE2's editor saves one picked with it, or with
 *   none, as its `save-recipe` saves one from the Workflow; or, for a record
 *   holding none, or one of another Bean, the Recipe's kept where
 *   it is of that Bean, and otherwise that Bean's batch most recently added
 *   at the Location, or none (ADR-0005);
 * - its Profile, by `profileId`, or else the Library Profile its
 *   `profileSnapshot` is, as DYE2 saves one read from the Workflow, a
 *   snapshot that is none of the Library's changing none;
 * - its Grinder, only one of its Location's, a change to any other being
 *   none; its Basket, keeping the Recipe's where the tablet holds no record
 *   of it and names none; and its Tools with their attributes, keeping those
 *   of the Recipe's the tablet holds no record of, which it was never
 *   written, where they were;
 * - its steam temperature, but one below STEAM_ON_FROM, which is steam
 *   off, as DYE2's editor saves "Off" as 0: steam on and off is each
 *   Machine's own (`steamOffPaths`), and DYE2 saves none of the steam
 *   settings from a Workflow whose steam is off;
 * - and the rest of its dial and settings as they are, one the record holds
 *   none of holding none.
 *
 * A record the map does not hold, or one of the tablet's own, names none.
 */
export function libraryValues(view: Readonly<RecipeView>, fields: Iterable<string>, current: Readonly<Record<string, unknown>>, context: IntakeContext): Record<string, unknown> {
  const { ids } = context;
  const values: Record<string, unknown> = {};
  const changed = new Set(fields);
  for (const [path, field] of Object.entries(EDITED)) if (changed.has(path)) values[field] = view[path] ?? null;
  if (changed.has("beanId") || changed.has("beanBatchId")) {
    // The batch DYE2 holds with its Bean, as its editor's picker chose it (decentespresso/dye2#27).
    const picked = typeof view.beanBatchId === "string" ? (ids.item("beanBatch", view.beanBatchId) ?? null) : null;
    // A record naming a batch and no Bean, as DYE2's `save-recipe` saves one from the Workflow, names the batch's Bean.
    const fromBatch = typeof view.beanId !== "string" && picked !== null ? (context.batchBeans.get(picked) ?? null) : null;
    const beanId = typeof view.beanId === "string" ? (ids.item("bean", view.beanId) ?? null) : fromBatch;
    if (changed.has("beanId") || fromBatch !== null) values.beanId = beanId;
    const kept = typeof current.beanBatchId === "string" && beanId !== null && context.batchBeans.get(current.beanBatchId) === beanId;
    if (picked !== null && beanId !== null && context.batchBeans.get(picked) === beanId) values.beanBatchId = picked;
    else values.beanBatchId = kept ? current.beanBatchId : beanId === null ? null : (context.latestBatches.get(beanId) ?? null);
  }
  if (changed.has("profileId") || (changed.has("profileSnapshot") && typeof view.profileId !== "string")) {
    const named = typeof view.profileId === "string" && view.profileId !== "" ? view.profileId : context.snapshotProfile;
    // A profile read from the Workflow that is no Library Profile names none the Library knows: the Recipe's stays.
    if (named !== null || !isObject(view.profileSnapshot)) values.profileId = named;
  }
  if (steamOffPaths({ [STEAM_TEMPERATURE_PATH]: view[STEAM_TEMPERATURE_PATH] }).length > 0) delete values.steamTemperature;
  if (changed.has(`${DV}.grinderId`)) {
    const local = view[`${DV}.grinderId`];
    const grinderId = typeof local === "string" ? (ids.item("grinder", local) ?? null) : null;
    if (grinderId === null || context.grinders.has(grinderId)) values.grinderId = grinderId;
  }
  if (changed.has(`${DV}.basketId`)) {
    const local = view[`${DV}.basketId`];
    const basketId = typeof local === "string" ? (ids.item("basket", local) ?? null) : null;
    // A Basket the tablet holds no record of was never written to it, so a record naming none cannot have dropped it.
    const unheldBasket = typeof current.basketId === "string" && ids.local("basket", current.basketId) === undefined;
    if (basketId !== null || !unheldBasket) values.basketId = basketId;
  }
  // Tools the tablet holds no record of were never written to it, so its record cannot name them: they stay, where they were.
  const unheld = (toolId: string) => ids.local("tool", toolId) === undefined;
  if (changed.has(`${DV}.equipmentIds`)) {
    const reported = Array.isArray(view[`${DV}.equipmentIds`]) ? (view[`${DV}.equipmentIds`] as unknown[]) : [];
    const named = reported.flatMap((local) => (typeof local === "string" ? [ids.item("tool", local)] : [])).filter((id): id is string => id !== undefined);
    const currentTools = (Array.isArray(current.toolIds) ? (current.toolIds as unknown[]) : []).filter((id): id is string => typeof id === "string");
    // The tablet's Tools, in its order, fill the places of the Tools it held; those it did not hold keep theirs.
    const queue = [...new Set(named)].filter((id) => !unheld(id));
    const tools = currentTools.flatMap((id) => (unheld(id) ? [id] : queue.length > 0 ? [queue.shift()!] : []));
    values.toolIds = [...new Set([...tools, ...queue])];
  }
  if (changed.has(`${DV}.equipmentCustom`)) {
    const reported = isObject(view[`${DV}.equipmentCustom`]) ? (view[`${DV}.equipmentCustom`] as Record<string, unknown>) : {};
    const attributes: Record<string, unknown> = {};
    for (const [local, value] of Object.entries(reported)) {
      const toolId = ids.item("tool", local);
      if (toolId !== undefined) attributes[toolId] = value;
    }
    const kept = isObject(current.toolAttributes) ? current.toolAttributes : {};
    for (const [toolId, value] of Object.entries(kept)) if (unheld(toolId)) attributes[toolId] = value;
    values.toolAttributes = attributes;
  }
  return values;
}

/**
 * The values of an edit of a Recipe read from the tablet's record of it
 * (`values`, as `libraryValues` reads them), but each the Recipe holds
 * already (`content`) by that tablet's own latest edit of it (`fieldEdits`):
 * the same edit reaching the server twice, as in a report of the record and
 * in the answer to a write of it the plugin made from a read before that
 * report.
 */
export function withoutOwnEdits(
  values: Readonly<Record<string, unknown>>,
  content: Readonly<Record<string, unknown>>,
  fieldEdits: FieldEdits,
  tabletId: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(([field, value]) => {
      const latest = Object.prototype.hasOwnProperty.call(fieldEdits, field) ? fieldEdits[field] : undefined;
      return !(latest?.tabletId === tabletId && sameValue(content[field] ?? null, value));
    }),
  );
}

/**
 * Whether a tablet's record of a recipe (`reported`) is a save of DYE2's
 * editor over the one known (`known`): DYE2 stamps `capturedAt` anew on each
 * save, but not as it records the Workflow into the recipe it has selected
 * (ADR-0005), so a save is the barista's edit of the Recipe, which no
 * Workflow holds yet, rather than a recording of one.
 */
export function savedInEditor(known: Readonly<Record<string, unknown>>, reported: Readonly<Record<string, unknown>>): boolean {
  return !sameValue(known.capturedAt ?? null, reported.capturedAt ?? null);
}

/** A new Recipe's content from a tablet's record: every field a barista edits, a field it holds no value for left out. */
export function recipeContent(view: Readonly<RecipeView>, context: IntakeContext): Record<string, unknown> {
  const values = libraryValues(view, EDITED_PATHS, {}, context);
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null));
}

/**
 * The paths of a tablet's changes of its record (`changed`, its paths with
 * their values) that turn steam off, which is no edit of the Recipe: a steam
 * temperature below STEAM_ON_FROM, as DYE2's editor saves for "Off". The
 * Recipe's is written back over it (ADR-0022).
 */
export function steamOffPaths(changed: Readonly<Record<string, unknown>>): string[] {
  const value = changed[STEAM_TEMPERATURE_PATH];
  return typeof value === "number" && value < STEAM_ON_FROM ? [STEAM_TEMPERATURE_PATH] : [];
}

/** The paths a barista edited, of those `changed` names (`editedContent` in equipment-intake.ts), that are edits of the Recipe. */
export function editedPaths(changed: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(changed).filter((path) => EDITED_PATHS.has(path));
}

/**
 * What else an edit setting `values` over a Recipe's content (`current`)
 * sets of its dose, yield and DYE2's ratio, which DYE2's editor keeps only
 * while the yield is the dose times it, to a tenth of a gram: a ratio set
 * without a yield, as a Conflict about it holds, sets the yield to the dose
 * times it, as picking a ratio in DYE2's editor does, and is refused
 * (`NoDoseForRatio`) for a Recipe with no dose, which it cannot be applied
 * to; and a ratio the edit leaves otherwise than the yield is cleared.
 * Nothing for an edit setting none of them, or one keeping them so.
 */
export function ratioValues(current: Readonly<Record<string, unknown>>, values: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const has = (field: string) => Object.prototype.hasOwnProperty.call(values, field);
  if (!has("dose") && !has("yield") && !has("ratio")) return {};
  const ratio = has("ratio") ? values.ratio : current.ratio;
  if (typeof ratio !== "number") return {};
  const dose = has("dose") ? values.dose : current.dose;
  const scaled = typeof dose === "number" ? Math.round(dose * ratio * 10) / 10 : null;
  if (has("ratio") && !has("yield")) {
    if (scaled === null) throw new NoDoseForRatio();
    return { yield: scaled };
  }
  const drink = has("yield") ? values.yield : current.yield;
  return scaled !== null && typeof drink === "number" && Math.abs(drink - scaled) < 0.05 ? {} : { ratio: null };
}

/** A ratio set on a Recipe with no dose to apply it to (`ratioValues`). */
export class NoDoseForRatio extends Error {
  constructor() {
    super("This Recipe has no dose to apply a ratio to: set its dose first");
  }
}

/** What writing a Recipe to a tablet reads besides it: the tablet's ids for what it names, and what DYE2 copies of each. */
export interface WriteContext {
  ids: TabletIds;
  /** Each Bean's name, by its global id. */
  beanNames: ReadonlyMap<string, string | null>;
  /** Each Bean's roaster, by its global id. */
  beanRoasters: ReadonlyMap<string, string | null>;
  /** Each Grinder's model. */
  grinderModels: ReadonlyMap<string, string | null>;
  /** Each Basket's name. */
  basketNames: ReadonlyMap<string, string | null>;
  /** Each Tool's name. */
  toolNames: ReadonlyMap<string, string | null>;
  /** Each Profile's `profile`, as Decaid keeps it, by Decaid's id; absent for one the Library does not have. */
  profiles: ReadonlyMap<string, Record<string, unknown>>;
}

/**
 * The record a tablet holds of a Recipe in a slot, or none (null), by the
 * paths the server writes (`RECIPE_PATHS`): its Recipe Slot as
 * RECIPE_SLOT_FIELD, null for none, as DYE2 holds one, which Streamline
 * places it on its strip by, and shown on the strip (RECIPE_SHOWN_FIELD)
 * exactly while it is in one, as DYE2 v0.1.32 holds a recipe hidden from the
 * strip in no slot (`updateRecipe` in dye2:dye2-plugin/src/utils/dev-api.ts);
 * its content, naming its Bean, Bean Batch,
 * Grinder, Basket and Tools by the tablet's ids, and its Profile by
 * Decaid's, each left out where the tablet holds no record of it, and the
 * names DYE2 copies from them; its full Profile in `profileSnapshot`, so it
 * applies where the Profile is hidden; its brew temperature, its Profile's
 * first step's where it holds none, which DYE2 records into only a record
 * holding one, and applies (ADR-0022); a blank barista and drinker; each
 * steam, hot water and flush setting it holds, blank where it holds none;
 * and `title`, `subtitle` and the embedded `workflow` as DYE2 derives them
 * (`recipeWorkflow`).
 */
export function recipeRecord(content: Readonly<Record<string, unknown>>, slot: number | null, context: WriteContext, recipeId: string): RecipeView {
  const { ids } = context;
  const id = (key: string) => (typeof content[key] === "string" ? (content[key] as string) : null);
  const local = (kind: Parameters<TabletIds["local"]>[0], itemId: string | null) => (itemId === null ? null : (ids.local(kind, itemId) ?? null));
  const named = (names: ReadonlyMap<string, string | null>, itemId: string | null) => (itemId === null ? null : (names.get(itemId) ?? null));
  const beanId = id("beanId");
  const profileId = id("profileId");
  const grinderId = id("grinderId");
  const basketId = id("basketId");
  const profile = profileId === null ? undefined : context.profiles.get(profileId);
  const brewTemperature = typeof content.brewTemperature === "number" ? content.brewTemperature : firstStepTemperature(profile);
  const tools = (Array.isArray(content.toolIds) ? (content.toolIds as unknown[]) : []).filter((tool): tool is string => typeof tool === "string");
  const held = tools.filter((tool) => ids.local("tool", tool) !== undefined);
  const attributes = isObject(content.toolAttributes) ? content.toolAttributes : {};
  const custom = Object.fromEntries(
    Object.entries(attributes).flatMap(([tool, value]) => {
      const localTool = ids.local("tool", tool);
      return localTool === undefined ? [] : [[localTool, value]];
    }),
  );
  const value = (key: string) => content[key] ?? null;
  const view: RecipeView = {
    name: value("name"),
    beverage: value("beverage"),
    barista: "",
    drinker: "",
    beanId: local("bean", beanId),
    beanName: named(context.beanNames, beanId),
    beanBatchId: local("beanBatch", id("beanBatchId")),
    beanRoaster: named(context.beanRoasters, beanId),
    profileId,
    profileTitle: profile && typeof profile.title === "string" ? profile.title : null,
    profileSnapshot: profile ?? null,
    [RECIPE_SHOWN_FIELD]: slot !== null,
    [RECIPE_SLOT_FIELD]: slot,
    [`${DV}.dose`]: value("dose"),
    [`${DV}.drink`]: value("yield"),
    [`${DV}.ratio`]: value("ratio"),
    // Held whatever the Recipe holds, as DYE2 records a brew temperature only into a record holding one.
    [`${DV}.brewC`]: brewTemperature,
    [`${DV}.steamMode`]: value("steamMode"),
    // By volume where it names none, as the management interface shows it: DYE2's editor shows a record holding a
    // temperature and no mode by temperature.
    [`${DV}.hotWaterMode`]: value("hotWaterMode") ?? "vol",
    ...Object.fromEntries(RECIPE_SETTING_NAMES.map((setting) => [`${DV}.${RECIPE_SETTINGS[setting].dye2}`, value(setting)])),
    [`${DV}.grind`]: value("grindSetting"),
    [`${DV}.rpm`]: value("rpm"),
    [`${DV}.grinderId`]: local("grinder", grinderId),
    [`${DV}.grinderModel`]: named(context.grinderModels, grinderId),
    [`${DV}.basketId`]: local("basket", basketId),
    [`${DV}.basketName`]: named(context.basketNames, basketId),
    [`${DV}.equipmentIds`]: held.map((tool) => ids.local("tool", tool)!),
    [`${DV}.equipmentNames`]: held.map((tool) => context.toolNames.get(tool) ?? null),
    [`${DV}.equipmentCustom`]: custom,
  };
  const name = typeof view.name === "string" ? view.name : "";
  view.title = name !== "" ? name : slot === null ? "Recipe" : `Recipe ${slot}`;
  view.subtitle = [view.beanName, view.beverage].find((text) => typeof text === "string" && text !== "") ?? "";
  view.workflow = recipeWorkflow(view);
  return view;
}

/** A profile's first step's temperature, or null for none. */
function firstStepTemperature(profile: unknown): number | null {
  const steps = isObject(profile) && Array.isArray(profile.steps) ? profile.steps : [];
  const first: unknown = steps[0];
  const temperature = isObject(first) ? first.temperature : undefined;
  return typeof temperature === "number" && Number.isFinite(temperature) ? temperature : null;
}

/**
 * The Workflow DYE2 embeds in a recipe, which Streamline applies, built as
 * DYE2's `buildRecipeWorkflow` builds it (dye2:dye2-plugin/src/utils/dev-api.ts
 * at v0.1.32) from the record's fields: its dose, yield (or its dose times
 * its ratio), grind setting, RPM, Grinder and Basket by the tablet's ids,
 * barista and drinker, each only where the record holds one; its coffee,
 * roaster and Bean Batch together, each null where it holds none, so
 * applying it clears a batch the Workflow held, and all three null where it
 * names no Bean, so a recipe naming none leaves no bean batch (DYE2
 * `ce38984`); and its full
 * Profile where it names one with steps, at its brew temperature, as
 * Streamline applies the profile as it is (`profileAtBrewTemperature`,
 * decentespresso/dye2#26), none where it holds no full Profile, as a stub
 * of its id and title would merge into the Workflow's profile and rename its
 * steps; and each steam, hot water and flush setting the
 * record holds, in partial `steamSettings`, `hotWaterData` and `rinseData`,
 * none where it holds none of them (`recipeMachineSettings`). DYE2's flags
 * of the fields it sets are left out.
 */
export function recipeWorkflow(view: Readonly<RecipeView>): Record<string, unknown> {
  const at = (field: string) => view[`${DV}.${field}`];
  const present = (value: unknown) => value !== null && value !== undefined;
  const context: Record<string, unknown> = {};
  const extras: Record<string, unknown> = {};
  if (present(at("dose"))) context.targetDoseWeight = at("dose");
  if (present(at("drink"))) context.targetYield = at("drink");
  else if (typeof at("ratio") === "number" && typeof at("dose") === "number") context.targetYield = Math.round((at("dose") as number) * (at("ratio") as number) * 10) / 10;
  if (present(at("grind"))) context.grinderSetting = String(at("grind"));
  if (present(at("rpm"))) extras.rpm = at("rpm");
  if (at("grinderId")) context.grinderId = at("grinderId");
  if (at("grinderModel")) context.grinderModel = at("grinderModel");
  if (at("basketId")) extras.basketId = at("basketId");
  if (at("basketName")) extras.basketName = at("basketName");
  if (Object.keys(extras).length > 0) context.extras = extras;
  // PUT /workflow merges, so a recipe naming no Bean holds explicit nulls, which clear the Bean a recipe applied before left.
  const named = Boolean(view.beanId || view.beanName);
  context.coffeeName = (named && view.beanName) || null;
  context.coffeeRoaster = (named && view.beanRoaster) || null;
  context.beanBatchId = (named && view.beanBatchId) || null;
  if (view.barista) context.baristaName = view.barista;
  if (view.drinker) context.drinkerName = view.drinker;
  const workflow: Record<string, unknown> = { context };
  if (view.profileId || view.profileTitle) {
    const snapshot = view.profileSnapshot;
    const brewTemperature = at("brewC");
    const shifted = isObject(snapshot) && typeof brewTemperature === "number" ? profileAtBrewTemperature(snapshot, brewTemperature) : null;
    if (isObject(snapshot) && Array.isArray(snapshot.steps) && snapshot.steps.length > 0) workflow.profile = shifted ?? snapshot;
  }
  const settings = RECIPE_SETTING_NAMES.flatMap((setting) => (present(at(RECIPE_SETTINGS[setting].dye2)) ? [[RECIPE_SETTINGS[setting].workflow, at(RECIPE_SETTINGS[setting].dye2)]] : []));
  return { ...workflow, ...workflowPatch(Object.fromEntries(settings)) };
}

/**
 * A record's view (`recipeRecord`) with the field flags DYE2 keeps in the
 * tablet's record of it (`held`) carried into its embedded `workflow`: its
 * editor's save adds its flags of the fields it sets (`extras.dye`), which
 * the server does not derive. So the server neither takes them for a change
 * of the record nor writes them out, which DYE2 would add back at its next
 * save. The steam, hot water and flush settings DYE2 copies there it derives
 * as DYE2 does (`recipeWorkflow`).
 */
export function withHeldFieldFlags(view: Readonly<RecipeView>, held: Readonly<Record<string, unknown>> | null): RecipeView {
  const derived = view.workflow;
  const kept = isObject(held?.workflow) ? held.workflow : null;
  const keptContext = isObject(kept?.context) ? kept.context : {};
  const flags = isObject(keptContext.extras) ? keptContext.extras.dye : undefined;
  if (flags === undefined || !isObject(derived) || !isObject(derived.context)) return { ...view };
  const extras = isObject(derived.context.extras) ? derived.context.extras : {};
  return { ...view, workflow: { ...derived, context: { ...derived.context, extras: { ...extras, dye: flags } } } };
}

/**
 * Whether a tablet's record (`held`) of a Recipe naming no Bean lacks the
 * explicit nulls for one in its embedded Workflow that the record it is to
 * hold (`view`) holds, which `recipeWorkflow` builds and DYE2 v0.1.32's
 * apply clears a Bean by: as the server wrote one before, and as DYE2's
 * `save-recipe` saves one from a Workflow naming no Bean. Comparing records
 * takes a field holding null for one not held, so such a record is written
 * its Workflow once on purpose.
 */
export function lacksBeanNulls(view: Readonly<RecipeView>, held: Readonly<Record<string, unknown>>): boolean {
  const contextOf = (workflow: unknown) => (isObject(workflow) && isObject(workflow.context) ? workflow.context : null);
  const nulls = ["coffeeName", "coffeeRoaster", "beanBatchId"];
  const due = contextOf(view.workflow);
  if (due === null || !nulls.every((field) => Object.prototype.hasOwnProperty.call(due, field) && due[field] === null)) return false;
  const context = contextOf(held.workflow);
  return context !== null && nulls.some((field) => !Object.prototype.hasOwnProperty.call(context, field));
}

/** Whether a tablet's record holds a Recipe's content as written to it (`recipeRecord`): every path a barista edits the same. */
export function holdsRecipe(view: Readonly<RecipeView>, written: Readonly<RecipeView>): boolean {
  return editedPaths(changedFields(written, view)).length === 0;
}

/** One thing a report of a tablet's recipes changes. */
export type RecipeIntakeStep =
  /** The tablet's record the map holds as a Recipe's differs from the one known: the barista's edit of that Recipe. */
  | { kind: "update"; itemId: string; reported: ReportedRecipe }
  /**
   * The tablet holds the Recipe's record, which is written over, not taken in: the Location's Recipe as the server wrote
   * it, which the map did not know, as after a lost answer; or a record of it the map holds that carries another item's
   * global id, or is of another Location's Recipe.
   */
  | { kind: "map"; itemId: string; reported: ReportedRecipe }
  /** A record the map does not hold under the record id of the Location's Recipe: saved there on the tablet, an edit of that Recipe, merged per field with Conflicts. */
  | { kind: "edit"; itemId: string; reported: ReportedRecipe }
  /** A record the map does not hold, of an id no Recipe of the Location has: a new Recipe there, with that record id. */
  | { kind: "add"; reported: ReportedRecipe }
  /** A record the map holds, listed before, is gone from the tablet's list: its Recipe is taken out of its slot at the tablet's Location, and kept (ADR-0019). */
  | { kind: "delete"; itemId: string; localId: string; updatedAt: Date | null; record: Record<string, unknown> }
  /** A record the server's write created is gone before any report listed it: lost to another app rewriting the list, so it is written again. */
  | { kind: "forget"; itemId: string; localId: string };

/** A Recipe the tablet's map holds a record of. */
export interface MappedRecipe {
  itemId: string;
  localId: string;
  updatedAt: Date | null;
  record: Record<string, unknown>;
  listed: boolean;
}

/**
 * What a report of the tablet's recipes changes, decided by record id, as a
 * recipe's id is the same on every tablet at its Recipe's Location
 * (ADR-0005), against the Location's Recipes (`recordIds`, each not
 * Archived by its record id; `own`, all of them). A record the map holds
 * stays that Recipe's: one that differs from the record known is the
 * barista's edit of it, but one carrying another item's global id, as one a
 * backup restored, or of another Location's Recipe, is written over. A
 * record the map does not hold under the record id of one of the Location's
 * Recipes is that Recipe's: the record carrying its global id is its record,
 * as when the answer to its write was lost, and any other was saved under
 * that id on the tablet, an edit of it. Any other record is a new Recipe.
 * Recipes are never matched (ADR-0018). Last, each record the map holds
 * that the list no longer holds (`listed`, every id the list holds, read or
 * not): deleted on the tablet if a report listed it before, and otherwise
 * lost to another app rewriting the list, which the map forgets.
 */
export function planRecipeIntake(
  reported: readonly ReportedRecipe[],
  mapped: readonly MappedRecipe[],
  recordIds: ReadonlyMap<string, string>,
  listed: ReadonlySet<string> = new Set(reported.map((record) => record.localId)),
  own: ReadonlySet<string> = new Set(recordIds.values()),
): RecipeIntakeStep[] {
  const byLocalId = new Map(mapped.map((record) => [record.localId, record]));
  /** The Recipes the tablet holds a record of that it still lists. */
  const held = new Set(mapped.filter((record) => listed.has(record.localId)).map((record) => record.itemId));
  const steps: RecipeIntakeStep[] = [];
  for (const record of reported) {
    const mine = byLocalId.get(record.localId);
    if (mine) {
      if (sameValue(mine.record, record.record)) continue;
      // Another Location's Recipe, or a record carrying another item's global id, as one a backup restored, is no edit of
      // it: it is written over.
      const foreign = !own.has(mine.itemId) || (record.globalId !== null && record.globalId !== mine.itemId);
      steps.push({ kind: foreign ? "map" : "update", itemId: mine.itemId, reported: record });
      continue;
    }
    const recipe = recordIds.get(record.localId);
    if (recipe === undefined) {
      steps.push({ kind: "add", reported: record });
    } else if (!held.has(recipe)) {
      held.add(recipe);
      steps.push({ kind: record.globalId === recipe ? "map" : "edit", itemId: recipe, reported: record });
    }
  }
  for (const record of mapped) {
    if (listed.has(record.localId)) continue;
    steps.push(
      record.listed
        ? { kind: "delete", itemId: record.itemId, localId: record.localId, updatedAt: record.updatedAt, record: record.record }
        : { kind: "forget", itemId: record.itemId, localId: record.localId },
    );
  }
  return steps;
}

/** A tablet's move of a Recipe at its Location: out of the Recipe Slot its record known was in (`from`), into another (`to`) or none. */
export interface SlotMove {
  itemId: string;
  from: number | null;
  to: number | null;
  /** When the plugin first read the record moved, as its edits are timed. */
  at: Date;
}

/**
 * The tablet's change of a record's Recipe Slot (`recipeSlotOf`), from the
 * record known (`known`, none for a record new to the map) to the one
 * reported, as DYE2's editor moves a recipe on the strip or takes it off,
 * and as hiding it from the strip does, which Streamline's long-press Clear
 * does keeping its `stripSlot`: which moves its Recipe at its Location; null
 * where it is unchanged.
 */
export function slotMove(itemId: string, known: Readonly<Record<string, unknown>> | null, reported: ReportedRecipe): SlotMove | null {
  const from = known === null ? null : recipeSlotOf(known);
  const to = recipeSlotOf(reported.record);
  return from === to ? null : { itemId, from, to, at: reported.updatedAt };
}
