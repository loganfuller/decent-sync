import type { BatchAtLocation, EditSource } from "@/lib/api";

// A Bean Batch's Remaining Weight at a Location as the management interface
// words it: the weight, or "Not tracked", and the one line under it that says
// what the count starts from and what Shots have used and Batch Moves have
// brought and taken since (ADR-0037). The server works the weight out;
// nothing here does.

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
 * from, when and by whom it was entered or the Location it arrived from, and
 * what has changed it since, the Shots pulled there with the coffee they
 * used and the amounts moved to it and away from it, such as "4180 g entered
 * 25 Nov by Sam. Since: 38 Shots used 760 g, 500 g moved to Riverside."
 * Undefined where the server said none of it, as the release before does.
 */
export function weightLine(here: BatchAtLocation, readerId: string | undefined, now: Date = new Date()): string | undefined {
  if (here.entered === undefined || here.used === undefined) return undefined;
  if (here.entered === null || here.used === null) return "No weight entered.";
  const by = enteredBy(here.entered.by, readerId);
  const day = dayText(here.entered.at, now);
  const start = here.entered.arrivedFrom ? `${grams(here.entered.weight)} arrived from ${here.entered.arrivedFrom.name} ${day}.` : `${grams(here.entered.weight)} entered ${day}${by === undefined ? "" : ` ${by}`}.`;
  const { shots, weight } = here.used;
  const since = [...(shots === 0 ? [] : [`${shots} ${shots === 1 ? "Shot" : "Shots"} used ${grams(weight)}`]), ...movedText(here.moved)];
  return `${start} ${since.length === 0 ? "No Shots since." : `Since: ${since.join(", ")}.`}`;
}

/** What Batch Moves have brought to a Location and taken from it since its count started, an amount for each other Location, and one for any whose Location has been deleted since. */
function movedText(moved: BatchAtLocation["moved"]): string[] {
  if (!moved) return [];
  const named = (amounts: { weight: number }[]) => amounts.reduce((sum, amount) => sum + amount.weight, 0);
  const gone = (total: number, amounts: { weight: number }[]) => Math.round((total - named(amounts)) * 10) / 10;
  return [
    ...moved.from.map((other) => `${grams(other.weight)} moved from ${other.location.name}`),
    ...(gone(moved.in, moved.from) > 0 ? [`${grams(gone(moved.in, moved.from))} moved from a Location since deleted`] : []),
    ...moved.to.map((other) => `${grams(other.weight)} moved to ${other.location.name}`),
    ...(gone(moved.away, moved.to) > 0 ? [`${grams(gone(moved.away, moved.to))} moved to a Location since deleted`] : []),
  ];
}
