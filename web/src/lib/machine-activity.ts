import type { LocationHistoryEntry, TrailEntry, WorkflowSummary } from "@/lib/api";

// A Machine's activity (#476) as its page lists it: the pure parts, which
// work out the day shown and how a time reads under it, and put a dial-in
// trail's entries into words.

/** The kinds of a Machine's activity, as the REST API names them, in the order the page offers them. */
export const ACTIVITY_KINDS = [
  { kind: "workflowChanges", label: "Dial-in trail" },
  { kind: "loadedRecipes", label: "Loaded Recipes" },
  { kind: "machineStates", label: "Machine States" },
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number]["kind"];

/**
 * The date, such as 2026-11-10, a moment has on the wall clock of a time
 * zone, UTC's for none or for one this browser doesn't know. Now, at the
 * Location a Machine is at, it is the day its activity is listed for until
 * another is chosen.
 */
export function dateIn(timeZone: string | undefined, at = Date.now()): string {
  const parts = (zone: string) => new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  let read: Intl.DateTimeFormatPart[];
  try {
    read = parts(timeZone ?? "UTC");
  } catch {
    read = parts("UTC");
  }
  const part = (type: Intl.DateTimeFormatPartTypes) => read.find((found) => found.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * The time zone of the Location the Machine was at, at a moment, by its
 * Location History, oldest first, and UTC before its first: the zone the
 * server reads its days in, so a time is shown in the day it is listed under.
 */
export function timeZoneAt(history: readonly Pick<LocationHistoryEntry, "effectiveFrom" | "location">[], at: string): string {
  const moment = Date.parse(at);
  let found = "UTC";
  for (const entry of history) {
    if (Date.parse(entry.effectiveFrom) > moment) break;
    found = entry.location.timeZone;
  }
  return found;
}

const TIMES = new Map<string, Intl.DateTimeFormat>();

/**
 * A time as a list shows it under the day chosen: on the wall clock of the
 * Location the Machine was at then, to the second, with that zone's
 * abbreviation, such as "8:30:05 AM MST". One of another day there, as what
 * was in effect as the day began is, has its date too, such as
 * "Nov 9, 2026, 9:00:00 PM MST".
 */
export function whenText(at: string, day: string, history: readonly Pick<LocationHistoryEntry, "effectiveFrom" | "location">[]): string {
  const timeZone = timeZoneAt(history, at);
  const dated = dateIn(timeZone, Date.parse(at)) !== day;
  const key = `${timeZone} ${dated}`;
  let format = TIMES.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(undefined, {
      timeZone,
      ...(dated && { year: "numeric", month: "short", day: "numeric" }),
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    });
    TIMES.set(key, format);
  }
  return format.format(new Date(at));
}

/**
 * What each kind of entry of a dial-in trail is, in words. The Workflow in
 * effect is the one the day began with, or the first of the day where its
 * tablet had reported none by then, so it isn't said to be either.
 */
export const TRAIL_KINDS: Record<TrailEntry["kind"], string> = {
  inEffect: "Workflow in effect",
  loaded: "Recipe loaded",
  unloaded: "Recipe unloaded",
  recipeUpdated: "Recipe updated",
  changed: "Changed",
};

/** What Decent Sync's own writes into a Workflow are, in words. */
const PLUGIN_WRITES: Record<string, string> = {
  load: "Decent Sync, loading the Recipe",
  loadedRecipe: "Decent Sync, from an edit made elsewhere",
  clear: "Decent Sync, clearing what it unloaded or the Location doesn't offer",
  steamOn: "Decent Sync, turning steam back on",
};

/**
 * Who made an entry's first change: Decent Sync, with which of its writes it
 * was; the tablet, for anyone else, a barista on its skin, the skin itself
 * and DYE2 alike, which can't be told apart; or nobody recorded.
 */
export function madeBy({ cause, pluginWrite }: Pick<TrailEntry, "cause" | "pluginWrite">): string {
  if (cause === "plugin") return (pluginWrite !== null && PLUGIN_WRITES[pluginWrite]) || "Decent Sync";
  return cause === "other" ? "The tablet" : "Not recorded";
}

/** A value of a line of a trail entry: its text, and the page of the Library item it names, if any. */
export interface TrailValue {
  text: string;
  to?: string;
}

/** A line of a trail entry: a field that changed, from what to what, or for the Workflow in effect, a field it held. */
export interface TrailLine {
  label: string;
  /** What it was before; none for a field of the Workflow in effect. */
  before?: TrailValue;
  after: TrailValue;
}

/** The fields of a Workflow's summary the page names, in the order it lists the Workflow in effect, each with its unit, if any. */
const FIELDS: Record<string, { label: string; unit?: string }> = {
  recipe: { label: "Recipe" },
  profile: { label: "Profile" },
  brewTemperature: { label: "Brew temperature", unit: "°C" },
  dose: { label: "Dose", unit: "g" },
  yield: { label: "Yield", unit: "g" },
  bean: { label: "Bean" },
  roaster: { label: "Roaster" },
  grinder: { label: "Grinder" },
  burrs: { label: "Burrs" },
  grindSetting: { label: "Grind setting" },
  basket: { label: "Basket" },
  barista: { label: "Barista" },
  "steam.temperature": { label: "Steam temperature", unit: "°C" },
  "steam.duration": { label: "Steam time", unit: "s" },
  "steam.flow": { label: "Steam flow", unit: "ml/s" },
  "hotWater.temperature": { label: "Hot water temperature", unit: "°C" },
  "hotWater.volume": { label: "Hot water volume", unit: "ml" },
  "flush.temperature": { label: "Flush temperature", unit: "°C" },
  "flush.duration": { label: "Flush time", unit: "s" },
};

/** The Library items a summary names: the field naming each, the field holding its id, what it is, and its page. */
const LINKS = [
  { name: "recipe", id: "recipeId", label: "Recipe", path: "/library/recipes/" },
  { name: "profile", id: "profileId", label: "Profile", path: "/library/profiles/" },
  { name: "bean", id: "beanBatchId", label: "Bean Batch", path: "/library/bean-batches/" },
  { name: "grinder", id: "grinderId", label: "Grinder", path: "/library/grinders/" },
  { name: "basket", id: "basketId", label: "Basket", path: "/library/baskets/" },
] as const;

type FieldValue = string | number | null;

/** A field's value in words, with its unit; none as "None". */
function valueText(field: string, value: FieldValue): string {
  if (value === null) return "None";
  const unit = FIELDS[field]?.unit;
  return unit === undefined ? String(value) : `${value} ${unit}`;
}

/** The page of the Library item an id names, of the kind its field holds. */
function pageOf(link: (typeof LINKS)[number], id: FieldValue): string | undefined {
  return typeof id === "string" ? `${link.path}${encodeURIComponent(id)}` : undefined;
}

/** A Library item a Workflow named, by the name it recorded, linked to its page where it named one; one it named with no name by its kind. */
function named(link: (typeof LINKS)[number], name: FieldValue, id: FieldValue): TrailValue {
  const to = pageOf(link, id);
  return { text: name === null && to !== undefined ? `Unnamed ${link.label}` : valueText(link.name, name), to };
}

/**
 * A trail entry's lines. For the Workflow in effect, each field it held, in
 * the page's order, the Library items it names linked. For any other, each
 * field that changed, in the order first changed, from what to what, a
 * field the page doesn't know by its name in the summary:
 *
 * - an item named anew, as a Profile switched, is one line, each side
 *   linked to its Library item where the Workflow named one;
 * - an item changed with its name unchanged, as the next batch of the same
 *   Bean, is one line naming its kind, each side linked, as "the previous
 *   one" and "the new one", for an entry gives only what changed.
 */
export function trailLines(entry: Pick<TrailEntry, "workflow" | "changes">): TrailLine[] {
  if (entry.workflow) return summaryLines(entry.workflow);
  const changed = new Map(entry.changes.map((change) => [change.field, change]));
  return entry.changes.flatMap(({ field, before, after }): TrailLine[] => {
    const link = LINKS.find((found) => found.name === field);
    if (link) {
      // Its id, where that changed too; where it didn't, the entry doesn't give it.
      const ids = changed.get(link.id);
      return [{ label: FIELDS[field]!.label, before: named(link, before, ids?.before ?? null), after: named(link, after, ids?.after ?? null) }];
    }
    const held = LINKS.find((link) => link.id === field);
    if (held) {
      // With its name, it is that line's links.
      if (changed.has(held.name)) return [];
      const side = (id: FieldValue, text: string): TrailValue => (id === null ? { text: "None" } : { text, to: pageOf(held, id) });
      return [{ label: held.label, before: side(before, "The previous one"), after: side(after, "The new one") }];
    }
    return [{ label: FIELDS[field]?.label ?? field, before: { text: valueText(field, before) }, after: { text: valueText(field, after) } }];
  });
}

/** A Workflow's summary as lines: each field the page names that it holds, the Library items it names linked. */
function summaryLines(summary: WorkflowSummary): TrailLine[] {
  const fields = new Map<string, FieldValue>();
  for (const [name, value] of Object.entries(summary) as [string, FieldValue | Record<string, FieldValue>][]) {
    if (value !== null && typeof value === "object") for (const [part, held] of Object.entries(value)) fields.set(`${name}.${part}`, held);
    else fields.set(name, value);
  }
  return Object.entries(FIELDS).flatMap(([field, { label }]): TrailLine[] => {
    const value = fields.get(field) ?? null;
    const link = LINKS.find((found) => found.name === field);
    const id = link ? (fields.get(link.id) ?? null) : null;
    if (value === null && id === null) return [];
    return [{ label, after: link ? named(link, value, id) : { text: valueText(field, value) } }];
  });
}
