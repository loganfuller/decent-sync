import { LOADED_RECIPE_PARTS, type LoadedRecipePart, RECIPE_FIELD, sameValue, workflowValueAt } from "@decent-sync/protocol";
import { isObject } from "./listed.js";
import { ratioValues } from "./recipe-intake.js";

// How the parts of a Workflow that follow its Loaded Recipe (ADR-0022,
// LOADED_RECIPE_PARTS) map to the Recipe's content, both ways: a change of
// one on the Recipe's Machine is an edit of the Recipe, but of its Grinder
// or Profile, which unloads it instead (the plugin's recipe-matching.ts),
// and a field of the Recipe's that the Workflow holds otherwise is written
// into it. A Workflow names its Grinder, Basket and Bean Batch by the
// tablet's ids, holds its Profile whole, and keeps its grind setting as
// text, as Decaid does; a Recipe names them by their global ids, its Profile
// by Decaid's, and keeps the grind setting DYE2 saves, a number. Pure, so
// module tests can drive it; machine-events/loaded-recipes.ts reads what it
// needs and carries it out.

/** Each part, in the order LOADED_RECIPE_PARTS lists them. */
export const PARTS = Object.keys(LOADED_RECIPE_PARTS) as LoadedRecipePart[];

/** The parts a change on the Machine edits the Recipe in: all but its Grinder and Profile, a change of which unloads it. */
export const EDITED_PARTS: readonly LoadedRecipePart[] = PARTS.filter((part) => part !== "grinder" && part !== "profile");

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
 * The parts the Workflow holds now (`now`) otherwise than it last did
 * (`held`): a part it holds none of now is no change, as Streamline clears
 * the batch, Basket and RPM once each Shot is stored, so they do not label
 * the next one, and the Recipe keeps them.
 */
export function changedParts(held: WorkflowParts, now: WorkflowParts): LoadedRecipePart[] {
  return EDITED_PARTS.filter((part) => now[part] !== null && !samePart(part, held[part], now[part]));
}

/** What reading a Workflow's parts into its Loaded Recipe looks up. */
export interface PartLookups {
  /** The Library item the tablet's record with that id is, by its map; undefined where the map holds none. */
  item(kind: "basket" | "beanBatch", localId: string): string | undefined;
  /** The Bean of a Bean Batch, by its global id; undefined where the Library has none. */
  beanOf(batchId: string): string | undefined;
}

/** What a change of a Workflow's parts makes of its Loaded Recipe (`partEdits`). */
export interface PartEdits {
  /** The fields of the Recipe's content the change sets, with their values: an edit of it, empty for none. */
  values: Record<string, unknown>;
  /** The parts the Workflow is held to hold from now on, as it holds them now: those that are edits, or no change of the Recipe. */
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
 * - a value set back to one the Recipe held before is an edit, as a barista
 *   setting back a tweak, which a stale copy of the Recipe applied looks
 *   like and so is too (ADR-0022): the barista's set-back wins;
 * - DYE2's ratio is kept only while the yield is the dose times it
 *   (`ratioValues`), the Workflow's yield kept as the Recipe's where it held
 *   none, the yield worked out from the ratio.
 */
export function partEdits(
  parts: readonly LoadedRecipePart[],
  now: WorkflowParts,
  content: Readonly<Record<string, unknown>>,
  lookups: PartLookups,
): PartEdits {
  const edits: PartEdits = { values: {}, taken: [], unmapped: [] };
  for (const part of parts) {
    const held = now[part];
    if (held === null) continue;
    const field = RECIPE_FIELDS[part];
    const kind = ITEM_PARTS[part];
    // A Grinder or Profile changed unloads the Recipe rather than edits it.
    if (kind === "grinder" || part === "profile") continue;
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
    if (sameValue(content[field] ?? null, value)) continue;
    edits.values[field] = value;
  }
  if ("dose" in edits.values && typeof content.yield !== "number" && !("yield" in edits.values) && typeof now.yield === "number") {
    edits.values.yield = now.yield;
  }
  Object.assign(edits.values, ratioValues(content, edits.values));
  return edits;
}

/**
 * What the Workflow is to hold of each part of a Recipe with this content,
 * as its tablet names it (`local`, the tablet's id for an item by its map):
 * null where the Recipe holds none, and undefined for a Grinder, Basket or
 * batch the tablet holds no record of yet, which is written first; its
 * Profile by Decaid's id, the same on every tablet. Its yield is its
 * dose times its ratio where it holds none, as DYE2 applies one.
 */
export function recipeParts(content: Readonly<Record<string, unknown>>, local: (kind: ItemKind, itemId: string) => string | undefined): Record<LoadedRecipePart, PartValue | undefined> {
  const parts = {} as Record<LoadedRecipePart, PartValue | undefined>;
  for (const part of PARTS) {
    const value = content[RECIPE_FIELDS[part]];
    const kind = ITEM_PARTS[part];
    parts[part] = kind !== undefined ? (typeof value === "string" ? local(kind, value) : null) : partValue(part, value);
    if (part === "profile") parts[part] = textOf(value);
  }
  const [dose, ratio] = [numberOf(content.dose), numberOf(content.ratio)];
  if (parts.yield === null && dose !== null && ratio !== null) parts.yield = Math.round(dose * ratio * 10) / 10;
  return parts;
}

/**
 * The parts of a Recipe the Workflow is to hold (`target`, as `recipeParts`
 * reads it) that wait for the tablet's record of the Recipe (`record`, as
 * the server last knew it) to hold them too: its dial (Profile, Grinder,
 * dose, yield and grind setting) and its Bean Batch. The plugin works out
 * which recipe a change of the Workflow's dial loads, and whether a change
 * of its Profile, Grinder or Bean unloads it, from the tablet's records
 * (recipe-matching.ts), so one written into the Workflow before the record,
 * as when the tablet refused the record's write, could unload the Recipe,
 * or load another whose record it then matches. Each that waits is
 * undefined, as one the tablet holds no record of yet is; the rest of the
 * write goes ahead.
 */
export function heldByRecord(
  target: Readonly<Record<LoadedRecipePart, PartValue | undefined>>,
  record: Readonly<Record<string, unknown>> | null,
): Record<LoadedRecipePart, PartValue | undefined> {
  const variables = isObject(record?.dashboardVariables) ? record.dashboardVariables : {};
  const own = isObject(record?.[RECIPE_FIELD]) ? record[RECIPE_FIELD] : {};
  const [dose, ratio] = [numberOf(variables.dose), numberOf(variables.ratio)];
  const holds: Partial<Record<LoadedRecipePart, unknown>> = {
    profile: record?.profileId ?? null,
    grinder: variables.grinderId ?? null,
    dose,
    yield: numberOf(variables.drink) ?? (dose !== null && ratio !== null ? Math.round(dose * ratio * 10) / 10 : null),
    grind: variables.grind ?? null,
    batch: own.beanBatchId ?? null,
  };
  const parts = { ...target };
  for (const part of ["profile", "grinder", "dose", "yield", "grind", "batch"] as const) {
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
