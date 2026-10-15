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
  /** The dials it holds now, and those it held before, each resolved: what a load is matched on. */
  dials: Dial[];
  /** The dials it holds now, resolved: what an unload is judged by. */
  now: Dial[];
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
 * lowest Recipe Slot (ADR-0022). Where the same change picked a batch of a
 * Bean (`picked`, by the tablet's id for it), as a barista does, but no app
 * applying a recipe, a recipe naming another Bean is none it loads. Where it
 * is a change of the dial (`changed`, the parts of the dial it changed), it
 * loads only a recipe with a dial it matches that sets one of them: a recipe
 * that leaves a field blank matches whatever the Workflow holds there, so a
 * tweak of the Loaded Recipe's grind, or Streamline clearing its grinder,
 * would otherwise load a recipe that sets no grind, or no grinder.
 */
export function chooseLoad(dial: Dial, named: string | null, held: readonly HeldRecipe[], picked: string | null = null, changed?: ReadonlySet<string>): HeldRecipe | null {
  const sets = (candidate: Dial) => (Object.keys(candidate) as (keyof Dial)[]).some((field) => candidate[field] !== null && changed!.has(field));
  const matching = held.filter((recipe) => {
    const bean = recipe.record.beanId;
    if (picked !== null && typeof bean === "string" && bean !== "" && bean !== picked) return false;
    return recipe.dials.some((candidate) => matches(candidate, dial) && (changed === undefined || sets(candidate)));
  });
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
 * Workflow has it, as is each part `kept`, and each of `keptWhereHeld` the
 * Workflow holds a value for. Null if the Workflow holds all of it already.
 */
export function loadWrite(
  workflow: Record<string, unknown>,
  record: Record<string, unknown>,
  globalId: string,
  load: LoadContext,
  kept: ReadonlySet<WrittenPart> = new Set(),
  keptWhereHeld: ReadonlySet<WrittenPart> = new Set(),
): Record<string, unknown> | null {
  const context = isObject(workflow.context) ? workflow.context : {};
  const extras = isObject(context.extras) ? context.extras : {};
  const variables = isObject(record.dashboardVariables) ? record.dashboardVariables : {};
  const [dial] = recipeDials(record) as [RecipeDial];
  const contextWrite: Record<string, unknown> = {};
  const extrasWrite: Record<string, unknown> = {};
  const hotWaterHeld = isObject(workflow.hotWaterData) ? workflow.hotWaterData : {};
  const holds: Readonly<Record<WrittenPart, unknown>> = {
    dose: context.targetDoseWeight,
    yield: context.targetYield,
    grind: context.grinderSetting,
    grinder: context.grinderId,
    profile: workflow.profile,
    rpm: extras.rpm,
    basket: extras.basketId,
    batch: context.beanBatchId,
    targetTemperature: hotWaterHeld.targetTemperature,
    duration: hotWaterHeld.duration,
    volume: hotWaterHeld.volume,
    flow: hotWaterHeld.flow,
  };
  const writes = (part: WrittenPart) => !kept.has(part) && !(keptWhereHeld.has(part) && holds[part] !== null && holds[part] !== undefined);
  if (writes("dose") && dial.dose !== null && !sameNumber(dial.dose, numberOf(context.targetDoseWeight))) contextWrite.targetDoseWeight = dial.dose;
  if (writes("yield") && dial.yield !== null && !sameNumber(dial.yield, numberOf(context.targetYield))) contextWrite.targetYield = dial.yield;
  if (writes("grind") && dial.grind !== null && !sameGrind(dial.grind, grindOf(context.grinderSetting))) contextWrite.grinderSetting = dial.grind;
  if (writes("grinder") && dial.grinder !== null && dial.grinder !== textOf(context.grinderId)) {
    contextWrite.grinderId = dial.grinder;
    if (textOf(variables.grinderModel) !== null) contextWrite.grinderModel = variables.grinderModel;
  }
  const rpm = numberOf(variables.rpm);
  if (writes("rpm") && rpm !== null && !sameNumber(rpm, numberOf(extras.rpm))) extrasWrite.rpm = rpm;
  const basket = textOf(variables.basketId);
  if (writes("basket") && basket !== null && basket !== textOf(extras.basketId)) {
    extrasWrite.basketId = basket;
    if (textOf(variables.basketName) !== null) extrasWrite.basketName = variables.basketName;
  }
  if (writes("batch") && load.batch !== null && load.batch.id !== textOf(context.beanBatchId)) {
    contextWrite.beanBatchId = load.batch.id;
    if (load.batch.coffeeName !== null) contextWrite.coffeeName = load.batch.coffeeName;
    if (load.batch.coffeeRoaster !== null) contextWrite.coffeeRoaster = load.batch.coffeeRoaster;
  }
  if (loadedRecipeOf(workflow) !== globalId) extrasWrite[LOADED_RECIPE_KEY] = globalId;
  if (Object.keys(extrasWrite).length > 0) contextWrite.extras = extrasWrite;

  const write: Record<string, unknown> = {};
  if (Object.keys(contextWrite).length > 0) write.context = contextWrite;
  const key = profileKey(load.profile);
  if (writes("profile") && key !== null && key !== profileKey(workflow.profile)) write.profile = load.profile;
  const own = isObject(record[RECIPE_FIELD]) ? record[RECIPE_FIELD] : {};
  const hotWater = isObject(own.hotWaterData) ? own.hotWaterData : {};
  const held = isObject(workflow.hotWaterData) ? workflow.hotWaterData : {};
  const hotWaterWrite = Object.fromEntries(
    HOT_WATER.flatMap((field) => {
      const value = numberOf(hotWater[field]);
      return writes(field) && value !== null && !sameNumber(value, numberOf(held[field])) ? [[field, value]] : [];
    }),
  );
  if (Object.keys(hotWaterWrite).length > 0) write.hotWaterData = hotWaterWrite;
  return Object.keys(write).length > 0 ? write : null;
}

/** A Workflow's hot water settings, as Decaid names them in its `hotWaterData`, which a Recipe holds all of. */
export const HOT_WATER = ["targetTemperature", "duration", "volume", "flow"] as const;

/** A part of a Workflow a load writes (`loadWrite`): its dial, RPM, Basket, Bean Batch, and each of its hot water settings. */
export type WrittenPart = "dose" | "yield" | "grind" | "grinder" | "profile" | "rpm" | "basket" | "batch" | (typeof HOT_WATER)[number];

/**
 * The parts of a Workflow a load writes that differ between two, and
 * `recipe` where they name another Loaded Recipe: none if a change between
 * them can neither load nor unload a recipe, nor be written over by a load.
 */
export function changedParts(a: Record<string, unknown>, b: Record<string, unknown>): Set<WrittenPart | "recipe"> {
  const [x, y] = [workflowDial(a), workflowDial(b)];
  const part = (workflow: Record<string, unknown>, name: string) => (isObject(workflow[name]) ? (workflow[name] as Record<string, unknown>) : {});
  const extra = (workflow: Record<string, unknown>, name: string) => {
    const extras = part(workflow, "context").extras;
    return isObject(extras) ? extras[name] : undefined;
  };
  const changed = new Set<WrittenPart | "recipe">();
  if (!sameNumber(x.dose, y.dose)) changed.add("dose");
  if (!sameNumber(x.yield, y.yield)) changed.add("yield");
  if (!sameGrind(x.grind, y.grind)) changed.add("grind");
  if (x.grinder !== y.grinder) changed.add("grinder");
  if (x.profile !== y.profile) changed.add("profile");
  if (!sameNumber(numberOf(extra(a, "rpm")), numberOf(extra(b, "rpm")))) changed.add("rpm");
  if (textOf(extra(a, "basketId")) !== textOf(extra(b, "basketId"))) changed.add("basket");
  if (workflowBatch(a) !== workflowBatch(b)) changed.add("batch");
  for (const field of HOT_WATER) if (!sameNumber(numberOf(part(a, "hotWaterData")[field]), numberOf(part(b, "hotWaterData")[field]))) changed.add(field);
  if (loadedRecipeOf(a) !== loadedRecipeOf(b)) changed.add("recipe");
  return changed;
}

/**
 * What the changes of the Workflow decided on so far leave to write into it:
 * nothing; a load of a recipe, but for the parts changed since it was
 * loaded (`kept`), which stay as they were changed; or clearing its Loaded
 * Recipe.
 */
export type Pending =
  | { kind: "none" }
  | {
      kind: "load";
      globalId: string;
      kept: ReadonlySet<WrittenPart>;
      /**
       * For a load of the recipe the Workflow names already, the parts it
       * leaves as the Workflow holds them, where it holds a value for them,
       * as the barista may have changed them since it was loaded.
       */
      alone?: ReadonlySet<WrittenPart>;
    }
  | { kind: "unload" };

/** Every part a pending load leaves as the Workflow holds it: those kept, and those it writes only where the Workflow holds none. */
export function keptParts(pending: Extract<Pending, { kind: "load" }>): Set<WrittenPart> {
  return new Set([...pending.kept, ...(pending.alone ?? [])]);
}

/** A Workflow as a change is decided on: its dial, its Bean Batch, that batch's Bean where it matters, and the Loaded Recipe it names. */
export interface ChangedSetUp {
  dial: Dial;
  batch: string | null;
  /** The Bean of its batch, by the tablet's id for it, where the change picked another batch; null otherwise. */
  bean: string | null;
  named: string | null;
}

/**
 * The parts a load writes besides the dial, which a load of the recipe the
 * Workflow names already leaves as they are: the barista may have changed
 * them since it was loaded, as its hot water, or the next bag of its Bean.
 */
const AFTER_LOADED: readonly WrittenPart[] = ["rpm", "basket", "batch", ...HOT_WATER];

/**
 * What one change of the Workflow, from `before` (undefined for the first
 * the plugin heard of, as on every load) to `after`, leaves to write, given
 * what the changes before it left (`pending`), and which of the parts a
 * load writes it changed (`changed`), decided as though at once, so the
 * outcome is the same however fast the plugin decides. A change of the dial
 * that matches one of the tablet's recipes (`chooseLoad`) loads it, a batch
 * picked in the same change, which no app applying a recipe does, staying
 * as picked, and a recipe of another Bean is none it loads. A load of the
 * recipe the Workflow names already, with nothing left to write, writes its
 * dial alone, as it is now, or, from a stale copy, all but its batch. The first
 * Workflow, as on every load of the plugin, is no change, and loads nothing:
 * naming a recipe it matches, that one is written its dial alone. Otherwise a
 * change of the profile, grinder or Bean to one the Loaded Recipe does not
 * name unloads it (`unloads`); the first Workflow unloads nothing. Any other
 * change made after a load that is still to be written is the barista's,
 * after it, and the load leaves those parts as they were changed.
 */
export function decideChange(
  pending: Pending,
  before: ChangedSetUp | undefined,
  after: ChangedSetUp,
  changed: ReadonlySet<WrittenPart | "recipe">,
  held: readonly HeldRecipe[],
): Pending {
  const dialChanged = !before || !sameDial(before.dial, after.dial);
  const picked = before !== undefined && before.batch !== after.batch;
  const loaded = pending.kind === "load" ? pending.globalId : pending.kind === "unload" ? null : after.named;
  if (dialChanged) {
    // The first Workflow is no change, which loads nothing: one naming a Loaded Recipe may match only that one again.
    const candidates = before ? held : held.filter((recipe) => recipe.globalId === after.named);
    const chosen = chooseLoad(after.dial, loaded, candidates, picked ? after.bean : null, before ? changed : undefined);
    if (chosen) {
      const kept = new Set<WrittenPart>(picked ? ["batch"] : []);
      const same = pending.kind === "load" && pending.globalId === chosen.globalId;
      // The dial matches the recipe again: the barista's changes since its load still to be written stay, but their
      // changes of the dial, which it sets again.
      if (same) for (const part of pending.kept) if (AFTER_LOADED.includes(part)) kept.add(part);
      // The recipe the Workflow names, with nothing else left to write: its dial set back, or applied again as it is
      // now, is written its current dial alone, the rest staying as the barista left it, where the Workflow holds a
      // value for it. A stale copy of it, matching only a dial it held before, has the rest corrected too, but its
      // batch, which no app applying a recipe sets. Decided afresh at each such change, as each would be at once.
      if ((pending.kind === "none" && after.named === chosen.globalId) || (same && pending.alone !== undefined)) {
        const current = chosen.now.some((candidate) => matches(candidate, after.dial));
        return { kind: "load", globalId: chosen.globalId, kept, alone: new Set<WrittenPart>(current ? AFTER_LOADED : ["batch"]) };
      }
      return { kind: "load", globalId: chosen.globalId, kept };
    }
  }
  if (loaded === null || !before) return pending;
  const recipe = held.find((candidate) => candidate.globalId === loaded);
  // A Loaded Recipe the tablet no longer holds in a slot stays: the server unloads it.
  if (!recipe) return pending;
  const bean = typeof recipe.record.beanId === "string" && recipe.record.beanId !== "" ? recipe.record.beanId : null;
  if (unloads({ dial: before.dial, bean: picked ? before.bean : null }, { dial: after.dial, bean: picked ? after.bean : null }, recipe.now, bean)) return { kind: "unload" };
  if (pending.kind !== "load") return pending;
  const kept = new Set<WrittenPart>(pending.kept);
  for (const part of changed) if (part !== "recipe") kept.add(part);
  return { ...pending, kept };
}

/** A Workflow's dial, and the Bean of its Bean Batch, by the tablet's id for it, or null where it names none or its batch is not the tablet's. */
export interface WorkflowSetUp {
  dial: Dial;
  bean: string | null;
}

/**
 * Whether a change of the Workflow unloads its Loaded Recipe, seen on the
 * tablet (ADR-0022): a change of its profile, grinder or Bean to one the
 * recipe, as the tablet holds it now (`dials`, `bean`), does not name. One
 * the recipe names none of, or a grinder or Bean Batch cleared, as
 * Streamline clears them once each Shot is stored, unloads nothing.
 * Another recipe loaded replaces it (`chooseLoad`), and a change of its
 * dose, yield or grind setting, as a barista's tweak, keeps it.
 */
export function unloads(before: WorkflowSetUp, after: WorkflowSetUp, dials: readonly Dial[], bean: string | null): boolean {
  const named = <T>(read: (dial: Dial) => T | null) => dials.map(read).filter((value): value is T => value !== null);
  const profiles = named((dial) => dial.profile);
  if (after.dial.profile !== before.dial.profile && profiles.length > 0 && !profiles.includes(after.dial.profile!)) return true;
  const grinders = named((dial) => dial.grinder);
  // A grinder cleared, as Streamline clears it once each Shot is stored, unloads nothing, as a batch cleared does not.
  if (after.dial.grinder !== before.dial.grinder && after.dial.grinder !== null && grinders.length > 0 && !grinders.includes(after.dial.grinder)) return true;
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
