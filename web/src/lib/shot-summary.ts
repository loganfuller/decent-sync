import type { SummaryGroupedBy, SummaryNumber } from "@/lib/api";

// How a Shot Summary's numbers read (#466): each as its median, with the
// range the middle half of its Shots fall in beside it, such as
// "26.0 s (25.6–26.6)"; and what its Shots are grouped by (#468), which the
// Shots list keeps in its address, and the filters a group opens as.

/** What a summary's Shots are grouped by, as the REST API's `groupBy` names each. */
export const GROUPINGS = ["location", "machine", "recipe", "bean", "beanBatch", "profile", "grinder", "basket", "barista"] as const;
export type Grouping = (typeof GROUPINGS)[number];

/** The most groupings a summary takes at once. */
export const MAX_GROUPINGS = 2;

/**
 * The groupings an address's `groupBy` names, such as `recipe,machine`:
 * those the summary has, each once, at most two. What else it holds is
 * passed over, so a mistyped address still shows a summary.
 */
export function groupingsIn(groupBy: string | null): Grouping[] {
  const named = (groupBy ?? "").split(",").filter((name): name is Grouping => (GROUPINGS as readonly string[]).includes(name));
  return [...new Set(named)].slice(0, MAX_GROUPINGS);
}

/**
 * The Shots list's filters a group opens as, each grouping's own, by what
 * the group is grouped by: the Shots they find are the group's. Null clears
 * a filter, `none` or an empty one finds the Shots with none, as the REST
 * API takes them.
 */
export function groupFilters(by: SummaryGroupedBy): Record<string, string | null> {
  const filters: Record<string, string | null> = {};
  if (by.location !== undefined) filters.locationId = by.location?.id ?? "none";
  // A Machine's group, or a Pending Machine's: the list takes one or the other.
  if (by.machine !== undefined || by.pendingMachine !== undefined) Object.assign(filters, { machineId: by.machine?.id ?? null, pendingMachineId: by.pendingMachine?.id ?? null });
  if (by.recipe !== undefined) filters.recipeId = by.recipe?.id ?? "none";
  if (by.bean !== undefined) Object.assign(filters, { coffeeRoaster: by.bean?.roaster ?? "", coffeeName: by.bean?.name ?? "" });
  if (by.beanBatch !== undefined) filters.beanBatchId = by.beanBatch?.id ?? "none";
  if (by.profile !== undefined) filters.profileTitle = by.profile ?? "";
  if (by.grinder !== undefined) filters.grinderId = by.grinder?.id ?? "none";
  if (by.basket !== undefined) filters.basketId = by.basket?.id ?? "none";
  if (by.barista !== undefined) filters.barista = by.barista ?? "";
  return filters;
}

/**
 * Who a Barista's name names, as the server reads one (`baristaKeySql`): the
 * name without its case or the blanks around it, which are spaces, tabs and
 * line ends and no other space, so the Barista filter's choice is found for
 * any spelling an address holds. Empty for no name, or a blank one.
 */
export function baristaKey(name: string): string {
  return name.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "").toLowerCase();
}

/** A number of a summary as it reads: its median with its unit, and the range from its 25th percentile to its 75th. */
export interface MedianText {
  median: string;
  range: string;
}

/** A duration as its median and range, in seconds to a tenth, as the Shots list shows one: none where no Shot had one. */
export function durationText(number: SummaryNumber): MedianText | undefined {
  const { median, p25, p75 } = number;
  if (median === null || p25 === null || p75 === null) return undefined;
  return { median: `${median.toFixed(1)} s`, range: `${p25.toFixed(1)}–${p75.toFixed(1)}` };
}

/**
 * A yield against target as its median and range, in grams to a tenth, each
 * with its sign, over or under the target: none where no Shot had one. The
 * range reads "to" rather than a dash, which a minus sign beside it would
 * be mistaken for.
 */
export function yieldAgainstTargetText(number: SummaryNumber): MedianText | undefined {
  const { median, p25, p75 } = number;
  if (median === null || p25 === null || p75 === null) return undefined;
  return { median: `${signedText(median)} g`, range: `${signedText(p25)} to ${signedText(p75)}` };
}

/** A difference to a tenth with its sign, a plus or a minus sign (U+2212); one that rounds to nothing has neither. */
export function signedText(value: number): string {
  const size = Math.abs(value).toFixed(1);
  if (Number(size) === 0) return size;
  return `${value > 0 ? "+" : "−"}${size}`;
}

/** A share, from 0 to 1, as a whole percentage: none where no Shot either did or didn't. */
export function shareText(share: number | null): string | undefined {
  return share === null ? undefined : `${Math.round(share * 100)}%`;
}

/** A count of Shots, as "1 Shot" or "12 Shots". */
export function shotsText(count: number): string {
  return `${count} ${count === 1 ? "Shot" : "Shots"}`;
}
