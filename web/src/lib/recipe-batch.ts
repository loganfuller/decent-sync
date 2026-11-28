import type { BeanBatchSummary, BeanSummary, Recipe } from "@/lib/api";
import { type NamedBatch, batchWords } from "./batch-name";
import { type BatchOption, type BatchOptionGroup, latestRoastedFirst } from "./batch-picker";
import { grams } from "./remaining-weight";

// A Recipe's Bean Batch (#733) as its page's strip, its form and the Change
// batch dialog read it: the pure parts, which name the batch a Recipe uses,
// say what is left of a batch at a Location, list what the picker offers a
// Recipe, and find the next roasts of a Recipe's Bean at its Location.

/** Stands for no batch, as the picker's options each need a value. */
export const NO_BATCH = "none";

/** Stands for a Recipe's Bean with no batch, as a Bean picked on a tablet with none at its Location leaves it: kept unless another is picked. */
export const BEAN_ONLY = "bean-only";

/** A Recipe's Bean Batch as what names one (`NamedBatch`): its Bean's name and roaster are its Recipe's Bean's. Undefined for a Recipe that names no batch. */
export function usedBatch(recipe: Pick<Recipe, "uses">): (NamedBatch & { id: string; bean: { name: string | null; roaster: string | null } }) | undefined {
  const { beanBatch, bean } = recipe.uses;
  return beanBatch ? { id: beanBatch.id, bean: { name: bean?.name ?? null, roaster: bean?.roaster ?? null }, roastDate: beanBatch.roastDate, batchCode: beanBatch.batchCode } : undefined;
}

/** A Recipe's Bean Batch in words, or, for one naming a Bean with no batch, that Bean and that it has none. */
export function usedBatchText(recipe: Pick<Recipe, "uses">): string | undefined {
  const batch = usedBatch(recipe);
  if (batch) return batchWords(batch);
  const { bean } = recipe.uses;
  return bean ? `${bean.name ?? "Unnamed Bean"}, no batch` : undefined;
}

/** The batches a Recipe is offered: none Archived, and none of an Archived Bean. */
export function offeredBatches(batches: readonly BeanBatchSummary[], beans: readonly Pick<BeanSummary, "id" | "archived">[]): BeanBatchSummary[] {
  const archivedBeans = new Set(beans.filter((bean) => bean.archived).map((bean) => bean.id));
  return batches.filter((batch) => !batch.archived && !archivedBeans.has(batch.bean.id));
}

/**
 * A batch's Remaining Weight at a Location: null where it is untracked
 * there, and undefined where the batch is not there, or the server said no
 * weight of it, so the page leaves the weight out.
 */
export function weightAt(batch: Pick<BeanBatchSummary, "locations"> | undefined, locationId: string | undefined): number | null | undefined {
  return batch?.locations.find((at) => at.location.id === locationId)?.remainingWeight;
}

/**
 * A batch's weight at a Location, as an option or a line says it: "3240 g
 * here" of the Location a page is of, or "there" of another (`where`), and
 * "Not tracked"; nothing where the page has none to say.
 */
export function hereText(weight: number | null | undefined, where: "here" | "there" = "here"): string | undefined {
  if (weight === undefined) return undefined;
  return weight === null ? "Not tracked" : `${grams(weight)} ${where}`;
}

/** A batch's weight over the Locations it is at, as an option says it of one from elsewhere: "6000 g there", or "Not tracked"; nothing for a batch at no Location. */
export function thereText(batch: Pick<BeanBatchSummary, "locations" | "totalRemainingWeight">): string | undefined {
  if (batch.locations.length === 0) return undefined;
  // The release before answers with no total, as it may during a deploy (ADR-0025): its weights are added up.
  const tracked = batch.locations.flatMap((at) => (at.remainingWeight == null ? [] : [at.remainingWeight]));
  const total = batch.totalRemainingWeight === undefined ? (tracked.length === 0 ? null : tracked.reduce((sum, weight) => sum + weight, 0)) : batch.totalRemainingWeight;
  return total === null ? "Not tracked" : `${grams(total)} there`;
}

/** Where a batch from elsewhere is, as its option's second line says it: "at Riverside", or "at no Location". */
export function elsewhereText(batch: Pick<BeanBatchSummary, "locations">): string {
  return batch.locations.length === 0 ? "at no Location" : `at ${batch.locations.map((at) => at.location.name).join(", ")}`;
}

/**
 * What the picker offers a Recipe at a Location (`here`), new or edited, as
 * the select it replaces did, and no more:
 * - the field's value where it is none of the batches offered, first: the
 *   Recipe's own batch, though Archived or its Bean's is, or what `kept`
 *   calls it, as a Bean kept with no batch;
 * - "At Downtown", the batches at the Location, the latest roasted first,
 *   each with its weight there;
 * - "Elsewhere: saving adds it at Downtown", the rest, each with the
 *   Locations it is at and its weight over them;
 * - "No batch".
 * `batches` are those offered (`offeredBatches`), and `own` the batch the
 * Recipe names now, whose option says so.
 */
export function recipeBatchGroups({
  batches,
  here,
  value,
  own,
  kept,
}: {
  batches: readonly BeanBatchSummary[];
  here: { id: string; name: string };
  value: string;
  own?: (NamedBatch & { id: string }) | undefined;
  kept?: string | undefined;
}): BatchOptionGroup[] {
  const atHere = (batch: BeanBatchSummary) => batch.locations.some((at) => at.location.id === here.id);
  const now = (batch: { id: string }) => (own?.id === batch.id ? { note: "this Recipe's batch now" } : {});
  const sorted = [...batches].sort(latestRoastedFirst);
  const keptOption: BatchOption[] =
    value === NO_BATCH || batches.some((batch) => batch.id === value) ? [] : own?.id === value ? [{ value, batch: own, ...now(own) }] : [{ value, label: kept ?? "Its batch now" }];
  return [
    { options: keptOption },
    {
      label: `At ${here.name}`,
      options: sorted.filter(atHere).map((batch) => ({ value: batch.id, batch, ...now(batch), weight: hereText(weightAt(batch, here.id)) })),
    },
    {
      label: `Elsewhere: saving adds it at ${here.name}`,
      options: sorted.filter((batch) => !atHere(batch)).map((batch) => ({ value: batch.id, batch, note: [now(batch).note, elsewhereText(batch)].filter((part) => part !== undefined).join(" · "), weight: thereText(batch) })),
    },
    { options: [{ value: NO_BATCH, label: "No batch" }] },
  ].filter((group) => group.options.length > 0);
}

/** The picker's value for a Recipe's content, or a new one's: its batch, that it names a Bean with none, or no batch. */
export function batchValueOf(content: Record<string, unknown>): string {
  if (typeof content.beanBatchId === "string") return content.beanBatchId;
  return typeof content.beanId === "string" ? BEAN_ONLY : NO_BATCH;
}

/** The edit of a Recipe's content a value of the picker makes: its batch, none, which clears its Bean with it, or nothing for a Bean kept with no batch. */
export function batchEdit(value: string): { beanBatchId?: string | null } {
  if (value === BEAN_ONLY) return {};
  return { beanBatchId: value === NO_BATCH ? null : value };
}

/**
 * The next roasts a Recipe whose batch is finished at its Location is
 * offered there: the other batches of its Bean that are at the Location,
 * none Archived, the latest roasted first. `batches` are those offered
 * (`offeredBatches`).
 */
export function nextRoasts(recipe: Pick<Recipe, "uses">, batches: readonly BeanBatchSummary[], locationId: string | undefined): BeanBatchSummary[] {
  const { bean, beanBatch } = recipe.uses;
  if (!bean || locationId === undefined) return [];
  return batches.filter((batch) => batch.bean.id === bean.id && batch.id !== beanBatch?.id && batch.locations.some((at) => at.location.id === locationId)).sort(latestRoastedFirst);
}

/** How long ago a roast was, in whole days, as the strip says it after the roast day: "today", "1 day ago" or "10 days ago". */
export function agoText(days: number): string {
  return days === 0 ? "today" : `${days} ${days === 1 ? "day" : "days"} ago`;
}
