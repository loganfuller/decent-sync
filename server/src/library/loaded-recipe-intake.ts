import { LOADED_RECIPE_PARTS, type LoadedRecipePart, RECIPE_FIELD, sameValue, workflowValueAt } from "@decent-sync/protocol";
import { isObject } from "./listed.js";
import { ratioValues } from "./recipe-intake.js";

// How the parts of a Workflow that follow its Loaded Recipe (ADR-0022,
// LOADED_RECIPE_PARTS) map to the Recipe's content, both ways: a change of
// one on the Recipe's Machine is an edit of the Recipe, and a field of the
// Recipe's that the Workflow holds otherwise is written into it. A Workflow
// names its Basket and Bean Batch by the tablet's ids, and keeps its grind
// setting as text, as Decaid does; a Recipe names them by their global ids,
// and keeps the grind setting DYE2 saves, a number. Pure, so module tests
// can drive it; machine-events/loaded-recipes.ts reads what it needs and
// carries it out.

/** Each part, in the order LOADED_RECIPE_PARTS lists them. */
export const PARTS = Object.keys(LOADED_RECIPE_PARTS) as LoadedRecipePart[];

/** A part's value as a Workflow holds it: a number, a grind setting's text, or the tablet's id for a Basket or Bean Batch; null for none. */
export type PartValue = number | string | null;

/** The parts a Workflow holds, by name. */
export type WorkflowParts = Record<LoadedRecipePart, PartValue>;

/** The field of a Recipe's content each part follows. */
export const RECIPE_FIELDS: Readonly<Record<LoadedRecipePart, string>> = {
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
};

/** The parts naming a Library item, each with its kind, by the tablet's id for it. */
const ITEM_PARTS: Partial<Readonly<Record<LoadedRecipePart, ItemKind>>> = { basket: "basket", batch: "beanBatch" };

/** The kinds of item a part names. */
export type ItemKind = "basket" | "beanBatch";

/** The parts a Workflow holds. */
export function workflowParts(workflow: unknown): WorkflowParts {
  return Object.fromEntries(PARTS.map((part) => [part, partValue(part, workflowValueAt(workflow, LOADED_RECIPE_PARTS[part][0]))])) as WorkflowParts;
}

/** Parts as stored (`tablet_loaded_recipes.held`): a part missing, or of no value, is none. */
export function readParts(value: unknown): WorkflowParts {
  const stored = isObject(value) ? value : {};
  return Object.fromEntries(PARTS.map((part) => [part, partValue(part, stored[part])])) as WorkflowParts;
}

/** A value as a part holds it: text for a grind setting, a Basket or a batch, a number for the rest; null for none. */
function partValue(part: LoadedRecipePart, value: unknown): PartValue {
  if (part === "grind") return typeof value === "number" ? (Number.isFinite(value) ? String(value) : null) : textOf(value);
  return ITEM_PARTS[part] !== undefined ? textOf(value) : numberOf(value);
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
 * The parts the Workflow holds now (`now`) otherwise than it last did
 * (`held`): a part it holds none of now is no change, as Streamline clears
 * the batch, Basket and RPM once each Shot is stored, so they do not label
 * the next one, and the Recipe keeps them.
 */
export function changedParts(held: WorkflowParts, now: WorkflowParts): LoadedRecipePart[] {
  return PARTS.filter((part) => now[part] !== null && !samePart(part, held[part], now[part]));
}

/** What reading a Workflow's parts into its Loaded Recipe looks up. */
export interface PartLookups {
  /** The Library item the tablet's record with that id is, by its map; undefined where the map holds none. */
  item(kind: ItemKind, localId: string): string | undefined;
  /** The Bean of a Bean Batch, by its global id; undefined where the Library has none. */
  beanOf(batchId: string): string | undefined;
}

/** What a Recipe's tablet's record held just before the server's latest write of its fields, and each of the Recipe's fields before its current value. */
export interface StaleCheck {
  /** The record's `before_write`, by its paths (recipe-intake.ts); null for none. */
  beforeWrite: Readonly<Record<string, unknown>> | null;
  /** The value each field of the Recipe held just before its current one, by field; absent where none is known. */
  previous: Readonly<Record<string, unknown>>;
}

/** What a change of a Workflow's parts makes of its Loaded Recipe (`partEdits`). */
export interface PartEdits {
  /** The fields of the Recipe's content the change sets, with their values: an edit of it, empty for none. */
  values: Record<string, unknown>;
  /** The parts the Workflow is held to hold from now on, as it holds them now: those that are edits, or no change of the Recipe, or set back by a stale copy. */
  taken: LoadedRecipePart[];
  /** The parts naming a Basket or batch the tablet's map does not hold yet, which are taken in as it gains them. */
  unmapped: LoadedRecipePart[];
}

/**
 * What a change of the parts given (`parts`, as `changedParts` finds them),
 * which the Workflow holds now (`now`), makes of its Loaded Recipe, whose
 * content is `content`:
 *
 * - a dose, yield, RPM or hot water setting is the Recipe's, and a grind
 *   setting that reads as a number is, as that number, as DYE2 keeps one;
 * - a Basket is the Library's the tablet's map says, and one it does not
 *   hold yet waits for it (`unmapped`);
 * - a Bean Batch is the Recipe's only where it is of the Recipe's Bean,
 *   which moves the Recipe to it; one of another Bean, or of a Recipe naming
 *   none, is none of its, as the plugin unloads the Recipe then, and the
 *   Workflow is not held to hold it;
 * - a value the Recipe holds already is no edit, as when Streamline saves
 *   the change into the recipe too, and its report arrived first;
 * - a value set back to what the tablet's record of the Recipe held just
 *   before the server's latest write of it, which was the Recipe's before its
 *   current one (`stale`), is a recipe applied from a copy read before that
 *   write, as a DYE2 page or Streamline strip opened before it, no edit
 *   (ADR-0005): the Recipe's value is written back;
 * - DYE2's ratio is kept only while the yield is the dose times it
 *   (`ratioValues`), the Workflow's yield kept as the Recipe's where it held
 *   none, the yield worked out from the ratio.
 */
export function partEdits(
  parts: readonly LoadedRecipePart[],
  now: WorkflowParts,
  content: Readonly<Record<string, unknown>>,
  lookups: PartLookups,
  stale: StaleCheck,
): PartEdits {
  const edits: PartEdits = { values: {}, taken: [], unmapped: [] };
  for (const part of parts) {
    const held = now[part];
    if (held === null) continue;
    const field = RECIPE_FIELDS[part];
    const kind = ITEM_PARTS[part];
    let value: unknown;
    if (kind !== undefined) {
      value = lookups.item(kind, String(held));
      if (value === undefined) {
        edits.unmapped.push(part);
        continue;
      }
      const bean = content.beanId;
      if (kind === "beanBatch" && (typeof bean !== "string" || lookups.beanOf(value as string) !== bean)) continue;
    } else if (part === "grind") {
      value = numberOf(held);
      // A grind setting that is not a number is no Recipe's, which DYE2 keeps as one.
      if (value === null) continue;
    } else {
      value = held;
    }
    edits.taken.push(part);
    if (sameValue(content[field] ?? null, value) || setBack(part, held, value, content[field], stale)) continue;
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
 * before its current one (`current`).
 */
function setBack(part: LoadedRecipePart, held: PartValue, value: unknown, current: unknown, stale: StaleCheck): boolean {
  if (stale.beforeWrite === null || !Object.prototype.hasOwnProperty.call(stale.previous, RECIPE_FIELDS[part])) return false;
  if (!sameValue(stale.previous[RECIPE_FIELDS[part]], value) || sameValue(current ?? null, value)) return false;
  return recordValues(part, stale.beforeWrite).some((before) => samePart(part, before, held));
}

/**
 * The values a recipe record's `before_write` keeps of a part: its own of
 * the record's `dashboardVariables`, and its Bean Batch and hot water in the
 * record's own field (RECIPE_FIELD), each only where the server wrote it.
 */
function recordValues(part: LoadedRecipePart, beforeWrite: Readonly<Record<string, unknown>>): unknown[] {
  const has = (path: string) => Object.prototype.hasOwnProperty.call(beforeWrite, path);
  const values = DASHBOARD_PATHS[part].filter(has).map((path) => beforeWrite[path]);
  if (has(RECIPE_FIELD)) {
    const own = isObject(beforeWrite[RECIPE_FIELD]) ? beforeWrite[RECIPE_FIELD] : {};
    const hotWater = isObject(own.hotWaterData) ? own.hotWaterData : {};
    if (part === "batch") values.push(own.beanBatchId ?? null);
    if (part in HOT_WATER_NAMES) values.push(hotWater[part] ?? null);
  }
  return values;
}

/** The paths of a recipe record's `dashboardVariables` holding each part, as DYE2 keeps one hot water value of its mode. */
const DASHBOARD_PATHS: Readonly<Record<LoadedRecipePart, readonly string[]>> = {
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
};

/** The hot water parts, as a recipe record's own field keeps all four. */
const HOT_WATER_NAMES = { targetTemperature: true, duration: true, volume: true, flow: true } as const;

/**
 * What the Workflow is to hold of each part of a Recipe with this content,
 * as its tablet names it (`local`, the tablet's id for an item by its map):
 * null where the Recipe holds none, and undefined for a Basket or batch the
 * tablet holds no record of yet, which is written first. Its yield is its
 * dose times its ratio where it holds none, as DYE2 applies one.
 */
export function recipeParts(content: Readonly<Record<string, unknown>>, local: (kind: ItemKind, itemId: string) => string | undefined): Record<LoadedRecipePart, PartValue | undefined> {
  const parts = {} as Record<LoadedRecipePart, PartValue | undefined>;
  for (const part of PARTS) {
    const value = content[RECIPE_FIELDS[part]];
    const kind = ITEM_PARTS[part];
    parts[part] = kind !== undefined ? (typeof value === "string" ? local(kind, value) : null) : partValue(part, value);
  }
  const [dose, ratio] = [numberOf(content.dose), numberOf(content.ratio)];
  if (parts.yield === null && dose !== null && ratio !== null) parts.yield = Math.round(dose * ratio * 10) / 10;
  return parts;
}

/** What DYE2 copies into the Workflow beside a Basket and a Bean Batch: the Basket's name, and the batch's Bean's name and roaster. */
export interface PartNames {
  basketName: string | null;
  coffeeName: string | null;
  coffeeRoaster: string | null;
}

/**
 * The fields of a write of LOADED_RECIPE_KIND that bring the Workflow, as
 * it last held its parts (`held`), to its Loaded Recipe's (`target`, as
 * `recipeParts` reads it), and the value it expects of each part's first
 * field: each part the Recipe holds a value of that the Workflow holds
 * otherwise, with the names DYE2 copies beside a Basket and a batch, where
 * known. One the tablet holds no record of yet waits. Null if none differs.
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
    fields[first] = value;
    expected[first] = held[part];
    const copied: Record<string, string | null> = {
      "context.extras.basketName": names.basketName,
      "context.coffeeName": names.coffeeName,
      "context.coffeeRoaster": names.coffeeRoaster,
    };
    for (const field of rest) if (copied[field] !== null && copied[field] !== undefined) fields[field] = copied[field];
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
