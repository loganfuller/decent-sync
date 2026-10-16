import {
  LOADED_RECIPE_KEY,
  LOADED_RECIPE_PARTS,
  type LoadBefore,
  type LoadedRecipePart,
  RECIPE_FIELD,
  dye2GlobalIdOf,
  isSlotId,
  loadedRecipeOf,
  profileAtBrewTemperature,
  workflowValueAt,
} from "@decent-sync/protocol";

// What the plugin writes into the Workflow as DYE2's selection loads a
// Recipe (ADR-0022), and what it reads of a Workflow to decide on one. Pure,
// so module tests can drive it; loaded-recipes.ts reads what it needs from
// Decaid and carries out what it decides.

/**
 * What Decaid hashes for a Profile's id (`ProfileHash.calculateProfileHash`
 * in decaid:lib/src/models/data/profile_hash.dart) but its target weight,
 * and its steps as `stepsKey` reads them: what the machine executes, but for
 * what a skin overrides as it loads a profile into the Workflow, the yield
 * and each step's temperature, as a Shot's Profile is found (`profileOfSql`
 * in the server's shots/links.ts). Null for a profile without steps.
 */
export function profileKey(profile: unknown): string | null {
  const steps = isObject(profile) ? stepsKey(profile.steps) : null;
  if (steps === null || !isObject(profile)) return null;
  const hashed = Object.fromEntries(HASHED.map((field) => [field, profile[field] ?? null]));
  return stableJson({ ...hashed, steps: JSON.parse(steps) as unknown });
}

/** What Decaid hashes for a Profile's id, but its steps and target weight. */
const HASHED = ["version", "beverage_type", "tank_temperature", "target_volume", "target_volume_count_start"] as const;

/**
 * A profile's steps as they identify it, as text that is the same for the
 * same steps, its keys sorted, as a Shot's Workflow and a profile's record
 * hold them alike; null if it has none. As the server compares them
 * (`profile_steps_key`), each step's temperature is left out and a limiter
 * of value 0, which is no limiter, is read as none: a skin overrides the
 * temperature in the profile it loads into the Workflow, and streamline-js
 * sends such a limiter as null while the record keeps it.
 */
export function stepsKey(steps: unknown): string | null {
  if (!Array.isArray(steps)) return null;
  return stableJson(
    steps.map((step: unknown) => {
      if (!isObject(step)) return step;
      const { temperature: _, ...rest } = step;
      return isObject(rest.limiter) && rest.limiter.value === 0 ? { ...rest, limiter: null } : rest;
    }),
  );
}

/** JSON with every object's keys sorted. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

/**
 * A profile as DYE2 fingerprints one to tell a change of profile, which
 * clears its selection (`profileFingerprint` in
 * dye2:dye2-plugin/src/utils/workflow-record.ts at 2cf631c): its title, tank
 * temperature and steps, but each step's temperature. Its target weight and
 * volume are the yield, which Streamline sends with the profile, so they are
 * left out (decentespresso/dye2#18). Null for none.
 */
export function dye2Fingerprint(profile: unknown): string | null {
  if (!isObject(profile)) return null;
  const steps = Array.isArray(profile.steps)
    ? profile.steps.map((step: unknown) => {
        if (!isObject(step)) return step;
        const { temperature: _, ...rest } = step;
        return rest;
      })
    : profile.steps;
  return JSON.stringify({ title: profile.title, tank_temperature: profile.tank_temperature, steps });
}

/** The Bean Batch a Workflow names, by the tablet's id for it, or null. */
export function workflowBatch(workflow: Record<string, unknown>): string | null {
  return isObject(workflow.context) ? textOf(workflow.context.beanBatchId) : null;
}

/** The grinder a Workflow names, by the tablet's id for it, or null. */
export function workflowGrinder(workflow: Record<string, unknown>): string | null {
  return isObject(workflow.context) ? textOf(workflow.context.grinderId) : null;
}

/** The records of a tablet's recipes that can be a Loaded Recipe: those in a Recipe Slot carrying a global id. */
export function loadable(records: readonly Record<string, unknown>[]): { globalId: string; slot: number; record: Record<string, unknown> }[] {
  return records.flatMap((record) => {
    const globalId = dye2GlobalIdOf(record);
    return globalId !== null && isSlotId(record.id) ? [{ globalId, slot: Number(record.id), record }] : [];
  });
}

/**
 * The slots of DYE2's recipes whose recipe a post of the list (`before` to
 * `after`) removes, or replaces with another Recipe's record, by the global
 * ids they carry: as the server removes a joining Machine's own recipes or
 * another Location's Recipes, and writes its Location's in their slots. DYE2
 * keeps its selection through its recipe's removal, and would record into
 * the recipe put in that slot, or have it loaded. A record given its global
 * id, as one a Location takes in, is no other recipe.
 */
export function vacatedSlots(before: readonly Record<string, unknown>[], after: readonly Record<string, unknown>[]): number[] {
  const now = new Map(after.flatMap((record) => (isSlotId(record.id) ? [[record.id, record] as const] : [])));
  return before.flatMap((record) => {
    if (!isSlotId(record.id)) return [];
    const was = dye2GlobalIdOf(record);
    const is = now.get(record.id);
    return is === undefined || (was !== null && dye2GlobalIdOf(is) !== was) ? [Number(record.id)] : [];
  });
}

/** What a recipe's record names that a change of grinder or Bean is judged by (dye2#19): its grinder, by the tablet's id, and its Bean. */
export function recipeSetUp(record: Record<string, unknown>): { grinder: string | null; bean: string | null } {
  const variables = isObject(record.dashboardVariables) ? record.dashboardVariables : {};
  return { grinder: textOf(variables.grinderId), bean: textOf(record.beanId) };
}

/**
 * What a load writes besides the record: the recipe's full Profile, as
 * applying it loads one; the step temperatures of the tablet's record of
 * that Profile, which a brew temperature shifts (`shiftedTemperatures`), or
 * null where the tablet holds none; and its Bean Batch as the tablet holds
 * it, with its Bean's name and roaster.
 */
export interface LoadContext {
  profile: Record<string, unknown> | null;
  baseTemperatures: readonly unknown[] | null;
  batch: { id: string; coffeeName: string | null; coffeeRoaster: string | null } | null;
}

/** A load's write into the Workflow, and what each part it changes held before it and holds once written (`WorkflowDelivery.loadBefore`). */
export interface LoadWrite {
  write: Record<string, unknown>;
  before: Record<string, LoadBefore>;
}

/**
 * What a load of the recipe writes into the Workflow, through `PUT
 * /workflow`, which Decaid merges into it: what the Workflow holds otherwise
 * of the recipe's current dose, yield, grind setting, grinder, RPM, Basket
 * and Profile, as DYE2 applies them; of its brew temperature, as
 * Streamline's Brew tile sets one, the Profile's shape kept
 * (`profileAtBrewTemperature`); of its Bean Batch, which applying a DYE2 recipe
 * never sets; and of its four hot water settings, which it keeps in its own
 * field (RECIPE_FIELD); and the recipe's global id (LOADED_RECIPE_KEY). A
 * value the recipe holds none of is left as the Workflow has it, and so is
 * one `omit` names. Null if the Workflow holds all of it already. With it,
 * each part it changes, by its name in LOADED_RECIPE_PARTS, with what the
 * Workflow held of it and what it writes, but the Profile.
 */
export function loadWrite(
  workflow: Record<string, unknown>,
  record: Record<string, unknown>,
  globalId: string,
  load: LoadContext,
  omit: ReadonlySet<LoadedRecipePart> = new Set(),
): LoadWrite | null {
  const context = isObject(workflow.context) ? workflow.context : {};
  const extras = isObject(context.extras) ? context.extras : {};
  const variables = isObject(record.dashboardVariables) ? record.dashboardVariables : {};
  const contextWrite: Record<string, unknown> = {};
  const extrasWrite: Record<string, unknown> = {};
  const before: Record<string, LoadBefore> = {};
  const changes = (part: LoadedRecipePart, written: unknown) => {
    if (omit.has(part)) return false;
    before[part] = { before: workflowValueAt(workflow, LOADED_RECIPE_PARTS[part][0]) ?? null, written };
    return true;
  };
  const dose = numberOf(variables.dose);
  if (dose !== null && !sameNumber(dose, numberOf(context.targetDoseWeight)) && changes("dose", dose)) contextWrite.targetDoseWeight = dose;
  const ratio = numberOf(variables.ratio);
  const yieldValue = numberOf(variables.drink) ?? (ratio !== null && dose !== null ? Math.round(dose * ratio * 10) / 10 : null);
  if (yieldValue !== null && !sameNumber(yieldValue, numberOf(context.targetYield)) && changes("yield", yieldValue)) contextWrite.targetYield = yieldValue;
  const grind = grindOf(variables.grind);
  if (grind !== null && !sameGrind(grind, grindOf(context.grinderSetting)) && changes("grind", grind)) contextWrite.grinderSetting = grind;
  const grinder = textOf(variables.grinderId);
  if (grinder !== null && grinder !== textOf(context.grinderId) && changes("grinder", grinder)) {
    contextWrite.grinderId = grinder;
    if (textOf(variables.grinderModel) !== null) contextWrite.grinderModel = variables.grinderModel;
  }
  const rpm = numberOf(variables.rpm);
  if (rpm !== null && !sameNumber(rpm, numberOf(extras.rpm)) && changes("rpm", rpm)) extrasWrite.rpm = rpm;
  const basket = textOf(variables.basketId);
  if (basket !== null && basket !== textOf(extras.basketId) && changes("basket", basket)) {
    extrasWrite.basketId = basket;
    if (textOf(variables.basketName) !== null) extrasWrite.basketName = variables.basketName;
  }
  if (load.batch !== null && load.batch.id !== textOf(context.beanBatchId) && changes("batch", load.batch.id)) {
    contextWrite.beanBatchId = load.batch.id;
    if (load.batch.coffeeName !== null) contextWrite.coffeeName = load.batch.coffeeName;
    if (load.batch.coffeeRoaster !== null) contextWrite.coffeeRoaster = load.batch.coffeeRoaster;
  }
  if (loadedRecipeOf(workflow) !== globalId) extrasWrite[LOADED_RECIPE_KEY] = globalId;
  if (Object.keys(extrasWrite).length > 0) contextWrite.extras = extrasWrite;

  const write: Record<string, unknown> = {};
  if (Object.keys(contextWrite).length > 0) write.context = contextWrite;
  const key = profileKey(load.profile);
  const profile = !omit.has("profile") && key !== null && key !== profileKey(workflow.profile) ? load.profile! : null;
  const temperature = numberOf(variables.brewC);
  const shifted = temperature === null || omit.has("brewTemperature") ? null : profileAtBrewTemperature(profile ?? workflow.profile, temperature, load.baseTemperatures);
  if (shifted !== null) {
    const held = workflowValueAt(workflow, LOADED_RECIPE_PARTS.brewTemperature[0]);
    if (!sameNumber(numberOf(held), temperature)) before.brewTemperature = { before: held ?? null, written: temperature };
  }
  if (shifted !== null && (profile !== null || !sameValue(shifted, workflow.profile))) write.profile = shifted;
  else if (profile !== null) write.profile = profile;
  const own = isObject(record[RECIPE_FIELD]) ? record[RECIPE_FIELD] : {};
  const hotWater = isObject(own.hotWaterData) ? own.hotWaterData : {};
  const held = isObject(workflow.hotWaterData) ? workflow.hotWaterData : {};
  const hotWaterWrite = Object.fromEntries(
    HOT_WATER.flatMap((field) => {
      const value = numberOf(hotWater[field]);
      return value !== null && !sameNumber(value, numberOf(held[field])) && changes(field, value) ? [[field, value]] : [];
    }),
  );
  if (Object.keys(hotWaterWrite).length > 0) write.hotWaterData = hotWaterWrite;
  return Object.keys(write).length > 0 ? { write, before } : null;
}

/** A Workflow's hot water settings, as Decaid names them in its `hotWaterData`, which a Recipe holds all of. */
export const HOT_WATER = ["targetTemperature", "duration", "volume", "flow"] as const;

/** A number as Decaid reads one (`parseOptionalDouble`): a number, or text that reads as one; otherwise null. */
function numberOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^\s*[+-]?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
}

/** A grind setting as Decaid keeps it, text (`parseOptionalString`), from the number DYE2 sends; null for none. */
function grindOf(value: unknown): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Whether two numbers are the same, but for the rounding of a yield worked out from a ratio. */
function sameNumber(a: number | null, b: number | null): boolean {
  return a === null || b === null ? a === b : Math.abs(a - b) < 1e-9;
}

/** Whether two grind settings are the same: as numbers where both read as one, as Decaid keeps "3" for DYE2's 3.0, and otherwise as text. */
function sameGrind(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const [x, y] = [numberOf(a), numberOf(b)];
  return x !== null && y !== null ? sameNumber(x, y) : a.trim() === b.trim();
}

/** Whether two values are the same as JSON, keys in any order. */
function sameValue(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
