import {
  DYE2_RECIPE_FIELD,
  type LoadedRecipePart,
  RECIPE_SETTINGS,
  RECIPE_SETTING_NAMES,
  STEAM_ON_FROM,
  dye2GlobalIdOf,
  sameGrindSetting,
  steamOff,
  workflowPatch,
  workflowValueAt,
} from "@decent-sync/protocol";

// What the plugin writes into the Workflow as it loads a Recipe the
// Workflow names, or as steam is turned back on with one loaded (ADR-0022),
// and what it reads of a Workflow and of DYE2's recipes to decide on one.
// Pure, so module tests can drive it;
// loaded-recipes.ts reads what it needs from Decaid and carries out what it
// decides.

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

/** A write clearing the recipe the Workflow names (DYE2_RECIPE_FIELD), as DYE2 clears it. */
export function clearRecipe(): Record<string, unknown> {
  return workflowPatch({ [DYE2_RECIPE_FIELD]: null });
}

/** The records of a tablet's recipes that can be a Loaded Recipe, by their ids there: those carrying a global id, in a Recipe Slot or not. */
export function loadable(records: readonly Record<string, unknown>[]): Map<string, { globalId: string; record: Record<string, unknown> }> {
  return new Map(
    records.flatMap((record) => {
      const globalId = dye2GlobalIdOf(record);
      return globalId !== null && typeof record.id === "string" ? [[record.id, { globalId, record }] as const] : [];
    }),
  );
}

/**
 * The ids of DYE2's recipes whose record a post of the list (`before` to
 * `after`) removes, or gives to another Recipe's, by the global ids they
 * carry: as the server removes a joining Machine's own recipes or another
 * Location's Recipes, and writes its Location's, whose records may have the
 * same ids where they were saved before DYE2 v0.1.25, numbered by their
 * slots. A Workflow naming one would name another recipe than it applied,
 * and have it loaded. A record given its global id, as one a Location takes
 * in, is no other recipe.
 */
export function vacatedIds(before: readonly Record<string, unknown>[], after: readonly Record<string, unknown>[]): string[] {
  const now = new Map(after.flatMap((record) => (typeof record.id === "string" ? [[record.id, record] as const] : [])));
  return before.flatMap((record) => {
    if (typeof record.id !== "string") return [];
    const was = dye2GlobalIdOf(record);
    const is = now.get(record.id);
    return is === undefined || (was !== null && dye2GlobalIdOf(is) !== was) ? [record.id] : [];
  });
}

/** What a load writes besides the record: the recipe's full Profile at its brew temperature, as applying it loads one. */
export interface LoadContext {
  profile: Record<string, unknown> | null;
}

/**
 * What a load of the recipe writes into the Workflow, through `PUT
 * /workflow`, which Decaid merges into it: what the Workflow holds otherwise
 * of the recipe's current dose, yield, grind setting, grinder, RPM, Basket,
 * Bean Batch with its Bean's name and roaster, and Profile, as DYE2 applies
 * them, a stale copy having applied others; and of each steam, hot water
 * and flush setting it holds (RECIPE_SETTINGS), as DYE2's dashboard applies
 * them and Streamline's strip does not yet (decentespresso/streamline-js#154),
 * but a steam temperature into a Workflow whose steam is off (`steamOff`),
 * which would turn steam on. Its brew temperature is DYE2's and Streamline's
 * to apply, and so is the Profile at it, which is written only where the
 * Workflow holds another. A value the recipe holds none of is left as the
 * Workflow has it, which the server takes as the Recipe's (ADR-0022), but
 * the Bean: a recipe naming none means no bean, as DYE2 v0.1.32 applies one
 * (`ce38984`), so the Workflow's batch, coffee and roaster are cleared, as a
 * copy holding none of DYE2's nulls for them leaves them. One `omit` names
 * is left too. Null if the Workflow holds all of it already.
 */
export function loadWrite(
  workflow: Record<string, unknown>,
  record: Record<string, unknown>,
  load: LoadContext,
  omit: ReadonlySet<LoadedRecipePart> = new Set(),
): Record<string, unknown> | null {
  const context = isObject(workflow.context) ? workflow.context : {};
  const extras = isObject(context.extras) ? context.extras : {};
  const variables = isObject(record.dashboardVariables) ? record.dashboardVariables : {};
  const contextWrite: Record<string, unknown> = {};
  const extrasWrite: Record<string, unknown> = {};
  const dose = numberOf(variables.dose);
  if (dose !== null && !sameNumber(dose, numberOf(context.targetDoseWeight)) && !omit.has("dose")) contextWrite.targetDoseWeight = dose;
  const ratio = numberOf(variables.ratio);
  const yieldValue = numberOf(variables.drink) ?? (ratio !== null && dose !== null ? Math.round(dose * ratio * 10) / 10 : null);
  if (yieldValue !== null && !sameNumber(yieldValue, numberOf(context.targetYield)) && !omit.has("yield")) contextWrite.targetYield = yieldValue;
  const grind = grindOf(variables.grind);
  if (grind !== null && !sameGrind(grind, grindOf(context.grinderSetting)) && !omit.has("grind")) contextWrite.grinderSetting = grind;
  const grinder = textOf(variables.grinderId);
  if (grinder !== null && grinder !== textOf(context.grinderId) && !omit.has("grinder")) {
    contextWrite.grinderId = grinder;
    if (textOf(variables.grinderModel) !== null) contextWrite.grinderModel = variables.grinderModel;
  }
  const rpm = numberOf(variables.rpm);
  if (rpm !== null && !sameNumber(rpm, numberOf(extras.rpm)) && !omit.has("rpm")) extrasWrite.rpm = rpm;
  const basket = textOf(variables.basketId);
  if (basket !== null && basket !== textOf(extras.basketId) && !omit.has("basket")) {
    extrasWrite.basketId = basket;
    if (textOf(variables.basketName) !== null) extrasWrite.basketName = variables.basketName;
  }
  const batch = textOf(record.beanBatchId);
  const namesBean = textOf(record.beanId) !== null || textOf(record.beanName) !== null;
  if (batch !== null && batch !== textOf(context.beanBatchId) && !omit.has("batch")) {
    contextWrite.beanBatchId = batch;
    if (textOf(record.beanName) !== null) contextWrite.coffeeName = record.beanName;
    if (textOf(record.beanRoaster) !== null) contextWrite.coffeeRoaster = record.beanRoaster;
  } else if (!namesBean && !omit.has("batch") && WORKFLOW_BEAN.some((field) => context[field] !== null && context[field] !== undefined)) {
    for (const field of WORKFLOW_BEAN) contextWrite[field] = null;
  }
  if (Object.keys(extrasWrite).length > 0) contextWrite.extras = extrasWrite;

  const write: Record<string, unknown> = {};
  if (Object.keys(contextWrite).length > 0) write.context = contextWrite;
  const key = profileKey(load.profile);
  if (!omit.has("profile") && key !== null && key !== profileKey(workflow.profile)) write.profile = load.profile;
  const settings = RECIPE_SETTING_NAMES.flatMap((setting) => {
    const { dye2, workflow: path } = RECIPE_SETTINGS[setting];
    const value = numberOf(variables[dye2]);
    if (value === null || sameNumber(value, numberOf(workflowValueAt(workflow, path)))) return [];
    if (setting === "steamTemperature" && steamOff(workflow)) return [];
    return omit.has(setting) ? [] : [[path, value] as const];
  });
  Object.assign(write, workflowPatch(Object.fromEntries(settings)));
  return Object.keys(write).length > 0 ? write : null;
}

/**
 * The steam temperature the Workflow has steam on at: STEAM_ON_FROM or
 * more, as Decaid judges it (below it is steam off, `steamOff`). Null where
 * steam is off or the Workflow holds no steam temperature. Steam is turned
 * back on where a Workflow has it on that had it off before.
 */
export function steamOnAt(workflow: Record<string, unknown>): number | null {
  const temperature = numberOf(workflowValueAt(workflow, RECIPE_SETTINGS.steamTemperature.workflow));
  return temperature !== null && temperature >= STEAM_ON_FROM ? temperature : null;
}

/**
 * What turning steam back on writes into the Workflow, as it takes the
 * Loaded Recipe's steam temperature (ADR-0022, Steam on and off): the
 * recipe record's, where it holds one of STEAM_ON_FROM or more, as DYE2's
 * editor saves none for "Off", and the Workflow still holds the temperature
 * steam came back at (`turnedOnAt`), not one set since, which is the
 * Recipe's edit, nor steam off again. Null where there is nothing to write.
 */
export function steamBackOnWrite(workflow: Record<string, unknown>, record: Record<string, unknown>, turnedOnAt: number): Record<string, unknown> | null {
  const { dye2, workflow: path } = RECIPE_SETTINGS.steamTemperature;
  const variables = isObject(record.dashboardVariables) ? record.dashboardVariables : {};
  const recipes = numberOf(variables[dye2]);
  const now = numberOf(workflowValueAt(workflow, path));
  if (recipes === null || recipes < STEAM_ON_FROM || !sameNumber(now, turnedOnAt) || sameNumber(now, recipes)) return null;
  return workflowPatch({ [path]: recipes });
}

/** The Workflow's fields naming its Bean and batch, which a recipe naming no Bean clears. */
const WORKFLOW_BEAN = ["beanBatchId", "coffeeName", "coffeeRoaster"] as const;

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

/** Whether two grind settings are the same: as numbers where both read as one, as Decaid keeps "3" for DYE2's 3.0 and a barista may type `.5` for 0.5, and otherwise as text, as the server compares them (`sameGrindSetting`). */
function sameGrind(a: string | null, b: string | null): boolean {
  return sameGrindSetting(a, b);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
