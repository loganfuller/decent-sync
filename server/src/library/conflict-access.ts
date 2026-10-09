import { type Scope, includesLocation } from "../accounts/scope.js";

/** What decides who may resolve a Conflict: the Location whose state it is about, its field, and for a Grinder the Location it belongs to. */
export interface ConflictScope {
  /** The Location whose state of the item the field is; null for the item's content. */
  locationId: string | null;
  field: string;
  /** The Location of the Grinder it is about, null if that Location no longer exists; undefined for other kinds. */
  grinderLocationId?: string | null;
}

/**
 * Whether an account may use a Conflict's value or dismiss it: one about an
 * item it can edit. An Admin can edit everything. Staff edit the Library's
 * shared content anywhere, and Archive and restore items, which a Grinder's
 * `archived` is; but what a Location offers only at their own Locations: a
 * Location's state of an item, and a Grinder, which belongs to one Location.
 */
export function mayResolve(scope: Scope, conflict: ConflictScope): boolean {
  if (conflict.locationId !== null) return includesLocation(scope, conflict.locationId);
  if (conflict.grinderLocationId !== undefined && conflict.field !== "archived") return includesLocation(scope, conflict.grinderLocationId);
  return true;
}
