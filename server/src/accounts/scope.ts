import { AccountRole } from "../generated/prisma/client.js";

/**
 * The Locations an account works at: every one for an Admin, the ones a
 * Staff member works at, or none for a Viewer, who changes nothing
 * (`SessionGuard` refuses them every route that does). They limit only what
 * Staff change: Staff move Machines only between their Locations. Staff and
 * Viewers read everything an Admin does, except other accounts' personal
 * information. Read with the session on every request and never kept, so a
 * change to an account's role or Locations applies to its next request on
 * any server instance.
 */
export type Scope = { kind: "everything" } | { kind: "locations"; locationIds: string[] } | { kind: "nothing" };

export const EVERYTHING: Scope = { kind: "everything" };

/** Whether the scope includes the Location. No Location (null) only an Admin's does. */
export function includesLocation(scope: Scope, locationId: string | null): boolean {
  if (scope.kind === "everything") return true;
  return scope.kind === "locations" && locationId !== null && scope.locationIds.includes(locationId);
}

/** A Viewer's: no Location, and nothing to change. */
export const NOTHING: Scope = { kind: "nothing" };

/** The Scope of an account with this role, and for Staff these Locations, as read with its session or access token. */
export function scopeOf(role: AccountRole, staffLocationIds: string[]): Scope {
  if (role === AccountRole.ADMIN) return EVERYTHING;
  if (role === AccountRole.VIEWER) return NOTHING;
  return { kind: "locations", locationIds: staffLocationIds };
}
