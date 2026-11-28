import type { BatchAtLocation, BeanBatch, EditSource, ItemVersion } from "@/lib/api";

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

/**
 * A Bean's batches in the line beside its Batches card's title (#732): how
 * many of them are at a Location, and the sum of their remaining weights
 * over the Locations that track them, such as "4 at a Location, 17090 g in
 * all", or "none with a weight" where no Location tracks one. An Archived
 * batch is counted in neither, as no Location offers one.
 */
export function batchesCountText(batches: readonly { archived: boolean; locations: BatchAtLocation[]; totalRemainingWeight?: number | null }[]): string {
  const here = batches.filter((batch) => !batch.archived && batch.locations.length > 0);
  if (here.length === 0) return "None at a Location";
  // The release before answers with no total, as it may during a deploy (ADR-0025): its weights are those entered.
  const totals = here.flatMap((batch) => {
    const total = batch.totalRemainingWeight === undefined ? sumOf(batch.locations) : batch.totalRemainingWeight;
    return total === null ? [] : [total];
  });
  return `${here.length} at a Location, ${totals.length === 0 ? "none with a weight" : `${grams(totals.reduce((sum, total) => sum + total, 0))} in all`}`;
}

/** Where a batch is, by Location name, with its Remaining Weight at each. */
export function atText(locations: BatchAtLocation[]): string {
  return locations.length === 0 ? "Nowhere" : locations.map((here) => `${here.location.name} (${weightText(here.remainingWeight).toLowerCase()})`).join(", ");
}

/**
 * Where a batch is as the list of batches says it, a line for each Location:
 * its name with its Remaining Weight there, "not tracked" where that
 * Location has none and another has one, and the name alone where no
 * Location tracks the batch.
 */
export function atLines(locations: BatchAtLocation[]): { id: string; name: string; weight?: string }[] {
  const tracked = locations.some((here) => here.remainingWeight !== null);
  return locations.map((here) => ({ id: here.location.id, name: here.location.name, ...(tracked ? { weight: weightText(here.remainingWeight).toLowerCase() } : {}) }));
}

/**
 * The line under a batch's total on its page: how many Locations it is at,
 * how many of them track it where not all do, and its roasted weight where
 * it has one, such as "At 3 Locations, 2 with a weight, of 6000 g roasted."
 * Undefined for a batch at no Location.
 */
export function totalLine(locations: BatchAtLocation[], roastedWeight: unknown): string | undefined {
  if (locations.length === 0) return undefined;
  const tracked = locations.filter((here) => here.remainingWeight !== null).length;
  const parts = [
    `At ${locations.length} ${locations.length === 1 ? "Location" : "Locations"}`,
    ...(tracked === locations.length ? [] : [`${tracked === 0 ? "none" : tracked} with a weight`]),
    ...(typeof roastedWeight === "number" && Number.isFinite(roastedWeight) && roastedWeight > 0 ? [`of ${grams(roastedWeight)} roasted`] : []),
  ];
  return `${parts.join(", ")}.`;
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
  const parts = weightLineParts(here, readerId, now);
  return parts && `${parts.before}${parts.shots ?? ""}${parts.after}`;
}

/**
 * That line in three parts, so the page can link its count of Shots, such as
 * "38 Shots", to those Shots in the Shots list: what is written before the
 * count, the count, absent where no Shot was pulled since, and what follows.
 */
export function weightLineParts(here: BatchAtLocation, readerId: string | undefined, now: Date = new Date()): { before: string; shots?: string; after: string } | undefined {
  if (here.entered === undefined || here.used === undefined) return undefined;
  if (here.entered === null || here.used === null) return { before: "No weight entered.", after: "" };
  const by = enteredBy(here.entered.by, readerId);
  const day = dayText(here.entered.at, now);
  const start = here.entered.arrivedFrom ? `${grams(here.entered.weight)} arrived from ${here.entered.arrivedFrom.name} ${day}.` : `${grams(here.entered.weight)} entered ${day}${by === undefined ? "" : ` ${by}`}.`;
  const { shots, weight } = here.used;
  const moved = movedText(here.moved);
  if (shots === 0) return { before: `${start} ${moved.length === 0 ? "No Shots since." : `Since: ${moved.join(", ")}.`}`, after: "" };
  return { before: `${start} Since: `, shots: `${shots} ${shots === 1 ? "Shot" : "Shots"}`, after: ` used ${[grams(weight), ...moved].join(", ")}.` };
}

/**
 * What a Location's bar on a batch's page draws: what is left of what stayed
 * there, its Remaining Weight over that weight plus what the Shots pulled
 * there since its count started have used, from 0 to 1, with both weights in
 * words for a screen reader. Coffee moved to another Location or received
 * from one is not drawn as used, so the bar is full while no Shot has been
 * pulled since, and empty at 0 g. Undefined, for no bar, where the batch is
 * untracked there, or the server gave no count of what was used, as the
 * release before does (ADR-0025).
 */
export function barOf(here: Pick<BatchAtLocation, "location" | "remainingWeight" | "used">): { fraction: number; label: string } | undefined {
  if (here.remainingWeight === null || !here.used) return undefined;
  const left = Math.max(0, here.remainingWeight);
  const used = Math.max(0, here.used.weight);
  return {
    fraction: left === 0 ? 0 : left / (left + used),
    label: `${grams(left)} left at ${here.location.name}, ${grams(used)} used by Shots there`,
  };
}

/**
 * How far a weight typed in the Enter weight dialog is from the one worked
 * out for the Location, such as "140 g less than the 2920 g worked out.", so
 * 292 typed for 2920 is noticed before it is saved. Undefined where the
 * Location has no weight worked out, the weight typed is the same, to the
 * tenth of a gram, or it is not a weight above zero: zero and an empty field
 * have lines of their own.
 */
export function differenceText(typed: string, worked: number | null): string | undefined {
  if (worked === null || typed.trim() === "") return undefined;
  const weight = Number(typed);
  if (!Number.isFinite(weight) || weight <= 0) return undefined;
  const difference = Math.round((weight - worked) * 10) / 10;
  if (difference === 0) return undefined;
  return `${grams(Math.abs(difference))} ${difference < 0 ? "less" : "more"} than the ${grams(worked)} worked out.`;
}

/**
 * What a batch's page says of a Location the batch has left, after the
 * Location's name: "Moved to Riverside 26 Nov" where a Batch Move of all
 * took it, which the batch's history says, and "Finished 26 Nov" otherwise,
 * also where the history is not read yet or is the release before's, which
 * names no move (ADR-0025). Of the changes that took the batch from the
 * Location, a move of all from it or a finish there, the latest decides, so
 * a batch moved away, brought back and then finished reads "Finished".
 */
export function leftText(left: BeanBatch["finished"][number], versions: ItemVersion[] | undefined, now: Date = new Date()): string {
  const day = dayText(left.finishedAt, now);
  const move = movedAway(left, versions);
  return move ? `Moved to ${move.to?.name ?? "a Location since deleted"} ${day}` : `Finished ${day}`;
}

/**
 * The same, as a Recipe's page says it of its own Location after its batch's
 * roast day (#733): "moved to Riverside 26 Nov", or "finished here 26 Nov".
 */
export function leftHereText(left: BeanBatch["finished"][number], versions: ItemVersion[] | undefined, now: Date = new Date()): string {
  const day = dayText(left.finishedAt, now);
  const move = movedAway(left, versions);
  return move ? `moved to ${move.to?.name ?? "a Location since deleted"} ${day}` : `finished here ${day}`;
}

/** The Batch Move of all that took a batch from a Location it has left, where the latest change that took it from there was one; undefined where it was finished there, or its history says neither. */
function movedAway(left: BeanBatch["finished"][number], versions: ItemVersion[] | undefined): NonNullable<ItemVersion["move"]> | undefined {
  const took = (versions ?? [])
    .filter((version) => (version.move ? version.move.all && version.move.from?.id === left.location.id : version.location?.id === left.location.id && version.fields.atLocation === false))
    .reduce<ItemVersion | undefined>((latest, version) => (latest === undefined || version.receivedAt > latest.receivedAt ? version : latest), undefined);
  return took?.move ?? undefined;
}

/** What Batch Moves have brought to a Location and taken from it since its count started, an amount for each other Location, and one for any whose Location has been deleted since. */
export function movedText(moved: BatchAtLocation["moved"]): string[] {
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

/**
 * What a batch's count at a Location starts from, as the Location's list of
 * batches says it under the weight: "of 4180 g entered 25 Nov", or, for a
 * count that started with a Batch Move, "of 6000 g arrived 20 Nov", and
 * "No weight entered" where it is untracked there.
 */
export function startText(here: Pick<BatchAtLocation, "entered">, now: Date = new Date()): string {
  if (!here.entered) return "No weight entered";
  return `of ${grams(here.entered.weight)} ${here.entered.arrivedFrom ? "arrived" : "entered"} ${dayText(here.entered.at, now)}`;
}

/** What Batch Moves have brought to a Location and taken from it since a batch's count there started, as the Location's list says it; "Nothing moved" for none. */
export function movedLine(moved: BatchAtLocation["moved"]): string {
  const amounts = movedText(moved);
  return amounts.length === 0 ? "Nothing moved" : amounts.join(", ");
}
