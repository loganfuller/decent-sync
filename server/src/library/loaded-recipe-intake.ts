import {
  BREW_TEMPERATURE_FIELD,
  LOADED_RECIPE_PARTS,
  type LoadedRecipePart,
  RECIPE_SETTING_NAMES,
  type RecipeSetting,
  WHOLE_SHOT_PARTS,
  WORKFLOW_YIELD_OFF,
  type Profile,
  dye2Fingerprint,
  grindSettingOf,
  isZero,
  sameGrindSetting,
  sameValue,
  steamTimeOf,
  workflowValueAt,
  profileOf,
} from "@decent-sync/protocol";
import { isObject } from "./listed.js";

// How the parts of a Workflow that follow its Loaded Recipe (ADR-0022,
// LOADED_RECIPE_PARTS) map to the Recipe's content, both ways: a change of
// one on the Recipe's Machine is saved into the Recipe, by DYE2 into the
// Recipe's record (`RECORDED_PARTS`), and by Decent Sync where DYE2 saves
// none (`valuesFromWorkflow`), but of the Profile, which unloads it
// instead (DYE2 clears the Workflow's recipe); and a field of the Recipe's
// that changed since the Workflow last took it, and that the Workflow holds
// otherwise, is written into it (`dueParts`), one the Recipe holds none of
// cleared from it where the Recipe is the whole Shot in it
// (WHOLE_SHOT_PARTS). A Workflow names its Grinder,
// Basket and Bean Batch by the tablet's ids, holds its Profile whole, its
// brew temperature as its first step's, and keeps its grind setting as text,
// as Decaid does; a Recipe names them by their global ids, its Profile by
// Decaid's, and keeps the grind setting as DYE2 v0.1.32 saves one, a number
// where it reads as one and otherwise the text (`grindSettingOf`). Pure, so
// module tests can drive it; machine-events/loaded-recipes.ts reads what it
// needs and carries it out.

/** Each part, in the order LOADED_RECIPE_PARTS lists them. */
export const PARTS = Object.keys(LOADED_RECIPE_PARTS) as LoadedRecipePart[];

/**
 * The parts DYE2 saves into the Loaded Recipe's record as the plugin has it
 * save a change of the Workflow (`record`), so a change of them on the
 * Machine reaches the server as the tablet's change of the record: its dose,
 * yield, grind setting, RPM, feed rate (from v0.1.34) and brew temperature,
 * where the record holds one; its Basket, where the record holds one, or
 * once it moves off the one the Workflow held as the recipe was applied
 * (`163a7c8`, from v0.1.33); and its steam, hot water and flush settings,
 * each where the record holds it, or once it moves off the value the
 * Workflow held as the recipe was applied (`itemPatch` and
 * `movedSinceArming` in dye2:dye2-plugin/src/utils/workflow-record.ts at
 * v0.1.35), but a steam temperature or steam time while steam is off, the
 * steam flow and milk stop then being saved too (`STEAM_OFF_KEYS`,
 * `5561549`, from v0.1.35). DYE2 saves none of steam turned off, a value
 * cleared, the Bean Batch, the Grinder or the Profile.
 */
export const RECORDED_PARTS: readonly LoadedRecipePart[] = ["dose", "yield", "grind", "rpm", "feedRate", "basket", "brewTemperature", ...RECIPE_SETTING_NAMES];

/**
 * A part's value as a Workflow holds it: a number, a grind setting's or
 * feed rate's text, the tablet's id for a Grinder, Basket or Bean Batch, or
 * the id of the Library Profile its profile is; null for none.
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
  feedRate: "feedRate",
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

/** A value as a part holds it: text for a grind setting, a feed rate, a Basket or a batch, a number for the rest; null for none. */
export function partValue(part: LoadedRecipePart, value: unknown): PartValue {
  if (part === "grind") return typeof value === "number" ? (Number.isFinite(value) ? String(value) : null) : textOf(value);
  return ITEM_PARTS[part] !== undefined || part === "profile" || part === "feedRate" ? textOf(value) : numberOf(value);
}

/**
 * The parts of which 0 is none: a dose, grind setting and RPM, as a Recipe
 * holds none of one at 0 (RECIPE_NONE_AT_ZERO in protocol/), and a yield, as
 * 0 is stop-at-weight off, which a Workflow holding none has too
 * (WORKFLOW_YIELD_OFF).
 */
const NONE_AT_ZERO: ReadonlySet<LoadedRecipePart> = new Set(["dose", "yield", "grind", "rpm"]);

/** Whether 0 is none of a part: a dose, yield, grind setting or RPM (`NONE_AT_ZERO`). */
export function noneAtZeroPart(part: LoadedRecipePart): boolean {
  return NONE_AT_ZERO.has(part);
}

/** Whether a part's value is none: null, or 0 for a dose, yield, grind setting or RPM (`NONE_AT_ZERO`). */
export function nonePart(part: LoadedRecipePart, value: unknown): boolean {
  return value === null || value === undefined || (NONE_AT_ZERO.has(part) && isZero(value));
}

/**
 * Whether two values of a part are the same: none both (`nonePart`), or
 * grind settings as numbers where both read as one, as Decaid keeps DYE2's 3
 * as "3" and a barista may type `.5` for 0.5 (`sameGrindSetting`).
 */
export function samePart(part: LoadedRecipePart, a: unknown, b: unknown): boolean {
  const [none, other] = [nonePart(part, a), nonePart(part, b)];
  if (none || other) return none && other;
  if (part === "grind") return sameGrindSetting(a, b);
  return sameValue(a, b);
}

/** The key of `BaseParts` holding the Recipe's Bean as the Workflow last took it. */
export const BEAN_TAKEN = "bean";

/**
 * The Bean taken (`BEAN_TAKEN`) by a Workflow holding the coffee of none the
 * Recipe names now, as one loaded from an out-of-date copy of its record, or
 * written as of an edit of its Bean a later one replaced: so the Recipe's
 * Bean is due into it, whichever it is.
 */
export const OTHER_BEAN = "other";

/**
 * The Recipe's parts as a tablet's Workflow last took them
 * (`tablet_loaded_recipes.base`), each as `WorkflowParts` holds it; a part
 * it does not name was never taken. With them, under `BEAN_TAKEN`, the
 * Recipe's Bean as the Workflow last took it, by its global id, or null for
 * none: where the Recipe names no Bean Batch, the batch part's coffee name
 * and roaster follow a change of it (#572). A base without it, as a release
 * before that saved, took the Recipe's Bean as it is now, until an edit of
 * the Recipe changes it (`keepBeanTaken`).
 */
export type BaseParts = Partial<WorkflowParts> & { [BEAN_TAKEN]?: string | null };

/** Base parts as stored: known parts only, and the Bean taken where it is kept. */
export function readBase(value: unknown): BaseParts {
  const stored = isObject(value) ? value : {};
  const base: BaseParts = {};
  for (const part of PARTS) if (Object.prototype.hasOwnProperty.call(stored, part)) base[part] = partValue(part, stored[part]);
  if (Object.prototype.hasOwnProperty.call(stored, BEAN_TAKEN)) base[BEAN_TAKEN] = beanIdOf(stored[BEAN_TAKEN]);
  return base;
}

/** The Bean a Recipe with this content names, by its global id, lower case; null for none. */
export function recipeBean(content: Readonly<Record<string, unknown>>): string | null {
  return beanIdOf(content.beanId);
}

function beanIdOf(value: unknown): string | null {
  return textOf(value)?.toLowerCase() ?? null;
}

/** The parts of a Recipe a tablet's Workflow is due (`dueParts`): each part's value, and whether its batch part is due for a change of the Recipe's Bean alone. */
export type DueParts = Record<LoadedRecipePart, PartValue | undefined> & { beanDue?: true };

/**
 * The parts of a Recipe (`target`, as `recipeParts` reads it) a tablet's
 * Workflow is due: each the Workflow holds otherwise than the Recipe
 * (`held`), but one the Workflow took as the Recipe holds it now (`base`),
 * which a change on the Machine since left as the Machine's own, as a batch
 * the Library retired, a value cleared or steam turned off (ADR-0022). One the
 * Recipe holds none of is due cleared (null) where the Recipe is the whole
 * Shot in it (WHOLE_SHOT_PARTS), as a Grinder or a dose, and never where the
 * Machine keeps its own, as a steam time. The rest are left out (undefined).
 * Where the Recipe names no batch, its batch part is due cleared too once
 * the Recipe's Bean (`bean`, as `recipeBean` reads it) is another than the
 * Workflow last took (`BEAN_TAKEN`), so the Bean's name and roaster are
 * written into it, or cleared, over any the Machine holds as its own
 * (`beanDue`, #572); a base keeping no Bean took the Recipe's as it is now.
 */
export function dueParts(
  target: Readonly<Record<LoadedRecipePart, PartValue | undefined>>,
  held: WorkflowParts,
  base: BaseParts,
  bean?: string | null,
): DueParts {
  const due = {} as DueParts;
  for (const part of PARTS) {
    const value = target[part];
    const none = nonePart(part, value);
    const taken = Object.prototype.hasOwnProperty.call(base, part) && samePart(part, base[part], value);
    const left = value === undefined || (none && !WHOLE_SHOT_PARTS.has(part));
    due[part] = left || samePart(part, held[part], value) || taken ? undefined : none ? null : value;
  }
  if (target.batch === null && bean !== undefined && Object.prototype.hasOwnProperty.call(base, BEAN_TAKEN) && base[BEAN_TAKEN] !== bean) {
    due.batch = null;
    due.beanDue = true;
  }
  // A Profile written whole holds its own step temperatures, which are moved to the Recipe's brew temperature with it.
  if (due.profile !== undefined && typeof target.brewTemperature === "number") due.brewTemperature = target.brewTemperature;
  return due;
}

/**
 * The parts of a Recipe a Workflow holds already as the Recipe does, none
 * of one included: on a load, the base the Workflow starts from
 * (`BaseParts`), so every other part is written into it once, or cleared
 * from it (`dueParts`).
 */
export function heldAlready(target: Readonly<Record<LoadedRecipePart, PartValue | undefined>>, held: WorkflowParts): BaseParts {
  const base: BaseParts = {};
  for (const part of PARTS) {
    const value = target[part];
    if (value !== undefined && samePart(part, held[part], value)) base[part] = value;
  }
  return base;
}

/**
 * What `valuesFromWorkflow` reads besides the parts: the tablet's map back to
 * the Library, the Location's Grinders, each batch's Bean, and the batches
 * the Library retired.
 */
export interface WorkflowValuesContext {
  /** The Library item a record of the tablet's is, by its id there; undefined where the map holds none. */
  item(kind: ItemKind, localId: string): string | undefined;
  /** The Grinders of the Recipe's Location, not Archived: a Recipe names only one of them. */
  grinders: ReadonlySet<string>;
  /** Each Bean Batch's Bean, by their global ids. */
  batchBeans: ReadonlyMap<string, string>;
  /** The Bean Batches the Library retired for the Recipe: each Archived, of an Archived Bean, or not at its Location, as one never added there or finished there. */
  retired: ReadonlySet<string>;
}

/** The parts Decent Sync takes into a Recipe from its Machine's Workflow, but where the Recipe holds a value already: its dial but the brew temperature and the Basket, which are DYE2's to save. */
const DIAL_FIELDS = { dose: "dose", yield: "yield", grind: "grindSetting", rpm: "rpm", feedRate: "feedRate" } as const satisfies Partial<Record<LoadedRecipePart, string>>;

/** The parts a pick of a Grinder brings with it, each with the Recipe's field it follows: its grind setting and RPM. */
const PICKED_WITH_GRINDER = { grind: "grindSetting", rpm: "rpm" } as const satisfies Partial<Record<LoadedRecipePart, string>>;

/**
 * The values of a Recipe (`content`, its parts `target` as `recipeParts`
 * reads them) that its Machine's Workflow sets, which Decent Sync records
 * itself as the tablet's edit, as DYE2 saves none of them (ADR-0022), each
 * where the Workflow changed it from `held`, the parts as it last held them,
 * to the one it holds now (`now`): a dose, yield, grind setting (a number, or
 * text as typed, as DYE2 v0.1.32 saves one), RPM or feed rate (text as typed,
 * which DYE2 adopts into no recipe holding none) the Recipe holds none of,
 * but one of 0, which is none (`nonePart`), so a Recipe holding no yield
 * takes none from a Workflow whose yield is 0; a Grinder, one of the
 * Location's, with the grind setting and RPM the Workflow holds after it,
 * none included, as DYE2 from v0.1.37 writes the picked grinder's defaults
 * with it, or none where it declares neither (`grinderDefaultsPatch` in
 * dye2:dye2-plugin/src/utils/grinder-form.ts), a dial position belonging to
 * the grinder it was read off; and a Bean Batch, with its Bean where it is
 * another Bean's (#570), but one the Library retired (`retired`): Archived,
 * of an Archived Bean, or not at the Recipe's Location. Nothing is
 * taken on a load: this reads only a Workflow that goes on naming the
 * Recipe. A retired batch, a value cleared, and anything the map does not
 * hold stay the Machine's own. With the parts they record.
 */
export function valuesFromWorkflow(
  content: Readonly<Record<string, unknown>>,
  target: Readonly<Record<LoadedRecipePart, PartValue | undefined>>,
  held: WorkflowParts,
  now: WorkflowParts,
  context: WorkflowValuesContext,
): { values: Record<string, unknown>; parts: LoadedRecipePart[] } {
  const values: Record<string, unknown> = {};
  const parts = new Set<LoadedRecipePart>();
  const changed = (part: LoadedRecipePart) => !nonePart(part, now[part]) && !samePart(part, held[part], now[part]);
  const valueOf = (part: LoadedRecipePart) => (nonePart(part, now[part]) ? null : part === "grind" ? grindSettingOf(now.grind) : now[part]);
  for (const [part, field] of Object.entries(DIAL_FIELDS) as [keyof typeof DIAL_FIELDS, string][]) {
    if (!nonePart(part, target[part]) || !changed(part)) continue;
    values[field] = valueOf(part);
    parts.add(part);
  }
  if (changed("grinder")) {
    const grinderId = context.item("grinder", now.grinder as string);
    if (grinderId !== undefined && context.grinders.has(grinderId) && grinderId !== textOf(content.grinderId)?.toLowerCase()) {
      values.grinderId = grinderId;
      parts.add("grinder");
      // The pick's own grind setting and RPM, or none, come with it: the ones the Recipe held were the other Grinder's.
      for (const [part, field] of Object.entries(PICKED_WITH_GRINDER) as [keyof typeof PICKED_WITH_GRINDER, string][]) {
        if (samePart(part, target[part], now[part])) continue;
        values[field] = valueOf(part);
        parts.add(part);
      }
    }
  }
  const beanBefore = recipeBean(content);
  if (changed("batch")) {
    const batchId = context.item("beanBatch", now.batch as string);
    const beanId = batchId === undefined ? undefined : context.batchBeans.get(batchId);
    if (batchId !== undefined && beanId !== undefined && !context.retired.has(batchId)) {
      values.beanBatchId = batchId;
      if (beanBefore !== beanId) values.beanId = beanId;
      parts.add("batch");
    }
  }
  return { values, parts: [...parts] };
}

/**
 * What the Workflow is to hold of each part of a Recipe with this content,
 * as its tablet names it (`local`, the tablet's id for an item by its map):
 * null where the Recipe holds none, and undefined for a Grinder, Basket or
 * batch the tablet holds no record of yet, which is written first; its
 * Profile by Decaid's id, the same on every tablet. Its yield is its
 * dose times its ratio where it holds none, as DYE2 applies one, and its
 * brew temperature its Profile's first step's (`profileTemperature`) where
 * it holds none, as its records hold one (`recipeRecord`). A steam time of
 * 0, as 1.6.2 may have taken one in, is none (`steamTimeOf`), and so is a
 * dose, grind setting or RPM of 0, as 1.10.0 may take one in (`nonePart`).
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
    if (part === "steamDuration") parts[part] = steamTimeOf(value);
    if (part !== "yield" && nonePart(part, parts[part]) && parts[part] !== undefined) parts[part] = null;
  }
  const [dose, ratio] = [parts.dose, numberOf(content.ratio)];
  if (parts.yield === null && typeof dose === "number" && ratio !== null) parts.yield = Math.round(dose * ratio * 10) / 10;
  parts.brewTemperature ??= profileTemperature;
  return parts;
}

/**
 * The parts of a Recipe the Workflow is to hold (`target`, as `recipeParts`
 * reads it) that wait for the tablet's record of the Recipe (`record`, as the
 * server last knew it) to hold them too: its dial (Profile, dose, yield,
 * grind setting, RPM, feed rate, Basket and brew temperature), as the record
 * is written first. DYE2 records the Workflow's dial into the record, so a
 * dial written into the Workflow first, as when the tablet refused the
 * record's write, would reach the server as the tablet's change of the
 * record. And DYE2 keeps the Workflow's recipe named through a change of
 * profile only onto the profile its record holds, where it holds one, by its
 * fingerprint (`recipeProfileChanged` in
 * dye2:dye2-plugin/src/utils/workflow-record.ts): so the Profile waits until
 * the record names it and holds it as the write carries it (`profile`, the
 * Library's), not as before an edit of its title, which keeps its id
 * (ADR-0006). One the Recipe holds none of waits the same way, until the
 * record holds none, or a 0 for it, which is none. Each that waits is
 * undefined, as one the tablet holds no record of yet is; the rest of the
 * write goes ahead, its Grinder and Bean Batch included, which DYE2 records
 * none of.
 */
export function heldByRecord(
  target: Readonly<Record<LoadedRecipePart, PartValue | undefined>>,
  record: Readonly<Record<string, unknown>> | null,
  profile: Profile | null,
): Record<LoadedRecipePart, PartValue | undefined> {
  const variables = isObject(record?.dashboardVariables) ? record.dashboardVariables : {};
  const [dose, ratio] = [nonePart("dose", variables.dose) ? null : numberOf(variables.dose), numberOf(variables.ratio)];
  const holds: Partial<Record<LoadedRecipePart, unknown>> = {
    profile: record?.profileId ?? null,
    dose,
    yield: numberOf(variables.drink) ?? (dose !== null && ratio !== null ? Math.round(dose * ratio * 10) / 10 : null),
    grind: variables.grind ?? null,
    rpm: numberOf(variables.rpm),
    feedRate: textOf(variables.feedRate),
    basket: variables.basketId ?? null,
    brewTemperature: numberOf(variables.brewC),
  };
  const parts = { ...target };
  for (const part of ["profile", "dose", "yield", "grind", "rpm", "feedRate", "basket", "brewTemperature"] as const) {
    if (parts[part] === undefined) continue;
    // With no record known there is none to wait for to hold none.
    if (record === null ? !nonePart(part, parts[part]) : !samePart(part, holds[part], parts[part])) parts[part] = undefined;
  }
  const held = dye2Fingerprint(recordProfile(record));
  if (parts.profile !== null && parts.profile !== undefined && held !== null && held !== dye2Fingerprint(profile)) parts.profile = undefined;
  return parts;
}

/**
 * The profile DYE2 compares the Workflow's with for a recipe: its record's
 * embedded Workflow's, or else its snapshot (`profileOf` in
 * dye2:dye2-plugin/src/utils/workflow-record.ts), as Decaid reads it; null
 * for none, or one Decaid would not read.
 */
export function recordProfile(record: Readonly<Record<string, unknown>> | null): Profile | null {
  const workflow = isObject(record?.workflow) ? record.workflow : undefined;
  return profileOf(workflow?.profile || record?.profileSnapshot || null);
}

/**
 * What a write puts in the Workflow beside a part's id: the Grinder's model,
 * the Basket's name, and the batch's Bean's name and roaster, as DYE2
 * copies them, and the Profile whole, as Decaid keeps it.
 */
export interface PartNames {
  profile: Profile | null;
  grinderModel: string | null;
  basketName: string | null;
  coffeeName: string | null;
  coffeeRoaster: string | null;
}

/**
 * The fields of a write of LOADED_RECIPE_KIND that bring the Workflow, as
 * it last held its parts (`held`), to its Loaded Recipe's (`target`, as
 * `dueParts` leaves it), and the value it expects of each part's first
 * field: each part the Recipe holds a value of that the Workflow holds
 * otherwise, with the names DYE2 copies beside a Grinder, a Basket and a
 * batch, where known; and each it holds none of, of those it is the whole
 * Shot in (WHOLE_SHOT_PARTS), cleared, every field of it null, as DYE2's
 * apply clears one, but its yield, set to WORKFLOW_YIELD_OFF, as Decaid
 * refuses a null there, and a batch's coffee and roaster, which are the
 * Recipe's Bean's where it names one (`names`), and so are written into a
 * Workflow holding no batch already where its batch part is due for a
 * change of the Recipe's Bean (`beanDue`, #572). One the tablet holds no
 * record of yet waits. A Profile is written whole, expecting nothing, as a
 * skin overrides parts of the one it loads, and only where the Library
 * holds it. Null if none differs.
 */
export function partsWrite(
  target: Readonly<Record<LoadedRecipePart, PartValue | undefined>> & { readonly beanDue?: boolean },
  held: WorkflowParts,
  names: PartNames,
): { fields: Record<string, unknown>; expected: Record<string, unknown> } | null {
  const fields: Record<string, unknown> = {};
  const expected: Record<string, unknown> = {};
  for (const part of PARTS) {
    const value = target[part];
    const none = nonePart(part, value);
    const beanDue = part === "batch" && target.beanDue === true;
    if (value === undefined || (none && !WHOLE_SHOT_PARTS.has(part)) || (samePart(part, held[part], value) && !beanDue)) continue;
    const [first, ...rest] = LOADED_RECIPE_PARTS[part] as readonly [string, ...string[]];
    if (part === "profile") {
      if (names.profile !== null) fields[first] = names.profile;
      continue;
    }
    fields[first] = !none ? value : part === "yield" ? WORKFLOW_YIELD_OFF : null;
    expected[first] = held[part];
    const copied: Record<string, string | null> = {
      "context.grinderModel": names.grinderModel,
      "context.extras.basketName": names.basketName,
      "context.coffeeName": names.coffeeName,
      "context.coffeeRoaster": names.coffeeRoaster,
    };
    for (const field of rest) {
      // Cleared with it, but a batch's coffee and roaster, which name the Recipe's Bean where it names one.
      if (none) fields[field] = part === "batch" ? (copied[field] ?? null) : null;
      else if (copied[field] !== null && copied[field] !== undefined) fields[field] = copied[field];
    }
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
