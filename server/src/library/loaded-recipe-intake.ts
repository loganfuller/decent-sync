import { BREW_TEMPERATURE_FIELD, LOADED_RECIPE_PARTS, type LoadedRecipePart, RECIPE_SETTING_NAMES, type RecipeSetting, sameValue, workflowValueAt } from "@decent-sync/protocol";
import { isObject } from "./listed.js";

// How the parts of a Workflow that follow its Loaded Recipe (ADR-0022,
// LOADED_RECIPE_PARTS) map to the Recipe's content, both ways: a change of
// one on the Recipe's Machine is saved into the Recipe, by DYE2 into the
// Recipe's record where it holds one (`RECORDED_PARTS`), and by Decent Sync
// otherwise (`valuesFromWorkflow`), but of the Profile, which unloads it
// instead (DYE2 clears the Workflow's recipe); and a field of the Recipe's
// that changed since the Workflow last took it, and that the Workflow holds
// otherwise, is written into it (`dueParts`). A Workflow names its Grinder,
// Basket and Bean Batch by the tablet's ids, holds its Profile whole, its
// brew temperature as its first step's, and keeps its grind setting as text,
// as Decaid does; a Recipe names them by their global ids, its Profile by
// Decaid's, and keeps the grind setting DYE2 saves, a number. Pure, so
// module tests can drive it; machine-events/loaded-recipes.ts reads what it
// needs and carries it out.

/** Each part, in the order LOADED_RECIPE_PARTS lists them. */
export const PARTS = Object.keys(LOADED_RECIPE_PARTS) as LoadedRecipePart[];

/**
 * The parts DYE2 saves into the Loaded Recipe's record as the plugin has it
 * save a change of the Workflow (`record`), so a change of them on the
 * Machine reaches the server as the tablet's change of the record: its dose,
 * yield, grind setting, RPM, Basket and brew temperature, where the record
 * holds one, and its steam, hot water and flush settings, each where the
 * record holds it, or once it moves off the value the Workflow held as the
 * recipe was applied (`itemPatch` in
 * dye2:dye2-plugin/src/utils/workflow-record.ts at v0.1.26). DYE2 saves
 * none of steam turned off, a value cleared, the Bean Batch, the Grinder or
 * the Profile.
 */
export const RECORDED_PARTS: readonly LoadedRecipePart[] = ["dose", "yield", "grind", "rpm", "basket", "brewTemperature", ...RECIPE_SETTING_NAMES];

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
  brewTemperature: "brewTemperature",
  // Each setting's part is named as the Recipe's field.
  ...(Object.fromEntries(RECIPE_SETTING_NAMES.map((setting) => [setting, setting])) as Record<RecipeSetting, string>),
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
export function partValue(part: LoadedRecipePart, value: unknown): PartValue {
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
 * The Recipe's parts as a tablet's Workflow last took them
 * (`tablet_loaded_recipes.base`), each as `WorkflowParts` holds it; a part
 * it does not name was never taken.
 */
export type BaseParts = Partial<WorkflowParts>;

/** Base parts as stored: known parts only. */
export function readBase(value: unknown): BaseParts {
  const stored = isObject(value) ? value : {};
  const base: BaseParts = {};
  for (const part of PARTS) if (Object.prototype.hasOwnProperty.call(stored, part)) base[part] = partValue(part, stored[part]);
  return base;
}

/**
 * The parts of a Recipe (`target`, as `recipeParts` reads it) a tablet's
 * Workflow is due: each the Recipe holds that the Workflow holds otherwise
 * (`held`), but one the Workflow took as the Recipe holds it now (`base`),
 * which a change on the Machine since left as the Machine's own, as a batch
 * of another Bean, a value cleared or steam turned off (ADR-0022). The rest
 * are left out (undefined).
 */
export function dueParts(
  target: Readonly<Record<LoadedRecipePart, PartValue | undefined>>,
  held: WorkflowParts,
  base: BaseParts,
): Record<LoadedRecipePart, PartValue | undefined> {
  const due = {} as Record<LoadedRecipePart, PartValue | undefined>;
  for (const part of PARTS) {
    const value = target[part];
    const taken = Object.prototype.hasOwnProperty.call(base, part) && samePart(part, base[part], value);
    due[part] = value === null || value === undefined || samePart(part, held[part], value) || taken ? undefined : value;
  }
  // A Profile written whole holds its own step temperatures, which are moved to the Recipe's brew temperature with it.
  if (due.profile !== undefined && typeof target.brewTemperature === "number") due.brewTemperature = target.brewTemperature;
  return due;
}

/**
 * The parts of a Recipe a Workflow holds already as the Recipe does: on a
 * load, the base the Workflow starts from (`BaseParts`), so every other
 * part the Recipe holds is written into it once.
 */
export function heldAlready(target: Readonly<Record<LoadedRecipePart, PartValue | undefined>>, held: WorkflowParts): BaseParts {
  const base: BaseParts = {};
  for (const part of PARTS) {
    const value = target[part];
    if (value !== undefined && samePart(part, held[part], value)) base[part] = value;
  }
  return base;
}

/** What `valuesFromWorkflow` reads besides the parts: the tablet's map back to the Library, and the Location's Grinders and each batch's Bean. */
export interface WorkflowValuesContext {
  /** The Library item a record of the tablet's is, by its id there; undefined where the map holds none. */
  item(kind: ItemKind, localId: string): string | undefined;
  /** The Grinders of the Recipe's Location, not Archived: a Recipe names only one of them. */
  grinders: ReadonlySet<string>;
  /** Each Bean Batch's Bean, by their global ids. */
  batchBeans: ReadonlyMap<string, string>;
}

/** The parts Decent Sync takes into a Recipe from its Machine's Workflow, but where the Recipe holds a value already: its dial but the brew temperature. */
const DIAL_FIELDS = { dose: "dose", yield: "yield", grind: "grindSetting", rpm: "rpm", basket: "basketId" } as const satisfies Partial<Record<LoadedRecipePart, string>>;

/**
 * The values of a Recipe (`content`, its parts `target` as `recipeParts`
 * reads them) that its Machine's Workflow sets, which Decent Sync records
 * itself as the tablet's edit, as DYE2 saves none of them (ADR-0022), each
 * where the Workflow changed it from `held`, the parts as it last held them,
 * or, on a load (`held` null), where the Recipe holds none, from the
 * Workflow as it stands (`now`): a dose, yield, grind setting, RPM or Basket
 * the Recipe holds none of; a Grinder, one of the Location's; and a Bean
 * Batch of the Recipe's own Bean, or with its Bean for a Recipe naming no
 * Bean. A batch of another Bean, a value cleared, and anything the map does
 * not hold stay the Machine's own. With the parts they record.
 */
export function valuesFromWorkflow(
  content: Readonly<Record<string, unknown>>,
  target: Readonly<Record<LoadedRecipePart, PartValue | undefined>>,
  held: WorkflowParts | null,
  now: WorkflowParts,
  context: WorkflowValuesContext,
): { values: Record<string, unknown>; parts: LoadedRecipePart[] } {
  const values: Record<string, unknown> = {};
  const parts: LoadedRecipePart[] = [];
  const changed = (part: LoadedRecipePart) => now[part] !== null && (held === null ? target[part] === null : !samePart(part, held[part], now[part]));
  for (const [part, field] of Object.entries(DIAL_FIELDS) as [keyof typeof DIAL_FIELDS, string][]) {
    if (target[part] !== null || !changed(part)) continue;
    const value = part === "basket" ? context.item("basket", now.basket as string) : part === "grind" ? numberOf(now.grind) : now[part];
    if (value === undefined || value === null) continue;
    values[field] = value;
    parts.push(part);
  }
  if (changed("grinder")) {
    const grinderId = context.item("grinder", now.grinder as string);
    if (grinderId !== undefined && context.grinders.has(grinderId) && grinderId !== textOf(content.grinderId)?.toLowerCase()) {
      values.grinderId = grinderId;
      parts.push("grinder");
    }
  }
  if (changed("batch")) {
    const batchId = context.item("beanBatch", now.batch as string);
    const beanId = batchId === undefined ? undefined : context.batchBeans.get(batchId);
    const recipeBean = textOf(content.beanId)?.toLowerCase() ?? null;
    if (batchId !== undefined && beanId !== undefined && (recipeBean === null || recipeBean === beanId)) {
      values.beanBatchId = batchId;
      if (recipeBean === null) values.beanId = beanId;
      parts.push("batch");
    }
  }
  return { values, parts };
}

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
