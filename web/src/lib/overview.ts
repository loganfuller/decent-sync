import type { GroupedBy, Machine, Recipe, SummaryGroup } from "@/lib/api";
import { dateIn } from "./machine-activity";

// The Overview (#471; GLOSSARY.md) as the home page and each Location's page
// show it: the pure parts, which work out a period's days at a Location and
// put a Shot Summary grouped by Recipe and Machine into a block's rows and
// columns.

/** The periods the Overview offers, as its address names them, in the order it offers them. */
export const PERIODS = [
  { period: "today", label: "Today", pulled: "today" },
  { period: "yesterday", label: "Yesterday", pulled: "yesterday" },
  { period: "week", label: "Last 7 days", pulled: "in the last 7 days" },
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
 * in theirs, which is by name.
 */
export function overviewColumns(groups: readonly SummaryGroup[], machines: readonly Machine[], locationId: string): OverviewColumn[] {
  const columns: OverviewColumn[] = machines.filter((machine) => machine.location?.id === locationId).map((machine) => ({ id: machine.id, name: machine.name, machine, here: true }));
  for (const { by } of groups) {
    // A Shot credited to a Location is a Machine's: a Pending Machine's is at none.
    if (!by.machine || columns.some((column) => column.id === by.machine!.id)) continue;
    columns.push({ ...by.machine, machine: machines.find((machine) => machine.id === by.machine!.id), here: false });
  }
  return columns;
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
      row = { recipe, details, slot: details?.location?.id === locationId ? details.slot : null, cells: new Map() };
      rows.set(recipe?.id ?? null, row);
    }
    row.cells.set(machineId, group);
  }
  /** Slots first, in their order, then the rest as they came, the Shots with no Recipe last. */
  const tier = (row: OverviewRow) => (row.recipe === null ? 2 : row.slot === null ? 1 : 0);
  return [...rows.values()].sort((a, b) => tier(a) - tier(b) || (a.slot ?? 0) - (b.slot ?? 0));
}

/** The Shots list's filters for a cell: its Location, Machine, Recipe, or none, and the period's days, so the Shots it finds are the cell's. */
export function cellFilters(locationId: string, machineId: string, recipeId: string | null, days: { from: string; to: string }): string {
  return new URLSearchParams({ locationId, machineId, recipeId: recipeId ?? "none", from: days.from, to: days.to }).toString();
}
