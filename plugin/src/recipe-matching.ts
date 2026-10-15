import { LOADED_RECIPE_KEY, RECIPE_FIELD, dye2GlobalIdOf, isSlotId, loadedRecipeOf } from "@decent-sync/protocol";

// Which of the tablet's recipes a Workflow has loaded (ADR-0022), worked out
// from the Workflow alone, as neither DYE2 nor Streamline records the recipe
// it applies. Pure, so module tests can drive it; loaded-recipes.ts reads
// what it needs from Decaid and carries out what it decides.
//
// Both apps apply a recipe in one `PUT /workflow` setting its profile,
// dose, yield, grinder and grind setting together, each only where the
// recipe holds one: DYE2's dashboard from the recipe's `dashboardVariables`
// and `profileSnapshot` (`applyRecipe` in dye2:dye2-plugin/src/pages/dashboard.ts
// at v0.1.19), Streamline's DYE strip from the Workflow embedded in it
// (`applyRecipe` in streamline-js:src/modules/dyeStrip.js), which its
// auto-save leaves behind the dial until the server writes it again. So a
// record has two dials, one each way it is applied, and a Workflow that
// matches either has loaded it. A Profile carries no id in the Workflow, so
// it is compared by what Decaid hashes for a Profile's id (`profileKey`).

/** What a load is matched on: a Workflow's profile, dose, yield, grinder and grind setting. */
export interface Dial {
  /** The profile's `profileKey`, or null for none. */
  profile: string | null;
  dose: number | null;
  yield: number | null;
  /** The tablet's id for its grinder. */
  grinder: string | null;
  /** As Decaid keeps it, text. */
  grind: string | null;
}

/**
 * A recipe's dial, one way it is applied: each null field it sets none of,
 * so the Workflow keeps what it had. Its profile is known by its
 * `profileKey`, or, where the record holds only the profile's id, as DYE2
 * saves one picked from the tablet's, by that id, which applying it looks up
 * among the tablet's profiles (`resolveDial`).
 */
export interface RecipeDial {
  profile: { key: string } | { id: string } | null;
  dose: number | null;
  yield: number | null;
  grinder: string | null;
  grind: string | null;
}

/** One of the tablet's recipes that a Workflow can load: one carrying its Recipe's global id, in a Recipe Slot. */
export interface HeldRecipe {
  globalId: string;
  slot: number;
  /** Its record as the tablet holds it now. */
  record: Record<string, unknown>;
  /** The dials it holds now, and those it held before (`RecipeVersions`), each resolved. */
  dials: Dial[];
}

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
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

/** A Workflow's dial. */
export function workflowDial(workflow: Record<string, unknown>): Dial {
  const context = isObject(workflow.context) ? workflow.context : {};
  return {
    profile: profileKey(workflow.profile),
    dose: numberOf(context.targetDoseWeight),
    yield: numberOf(context.targetYield),
    grinder: textOf(context.grinderId),
    grind: grindOf(context.grinderSetting),
  };
}

/** The Bean Batch a Workflow names, by the tablet's id for it, or null. */
export function workflowBatch(workflow: Record<string, unknown>): string | null {
  return isObject(workflow.context) ? textOf(workflow.context.beanBatchId) : null;
}

/**
 * A record's dials, each way it is applied: DYE2's, from its
 * `dashboardVariables` and its `profileSnapshot` where that has steps, or
 * else its `profileId`, its yield its dose times its ratio where it holds
 * none; and Streamline's, from its embedded `workflow`, its profile whole
 * where it has steps, or else by its id. Streamline's is left out where it
 * is DYE2's, as on every record the server wrote, and where the record
 * embeds no Workflow.
 */
export function recipeDials(record: Record<string, unknown>): RecipeDial[] {
  const variables = isObject(record.dashboardVariables) ? record.dashboardVariables : {};
  const dose = numberOf(variables.dose);
  const ratio = numberOf(variables.ratio);
  const drink = numberOf(variables.drink);
  const dye2: RecipeDial = {
    profile: profileRef(record.profileSnapshot, record.profileId),
    dose,
    yield: drink ?? (ratio !== null && dose !== null ? Math.round(dose * ratio * 10) / 10 : null),
    grinder: textOf(variables.grinderId),
    grind: grindOf(variables.grind),
  };
  const dials = [dye2];
  const embedded = isObject(record.workflow) ? record.workflow : undefined;
  if (embedded) {
    const context = isObject(embedded.context) ? embedded.context : {};
    const profile = isObject(embedded.profile) ? embedded.profile : undefined;
    const streamline: RecipeDial = {
      profile: profile ? profileRef(profile, profile.id) : null,
      dose: numberOf(context.targetDoseWeight),
      yield: numberOf(context.targetYield),
      grinder: textOf(context.grinderId),
      grind: grindOf(context.grinderSetting),
    };
    if (!sameRecipeDial(streamline, dye2)) dials.push(streamline);
  }
  return dials;
}

/** A recipe's profile: by its key where it is given whole, with steps, or else by its id, or none. */
function profileRef(profile: unknown, id: unknown): RecipeDial["profile"] {
  const key = profileKey(profile);
  if (key !== null) return { key };
  const named = textOf(id);
  return named === null ? null : { id: named };
}

/**
 * A recipe's dial with its profile known by its key: one named by its id is
 * the tablet's profile with that id (`keyOfId`), and none where the tablet
 * holds none, as applying it then leaves the Workflow's.
 */
export function resolveDial(dial: RecipeDial, keyOfId: (id: string) => string | null): Dial {
  const profile = dial.profile === null ? null : "key" in dial.profile ? dial.profile.key : keyOfId(dial.profile.id);
  return { ...dial, profile };
}

/** The profile ids a recipe's dials name the profile by, which `resolveDial` looks up. */
export function profileIds(dials: readonly RecipeDial[]): string[] {
  return dials.flatMap((dial) => (dial.profile !== null && "id" in dial.profile ? [dial.profile.id] : []));
}

/** Whether two recipe dials are the same. */
export function sameRecipeDial(a: RecipeDial, b: RecipeDial): boolean {
  return stableJson(a) === stableJson(b);
}

/** Whether two dials are the same. */
export function sameDial(a: Dial, b: Dial): boolean {
  return (
    a.profile === b.profile &&
    sameNumber(a.dose, b.dose) &&
    sameNumber(a.yield, b.yield) &&
    a.grinder === b.grinder &&
    sameGrind(a.grind, b.grind)
  );
}

/**
 * Whether a Workflow's dial is a recipe's: every field the recipe sets, the
 * Workflow holds, and the recipe sets at least one. A field it sets none of
 * is the Workflow's, whatever it holds.
 */
export function matches(recipe: Dial, workflow: Dial): boolean {
  if (recipe.profile === null && recipe.dose === null && recipe.yield === null && recipe.grinder === null && recipe.grind === null) return false;
  return (
    (recipe.profile === null || recipe.profile === workflow.profile) &&
    (recipe.dose === null || sameNumber(recipe.dose, workflow.dose)) &&
    (recipe.yield === null || sameNumber(recipe.yield, workflow.yield)) &&
    (recipe.grinder === null || recipe.grinder === workflow.grinder) &&
    (recipe.grind === null || sameGrind(recipe.grind, workflow.grind))
  );
}

/**
 * The recipe a Workflow's dial loads, of the tablet's (`held`), or null: one
 * any of whose dials, now or before, it matches. Of several, the one the
 * Workflow names as loaded already (`named`) wins, then the one in the
 * lowest Recipe Slot (ADR-0022).
 */
export function chooseLoad(dial: Dial, named: string | null, held: readonly HeldRecipe[]): HeldRecipe | null {
  const matching = held.filter((recipe) => recipe.dials.some((candidate) => matches(candidate, dial)));
  return matching.find((recipe) => recipe.globalId === named) ?? [...matching].sort((a, b) => a.slot - b.slot)[0] ?? null;
}

/** The records of a tablet's recipes that a Workflow can load: those in a Recipe Slot carrying a global id. */
export function loadable(records: readonly Record<string, unknown>[]): { globalId: string; slot: number; record: Record<string, unknown> }[] {
  return records.flatMap((record) => {
    const globalId = dye2GlobalIdOf(record);
    return globalId !== null && isSlotId(record.id) ? [{ globalId, slot: Number(record.id), record }] : [];
  });
}

/** What a load writes besides the record: the recipe's full Profile, and its Bean Batch as the tablet holds it, with its Bean's name and roaster. */
export interface LoadContext {
  profile: Record<string, unknown> | null;
  batch: { id: string; coffeeName: string | null; coffeeRoaster: string | null } | null;
}

/**
 * What recording a load of the recipe writes into the Workflow, through
 * `PUT /workflow`, which Decaid merges into it: what the Workflow holds
 * otherwise of the recipe's current dose, yield, grind setting, grinder,
 * RPM, Basket and Profile, as DYE2 applies them, of its Bean Batch, which
 * applying a DYE2 recipe never sets, and of its four hot water settings,
 * which it keeps in its own field (RECIPE_FIELD), and the recipe's global
 * id (LOADED_RECIPE_KEY). A value the recipe holds none of is left as the
 * Workflow has it. Null if the Workflow holds all of it already.
 */
export function loadWrite(workflow: Record<string, unknown>, record: Record<string, unknown>, globalId: string, load: LoadContext): Record<string, unknown> | null {
  const context = isObject(workflow.context) ? workflow.context : {};
  const extras = isObject(context.extras) ? context.extras : {};
  const variables = isObject(record.dashboardVariables) ? record.dashboardVariables : {};
  const [dial] = recipeDials(record) as [RecipeDial];
  const contextWrite: Record<string, unknown> = {};
  const extrasWrite: Record<string, unknown> = {};
  if (dial.dose !== null && !sameNumber(dial.dose, numberOf(context.targetDoseWeight))) contextWrite.targetDoseWeight = dial.dose;
  if (dial.yield !== null && !sameNumber(dial.yield, numberOf(context.targetYield))) contextWrite.targetYield = dial.yield;
  if (dial.grind !== null && !sameGrind(dial.grind, grindOf(context.grinderSetting))) contextWrite.grinderSetting = dial.grind;
  if (dial.grinder !== null && dial.grinder !== textOf(context.grinderId)) {
    contextWrite.grinderId = dial.grinder;
    if (textOf(variables.grinderModel) !== null) contextWrite.grinderModel = variables.grinderModel;
  }
  const rpm = numberOf(variables.rpm);
  if (rpm !== null && !sameNumber(rpm, numberOf(extras.rpm))) extrasWrite.rpm = rpm;
  const basket = textOf(variables.basketId);
  if (basket !== null && basket !== textOf(extras.basketId)) {
    extrasWrite.basketId = basket;
    if (textOf(variables.basketName) !== null) extrasWrite.basketName = variables.basketName;
  }
  if (load.batch !== null && load.batch.id !== textOf(context.beanBatchId)) {
    contextWrite.beanBatchId = load.batch.id;
    if (load.batch.coffeeName !== null) contextWrite.coffeeName = load.batch.coffeeName;
    if (load.batch.coffeeRoaster !== null) contextWrite.coffeeRoaster = load.batch.coffeeRoaster;
  }
  if (loadedRecipeOf(workflow) !== globalId) extrasWrite[LOADED_RECIPE_KEY] = globalId;
  if (Object.keys(extrasWrite).length > 0) contextWrite.extras = extrasWrite;

  const write: Record<string, unknown> = {};
  if (Object.keys(contextWrite).length > 0) write.context = contextWrite;
  const key = profileKey(load.profile);
  if (key !== null && key !== profileKey(workflow.profile)) write.profile = load.profile;
  const kept = isObject(record[RECIPE_FIELD]) ? record[RECIPE_FIELD] : {};
  const hotWater = isObject(kept.hotWaterData) ? kept.hotWaterData : {};
  const held = isObject(workflow.hotWaterData) ? workflow.hotWaterData : {};
  const hotWaterWrite = Object.fromEntries(
    HOT_WATER.flatMap((field) => {
      const value = numberOf(hotWater[field]);
      return value !== null && !sameNumber(value, numberOf(held[field])) ? [[field, value]] : [];
    }),
  );
  if (Object.keys(hotWaterWrite).length > 0) write.hotWaterData = hotWaterWrite;
  return Object.keys(write).length > 0 ? write : null;
}

/** A Workflow's hot water settings, as Decaid names them in its `hotWaterData`, which a Recipe holds all of. */
export const HOT_WATER = ["targetTemperature", "duration", "volume", "flow"] as const;

/** A Workflow's dial, and the Bean of its Bean Batch, by the tablet's id for it, or null where it names none or its batch is not the tablet's. */
export interface WorkflowSetUp {
  dial: Dial;
  bean: string | null;
}

/**
 * Whether a change of the Workflow unloads its Loaded Recipe, seen on the
 * tablet (ADR-0022): a change of its profile, grinder or Bean to one the
 * recipe, as the tablet holds it now (`dials`, `bean`), does not name. One
 * the recipe names none of, or a Bean Batch cleared, unloads nothing.
 * Another recipe loaded replaces it (`chooseLoad`), and a change of its
 * dose, yield or grind setting, as a barista's tweak, keeps it.
 */
export function unloads(before: WorkflowSetUp, after: WorkflowSetUp, dials: readonly Dial[], bean: string | null): boolean {
  const named = <T>(read: (dial: Dial) => T | null) => dials.map(read).filter((value): value is T => value !== null);
  const profiles = named((dial) => dial.profile);
  if (after.dial.profile !== before.dial.profile && profiles.length > 0 && !profiles.includes(after.dial.profile!)) return true;
  const grinders = named((dial) => dial.grinder);
  if (after.dial.grinder !== before.dial.grinder && grinders.length > 0 && !grinders.includes(after.dial.grinder!)) return true;
  return after.bean !== before.bean && after.bean !== null && bean !== null && after.bean !== bean;
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
