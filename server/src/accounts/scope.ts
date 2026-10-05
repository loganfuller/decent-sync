/**
 * The Locations an account sees: every one for an Admin, or the ones a Staff
 * member works at, with the Machines at them. Read with the session on every
 * request and never kept, so a change to an account's role or Locations
 * applies to its next request on any server instance.
 */
export type Scope = { kind: "everything" } | { kind: "locations"; locationIds: string[] };

export const EVERYTHING: Scope = { kind: "everything" };

/** Whether the scope includes the Location. No Location (null) is seen only by Admins. */
export function seesLocation(scope: Scope, locationId: string | null): boolean {
  return scope.kind === "everything" || (locationId !== null && scope.locationIds.includes(locationId));
}
