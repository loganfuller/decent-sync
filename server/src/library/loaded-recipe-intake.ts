import { BREW_TEMPERATURE_FIELD, LOADED_RECIPE_PARTS, type LoadedRecipePart, RECIPE_FIELD, sameValue, workflowValueAt } from "@decent-sync/protocol";
import { isObject } from "./listed.js";
import { ratioValues } from "./recipe-intake.js";

// How the parts of a Workflow that follow its Loaded Recipe (ADR-0022,
// LOADED_RECIPE_PARTS) map to the Recipe's content, both ways: a change of
// one on the Recipe's Machine that DYE2 does not record is an edit of the
// Recipe, but of its Grinder, Bean Batch or Profile, which unloads it
// instead (DYE2 clears its selection, and the plugin's loaded-recipes.ts
// follows), and a field of the Recipe's that the Workflow holds otherwise is
// written into it. A Workflow names its Grinder, Basket
// and Bean Batch by the tablet's ids, holds its Profile whole, its brew
// temperature as its first step's, and keeps its grind setting as text, as
// Decaid does; a Recipe names them by their global ids, its Profile by
// Decaid's, and keeps the grind setting DYE2 saves, a number. Pure, so
// module tests can drive it; machine-events/loaded-recipes.ts reads what it
// needs and carries it out.

/** Each part, in the order LOADED_RECIPE_PARTS lists them. */
export const PARTS = Object.keys(LOADED_RECIPE_PARTS) as LoadedRecipePart[];

/**
 * The parts DYE2 records into the Loaded Recipe's record as they change in
 * the Workflow, so a change of them on the Machine reaches the server as the
 * tablet's change of the record, not of the Workflow: its dose, yield,
 * grind setting, RPM, Basket and brew temperature, where the record holds
 * one, and its hot water volume and temperature, which every record the
 * server writes holds where the Recipe does, and DYE2 records once they
 * move otherwise (`itemPatch` in
 * dye2:dye2-plugin/src/utils/workflow-record.ts, decentespresso/dye2#21).
 * A change of a dial part a Recipe holds none of stays on the Machine.
 */
export const RECORDED_PARTS: readonly LoadedRecipePart[] = ["dose", "yield", "grind", "rpm", "basket", "brewTemperature", "volume", "targetTemperature"];

/**
 * The parts a change of the Workflow on the Machine edits the Recipe in,
 * those whose record field the server does not take in: its hot water
 * duration and flow, until a Recipe holds them as DYE2's recipe does
 * (#173). Not its Grinder, Bean Batch or Profile, a change of which unloads
 * it.
 */
export const WORKFLOW_EDITED_PARTS: readonly LoadedRecipePart[] = ["duration", "flow"];

/**
 * A part's value as a Workflow holds it: a number, a grind setting's text,
 * the tablet's id for a Grinder, Basket or Bean Batch, or the id of the
 * Library Profile its profile is; null for none.
 */
export type PartValue = number | string | null;

/** The parts a Workflow holds, by name. */
export type WorkflowParts = Record<LoadedRecipePart, PartValue>;

/** The field of a Recipe's content each part follows. */
export const RECIPE_FIELDS: Readonly<Record<LoadedRecipePart, string>> = {
  profile: "profileId",
  grinder: "grinderId",
  dose: "dose",
  yield: "yield",
  grind: "grindSetting",
  rpm: "rpm",
  basket: "basketId",
  batch: "beanBatchId",
  targetTemperature: "hotWaterTemperature",
  duration: "hotWaterDuration",
  volume: "hotWaterVolume",
  flow: "hotWaterFlow",
  brewTemperature: "brewTemperature",
};

/** The parts naming a Library item, each with its kind, by the tablet's id for it. */
const ITEM_PARTS: Partial<Readonly<Record<LoadedRecipePart, ItemKind>>> = { grinder: "grinder", basket: "basket", batch: "beanBatch" };

/** The kinds of item a part names by the tablet's id for it. */
export type ItemKind = "grinder" | "basket" | "beanBatch";

/** The parts a Workflow holds, its profile as the Library Profile it is (`profile`), found as a Shot's is, or none. */
export function workflowParts(workflow: unknown, profile: string | null = null): WorkflowParts {
  const parts = Object.fromEntries(PARTS.map((part) => [part, partValue(part, workflowValueAt(workflow, LOADED_RECIPE_PARTS[part][0]))])) as WorkflowParts;
  return { ...parts, profile };
}

/** Parts as stored (`tablet_loaded_recipes.held`): a part missing, or of no value, is none. */
export function readParts(value: unknown): WorkflowParts {
  const stored = isObject(value) ? value : {};
  return Object.fromEntries(PARTS.map((part) => [part, partValue(part, stored[part])])) as WorkflowParts;
}

/** A value as a part holds it: text for a grind setting, a Basket or a batch, a number for the rest; null for none. */
function partValue(part: LoadedRecipePart, value: unknown): PartValue {
  if (part === "grind") return typeof value === "number" ? (Number.isFinite(value) ? String(value) : null) : textOf(value);
  return ITEM_PARTS[part] !== undefined || part === "profile" ? textOf(value) : numberOf(value);
}

/** Whether two values of a part are the same: grind settings as numbers where both read as one, as Decaid keeps DYE2's 3 as "3". */
export function samePart(part: LoadedRecipePart, a: unknown, b: unknown): boolean {
  if (part === "grind") {
    const [x, y] = [numberOf(a), numberOf(b)];
    if (x !== null && y !== null) return Math.abs(x - y) < 1e-9;
  }
  return sameValue(a ?? null, b ?? null);
}

/**
 * The parts of those given (`parts`) the Workflow holds now (`now`)
 * otherwise than it last did (`held`): a part it holds none of now is no
 * change, as Streamline clears the batch, Basket and RPM after a Shot
 * stored while DYE2 has no recipe selected, so they do not label the next
 * one, and the Recipe keeps them.
 */
export function changedParts(held: WorkflowParts, now: WorkflowParts, parts: readonly LoadedRecipePart[]): LoadedRecipePart[] {
  return parts.filter((part) => now[part] !== null && !samePart(part, held[part], now[part]));
}

/** What the plugin's write of a load replaced, by part (`WorkflowDelivery.loadBefore`), as stored with the load: known parts only. */
export type LoadBefore = Partial<Record<LoadedRecipePart, { before: PartValue; written: PartValue }>>;

/** A load's `loadBefore` as delivered or stored, read as parts; null where it names none. */
export function readLoadBefore(value: unknown): LoadBefore | null {
  if (!isObject(value)) return null;
  const parts: LoadBefore = {};
  for (const part of PARTS) {
    const kept = value[part];
    if (isObject(kept) && "before" in kept) parts[part] = { before: partValue(part, kept.before), written: partValue(part, kept.written) };
  }
  return Object.keys(parts).length === 0 ? null : parts;
}

/**
 * Whether a part's value (`held`, as the Workflow holds it) sets it back to
 * what the plugin's write of the load replaced (`loadBefore`), which the
 * load changed: stale, as DYE2's dashboard sends back the Workflow it read as
 * it opened (decentespresso/dye2#31), unless the tablet made the field's
 * latest edit itself since the load, as a barista undoing a tweak (`own`),
 * or it is the Grinder, a change of which unloads the Recipe (dye2#19).
 */
export function setBackToLoad(part: LoadedRecipePart, held: PartValue, loadBefore: LoadBefore | null, own: ReadonlySet<string>): boolean {
  const replaced = loadBefore?.[part];
  if (replaced === undefined || part === "grinder" || held === null || own.has(RECIPE_FIELDS[part])) return false;
  return samePart(part, replaced.before, held) && !samePart(part, replaced.written, held);
}

/**
 * What tells a part set back by a stale copy of a Recipe (`partEdits`): what
 * its tablet's record of it held just before the server's latest write of
 * its fields, each of the Recipe's fields before its current value, and the
 * fields whose latest edit was that tablet's own.
 */
export interface StaleCheck {
  /** The record's `before_write`, by its paths (recipe-intake.ts); null for none. */
  beforeWrite: Readonly<Record<string, unknown>> | null;
  /** The value each field of the Recipe held just before its current one, by field; absent where none is known. */
  previous: Readonly<Record<string, unknown>>;
  /** The fields of the Recipe whose latest edit the tablet made itself. */
  own: ReadonlySet<string>;
  /** What the plugin's write of the load replaced, until the Machine's first espresso since (`setBackToLoad`); null for none. */
  loadBefore?: LoadBefore | null;
  /** The fields of the Recipe whose latest edit the tablet made itself since the load, which a set-back to what the load replaced undoes. */
  ownSinceLoad?: ReadonlySet<string>;
}

/** No stale copy to tell: what a part is judged by where the tablet's record of the Recipe is not known. */
export const NO_STALE_CHECK: StaleCheck = { beforeWrite: null, previous: {}, own: new Set() };

/** What a change of a Workflow's parts makes of its Loaded Recipe (`partEdits`). */
export interface PartEdits {
  /** The fields of the Recipe's content the change sets, with their values: an edit of it, empty for none. */
  values: Record<string, unknown>;
  /** The parts the Workflow is held to hold from now on, as it holds them now: those that are edits, or no change of the Recipe, or set back by a stale copy. */
  taken: LoadedRecipePart[];
}

/**
 * What a change of the parts given (`parts`, as `changedParts` finds them),
 * which the Workflow holds now (`now`), makes of its Loaded Recipe, whose
 * content is `content`:
 *
 * - a dose, yield, RPM or hot water setting is the Recipe's, and a grind
 *   setting that reads as a number is, as that number, as DYE2 keeps one;
 * - a Grinder, Basket, Bean Batch or Profile is none of its: DYE2 records
 *   the Basket, and a change of the rest unloads the Recipe;
 * - a value the Recipe holds already is no edit, as when Streamline saves
 *   the change into the recipe too, and its report arrived first;
 * - a value set back to what the tablet's record of the Recipe held just
 *   before the server's latest write of it, which was the Recipe's before its
 *   current one, set by another tablet or in the management interface
 *   (`stale`), is a recipe applied from a copy read before that write, as a
 *   DYE2 page or Streamline strip opened before it, or DYE2's dashboard
 *   sending back the Workflow it read as it opened: no edit, as for a stale
 *   save (ADR-0005), and the Recipe's value is written back. One set back
 *   over the tablet's own latest edit of the field is its barista undoing a
 *   tweak, and an edit;
 * - a value set back to what the plugin's write of the load replaced, before
 *   the Machine's first espresso since (`setBackToLoad`), is no edit either,
 *   and the Recipe's value is written back;
 * - DYE2's ratio is kept only while the yield is the dose times it
 *   (`ratioValues`), the Workflow's yield kept as the Recipe's where it held
 *   none, the yield worked out from the ratio.
 */
export function partEdits(parts: readonly LoadedRecipePart[], now: WorkflowParts, content: Readonly<Record<string, unknown>>, stale: StaleCheck = NO_STALE_CHECK): PartEdits {
  const edits: PartEdits = { values: {}, taken: [] };
  for (const part of parts) {
    const held = now[part];
    if (held === null || ITEM_PARTS[part] !== undefined || part === "profile") continue;
    const field = RECIPE_FIELDS[part];
    // A grind setting that is not a number is no Recipe's, which DYE2 keeps as one.
    const value = part === "grind" ? numberOf(held) : held;
    if (value === null) continue;
    edits.taken.push(part);
    if (sameValue(content[field] ?? null, value) || setBack(part, held, value, content[field], stale) || setBackToLoad(part, held, stale.loadBefore ?? null, stale.ownSinceLoad ?? new Set())) continue;
    edits.values[field] = value;
  }
  if ("dose" in edits.values && typeof content.yield !== "number" && !("yield" in edits.values) && typeof now.yield === "number") {
    edits.values.yield = now.yield;
  }
  Object.assign(edits.values, ratioValues(content, edits.values));
  return edits;
}

/**
 * Whether a part's value (`held` as the Workflow holds it, `value` as the
 * Recipe would) sets it back to what the tablet's record of the Recipe held
 * just before the server's latest write of it, which was the Recipe's value
 * before its current one (`current`), set by another than the tablet itself.
 */
function setBack(part: LoadedRecipePart, held: PartValue, value: unknown, current: unknown, stale: StaleCheck): boolean {
  const field = RECIPE_FIELDS[part];
  if (stale.beforeWrite === null || stale.own.has(field) || !Object.prototype.hasOwnProperty.call(stale.previous, field)) return false;
  if (!sameValue(stale.previous[field], value) || sameValue(current ?? null, value)) return false;
  return recordValues(part, stale.beforeWrite).some((before) => samePart(part, before, held));
}

/**
 * The values a recipe record's `before_write` keeps of a part: its own of
 * the record's `dashboardVariables`, and its hot water in the record's own
 * field (RECIPE_FIELD), each only where the server wrote it.
 */
function recordValues(part: LoadedRecipePart, beforeWrite: Readonly<Record<string, unknown>>): unknown[] {
  const has = (path: string) => Object.prototype.hasOwnProperty.call(beforeWrite, path);
  const values = DASHBOARD_PATHS[part].filter(has).map((path) => beforeWrite[path]);
  if (has(RECIPE_FIELD)) {
    const own = isObject(beforeWrite[RECIPE_FIELD]) ? beforeWrite[RECIPE_FIELD] : {};
    const hotWater = isObject(own.hotWaterData) ? own.hotWaterData : {};
    if (part in HOT_WATER_NAMES) values.push(hotWater[part] ?? null);
  }
  return values;
}

/** The paths of a recipe record's `dashboardVariables` holding each part. */
const DASHBOARD_PATHS: Readonly<Record<LoadedRecipePart, readonly string[]>> = {
  profile: [],
  grinder: [],
  dose: ["dashboardVariables.dose"],
  yield: ["dashboardVariables.drink"],
  grind: ["dashboardVariables.grind"],
  rpm: ["dashboardVariables.rpm"],
  basket: ["dashboardVariables.basketId"],
  batch: [],
  targetTemperature: ["dashboardVariables.hotWaterTempC"],
  duration: [],
  volume: ["dashboardVariables.hotWaterMl"],
  flow: [],
  brewTemperature: ["dashboardVariables.brewC"],
};

/** The hot water parts, as a recipe record's own field keeps all four. */
const HOT_WATER_NAMES = { targetTemperature: true, duration: true, volume: true, flow: true } as const;

/**
 * What the Workflow is to hold of each part of a Recipe with this content,
 * as its tablet names it (`local`, the tablet's id for an item by its map):
 * null where the Recipe holds none, and undefined for a Grinder, Basket or
 * batch the tablet holds no record of yet, which is written first; its
 * Profile by Decaid's id, the same on every tablet. Its yield is its
 * dose times its ratio where it holds none, as DYE2 applies one, and its
 * brew temperature its Profile's first step's (`profileTemperature`) where
 * it holds none, as its records hold one (`recipeRecord`).
 */
export function recipeParts(
  content: Readonly<Record<string, unknown>>,
  local: (kind: ItemKind, itemId: string) => string | undefined,
  profileTemperature: number | null = null,
): Record<LoadedRecipePart, PartValue | undefined> {
  const parts = {} as Record<LoadedRecipePart, PartValue | undefined>;
  for (const part of PARTS) {
    const value = content[RECIPE_FIELDS[part]];
    const kind = ITEM_PARTS[part];
    parts[part] = kind !== undefined ? (typeof value === "string" ? local(kind, value) : null) : partValue(part, value);
    if (part === "profile") parts[part] = textOf(value);
  }
  const [dose, ratio] = [numberOf(content.dose), numberOf(content.ratio)];
  if (parts.yield === null && dose !== null && ratio !== null) parts.yield = Math.round(dose * ratio * 10) / 10;
  parts.brewTemperature ??= profileTemperature;
  return parts;
}

/**
 * The parts of a Recipe the Workflow is to hold (`target`, as `recipeParts`
 * reads it) that wait for the tablet's record of the Recipe (`record`, as
 * the server last knew it) to hold them too: its dial (Profile, dose, yield,
 * grind setting, RPM, Basket and brew temperature), as the record is written
 * first. DYE2 records the Workflow's dial into the record, so a dial written
 * into the Workflow first, as when the tablet refused the record's write,
 * would reach the server as the tablet's change of the record. Each that
 * waits is undefined, as one the tablet holds no record of yet is; the rest
 * of the write goes ahead, its Grinder and Bean Batch included, which DYE2
 * records none of.
 */
export function heldByRecord(
  target: Readonly<Record<LoadedRecipePart, PartValue | undefined>>,
  record: Readonly<Record<string, unknown>> | null,
): Record<LoadedRecipePart, PartValue | undefined> {
  const variables = isObject(record?.dashboardVariables) ? record.dashboardVariables : {};
  const [dose, ratio] = [numberOf(variables.dose), numberOf(variables.ratio)];
  const holds: Partial<Record<LoadedRecipePart, unknown>> = {
    profile: record?.profileId ?? null,
    dose,
    yield: numberOf(variables.drink) ?? (dose !== null && ratio !== null ? Math.round(dose * ratio * 10) / 10 : null),
    grind: variables.grind ?? null,
    rpm: numberOf(variables.rpm),
    basket: variables.basketId ?? null,
    brewTemperature: numberOf(variables.brewC),
  };
  const parts = { ...target };
  for (const part of ["profile", "dose", "yield", "grind", "rpm", "basket", "brewTemperature"] as const) {
    if (parts[part] !== null && parts[part] !== undefined && (record === null || !samePart(part, holds[part], parts[part]))) parts[part] = undefined;
  }
  return parts;
}

/**
 * What a write puts in the Workflow beside a part's id: the Grinder's model,
 * the Basket's name, and the batch's Bean's name and roaster, as DYE2
 * copies them, and the Profile whole, as Decaid keeps it.
 */
export interface PartNames {
  profile: Record<string, unknown> | null;
  grinderModel: string | null;
  basketName: string | null;
  coffeeName: string | null;
  coffeeRoaster: string | null;
}

/**
 * The fields of a write of LOADED_RECIPE_KIND that bring the Workflow, as
 * it last held its parts (`held`), to its Loaded Recipe's (`target`, as
 * `recipeParts` reads it), and the value it expects of each part's first
 * field: each part the Recipe holds a value of that the Workflow holds
 * otherwise, with the names DYE2 copies beside a Grinder, a Basket and a
 * batch, where known. One the tablet holds no record of yet waits. A Profile
 * is written whole, expecting nothing, as a skin overrides parts of the one
 * it loads, and only where the Library holds it. Null if none differs.
 */
export function partsWrite(
  target: Readonly<Record<LoadedRecipePart, PartValue | undefined>>,
  held: WorkflowParts,
  names: PartNames,
): { fields: Record<string, unknown>; expected: Record<string, unknown> } | null {
  const fields: Record<string, unknown> = {};
  const expected: Record<string, unknown> = {};
  for (const part of PARTS) {
    const value = target[part];
    if (value === null || value === undefined || samePart(part, held[part], value)) continue;
    const [first, ...rest] = LOADED_RECIPE_PARTS[part] as readonly [string, ...string[]];
    if (part === "profile") {
      if (names.profile !== null) fields[first] = names.profile;
      continue;
    }
    fields[first] = value;
    expected[first] = held[part];
    const copied: Record<string, string | null> = {
      "context.grinderModel": names.grinderModel,
      "context.extras.basketName": names.basketName,
      "context.coffeeName": names.coffeeName,
      "context.coffeeRoaster": names.coffeeRoaster,
    };
    for (const field of rest) if (copied[field] !== null && copied[field] !== undefined) fields[field] = copied[field];
  }
  // A Profile written whole holds its own step temperatures: its brew temperature is moved to the Recipe's after it.
  const temperature = target.brewTemperature;
  if ("profile" in fields && typeof temperature === "number") {
    fields[BREW_TEMPERATURE_FIELD] = temperature;
    delete expected[BREW_TEMPERATURE_FIELD];
  }
  return Object.keys(fields).length === 0 ? null : { fields, expected };
}

/** A number as Decaid reads one: a number, or text that reads as one; otherwise null. */
function numberOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^\s*[+-]?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
