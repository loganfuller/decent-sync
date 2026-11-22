import {
  DYE2_RECIPE_FIELD,
  LOADED_RECIPE_PARTS,
  type LoadedRecipePart,
  RECIPE_SETTINGS,
  RECIPE_SETTING_NAMES,
  STEAM_OFF_VALUE,
  STEAM_ON_FROM,
  WORKFLOW_YIELD_OFF,
  dye2Fingerprint,
  dye2GlobalIdOf,
  profileOf,
  profileStepsKey,
  type Profile,
  noneAtZero,
  sameValue,
  sameGrindSetting,
  steamHeldOff,
  steamOff,
  steamTimeOf,
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
 * A profile's key as the server finds a Shot's Profile (`profileStepsKey` in
 * protocol/): what the machine executes, but for what a Skin overrides as it
 * loads a profile into the Workflow, the yield and each step's temperature.
 * Null for one without steps, or that Decaid would not read.
 */
export function profileKey(profile: unknown): string | null {
  const read = profileOf(profile);
  return read === null || read.steps.length === 0 ? null : profileStepsKey(read);
}

/**
 * Whether a change of the Workflow, from `previous` to `workflow`, moved what
 * a Skin edits a Loaded Recipe by writing its DYE2 record before the
 * Workflow (#570): its profile, as DYE2 fingerprints one, or its bean, any
 * field of the batch part (LOADED_RECIPE_PARTS) differing. Neither its
 * dial, nor its steam, hot water or flush settings.
 */
export function movedBeanOrProfile(previous: Record<string, unknown>, workflow: Record<string, unknown>): boolean {
  if (dye2Fingerprint(profileOf(previous.profile)) !== dye2Fingerprint(profileOf(workflow.profile))) return true;
  return LOADED_RECIPE_PARTS.batch.some((field) => !sameValue(workflowValueAt(previous, field) ?? null, workflowValueAt(workflow, field) ?? null));
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
  profile: Profile | null;
}

/**
 * What a load of the recipe writes into the Workflow, through `PUT
 * /workflow`, which Decaid merges into it: what brings the Workflow to the
 * recipe whole, whatever applied it (ADR-0022). A recipe is the whole shot
 * (dye2:docs/KV_CONTRACT.md), so of its dose, yield, grind setting, grinder,
 * RPM, feed rate (text as typed), Basket and Bean Batch with its Bean's name
 * and roaster (WHOLE_SHOT_PARTS), the load writes each the Workflow holds
 * otherwise, a stale copy having applied others, and clears each the recipe
 * names none of that the Workflow still holds, as DYE2's dashboard from
 * v0.1.37 and Streamline's strip from v0.2.25 clear them as they apply one
 * (`applyRecipe` in dye2:dye2-plugin/src/pages/dashboard.ts,
 * `clearInheritedFields` in streamline-js:src/modules/workflow-fields.js),
 * and a Skin that clears nothing leaves them: each field null, but the
 * yield, set to WORKFLOW_YIELD_OFF where the recipe names neither a yield
 * nor a dose and ratio, as Decaid refuses a null there, and the coffee and
 * roaster of a recipe naming a Bean and no batch, which stay its Bean's. A
 * dose or RPM of 0 in the record names none (`noneAtZero`), and one of 0 in
 * the Workflow is none held, as a yield of 0 is; a grind setting of 0 is a
 * dial position, written as the text "0", as DYE2 from v0.1.42 applies one
 * (decentespresso/dye2#47). It also
 * writes the recipe's Profile, and each steam, hot water and flush setting
 * it holds (RECIPE_SETTINGS), as DYE2's dashboard applies them and, from
 * v0.2.29, Streamline's strip (`mergeRecipeLiveSettings`,
 * decentespresso/streamline-js#154), so after either it finds them held and
 * writes them only for a Skin that applies none, or a stale copy. A load
 * switches steam as the recipe holds it (ADR-0022, Steam on and off): its
 * steam temperature and steam time are written whether the Workflow's steam
 * is on or off, so one holding a steam temperature turns steam on at it,
 * and one holding "Off" (`steamHeldOff`), a steam temperature below
 * STEAM_ON_FROM or a steam time below STEAM_TIME_FROM, as DYE2's editor
 * saves 0 for both, turns it off whole, both written STEAM_OFF_VALUE, as
 * DYE2 and Streamline apply one. One holding only one of the two has that
 * one written and the other left as the apply chose it, and one holding
 * neither leaves the Machine's steam as it is. Its brew temperature is
 * DYE2's and Streamline's to apply, and so is the Profile at it, which is
 * written only where the Workflow holds another. A setting the recipe holds
 * none of is left as the Machine has it, and so is the Workflow's profile
 * where the recipe names none, as DYE2's apply leaves it. One `omit` names
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
  const dose = noneAtZero(numberOf(variables.dose));
  if (!sameNumber(dose, noneAtZero(numberOf(context.targetDoseWeight))) && !omit.has("dose")) contextWrite.targetDoseWeight = dose;
  const ratio = numberOf(variables.ratio);
  const yieldValue = numberOf(variables.drink) ?? (ratio !== null && dose !== null ? Math.round(dose * ratio * 10) / 10 : WORKFLOW_YIELD_OFF);
  // A Workflow holding no yield has stop-at-weight off, as one holding 0.
  if (!sameNumber(yieldValue, numberOf(context.targetYield) ?? WORKFLOW_YIELD_OFF) && !omit.has("yield")) contextWrite.targetYield = yieldValue;
  const grind = grindOf(variables.grind);
  if (!sameGrind(grind, grindOf(context.grinderSetting)) && !omit.has("grind")) contextWrite.grinderSetting = grind;
  const grinder = textOf(variables.grinderId);
  if (grinder === null) {
    // Cleared with its model, as DYE2's apply clears both.
    if ((textOf(context.grinderId) !== null || textOf(context.grinderModel) !== null) && !omit.has("grinder")) Object.assign(contextWrite, { grinderId: null, grinderModel: null });
  } else if (grinder !== textOf(context.grinderId) && !omit.has("grinder")) {
    contextWrite.grinderId = grinder;
    if (textOf(variables.grinderModel) !== null) contextWrite.grinderModel = variables.grinderModel;
  }
  const rpm = noneAtZero(numberOf(variables.rpm));
  if (!sameNumber(rpm, noneAtZero(numberOf(extras.rpm))) && !omit.has("rpm")) extrasWrite.rpm = rpm;
  const feedRate = textOf(variables.feedRate);
  if (feedRate !== textOf(extras.feedRate) && !omit.has("feedRate")) extrasWrite.feedRate = feedRate;
  const basket = textOf(variables.basketId);
  if (basket === null) {
    if ((textOf(extras.basketId) !== null || textOf(extras.basketName) !== null) && !omit.has("basket")) Object.assign(extrasWrite, { basketId: null, basketName: null });
  } else if (basket !== textOf(extras.basketId) && !omit.has("basket")) {
    extrasWrite.basketId = basket;
    if (textOf(variables.basketName) !== null) extrasWrite.basketName = variables.basketName;
  }
  const batch = textOf(record.beanBatchId);
  const namesBean = textOf(record.beanId) !== null || textOf(record.beanName) !== null;
  if (batch !== null && batch !== textOf(context.beanBatchId) && !omit.has("batch")) {
    contextWrite.beanBatchId = batch;
    if (textOf(record.beanName) !== null) contextWrite.coffeeName = record.beanName;
    if (textOf(record.beanRoaster) !== null) contextWrite.coffeeRoaster = record.beanRoaster;
  } else if (batch === null && namesBean && textOf(context.beanBatchId) !== null && !omit.has("batch")) {
    // A Bean and no batch: the batch a recipe applied before left is cleared, the coffee and roaster the Bean's, as DYE2 applies one.
    contextWrite.beanBatchId = null;
    contextWrite.coffeeName = textOf(record.beanName);
    contextWrite.coffeeRoaster = textOf(record.beanRoaster);
  } else if (!namesBean && !omit.has("batch") && WORKFLOW_BEAN.some((field) => context[field] !== null && context[field] !== undefined)) {
    for (const field of WORKFLOW_BEAN) contextWrite[field] = null;
  }
  if (Object.keys(extrasWrite).length > 0) contextWrite.extras = extrasWrite;

  const write: Record<string, unknown> = {};
  if (Object.keys(contextWrite).length > 0) write.context = contextWrite;
  const key = load.profile === null ? null : profileStepsKey(load.profile);
  if (!omit.has("profile") && key !== null && key !== profileKey(workflow.profile)) write.profile = load.profile;
  const off = steamHeldOff(numberOf(variables[RECIPE_SETTINGS.steamTemperature.dye2]), numberOf(variables[RECIPE_SETTINGS.steamDuration.dye2]));
  const settings = RECIPE_SETTING_NAMES.flatMap((setting) => {
    const { dye2, workflow: path } = RECIPE_SETTINGS[setting];
    const held = numberOf(variables[dye2]);
    const value = SWITCHES_STEAM.has(setting) && off ? STEAM_OFF_VALUE : setting === "steamDuration" ? steamTimeOf(held) : held;
    if (value === null || sameNumber(value, numberOf(workflowValueAt(workflow, path)))) return [];
    return omit.has(setting) ? [] : [[path, value] as const];
  });
  Object.assign(write, workflowPatch(Object.fromEntries(settings)));
  return Object.keys(write).length > 0 ? write : null;
}

/** The two settings that hold steam on or off, written together as STEAM_OFF_VALUE for a recipe holding "Off" (`steamHeldOff`). */
const SWITCHES_STEAM: ReadonlySet<string> = new Set(["steamTemperature", "steamDuration"]);

/** What a Workflow has steam on with: its steam temperature, STEAM_ON_FROM or more, and its steam time, null for none. */
export interface SteamOn {
  temperature: number;
  duration: number | null;
}

/**
 * What the Workflow has steam on with: its steam temperature, STEAM_ON_FROM
 * or more, as Decaid judges it (below it is steam off, `steamOff`), and its
 * steam time as it holds it, 0 included. Null where steam is off or the
 * Workflow holds no steam temperature. Steam is turned back on where a
 * Workflow has it on that had it off before.
 */
export function steamOnWith(workflow: Record<string, unknown>): SteamOn | null {
  const temperature = numberOf(workflowValueAt(workflow, RECIPE_SETTINGS.steamTemperature.workflow));
  if (temperature === null || temperature < STEAM_ON_FROM) return null;
  return { temperature, duration: numberOf(workflowValueAt(workflow, RECIPE_SETTINGS.steamDuration.workflow)) };
}

/**
 * What turning steam back on writes into the Workflow, as it takes the
 * Loaded Recipe's steam temperature and steam time (ADR-0022, Steam on and
 * off): each the recipe record holds, where the Workflow still holds the one
 * steam came back with (`turnedOn`), not one set since, which is the
 * Recipe's edit, and holds another. Nothing where the record holds "Off"
 * (`steamHeldOff`), which has none to take: DYE2 saves what steam came back
 * with into it, the Recipe's edit. Nothing while steam is off again. Null
 * where there is nothing to write.
 */
export function steamBackOnWrite(workflow: Record<string, unknown>, record: Record<string, unknown>, turnedOn: SteamOn): Record<string, unknown> | null {
  if (steamOff(workflow)) return null;
  const variables = isObject(record.dashboardVariables) ? record.dashboardVariables : {};
  const [temperature, duration] = [numberOf(variables[RECIPE_SETTINGS.steamTemperature.dye2]), numberOf(variables[RECIPE_SETTINGS.steamDuration.dye2])];
  if (steamHeldOff(temperature, duration)) return null;
  const recipes = { temperature, duration: steamTimeOf(duration) };
  const fields: Record<string, number> = {};
  for (const [part, setting] of [["temperature", "steamTemperature"], ["duration", "steamDuration"]] as const) {
    const path = RECIPE_SETTINGS[setting].workflow;
    const value = recipes[part];
    const now = numberOf(workflowValueAt(workflow, path));
    if (value === null) continue;
    if (sameNumber(now, turnedOn[part]) && !sameNumber(now, value)) fields[path] = value;
  }
  return Object.keys(fields).length > 0 ? workflowPatch(fields) : null;
}

/**
 * The fields of a write of the Loaded Recipe into the Workflow (`fields`,
 * of those the server sent, `sent`) with its steam time paired to a steam
 * temperature that is steam off, below STEAM_ON_FROM, as a Recipe edited to
 * "Off" carries: written with it as STEAM_OFF_VALUE, or left out where the
 * temperature is left out, so steam is never left on with a steam time of 0.
 * The server sends both as STEAM_OFF_VALUE; the previous release's server
 * sends the Recipe's steam time beside it (ADR-0025).
 */
export function steamOffPaired(fields: Record<string, unknown>, sent: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const [temperaturePath, timePath] = [RECIPE_SETTINGS.steamTemperature.workflow, RECIPE_SETTINGS.steamDuration.workflow];
  const temperature = sent[temperaturePath];
  if (typeof temperature !== "number" || temperature >= STEAM_ON_FROM) return fields;
  if (temperaturePath in fields) return { ...fields, [timePath]: STEAM_OFF_VALUE };
  const kept = { ...fields };
  delete kept[timePath];
  return kept;
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
