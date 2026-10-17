import {
  LOADED_RECIPE_PARTS,
  type LoadBefore,
  type LoadedRecipePart,
  RECIPE_SETTINGS,
  RECIPE_SETTING_NAMES,
  dye2GlobalIdOf,
  isSlotId,
  steamOff,
  workflowPatch,
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
function workflowBatch(workflow: Record<string, unknown>): string | null {
  return isObject(workflow.context) ? textOf(workflow.context.beanBatchId) : null;
}

/** The grinder a Workflow names, by the tablet's id for it, or null. */
function workflowGrinder(workflow: Record<string, unknown>): string | null {
  return isObject(workflow.context) ? textOf(workflow.context.grinderId) : null;
}

/**
 * What the Workflow held as DYE2's selection was made, as DYE2 judges a
 * change off it by (`profileDrifted` and `contextDrifted` in
 * dye2:dye2-plugin/src/utils/workflow-record.ts at 2cf631c): the fingerprint
 * of its profile (`dye2Fingerprint`), and its Bean Batch and grinder, by the
 * tablet's ids. Each is null where DYE2 answered none or does not know it,
 * as for a Workflow that held no batch, where DYE2 takes the first one set.
 */
export interface ArmedOn {
  fingerprint: string | null;
  batch: string | null;
  grinder: string | null;
}

/**
 * Whether DYE2's selection, made on what its answer names (`ArmedOn`),
 * still holds for the Workflow, as DYE2 judges it on the Workflow's next
 * change (`profileDrifted` and `contextDrifted` in
 * dye2:dye2-plugin/src/utils/workflow-record.ts at 2cf631c): the same
 * profile by DYE2's fingerprint, and the same Bean Batch and grinder. A
 * value DYE2 answered none of counts as no difference, as DYE2 takes the
 * first one set then; a batch or grinder cleared since is one. So a
 * selection DYE2 restored over a Bean, grinder or profile switched while it
 * was away does not hold. False for a Workflow not seen yet.
 */
export function selectedOn(armed: ArmedOn, workflow: Record<string, unknown> | undefined): boolean {
  if (workflow === undefined) return false;
  const fingerprint = dye2Fingerprint(workflow.profile);
  if (armed.fingerprint !== null && fingerprint !== null && armed.fingerprint !== fingerprint) return false;
  if (armed.batch !== null && armed.batch !== workflowBatch(workflow)) return false;
  return armed.grinder === null || armed.grinder === workflowGrinder(workflow);
}

/** What a Workflow holds that DYE2 judges a change off a selection by, as one made on it now would hold it. */
export function armedOn(workflow: Record<string, unknown>): ArmedOn {
  return { fingerprint: dye2Fingerprint(workflow.profile), batch: workflowBatch(workflow), grinder: workflowGrinder(workflow) };
}

/**
 * Whether a write into the Workflow (`write`, the body of a `PUT /workflow`,
 * which Decaid merges into it) changes what DYE2 clears its selection on:
 * the profile, by DYE2's fingerprint, the Bean Batch or the grinder
 * (decentespresso/dye2#18, #19). Judged by what the write sets, not by
 * Decaid's answer, which holds a barista's change made meanwhile too. A
 * batch or grinder set where the Workflow held none may leave the
 * selection, which DYE2 then takes as the one it holds.
 */
export function clearsSelection(workflow: Record<string, unknown>, write: Record<string, unknown>): boolean {
  const context = { ...(isObject(workflow.context) ? workflow.context : {}), ...(isObject(write.context) ? write.context : {}) };
  const after = { ...workflow, context, ...(isObject(write.profile) ? { profile: write.profile } : {}) };
  return (
    dye2Fingerprint(workflow.profile) !== dye2Fingerprint(after.profile) ||
    workflowBatch(workflow) !== workflowBatch(after) ||
    workflowGrinder(workflow) !== workflowGrinder(after)
  );
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

/** What a load writes besides the record: the recipe's full Profile at its brew temperature, as applying it loads one. */
export interface LoadContext {
  profile: Record<string, unknown> | null;
}

/** A load's write into the Workflow, and what each part it changes held before it and holds once written (`WorkflowDelivery.loadBefore`). */
export interface LoadWrite {
  write: Record<string, unknown>;
  before: Record<string, LoadBefore>;
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
 * Workflow has it, and so is one `omit` names. Null if the Workflow holds
 * all of it already. With it, each part it changes, by its name in
 * LOADED_RECIPE_PARTS, with what the Workflow held of it and what it
 * writes, but the Profile.
 */
export function loadWrite(
  workflow: Record<string, unknown>,
  record: Record<string, unknown>,
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
  const batch = textOf(record.beanBatchId);
  if (batch !== null && batch !== textOf(context.beanBatchId) && changes("batch", batch)) {
    contextWrite.beanBatchId = batch;
    if (textOf(record.beanName) !== null) contextWrite.coffeeName = record.beanName;
    if (textOf(record.beanRoaster) !== null) contextWrite.coffeeRoaster = record.beanRoaster;
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
    return changes(setting, value) ? [[path, value] as const] : [];
  });
  Object.assign(write, workflowPatch(Object.fromEntries(settings)));
  return Object.keys(write).length > 0 ? { write, before } : null;
}

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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
