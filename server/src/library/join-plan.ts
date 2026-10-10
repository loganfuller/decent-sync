import { WORKFLOW_BATCH, WORKFLOW_GRINDER, sameValue } from "@decent-sync/protocol";
import { isObject } from "./listed.js";

// The plan a Machine's tablet follows when it joins a Location (ADR-0008):
// when a report is part of joining, and which of its Workflow's grinder and
// batch are cleared, as the Location does not offer them. What the Library
// leaves out of what it holds is decided by left-out.ts, and what it is
// written of the Location's Library and settings is planned as for any
// tablet there (holdings.ts, settings-intake.ts), the Location's state
// winning. Pure, so module tests can drive it; joining.ts reads what it
// needs.

/**
 * An entry of a Machine's Location History, current as a report is taken
 * in: its id and its Location, and when an Admin last turned the Machine's
 * sharing back on, null if never.
 */
export interface CurrentEntry {
  id: string;
  locationId: string;
  sharingSince: Date | null;
}

/**
 * Whether a report taken in under `current` is part of the tablet joining
 * its Location: the first of its kind the tablet has had taken in, or the
 * first since its Machine's Location changed, as on a move, or as when an
 * Admin corrects the current entry's Location or removes it; or since its
 * sharing was turned back on; or since a newer entry replaced the one it was
 * last taken in under (`lastRemains`), as when the Machine moved away and
 * back. A corrected time of a move changes none of them, nor does removing
 * a move made by mistake, after which the Machine never left: so neither
 * changes anything on the tablet.
 */
export function joins(last: CurrentEntry | null, current: CurrentEntry, lastRemains: boolean): boolean {
  if (last === null || last.locationId !== current.locationId || !sameSharing(last, current)) return true;
  return last.id !== current.id && lastRemains;
}

/** Whether two entries were current with the Machine's sharing last turned back on at the same time, or neither since it was ever turned off. */
export function sameSharing(a: CurrentEntry, b: CurrentEntry): boolean {
  return (a.sharingSince?.getTime() ?? null) === (b.sharingSince?.getTime() ?? null);
}

/**
 * Where a tablet's reports are taken in, as its writer compares them with
 * where its Machine takes part now: the Location, and when the Machine's
 * sharing was last turned back on. A report taken in before sharing was
 * turned off and on again is not where the Machine takes part now, so the
 * tablet is asked for its reports afresh, and joins again.
 */
export function standing(entry: CurrentEntry): string {
  return entry.sharingSince === null ? entry.locationId : `${entry.locationId}@${entry.sharingSince.toISOString()}`;
}

/** Whether the Location offers an item a tablet's Workflow names, by its map; unknown if the map holds no such record. */
export type Offered = "offered" | "notOffered" | "unknown";

/**
 * The fields of a joining tablet's Workflow to clear (WORKFLOW_GRINDER,
 * WORKFLOW_BATCH), each with the value it holds now, which the plugin
 * expects to find: its grinder's if its Location does not offer the Grinder
 * its `context.grinderId` names, and its batch's if it does not offer that
 * batch. Its profile, dose and yield stay, and so does a grinder or batch it
 * offers, or that is unknown, as one the tablet's map does not hold that
 * joins the Library at a Location offering none of its kind yet, with this
 * report or the next. Null if nothing is to be cleared.
 */
export function workflowClear(context: unknown, grinder: Offered, batch: Offered): Record<string, unknown> | null {
  if (!isObject(context)) return null;
  const expected: Record<string, unknown> = {};
  const clear = (fields: readonly string[]) => {
    for (const field of fields) expected[field] = valueAt(context, field);
  };
  if (typeof context.grinderId === "string" && grinder === "notOffered") clear(WORKFLOW_GRINDER);
  if (typeof context.beanBatchId === "string" && batch === "notOffered") clear(WORKFLOW_BATCH);
  return Object.keys(expected).length === 0 ? null : expected;
}

/**
 * What of a clear still due the tablet's Workflow still holds: the grinder
 * while its `context.grinderId` is still the one expected, and the batch
 * while its `context.beanBatchId` is, each field expecting what the
 * Workflow holds now, as a skin may relabel the same grinder. One a barista
 * changed since, as by picking another grinder, or that a write cleared, is
 * no longer due, whatever its other fields hold, as another grinder may be
 * of the same model. Null if neither is. The plugin judges a group by its id
 * alike.
 */
export function clearStillDue(expected: Readonly<Record<string, unknown>>, context: unknown): Record<string, unknown> | null {
  const held = isObject(context) ? context : {};
  const due: Record<string, unknown> = {};
  for (const fields of [WORKFLOW_GRINDER, WORKFLOW_BATCH]) {
    const [id] = fields;
    if (!(id in expected) || expected[id] === null || !sameValue(valueAt(held, id), expected[id])) continue;
    for (const field of fields) if (field in expected) due[field] = valueAt(held, field);
  }
  return Object.keys(due).length === 0 ? null : due;
}

/** The value a Workflow's `context` holds for a field named as WORKFLOW_GRINDER names it, such as `context.grinderId`; null for none. */
function valueAt(context: Record<string, unknown>, field: string): unknown {
  return context[field.slice("context.".length)] ?? null;
}
