import { type Scope, includesLocation } from "../accounts/scope.js";

/** What decides who may resolve a Conflict: the Location whose state it is about, its field, and for an item that belongs to one Location, as a Grinder does, that Location. */
export interface ConflictScope {
  /** The Location whose state of the item the field is; null for the item's content. */
  locationId: string | null;
  field: string;
  /** The Location the item belongs to (`belongsToLocation`), null if that Location no longer exists; undefined for kinds that belong to none. */
  itemLocationId?: string | null;
}

/**
 * Whether an account may use a Conflict's value or dismiss it: one about an
 * item it can edit. An Admin can edit everything. Staff edit the Library's
 * shared content anywhere, and Archive and restore items, which a Grinder's
 * `archived` is; but what a Location offers only at their own Locations: a
 * Location's state of an item, and an item that belongs to one Location, as
 * a Grinder does.
 */
export function mayResolve(scope: Scope, conflict: ConflictScope): boolean {
  if (conflict.locationId !== null) return includesLocation(scope, conflict.locationId);
  if (conflict.itemLocationId !== undefined && conflict.field !== "archived") return includesLocation(scope, conflict.itemLocationId);
  return true;
}
