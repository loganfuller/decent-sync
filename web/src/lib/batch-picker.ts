import { type NamedBatch, batchWords } from "./batch-name";

// The batch picker (#733) as the Recipe form, the copy dialog, the Change
// batch dialog and the Shots list's Bean Batch filter use it: the pure
// parts, which say what an option is, which options the words typed find,
// and how an option reads in the field and to a screen reader. The component
// that draws it is components/batch-picker.tsx.

/** A batch as the picker names and finds it: what names one, with its Bean's roaster, which the words typed are looked for in too. */
export interface PickedBatch extends NamedBatch {
  bean: { name: string | null; roaster?: string | null };
}

/**
 * An option of the picker: a batch, drawn in two lines, its Bean and its
 * Batch Code over its roast day, or an entry that is no batch, such as "No
 * batch", drawn as its `label`. `note` follows a batch's roast day on its
 * second line, such as "this Recipe's batch now" or "at Riverside", and
 * `weight` is what stands at its right, such as "3240 g here".
 */
export interface BatchOption {
  /** What choosing it sets the field to: a batch's id, or what stands for an entry that is no batch. */
  value: string;
  batch?: PickedBatch;
  label?: string;
  note?: string;
  weight?: string;
}

/** Options under a heading, such as "At Downtown", or under none. */
export interface BatchOptionGroup {
  label?: string;
  options: BatchOption[];
}

/**
 * Whether a batch matches the words typed, as the list of batches searches:
 * each word in its Bean's name, its roaster or its Batch Code, ignoring
 * case. No word typed matches every batch.
 */
export function batchMatches(batch: { bean: { name: string | null; roaster?: string | null }; batchCode?: string | null }, search: string): boolean {
  const text = [batch.bean.name, batch.bean.roaster, batch.batchCode].filter((part) => part != null).join(" ").toLowerCase();
  return search.toLowerCase().split(/\s+/).every((word) => text.includes(word));
}

/**
 * The groups as the words typed leave them: each batch that matches, and
 * every entry that is no batch, which no word hides, so "No batch" stays in
 * reach. A group left with no option is left out.
 */
export function matchingGroups(groups: readonly BatchOptionGroup[], search: string): BatchOptionGroup[] {
  return groups.map((group) => ({ ...group, options: group.options.filter((option) => !option.batch || batchMatches(option.batch, search)) })).filter((group) => group.options.length > 0);
}

/** How many batches the groups hold, the entries that are no batch left out. */
export function batchCount(groups: readonly BatchOptionGroup[]): number {
  return groups.reduce((count, group) => count + group.options.filter((option) => option.batch).length, 0);
}

/**
 * The option the arrows and Enter are on: the one the arrows moved to; else,
 * while words are typed, the first batch they find, since an entry that is
 * no batch is never hidden, and the one chosen would keep Enter on "No
 * batch" with a match above it; else the one chosen; else the first.
 */
export function activeOption(options: readonly BatchOption[], active: string | undefined, value: string, search: string): BatchOption | undefined {
  const moved = options.find((option) => option.value === active);
  if (moved) return moved;
  const found = search.trim() === "" ? undefined : options.find((option) => option.batch);
  return found ?? options.find((option) => option.value === value) ?? options[0];
}

/** An option as the field reads while it is the one chosen: the batch in words, with its note, or the entry's label. */
export function optionText(option: BatchOption, now: Date = new Date()): string {
  if (!option.batch) return option.label ?? "";
  return `${batchWords(option.batch, now)}${option.note === undefined ? "" : ` (${option.note})`}`;
}

/** An option as a screen reader names it: the batch in words, then its note and its weight, or the entry's label. */
export function optionName(option: BatchOption, now: Date = new Date()): string {
  if (!option.batch) return option.label ?? "";
  return [batchWords(option.batch, now), option.note, option.weight].filter((part) => part !== undefined).join(", ");
}

/** Orders batches the latest roasted first, one with no roast date after those with one, then the latest to join the Library first. */
export function latestRoastedFirst(a: { roastDate: string | null; createdAt?: string }, b: { roastDate: string | null; createdAt?: string }): number {
  const [roastedA, roastedB] = [a.roastDate?.slice(0, 10) ?? "", b.roastDate?.slice(0, 10) ?? ""];
  if (roastedA !== roastedB) return roastedA < roastedB ? 1 : -1;
  const [joinedA, joinedB] = [a.createdAt ?? "", b.createdAt ?? ""];
  return joinedA === joinedB ? 0 : joinedA < joinedB ? 1 : -1;
}
