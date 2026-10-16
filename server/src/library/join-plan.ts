import { WORKFLOW_BASKET, WORKFLOW_BATCH, WORKFLOW_CLEARED, WORKFLOW_GRINDER, sameValue, workflowValueAt } from "@decent-sync/protocol";
import { isObject } from "./listed.js";

// The plan a Machine's tablet follows when it joins a Location (ADR-0008):
// when a report is part of joining, what it does with the tablet's records
// of Recipes, Baskets and Tools, and which of its Workflow's grinder, batch
// and Basket are cleared, as the Location does not offer them. What the
// Library leaves out of what it holds is kept by left-out.ts, and what it is
// written of the Location's Library is planned as for any tablet there
// (holdings.ts), the Location's state winning. Pure, so module tests can drive it; joining.ts reads what it
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

/**
 * How the intake of a tablet's DYE2 list plans one of its records it holds
 * (`planRecipeIntake`, `planEquipmentIntake`): a record of an item the map
 * holds, changed (`update`), or a record of a Library item by the global id
 * it carries, or of another Location's Recipe (`map`); a Basket or Tool the
 * map does not hold whose name matches a Library item's (`link`); a recipe
 * the map does not hold saved in a slot of the Location's Recipe (`edit`);
 * and a new one (`add`).
 */
export type PlannedRecord = "map" | "update" | "link" | "edit" | "add";

/**
 * What a report that is part of joining does with one of the tablet's
 * records of Recipes, Baskets or Tools (ADR-0018). A record of an item the
 * Library has is that item, and is written the Location's state, nothing of
 * it taken in: removed if the Location does not offer it, as another
 * Location's Recipe or a Basket it does not show (`theItem`); but a Basket or
 * Tool matched by name, at a Location that shows none of the kind yet, is
 * shown there (`shown`). Every other record, the tablet's own, is left out,
 * removed from DYE2's list and not kept (`leftOut`), unless the Location has
 * none of the kind yet (`bringing`): a Location with no Recipes in its slots
 * takes the tablet's in their slots, and one that shows no Basket, or no
 * Tool, takes the tablet's own and shows them (`brought`). A recipe saved in
 * a slot the Location fills is its own, never that Recipe's.
 */
export function joiningRecord(step: PlannedRecord, bringing: boolean): "theItem" | "shown" | "leftOut" | "brought" {
  if (step === "add") return bringing ? "brought" : "leftOut";
  if (step === "edit") return "leftOut";
  return step === "link" && bringing ? "shown" : "theItem";
}

/** Whether the Location offers an item a tablet's Workflow names, by its map; unknown if the map holds no such record. */
export type Offered = "offered" | "notOffered" | "unknown";

/** Whether the Location offers the grinder, batch and Basket a joining tablet's Workflow names. */
export interface WorkflowOffers {
  grinder: Offered;
  batch: Offered;
  basket: Offered;
}

/**
 * The fields of a joining tablet's Workflow to clear (WORKFLOW_CLEARED), by
 * their paths, each with the value it holds now, which the plugin expects to
 * find: its grinder's if its Location does not offer the Grinder its
 * `context.grinderId` names, its batch's if it does not offer that batch,
 * and its Basket's if it does not show the Basket its
 * `context.extras.basketId` names. Its profile, dose, yield and hot water
 * stay, and so does a grinder, batch or Basket it offers, or that is
 * unknown, as one the tablet's map does not hold that joins the Library at a
 * Location offering none of its kind yet, with this report or the next.
 * Null if nothing is to be cleared.
 */
export function workflowClear(context: unknown, offers: WorkflowOffers): Record<string, unknown> | null {
  if (!isObject(context)) return null;
  const expected: Record<string, unknown> = {};
  for (const [fields, offer] of [
    [WORKFLOW_GRINDER, offers.grinder],
    [WORKFLOW_BATCH, offers.batch],
    [WORKFLOW_BASKET, offers.basket],
  ] as const) {
    if (offer !== "notOffered" || typeof valueAt(context, fields[0]) !== "string") continue;
    for (const field of fields) expected[field] = valueAt(context, field);
  }
  return Object.keys(expected).length === 0 ? null : expected;
}

/**
 * What of a clear still due the tablet's Workflow still holds: the grinder
 * while its `context.grinderId` is still the one expected, the batch while
 * its `context.beanBatchId` is, and the Basket while its
 * `context.extras.basketId` is, each field expecting what the Workflow holds
 * now, as a skin may relabel the same grinder. One a barista changed since,
 * as by picking another grinder, or that a write cleared, is no longer due,
 * whatever its other fields hold, as another grinder may be of the same
 * model. Null if none is. The plugin judges a group by its id alike.
 */
export function clearStillDue(expected: Readonly<Record<string, unknown>>, context: unknown): Record<string, unknown> | null {
  const held = isObject(context) ? context : {};
  const due: Record<string, unknown> = {};
  for (const fields of WORKFLOW_CLEARED) {
    const [id] = fields;
    if (!(id in expected) || expected[id] === null || !sameValue(valueAt(held, id), expected[id])) continue;
    for (const field of fields) if (field in expected) due[field] = valueAt(held, field);
  }
  return Object.keys(due).length === 0 ? null : due;
}

/** The value a Workflow's `context` holds for a field named by its path, as WORKFLOW_CLEARED names it, such as `context.extras.basketId`; null for none. */
function valueAt(context: Record<string, unknown>, field: string): unknown {
  return workflowValueAt({ context }, field) ?? null;
}
