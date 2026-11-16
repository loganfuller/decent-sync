import type { GroupSpec, GroupedBy, Machine, Recipe, ShotSpec, SummaryGroup, SummaryReference } from "@/lib/api";
import { dateIn } from "./machine-activity";
import { shotsText, signedText, yieldAgainstTargetText } from "./shot-summary";

// The Overview (#471, #543; GLOSSARY.md) as the home page and each
// Location's page show it: the pure parts, which work out a period's days at
// a Location, put a Shot Summary grouped by Recipe and Machine into a
// block's rows and columns, and word what the server judged out of spec.

/** The periods the Overview offers, as its address names them, in the order it offers them, each with the Shots list's date preset of the same days (`shots`). */
export const PERIODS = [
  { period: "today", label: "Today", pulled: "today", shots: "today" },
  { period: "yesterday", label: "Yesterday", pulled: "yesterday", shots: "yesterday" },
  { period: "week", label: "7 days", pulled: "in the last 7 days", shots: "7days" },
] as const;

export type Period = (typeof PERIODS)[number]["period"];

/** The period an address's `period` names: today where it names none, or one this build doesn't know. */
export function periodOf(param: string | null): Period {
  return PERIODS.find(({ period }) => period === param)?.period ?? "today";
}

/** The day `days` before a date, such as 2026-11-10, on the calendar. */
function daysBefore(date: string, days: number): string {
  return new Date(dayNumber(date)! - days * DAY).toISOString().slice(0, 10);
}

const DAY = 86_400_000;

/** A date's day, as UTC's midnight on it, for counting days between two: none where the text starts with no date. */
function dayNumber(date: string): number | undefined {
  const match = /^(\d{4})-(\d\d)-(\d\d)/.exec(date);
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : undefined;
}

/**
 * A period's days at a Location, by its time zone's wall clock now, as the
 * Shots list's `from` and `to` take them, each a whole day there: today,
 * yesterday, or the seven days that end with today. With `today`, which
 * days since a roast are counted to.
 */
export function periodDays(period: Period, timeZone: string, now = Date.now()): { from: string; to: string; today: string } {
  const today = dateIn(timeZone, now);
  if (period === "yesterday") return { from: daysBefore(today, 1), to: daysBefore(today, 1), today };
  return { from: period === "week" ? daysBefore(today, 6) : today, to: today, today };
}

/**
 * The whole days from a roast date, as Decaid recorded it, to `today`: none
 * where it has no date, or one after today.
 */
export function daysSinceRoast(roastDate: string | null, today: string): number | undefined {
  const roasted = roastDate === null ? undefined : dayNumber(roastDate);
  const now = dayNumber(today);
  if (roasted === undefined || now === undefined || roasted > now) return undefined;
  return Math.round((now - roasted) / DAY);
}

/** A column of a Location's block: a Machine that is there now, or that pulled Shots there in the period. */
export interface OverviewColumn {
  id: string;
  name: string;
  /** The Machine as the Machines page gives it; none for one its list doesn't hold, as one created since it was read. */
  machine: Machine | undefined;
  /** Whether it is at the Location now. */
  here: boolean;
}

/**
 * A block's columns: the Machines at the Location now, in the Machines
 * list's order, then any other whose Shots there the summary's groups hold,
 * by name, ignoring case, then by id, so they stay in their places whatever
 * Recipes the groups come to hold.
 */
export function overviewColumns(groups: readonly SummaryGroup[], machines: readonly Machine[], locationId: string): OverviewColumn[] {
  const here: OverviewColumn[] = machines.filter((machine) => machine.location?.id === locationId).map((machine) => ({ id: machine.id, name: machine.name, machine, here: true }));
  const others = new Map<string, OverviewColumn>();
  for (const { by } of groups) {
    // A Shot credited to a Location is a Machine's: a Pending Machine's is at none.
    if (!by.machine || others.has(by.machine.id) || here.some((column) => column.id === by.machine!.id)) continue;
    others.set(by.machine.id, { ...by.machine, machine: machines.find((machine) => machine.id === by.machine!.id), here: false });
  }
  const byName = (a: OverviewColumn, b: OverviewColumn) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id);
  return [...here, ...[...others.values()].sort(byName)];
}

/** A row of a Location's block: a Recipe pulled there in the period, or the Shots pulled with none. */
export interface OverviewRow {
  /** The Recipe as the summary names it, with the Location it belongs to; null for the Shots pulled with none. */
  recipe: NonNullable<GroupedBy["recipe"]> | null;
  /** The Recipe as the Library holds it now, for its Bean Batch; none until it is read. */
  details: Recipe | undefined;
  /** Its Recipe Slot at this Location; null for one in none, and for another Location's Recipe, whose slot is there. */
  slot: number | null;
  /** Each Machine's Shots of it, by the Machine's id. */
  cells: Map<string, SummaryGroup>;
  /** The Recipe's Reference Shot, as its groups give it: none for a Recipe with none, or from the previous release's answer. */
  reference: SummaryReference | undefined;
  /** The Recipe between its Machines, as its groups give it: none for the Shots pulled with no Recipe, or from the previous release's answer. */
  betweenMachines: GroupSpec["betweenMachines"];
}

/**
 * A block's rows, from a summary of the Location's Shots grouped by Recipe
 * and then Machine: its Recipes in Recipe Slots, in slot order; then its
 * Recipes in no slot and any Recipe of another Location, in the summary's
 * order, by name; then the Shots pulled with no Recipe. `recipes` are the
 * Recipes read for it, the Location's and the others the groups name.
 */
export function overviewRows(groups: readonly SummaryGroup[], recipes: readonly Recipe[], locationId: string): OverviewRow[] {
  const rows = new Map<string | null, OverviewRow>();
  for (const group of groups) {
    const recipe = group.by.recipe ?? null;
    const machineId = group.by.machine?.id;
    if (machineId === undefined) continue;
    let row = rows.get(recipe?.id ?? null);
    if (!row) {
      const details = recipe ? recipes.find((held) => held.id === recipe.id) : undefined;
      // Each group of a Recipe gives the same Reference Shot and the same judgement between its Machines.
      row = { recipe, details, slot: details?.location?.id === locationId ? details.slot : null, cells: new Map(), reference: group.reference, betweenMachines: group.spec?.betweenMachines };
      rows.set(recipe?.id ?? null, row);
    }
    row.cells.set(machineId, group);
  }
  /** Slots first, in their order, then the rest as they came, the Shots with no Recipe last. */
  const tier = (row: OverviewRow) => (row.recipe === null ? 2 : row.slot === null ? 1 : 0);
  return [...rows.values()].sort((a, b) => tier(a) - tier(b) || (a.slot ?? 0) - (b.slot ?? 0));
}

/**
 * The Shots list's filters for a cell: its Location, Machine, Recipe, or
 * none, and the period as the list's date preset of the same days, which
 * are that Location's own there too, so the Shots it finds are the cell's.
 */
export function cellFilters(locationId: string, machineId: string, recipeId: string | null, period: Period): string {
  return new URLSearchParams({ locationId, machineId, recipeId: recipeId ?? "none", period: PERIODS.find((each) => each.period === period)!.shots }).toString();
}

/** What a block's heading says its period's numbers cover: how many Shots, with the Unfinished Shots left out of them beside it. */
export function coveredText(groups: readonly SummaryGroup[], period: Period): string {
  const count = (of: (counts: SummaryGroup["counts"]) => number) => groups.reduce((sum, group) => sum + of(group.counts), 0);
  const shots = count((counts) => counts.shots);
  const unfinished = count((counts) => counts.unfinished);
  const pulled = PERIODS.find((each) => each.period === period)!.pulled;
  return `${shots === 0 ? "No Shots" : shotsText(shots)} ${pulled}${unfinished > 0 ? ` · ${unfinished} unfinished` : ""}`;
}

/**
 * A line of a cell, a row or a status card that says how far something is
 * from what it is measured against: `text` in full, `short` as a narrow
 * screen has room for, and whether it is marked, being out of spec, or
 * muted, being within spec or not judged.
 */
export interface SpecLine {
  text: string;
  short: string;
  marked: boolean;
}

/** Seconds to a tenth, with their sign. */
const secondsApart = (seconds: number) => `${signedText(seconds)} s`;

/**
 * What a cell says under its count and median duration (#543), from the
 * server's judgement of its Shots:
 * - `duration`, the median's difference from the Recipe's Reference Shot's,
 *   always, where there is one: marked when out of spec;
 * - `yield` and `stopping`, each only when out of spec, marked, or, for a
 *   cell too small to judge, when its few Shots are beyond the margin,
 *   muted;
 * - `leftOut`, the Unfinished Shots and the cleaning and calibration Shots
 *   its numbers leave out.
 * The previous release's answer during a deploy judges nothing (ADR-0025),
 * so its cells say only what they leave out.
 */
export function cellLines({ counts, numbers, spec }: SummaryGroup): { duration?: SpecLine; yield?: SpecLine; stopping?: SpecLine; leftOut: string[] } {
  const shown = (judged: GroupSpec["yield"] | undefined) => judged?.judgement === "outOfSpec" || (judged?.judgement === "notJudged" && judged.beyondMargin === true);
  const marked = (judged: GroupSpec["yield"]) => judged.judgement === "outOfSpec";
  const difference = spec?.duration?.difference;
  const against = numbers.yieldAgainstTarget && yieldAgainstTargetText(numbers.yieldAgainstTarget)?.median;
  const stops = numbers.stoppedAtTarget;
  return {
    ...(spec?.duration && difference != null && { duration: { text: `${secondsApart(difference)} vs reference`, short: secondsApart(difference), marked: marked(spec.duration) } }),
    ...(spec && shown(spec.yield) && against && { yield: { text: `${against} vs target`, short: against, marked: marked(spec.yield) } }),
    ...(spec &&
      shown(spec.stoppedAtTarget) &&
      stops && { stopping: { text: `${stops.atTarget} of ${stops.shots} stopped at target`, short: `${stops.atTarget} of ${stops.shots} at target`, marked: marked(spec.stoppedAtTarget) } }),
    leftOut: [
      ...(counts.unfinished > 0 ? [`${counts.unfinished} unfinished`] : []),
      ...(counts.cleaningAndCalibration > 0 ? [`${counts.cleaningAndCalibration} cleaning or calibration`] : []),
    ],
  };
}

/** How far apart a Recipe's Machines are, as its row says it: marked when out of spec between Machines; none where fewer than two Machines pulled it. */
export function betweenMachinesLine(between: GroupSpec["betweenMachines"]): SpecLine | undefined {
  if (!between || between.apart === null) return undefined;
  const text = `${between.apart.toFixed(1)} s apart`;
  return { text, short: text, marked: between.judgement === "outOfSpec" };
}

/**
 * What of a Machine's last Shot is out of spec, as its status card marks it:
 * its duration against its Recipe's Reference Shot's, and its yield against
 * its own target, each only when out of spec.
 */
export function lastShotMarks(spec: ShotSpec | undefined): string[] {
  return [
    ...(spec?.duration?.outOfSpec ? [`${secondsApart(spec.duration.difference)} vs reference`] : []),
    ...(spec?.yield?.outOfSpec ? [`${signedText(spec.yield.againstTarget)} g vs target`] : []),
  ];
}

/**
 * How a Machine that is offline reads (#543): `asleep` where its last
 * Machine State was asleep, which is where a Machine left for the night
 * ends up, and reads muted; `awake` where it went offline doing anything
 * else, which is marked; and `never` where no plugin has ever connected
 * with its token, which is nothing to mark.
 */
export function offlineKind(machine: Pick<Machine, "lastSeenAt" | "machineState">): "asleep" | "awake" | "never" {
  if (machine.lastSeenAt === null) return "never";
  return machine.machineState?.state === "sleeping" ? "asleep" : "awake";
}
