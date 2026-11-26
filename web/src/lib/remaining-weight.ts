import type { BatchAtLocation, EditSource } from "@/lib/api";

// A Bean Batch's Remaining Weight at a Location as the management interface
// words it: the weight, or "Not tracked", and the one line under it that says
// what the count starts from and what Shots have used since (ADR-0037). The
// server works the weight out; nothing here does.

/** A weight in grams, to the tenth of a gram at most. */
export function grams(weight: number): string {
  return `${Math.round(weight * 10) / 10} g`;
}

/** A batch's Remaining Weight at a Location: untracked where it has none, never zero. */
export function weightText(weight: number | null): string {
  return weight === null ? "Not tracked" : grams(weight);
}

/** A batch's total over the Locations that track it, as lists show it: nothing for a batch at no Location. */
export function totalText(batch: { locations: BatchAtLocation[]; totalRemainingWeight?: number | null }): string | undefined {
  if (batch.locations.length === 0) return undefined;
  // The release before answers with no total, as it may during a deploy (ADR-0025): its weights are those entered.
  const total = batch.totalRemainingWeight === undefined ? sumOf(batch.locations) : batch.totalRemainingWeight;
  return weightText(total);
}

function sumOf(locations: BatchAtLocation[]): number | null {
  const weights = locations.flatMap((here) => (here.remainingWeight === null ? [] : [here.remainingWeight]));
  return weights.length === 0 ? null : weights.reduce((sum, weight) => sum + weight, 0);
}

/** Where a batch is, by Location name, with its Remaining Weight at each. */
export function atText(locations: BatchAtLocation[]): string {
  return locations.length === 0 ? "Nowhere" : locations.map((here) => `${here.location.name} (${weightText(here.remainingWeight).toLowerCase()})`).join(", ");
}

const DAY = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const DAY_AND_YEAR = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

/** A day as the line names it, such as "25 Nov", with its year when that is not this one. */
export function dayText(iso: string, now: Date = new Date()): string {
  const day = new Date(iso);
  return (day.getFullYear() === now.getFullYear() ? DAY : DAY_AND_YEAR).format(day);
}

/** Who entered a weight, as the line names them: the Machine it was entered on, or the account, "you" for the one reading. */
export function enteredBy(source: EditSource | null, readerId: string | undefined): string | undefined {
  if (source === null) return undefined;
  if (source.machine) return `on ${source.machine.name}`;
  if (source.account) {
    const who = readerId !== undefined && source.account.id === readerId ? "you" : (source.account.name ?? "an account");
    return source.connectedApp ? `by ${who}, through ${source.connectedApp.name}` : `by ${who}`;
  }
  return source.tabletId ? "on a Machine since removed" : undefined;
}

/**
 * The one line a Location has on a batch's page: the weight its count starts
 * from, when and by whom it was entered, and the Shots pulled there since
 * with the coffee they used, such as "4180 g entered 25 Nov by Sam. Since: 38
 * Shots used 760 g." Undefined where the server said none of it, as the
 * release before does.
 */
export function weightLine(here: BatchAtLocation, readerId: string | undefined, now: Date = new Date()): string | undefined {
  if (here.entered === undefined || here.used === undefined) return undefined;
  if (here.entered === null || here.used === null) return "No weight entered.";
  const by = enteredBy(here.entered.by, readerId);
  const entered = `${grams(here.entered.weight)} entered ${dayText(here.entered.at, now)}${by === undefined ? "" : ` ${by}`}.`;
  const { shots, weight } = here.used;
  const since = shots === 0 ? "No Shots since." : `Since: ${shots} ${shots === 1 ? "Shot" : "Shots"} used ${grams(weight)}.`;
  return `${entered} ${since}`;
}
