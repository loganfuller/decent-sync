// Compares what the simulated DYE2 v0.1.42 and Streamline v0.2.31 make again
// with a recording made before DYE2 v0.1.37 (fixtures/decaid/dye2-v0.1.26/ to
// dye2-v0.1.35/ and streamline-v0.2.24/), which still shows what it was
// recorded for but where a recipe's apply clears what the recipe names none
// of.

type Record_ = Record<string, unknown>;

/** The fields of a Workflow's context a recipe's apply clears from DYE2 v0.1.37 and Streamline v0.2.25 where the recipe names none, and those of its `extras`, each of the latter flagged in `extras.dye` with its Grinder, barista and drinker. */
const CLEARED_BY_APPLY = ["targetDoseWeight", "grinderSetting", "grinderId", "grinderModel", "baristaName", "drinkerName"];
const CLEARED_EXTRAS = ["rpm", "feedRate", "basketId", "basketName"];
const CLEARED_FLAGS = ["grinderId", "grinderModel", "baristaName", "drinkerName", ...CLEARED_EXTRAS];

/**
 * What was made again and what was recorded before DYE2 v0.1.37, compared
 * but for what a recipe's apply clears since (`0ab4d00`, `d992296`;
 * streamline-js `26d894e`, `60ccf0b`): in each Workflow context of the two,
 * its own, a request's or a recipe's embedded one, a field the apply clears
 * (`CLEARED_BY_APPLY`, `CLEARED_EXTRAS`, their flags) that either holds none
 * of, or a yield either holds as 0, is left out of both: the recording
 * inherited it from the recipe applied before, or held no key for it, and
 * the one made again writes it again once an apply cleared it, where the
 * recording's Workflow still held it, and so a barista or drinker a recipe
 * `save-recipe` made took from it. One both hold is compared as it is, but a Basket
 * with its name and flags, left out of both whatever each holds: from
 * v0.1.37 DYE2's dashboard applies a recipe's Basket, or clears it, where
 * the recordings' left the Workflow's as it was. What v0.1.40 and v0.2.27
 * clear and apply is made again from fixtures/decaid/dye2-v0.1.40/.
 */
export function sinceV0137<T>(madeAgain: T, recorded: T, contexts = false): [T, T] {
  const pair: [unknown, unknown] = [structuredClone(madeAgain), structuredClone(recorded)];
  const object = (value: unknown): value is Record_ => typeof value === "object" && value !== null && !Array.isArray(value);
  const none = (value: unknown) => value === null || value === undefined;
  /** Leaves each field out of both where either holds none of it, or `cleared` says so of either. */
  const drop = (made: Record_, kept: Record_ | undefined, fields: readonly string[], cleared: (value: unknown) => boolean = none) => {
    for (const field of fields) {
      if (!cleared(made[field]) && !(kept !== undefined && cleared(kept[field]))) continue;
      delete made[field];
      if (kept) delete kept[field];
    }
  };
  const context = (made: Record_, kept: unknown) => {
    const other = object(kept) ? kept : undefined;
    drop(made, other, CLEARED_BY_APPLY);
    drop(made, other, ["targetYield"], (value) => none(value) || value === 0);
    const extras = object(made.extras) ? made.extras : {};
    const otherExtras = other && object(other.extras) ? other.extras : undefined;
    const basket = (field: string) => field === "basketId" || field === "basketName";
    drop(extras, otherExtras, CLEARED_EXTRAS, (value) => none(value));
    drop(extras, otherExtras, CLEARED_EXTRAS.filter(basket), () => true);
    if (object(extras.dye)) {
      const flags = otherExtras && object(otherExtras.dye) ? otherExtras.dye : undefined;
      drop(extras.dye, flags, CLEARED_FLAGS);
      drop(extras.dye, flags, CLEARED_FLAGS.filter(basket), () => true);
    }
    // A recording holding one of them where the one made again holds no `extras` at all, or no flags.
    if (otherExtras && !object(made.extras)) drop({}, otherExtras, CLEARED_EXTRAS);
    if (otherExtras && object(otherExtras.dye) && !object(extras.dye)) drop({}, otherExtras.dye, CLEARED_FLAGS);
    // Nothing left of one's `extras` where the other never had any.
    const empty = (value: unknown) => object(value) && Object.keys(value).length === 0;
    if (empty(made.extras) && (!other || other.extras === undefined)) delete made.extras;
    if (other && empty(other.extras) && made.extras === undefined) delete other.extras;
  };
  const walk = (made: unknown, kept: unknown, isContext: boolean) => {
    if (Array.isArray(made)) {
      made.forEach((item, index) => walk(item, Array.isArray(kept) ? kept[index] : undefined, isContext));
      return;
    }
    if (!object(made)) return;
    if (isContext) context(made, kept);
    // A recipe `save-recipe` made of the Workflow: its barista and drinker, where either holds none, as the Workflow's.
    if (object(made.dashboardVariables) && object(kept)) drop(made, kept, ["barista", "drinker"], (value) => none(value) || value === "");
    for (const [key, value] of Object.entries(made)) walk(value, object(kept) ? kept[key] : undefined, key === "context");
  };
  walk(pair[0], pair[1], contexts);
  return pair as [T, T];
}
