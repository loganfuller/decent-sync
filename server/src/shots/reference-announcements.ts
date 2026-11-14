import { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";

/**
 * Announces a change to each Location with a Recipe in a slot whose
 * Reference Shot is one of the Shots that `which` holds of, of `shots`
 * aliased `s`: its tablets keep a copy of that Shot (ticket #510,
 * shots/location-references.ts), which each instance then brings current.
 * Called in the transaction that changes what such a copy holds otherwise
 * than through its Recipe: the Shot stored anew, as when its rating or note
 * changes, or hidden or shown with its Pending Machine. The Recipes are
 * found through the index on their Reference Shots, so it costs a Shot that
 * is no Recipe's reference one probe of it.
 */
export async function announceReferenceShots(tx: Prisma.TransactionClient, which: Prisma.Sql): Promise<void> {
  const locations = await tx.$queryRaw<{ locationId: string }[]>`
    SELECT DISTINCT r.location_id::text AS "locationId" FROM recipes AS r JOIN shots AS s ON s.id = r.reference_shot_id
    WHERE r.slot IS NOT NULL AND r.location_id IS NOT NULL AND ${which}`;
  for (const { locationId } of locations) await notify(tx, "library_changes", locationId);
}
