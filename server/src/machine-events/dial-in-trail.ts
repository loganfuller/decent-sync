import type { PluginWorkflowWrite } from "@decent-sync/protocol";
import type { WorkflowSummary } from "./workflow-summary.js";

// A Machine's Workflow changes over a time range as a dial-in trail (#436),
// as an assistant reads them: one list in time order of the Recipes loaded
// and unloaded and of what changed between them, each change of the Workflow
// given as the fields of its summary (workflow-summary.ts) that changed,
// before and after, with Recipe sync's own writes folded away. It answers
// "what did the Barista change this morning?" without comparing whole
// Workflows by hand. It only reshapes what the REST API gives, the Workflow
// changes with who made each (#434) and the Loaded Recipes, which keep their
// own raw lists.
//
// A Recipe applied on Streamline's strip is two changes about 2 s apart, the
// strip's and the plugin's write of what the strip leaves out (`load`); a
// profile switch on Streamline unloads it in one change, which Streamline
// follows with the steam time it saved for that profile. So, in time order,
// a load or unload before a Workflow change at the same moment, then by
// stored id:
//
// - a load or unload takes the first change within 5 s after it, that which
//   loaded or unloaded it, and then, within those 5 s, a load the plugin's
//   load writes, and an unload changes of the same cause as that first; a
//   Recipe loaded as another unloads, at one moment, is one load entry,
//   naming the one it replaced;
// - other changes of the same cause, the plugin's write included, one
//   within 5 s of the one before it, merge, a group spanning at most 30 s,
//   and never across a load or unload; the plugin's write of an edit of the
//   Loaded Recipe made elsewhere (`loadedRecipe`) is that Recipe updated,
//   whose own history says who changed it;
// - changes stored before Decent Sync recorded who made them (`unknown`)
//   merge by the 5 s window alone, as of one cause, and a load whose first
//   change is `unknown` takes the other `unknown` changes in its 5 s, as its
//   load write may be stored so too, as well as the plugin's load writes;
// - an entry left with no field changed is dropped, but for a load or unload,
//   which is a change in itself.
//
// The trail's oldest entry is the Workflow in effect as the range began,
// whole: the latest observed at or before its start, or the first observed
// in it where none was. It is grouped whole before any page of it is taken,
// so its pages and its total stay as they are.

/** How close a change is to the one before it, or to a load or unload, to merge with it or fold into it. */
export const MERGE_WITHIN_MS = 5_000;

/** The longest a group of merged changes spans, from its first change to its last. */
export const LONGEST_GROUP_MS = 30_000;

/** Who made a Workflow change, as the REST API gives it (`WorkflowEventView.cause`). */
export type ChangeCause = "plugin" | "other" | "unknown";

/** A Workflow change, as the trail reads it: its stored id, time and cause, and its Workflow summarised. */
export interface TrailChange {
  id: bigint;
  observedAt: Date;
  cause: ChangeCause;
  pluginWrite: PluginWorkflowWrite | null;
  summary: WorkflowSummary;
}

/** A Recipe as the trail names it. */
export interface TrailRecipe {
  id: string;
  name: string | null;
}

/** A Recipe's load onto the Machine or unload from it, as its entry in `loaded_recipes` records it, by that entry's id. */
export interface RecipeEvent {
  kind: "loaded" | "unloaded";
  id: bigint;
  at: Date;
  recipe: TrailRecipe;
}

/** A field of the summary that changed, by its name in the summary, a part's as `steam.duration`. */
export interface FieldChange {
  field: string;
  before: string | number | null;
  after: string | number | null;
}

/** What the trail's entries are. */
export type TrailKind = "inEffect" | "loaded" | "unloaded" | "recipeUpdated" | "changed";

/** An entry of the trail. */
export interface TrailEntry {
  kind: TrailKind;
  /** When it began: a load's or unload's time, or its first change's. */
  observedAt: string;
  /** When it took a change after the moment it began, the last one's time; otherwise null. */
  lastObservedAt: string | null;
  /** Who made its first change; `unknown` for a load or unload no change came within 5 s of. */
  cause: ChangeCause;
  pluginWrite: PluginWorkflowWrite | null;
  /** The Recipe loaded, unloaded or updated; for any other entry, the Machine's Loaded Recipe then, or null. */
  loadedRecipe: TrailRecipe | null;
  /** For a load, the Recipe unloaded as it loaded; otherwise null. */
  replaced: TrailRecipe | null;
  /** For the Workflow in effect as the range began, its summary, whole; otherwise null. */
  workflow: WorkflowSummary | null;
  /** For any other, each field that changed, before and after. */
  changes: FieldChange[];
}

/** What the trail is made from. */
export interface TrailInput {
  /** The Workflow in effect as the range began, the latest at or before its start, or the first in it. */
  baseline: TrailChange;
  /** The Workflow changes after it in the range, in time order, then by stored id. */
  changes: readonly TrailChange[];
  /** The loads and unloads after the baseline began, or after the range's start, whichever is later, in the range. */
  recipeEvents: readonly RecipeEvent[];
  /** The Machine's Loaded Recipe as the trail begins, then, or null. */
  loadedAtStart: TrailRecipe | null;
}

/** The dial-in trail, oldest first. */
export function dialInTrail({ baseline, changes, recipeEvents, loadedAtStart }: TrailInput): TrailEntry[] {
  type Item = { at: number; order: 0 | 1; id: bigint; event?: RecipeEvent; change?: TrailChange };
  const timeline: Item[] = [
    ...recipeEvents.map((event): Item => ({ at: event.at.getTime(), order: 0, id: event.id, event })),
    ...changes.map((change): Item => ({ at: change.observedAt.getTime(), order: 1, id: change.id, change })),
  ].sort((a, b) => a.at - b.at || a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const first = new Group("inEffect", baseline.observedAt.getTime(), loadedAtStart);
  first.take(baseline);
  first.workflow = baseline.summary;
  const groups = [first];
  let state = fieldsOf(baseline.summary);
  let loaded = loadedAtStart;
  /** The latest load or unload, which folds changes in the 5 s after it. */
  let recipeGroup: Group | null = null;
  /** The latest group of other changes, which a change of its cause merges into. */
  let burst: Group | null = null;

  for (const { at, event, change } of timeline) {
    if (event) {
      burst = null;
      if (event.kind === "loaded" && recipeGroup?.kind === "unloaded" && recipeGroup.at === at && recipeGroup.count === 0) {
        // Loaded as another unloads, as when another Recipe is applied: one entry.
        recipeGroup.kind = "loaded";
        recipeGroup.replaced = recipeGroup.loadedRecipe;
        recipeGroup.loadedRecipe = event.recipe;
      } else {
        recipeGroup = new Group(event.kind, at, event.recipe);
        groups.push(recipeGroup);
      }
      if (event.kind === "loaded") loaded = event.recipe;
      else if (loaded?.id === event.recipe.id) loaded = null;
      continue;
    }
    const taken = change!;
    const key = causeKey(taken);
    let group: Group;
    // A load takes the plugin's load writes after its first change, and after an unknown one, as stored before #434 or by
    // the previous release beside this one, the other unknown changes too, as its load write may be.
    const folds = (into: Group) => key === into.folds || (into.kind === "loaded" && key === "plugin:load");
    if (recipeGroup && at - recipeGroup.at <= MERGE_WITHIN_MS && (recipeGroup.count === 0 || folds(recipeGroup))) {
      group = recipeGroup;
      if (group.count === 0) group.folds = group.kind === "loaded" && key !== "unknown" ? "plugin:load" : key;
    } else if (burst && key === burst.folds && at - burst.last <= MERGE_WITHIN_MS && at - burst.at <= LONGEST_GROUP_MS) {
      group = burst;
    } else {
      burst = new Group(key === "plugin:loadedRecipe" ? "recipeUpdated" : "changed", at, loaded);
      burst.folds = key;
      groups.push(burst);
      group = burst;
    }
    const after = fieldsOf(taken.summary);
    group.take(taken, state, after);
    state = after;
  }
  return groups.flatMap((group) => group.entry() ?? []);
}

/** A change's cause, with the plugin's write, as changes of one cause merge. */
function causeKey(change: TrailChange): string {
  return change.cause === "plugin" ? `plugin:${change.pluginWrite ?? ""}` : change.cause;
}

/** An entry of the trail as it is made: the changes folded or merged into it so far. */
class Group {
  /** The cause of the changes it takes after its first. */
  folds = "";
  count = 0;
  last: number;
  cause: ChangeCause = "unknown";
  pluginWrite: PluginWorkflowWrite | null = null;
  replaced: TrailRecipe | null = null;
  workflow: WorkflowSummary | null = null;
  /** Each field changed, in the order first changed, as before its first change and after its last. */
  private readonly fields = new Map<string, { before: FieldValue; after: FieldValue }>();

  constructor(
    public kind: TrailKind,
    public readonly at: number,
    public loadedRecipe: TrailRecipe | null,
  ) {
    this.last = at;
  }

  /** Takes a change, from the Workflow's fields before it, if given, to those after it. */
  take(change: TrailChange, before?: Fields, after?: Fields): void {
    if (this.count === 0) [this.cause, this.pluginWrite] = [change.cause, change.pluginWrite];
    this.count++;
    this.last = Math.max(this.last, change.observedAt.getTime());
    if (!before || !after) return;
    for (const [field, value] of after) {
      const was = before.get(field) ?? null;
      if (was === value) continue;
      const held = this.fields.get(field);
      if (held) held.after = value;
      else this.fields.set(field, { before: was, after: value });
    }
  }

  /** Its entry, or null for one that changed nothing in the end but a load or unload, which is a change in itself. */
  entry(): TrailEntry | null {
    const changes = [...this.fields].filter(([, { before, after }]) => before !== after).map(([field, values]) => ({ field, ...values }));
    if (changes.length === 0 && (this.kind === "changed" || this.kind === "recipeUpdated")) return null;
    return {
      kind: this.kind,
      observedAt: new Date(this.at).toISOString(),
      lastObservedAt: this.last !== this.at ? new Date(this.last).toISOString() : null,
      cause: this.cause,
      pluginWrite: this.pluginWrite,
      loadedRecipe: this.loadedRecipe,
      replaced: this.replaced,
      workflow: this.workflow,
      changes,
    };
  }
}

type FieldValue = string | number | null;
type Fields = Map<string, FieldValue>;

/** A summary's fields, a part's by its name and the part's, as `steam.duration`; a part the Workflow has none of as its fields all null. */
function fieldsOf(summary: WorkflowSummary): Fields {
  const fields: Fields = new Map();
  for (const [name, value] of Object.entries(summary) as [keyof WorkflowSummary, unknown][]) {
    if (value !== null && typeof value === "object") {
      for (const [part, held] of Object.entries(value)) fields.set(`${name}.${part}`, held as FieldValue);
    } else if (PARTS[name]) {
      for (const part of PARTS[name]) fields.set(`${name}.${part}`, null);
    } else fields.set(name, value as FieldValue);
  }
  return fields;
}

/** The summary's parts and their fields, which a Workflow without the part gives as null. */
const PARTS: Partial<Record<keyof WorkflowSummary, readonly string[]>> = {
  steam: ["temperature", "duration", "flow"],
  hotWater: ["temperature", "volume"],
  flush: ["temperature", "duration"],
};
