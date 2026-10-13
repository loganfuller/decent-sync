import { RECIPE_FIELD, type SharedSetting, dye2GlobalIdOf, dye2Records, isSlotId, sameValue } from "@decent-sync/protocol";
import { isObject } from "./listed.js";
import { changedFields } from "./merge.js";
import type { LocationValues } from "./settings-intake.js";

// How a DYE2 recipe record on a tablet maps to a Recipe, both ways
// (ADR-0005). Pure, so module tests can drive it; recipes.ts reads what it
// needs and carries the mapping out.
//
// A Recipe's content is kept in the Library's terms: its Bean, Bean Batch,
// Grinder, Basket and Tools by their global ids, its Profile by Decaid's id,
// and its dial and hot water settings. A tablet's record names those items
// by its own ids, nests its dial in `dashboardVariables`, keeps one hot
// water value, chosen by its mode, and copies names and a Workflow from the
// items it names. So the server compares and writes a record by its fields'
// paths (`recipeView`), a field of its `dashboardVariables` as
// `dashboardVariables.dose`: the paths it writes are the record's view, and
// those a barista edits are taken in as edits of the Recipe's content
// (`libraryValues`), each read through the tablet's map. The rest DYE2
// derives (`title`, `subtitle`, the embedded `workflow`, the names it copies
// and `profileSnapshot`), and the barista and drinker, which a Recipe never
// carries, are written but never taken in. Its steam and flush values
// mirror the steam and rinse settings its tablet's Machine takes part in
// (ADR-0014): the Location's, or the Machine's own while its sharing of them
// is off. They are written as those, and a barista's change of one is an
// edit of those settings (`settingsValues`), not of the Recipe.

const DV = "dashboardVariables";

/** The paths of a recipe record the server writes, in a record's own field or its `dashboardVariables`. */
export const RECIPE_PATHS = [
  "name",
  "beverage",
  "barista",
  "drinker",
  "beanId",
  "beanName",
  "profileId",
  "profileTitle",
  "profileSnapshot",
  "showOnStreamlineDashboard",
  `${DV}.dose`,
  `${DV}.drink`,
  `${DV}.ratio`,
  `${DV}.brewC`,
  `${DV}.steamMode`,
  `${DV}.steamTimeS`,
  `${DV}.steamFlowMls`,
  `${DV}.flushS`,
  `${DV}.hotWaterMode`,
  `${DV}.hotWaterMl`,
  `${DV}.hotWaterTempC`,
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
  RECIPE_FIELD,
] as const;

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
  showOnStreamlineDashboard: "showOnDashboard",
  [`${DV}.dose`]: "dose",
  [`${DV}.drink`]: "yield",
  [`${DV}.ratio`]: "ratio",
  [`${DV}.brewC`]: "brewTemperature",
  [`${DV}.steamMode`]: "steamMode",
  [`${DV}.hotWaterMode`]: "hotWaterMode",
  [`${DV}.grind`]: "grindSetting",
  [`${DV}.rpm`]: "rpm",
};

/** The paths a barista edits, which are taken in as edits of the Recipe: but those DYE2 derives, the barista and drinker, and the server's own field. */
export const EDITED_PATHS: ReadonlySet<string> = new Set([
  ...Object.keys(EDITED),
  "beanId",
  "profileId",
  "profileSnapshot",
  `${DV}.hotWaterMl`,
  `${DV}.hotWaterTempC`,
  `${DV}.grinderId`,
  `${DV}.basketId`,
  `${DV}.equipmentIds`,
  `${DV}.equipmentCustom`,
]);

/**
 * The paths of a recipe record whose values mirror the steam and rinse
 * settings (ADR-0014), each with the setting it mirrors, as DYE2 and
 * Streamline apply a recipe: its steam time where its steam mode is `time`,
 * its steam flow where it is `flow`, and its flush time.
 */
export const MIRRORED_PATHS: Readonly<Record<string, SharedSetting>> = {
  [`${DV}.steamTimeS`]: "steamSettings.duration",
  [`${DV}.steamFlowMls`]: "steamSettings.flow",
  [`${DV}.flushS`]: "rinseData.duration",
};

/** A recipe's record as a tablet reported it, one Decent Sync can take in. */
export interface ReportedRecipe {
  /** Its id on the tablet: its Recipe Slot. */
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
 * none from a list in a shape it does not recognise (`dye2Records`), as one
 * whose ids are not slot numbers. A record without a time is left out.
 */
export function readReportedRecipes(value: unknown, updatedAt: readonly (string | null)[] | undefined): ReportedRecipe[] {
  const records = dye2Records(value, "recipes");
  if (records === null) return [];
  return records.flatMap((record, index) => {
    const time = updatedAt?.[index];
    if (!time || !isSlotId(record.id)) return [];
    return [{ localId: record.id, globalId: dye2GlobalIdOf(record), updatedAt: new Date(time), record }];
  });
}

/** The value at a path of a record: a field of its own, or of its `dashboardVariables`; undefined for none. */
export function valueAt(record: Readonly<Record<string, unknown>>, path: string): unknown {
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
  /** Each Bean Batch's Bean, for the Recipe's batch now. */
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
 * - its Bean, by the tablet's map, with the Recipe's Bean Batch kept where
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
 * - its hot water value of the mode the record names, a value the record
 *   leaves out, as DYE2 keeps one, changing none;
 * - and the rest of its dial as it is.
 *
 * A record the map does not hold, or one of the tablet's own, names none.
 */
export function libraryValues(view: Readonly<RecipeView>, fields: Iterable<string>, current: Readonly<Record<string, unknown>>, context: IntakeContext): Record<string, unknown> {
  const { ids } = context;
  const values: Record<string, unknown> = {};
  const changed = new Set(fields);
  for (const [path, field] of Object.entries(EDITED)) if (changed.has(path)) values[field] = view[path] ?? null;
  if (changed.has("beanId")) {
    const beanId = typeof view.beanId === "string" ? (ids.item("bean", view.beanId) ?? null) : null;
    values.beanId = beanId;
    const kept = typeof current.beanBatchId === "string" && beanId !== null && context.batchBeans.get(current.beanBatchId) === beanId;
    values.beanBatchId = kept ? current.beanBatchId : beanId === null ? null : (context.latestBatches.get(beanId) ?? null);
  }
  if (changed.has("profileId") || (changed.has("profileSnapshot") && typeof view.profileId !== "string")) {
    const named = typeof view.profileId === "string" && view.profileId !== "" ? view.profileId : context.snapshotProfile;
    // A profile read from the Workflow that is no Library Profile names none the Library knows: the Recipe's stays.
    if (named !== null || !isObject(view.profileSnapshot)) values.profileId = named;
  }
  // DYE2 keeps one hot water value, of its mode; the one it leaves out stays as it is.
  if (changed.has(`${DV}.hotWaterMl`) && view[`${DV}.hotWaterMl`] !== null) values.hotWaterVolume = view[`${DV}.hotWaterMl`];
  if (changed.has(`${DV}.hotWaterTempC`) && view[`${DV}.hotWaterTempC`] !== null) values.hotWaterTemperature = view[`${DV}.hotWaterTempC`];
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

/** A new Recipe's content from a tablet's record: every field a barista edits, a field it holds no value for left out. */
export function recipeContent(view: Readonly<RecipeView>, context: IntakeContext): Record<string, unknown> {
  const values = libraryValues(view, EDITED_PATHS, {}, context);
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null));
}

/** The paths a barista edited, of those `changed` names (`editedContent` in equipment-intake.ts), that are edits of the Recipe. */
export function editedPaths(changed: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(changed).filter((path) => EDITED_PATHS.has(path));
}

/**
 * The steam and rinse settings a barista's change of the paths given of a
 * record that mirror them (`MIRRORED_PATHS`) edits, each with its value: but
 * a blank one, which DYE2's editor saves as 0 and DYE2 leaves out as absent,
 * is no edit, so a recipe saved with blank fields never sets a wand to 0.
 * Nor is a steam value saved with a change of the record's steam mode: DYE2's
 * editor keeps the number shown as its mode is switched, so a 30 s steam time
 * would be saved as a 30 ml/s flow. The value of the new mode is written
 * then, and Streamline, switching it as it saves a Workflow change into the
 * recipe, made that change in the Workflow too.
 */
export function settingsValues(view: Readonly<RecipeView>, fields: Iterable<string>): Partial<Record<SharedSetting, number>> {
  const changed = new Set(fields);
  const values: Partial<Record<SharedSetting, number>> = {};
  for (const path of changed) {
    const setting = MIRRORED_PATHS[path];
    const value = view[path];
    if (setting === undefined || typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    if (setting.startsWith("steamSettings.") && changed.has(`${DV}.steamMode`)) continue;
    values[setting] = value;
  }
  return values;
}

/**
 * The settings of those a tablet's Workflow changed (`values`) that it set
 * back to a value its recipes held just before the server's latest write of
 * it (`beforeWrites`, each record's `before_write`), where the settings now
 * hold another (`current`): a recipe applied from a copy read before that
 * write, as DYE2's dashboard and Streamline's strip read their recipes once
 * and keep them, which is no edit (ADR-0005), and the settings' value is
 * written back. A barista who deliberately sets exactly that value on the
 * machine has to set it again.
 */
export function staleApplied(
  values: Readonly<Partial<Record<SharedSetting, number>>>,
  beforeWrites: readonly Readonly<Record<string, unknown>>[],
  current: LocationValues,
): SharedSetting[] {
  const stale: SharedSetting[] = [];
  for (const [path, setting] of Object.entries(MIRRORED_PATHS)) {
    const value = values[setting];
    if (value === undefined || sameValue(current[setting], value)) continue;
    if (beforeWrites.some((before) => Object.prototype.hasOwnProperty.call(before, path) && sameValue(before[path], value))) stale.push(setting);
  }
  return stale;
}

/** What writing a Recipe to a tablet reads besides it: the tablet's ids for what it names, and what DYE2 copies of each. */
export interface WriteContext {
  ids: TabletIds;
  /** Each Bean's name, by its global id. */
  beanNames: ReadonlyMap<string, string | null>;
  /** Each Grinder's model. */
  grinderModels: ReadonlyMap<string, string | null>;
  /** Each Basket's name. */
  basketNames: ReadonlyMap<string, string | null>;
  /** Each Tool's name. */
  toolNames: ReadonlyMap<string, string | null>;
  /** Each Profile's `profile`, as Decaid keeps it, by Decaid's id; absent for one the Library does not have. */
  profiles: ReadonlyMap<string, Record<string, unknown>>;
  /** The steam and rinse settings its recipes mirror (`mirroredSettings` in location-settings.ts): a setting not known is absent. */
  settings: LocationValues;
}

/**
 * The record a tablet holds of a Recipe in a slot, by the paths the server
 * writes (`RECIPE_PATHS`): its content, naming its Bean, Grinder, Basket and
 * Tools by the tablet's ids, and its Profile by Decaid's, each left out where
 * the tablet holds no record of it, and the names DYE2 copies from them; its
 * full Profile in `profileSnapshot`, so it applies where the Profile is
 * hidden; a blank barista and drinker; the steam and rinse settings it
 * mirrors (`MIRRORED_PATHS`), its steam's of its steam mode alone, and none
 * not known; the hot water value of its mode,
 * with all four and its Bean Batch, by the tablet's id, in the record's own
 * field (RECIPE_FIELD); and `title`, `subtitle` and the embedded `workflow`
 * as DYE2 derives them (`recipeWorkflow`).
 */
export function recipeRecord(content: Readonly<Record<string, unknown>>, slot: number, context: WriteContext): RecipeView {
  const { ids } = context;
  const id = (key: string) => (typeof content[key] === "string" ? (content[key] as string) : null);
  const local = (kind: Parameters<TabletIds["local"]>[0], itemId: string | null) => (itemId === null ? null : (ids.local(kind, itemId) ?? null));
  const named = (names: ReadonlyMap<string, string | null>, itemId: string | null) => (itemId === null ? null : (names.get(itemId) ?? null));
  const beanId = id("beanId");
  const profileId = id("profileId");
  const grinderId = id("grinderId");
  const basketId = id("basketId");
  const profile = profileId === null ? undefined : context.profiles.get(profileId);
  const tools = (Array.isArray(content.toolIds) ? (content.toolIds as unknown[]) : []).filter((tool): tool is string => typeof tool === "string");
  const held = tools.filter((tool) => ids.local("tool", tool) !== undefined);
  const attributes = isObject(content.toolAttributes) ? content.toolAttributes : {};
  const custom = Object.fromEntries(
    Object.entries(attributes).flatMap(([tool, value]) => {
      const localTool = ids.local("tool", tool);
      return localTool === undefined ? [] : [[localTool, value]];
    }),
  );
  const hotWaterMode = content.hotWaterMode ?? null;
  const steamMode = content.steamMode ?? null;
  const value = (key: string) => content[key] ?? null;
  const setting = (field: SharedSetting) => context.settings[field] ?? null;
  const view: RecipeView = {
    name: value("name"),
    beverage: value("beverage"),
    barista: "",
    drinker: "",
    beanId: local("bean", beanId),
    beanName: named(context.beanNames, beanId),
    profileId,
    profileTitle: profile && typeof profile.title === "string" ? profile.title : null,
    profileSnapshot: profile ?? null,
    showOnStreamlineDashboard: value("showOnDashboard"),
    [`${DV}.dose`]: value("dose"),
    [`${DV}.drink`]: value("yield"),
    [`${DV}.ratio`]: value("ratio"),
    [`${DV}.brewC`]: value("brewTemperature"),
    [`${DV}.steamMode`]: steamMode,
    // DYE2 and Streamline apply the steam value of the recipe's mode alone. The other is left out: DYE2's editor shows a
    // time whatever the mode, and would save it as the flow.
    [`${DV}.steamTimeS`]: steamMode === "time" ? setting("steamSettings.duration") : null,
    [`${DV}.steamFlowMls`]: steamMode === "flow" ? setting("steamSettings.flow") : null,
    [`${DV}.flushS`]: setting("rinseData.duration"),
    [`${DV}.hotWaterMode`]: hotWaterMode,
    // DYE2 keeps the value of its mode, volume where it names none, as its editor shows.
    [`${DV}.hotWaterMl`]: hotWaterMode === "temp" ? null : value("hotWaterVolume"),
    [`${DV}.hotWaterTempC`]: hotWaterMode === "temp" ? value("hotWaterTemperature") : null,
    [`${DV}.grind`]: value("grindSetting"),
    [`${DV}.rpm`]: value("rpm"),
    [`${DV}.grinderId`]: local("grinder", grinderId),
    [`${DV}.grinderModel`]: named(context.grinderModels, grinderId),
    [`${DV}.basketId`]: local("basket", basketId),
    [`${DV}.basketName`]: named(context.basketNames, basketId),
    [`${DV}.equipmentIds`]: held.map((tool) => ids.local("tool", tool)!),
    [`${DV}.equipmentNames`]: held.map((tool) => context.toolNames.get(tool) ?? null),
    [`${DV}.equipmentCustom`]: custom,
    [RECIPE_FIELD]: {
      beanBatchId: local("beanBatch", id("beanBatchId")),
      hotWaterData: {
        targetTemperature: value("hotWaterTemperature"),
        duration: value("hotWaterDuration"),
        volume: value("hotWaterVolume"),
        flow: value("hotWaterFlow"),
      },
    },
  };
  const name = typeof view.name === "string" ? view.name : "";
  view.title = name !== "" ? name : `Recipe ${slot}`;
  view.subtitle = [view.beanName, view.beverage].find((text) => typeof text === "string" && text !== "") ?? "";
  view.workflow = recipeWorkflow(view);
  return view;
}

/**
 * The Workflow DYE2 embeds in a recipe, which Streamline applies, built as
 * DYE2's `buildRecipeWorkflow` builds it (dye2:dye2-plugin/src/utils/dev-api.ts
 * at v0.1.19) from the record's fields: its dose, yield (or its dose times
 * its ratio), grind setting, RPM, Grinder and Basket by the tablet's ids,
 * coffee, barista and drinker, each only where the record holds one, and its
 * full Profile where it names one.
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
  if (view.beanName) context.coffeeName = view.beanName;
  if (view.barista) context.baristaName = view.barista;
  if (view.drinker) context.drinkerName = view.drinker;
  const workflow: Record<string, unknown> = { context };
  if (view.profileId || view.profileTitle) {
    const snapshot = view.profileSnapshot;
    workflow.profile = isObject(snapshot) && Array.isArray(snapshot.steps) ? snapshot : { id: view.profileId, title: view.profileTitle };
  }
  return workflow;
}

/** Whether a tablet's record holds a Recipe's content as written to it (`recipeRecord`): every path a barista edits the same. */
export function holdsRecipe(view: Readonly<RecipeView>, written: Readonly<RecipeView>): boolean {
  return editedPaths(changedFields(written, view)).length === 0 && sameValue(view[RECIPE_FIELD], written[RECIPE_FIELD]);
}

/** Whether a tablet's record holds a Recipe as written to it (`holdsRecipe`), and the settings it mirrors as written. */
export function holdsRecord(view: Readonly<RecipeView>, written: Readonly<RecipeView>): boolean {
  return holdsRecipe(view, written) && Object.keys(MIRRORED_PATHS).every((path) => sameValue(view[path], written[path]));
}

/** One thing a report of a tablet's recipes changes. */
export type RecipeIntakeStep =
  /** The tablet's record in a slot the map holds as a Recipe's differs from the one known: the barista's edit of that Recipe. */
  | { kind: "update"; itemId: string; reported: ReportedRecipe }
  /**
   * The tablet holds the Recipe's record, which is written over, not taken in: the Location's Recipe in its slot as the
   * server wrote it, which the map did not know, as after a lost answer; or a record of it the map holds that carries
   * another item's global id, or is of another Location's Recipe.
   */
  | { kind: "map"; itemId: string; reported: ReportedRecipe }
  /** A record the map does not hold in a slot of the Location's Recipe: saved there on the tablet, an edit of that Recipe, merged per field with Conflicts. */
  | { kind: "edit"; itemId: string; reported: ReportedRecipe }
  /** A record the map does not hold in a slot the Location leaves empty: a new Recipe there. */
  | { kind: "add"; reported: ReportedRecipe }
  /** A record the map holds, listed before, is gone from the tablet's list: its Recipe is taken out of that slot at the tablet's Location, and kept (ADR-0019). */
  | { kind: "delete"; itemId: string; localId: string; updatedAt: Date | null }
  /** A record the server's write created is gone before any report listed it: lost to another app rewriting the list, so it is written again. */
  | { kind: "forget"; itemId: string; localId: string };

/** A Recipe the tablet's map holds a record of. */
export interface MappedRecipe {
  itemId: string;
  localId: string;
  updatedAt: Date | null;
  record: Record<string, unknown>;
  beforeWrite: Record<string, unknown> | null;
  listed: boolean;
}

/**
 * What a report of the tablet's recipes changes, decided by slot, as a
 * recipe's id on a tablet is its Recipe Slot (ADR-0005), against the
 * Location's slotted Recipes (`slots`, each Recipe by its slot's id). A
 * record the map holds by its slot stays that Recipe's: one that differs
 * from the record known is the barista's edit of it, but one carrying
 * another item's global id, as one a backup restored, or of another
 * Location's Recipe, is written over; and unless that Recipe is one of the
 * Location's (`own`) that is no longer in that slot, as one taken out of it
 * since, when the save is in the slot as it is now, as a record the map does
 * not hold. Any other record is in
 * the slot of the Location's Recipe there, if any: the record carrying its
 * global id is its record, as when the answer to its write was lost, and
 * any other was saved in that slot on the tablet, an edit of it; unless the
 * tablet still holds that Recipe in another slot, which is written first.
 * A record in a slot the Location leaves empty is a new Recipe there.
 * Recipes are never matched (ADR-0018). Last, each record the map holds
 * whose slot the list no longer holds (`listed`, every id the list holds,
 * read or not): deleted on the tablet if a report listed it before, and
 * otherwise lost to another app rewriting the list, which the map forgets.
 */
export function planRecipeIntake(
  reported: readonly ReportedRecipe[],
  mapped: readonly MappedRecipe[],
  slots: ReadonlyMap<string, string>,
  listed: ReadonlySet<string> = new Set(reported.map((record) => record.localId)),
  own: ReadonlySet<string> = new Set(slots.values()),
): RecipeIntakeStep[] {
  const byLocalId = new Map(mapped.map((record) => [record.localId, record]));
  /** The Recipes the tablet holds a record of that it still lists. */
  const held = new Set(mapped.filter((record) => listed.has(record.localId)).map((record) => record.itemId));
  const steps: RecipeIntakeStep[] = [];
  for (const record of reported) {
    const mine = byLocalId.get(record.localId);
    const slotted = slots.get(record.localId);
    // That Recipe's record, unless it is a save in a slot the Location's Recipe has left: one unchanged the writer removes.
    if (mine && (sameValue(mine.record, record.record) || !own.has(mine.itemId) || mine.itemId === slotted)) {
      if (sameValue(mine.record, record.record)) continue;
      // Another Location's Recipe, or a record carrying another item's global id, as one a backup restored, is no edit of
      // it: it is written over.
      const foreign = !own.has(mine.itemId) || (record.globalId !== null && record.globalId !== mine.itemId);
      steps.push({ kind: foreign ? "map" : "update", itemId: mine.itemId, reported: record });
      continue;
    }
    if (slotted === undefined) {
      steps.push({ kind: "add", reported: record });
    } else if (!held.has(slotted)) {
      held.add(slotted);
      steps.push({ kind: record.globalId === slotted ? "map" : "edit", itemId: slotted, reported: record });
    }
  }
  for (const record of mapped) {
    if (listed.has(record.localId)) continue;
    steps.push(
      record.listed
        ? { kind: "delete", itemId: record.itemId, localId: record.localId, updatedAt: record.updatedAt }
        : { kind: "forget", itemId: record.itemId, localId: record.localId },
    );
  }
  return steps;
}
