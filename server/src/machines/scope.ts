import { type Scope, seesLocation } from "../accounts/scope.js";
import type { Prisma } from "../generated/prisma/client.js";
import { machineNotFound } from "./input.js";

// The Machines an account sees: every one for an Admin; for Staff, those
// whose current Location is one they work at. A Machine's current Location
// is its Location History's latest entry, since no entry may be in the
// future; an unassigned Machine is seen only by Admins.

/** The Machines the scope includes, as a filter. */
export async function machinesInScope(db: Prisma.TransactionClient, scope: Scope): Promise<Prisma.MachineWhereInput> {
  if (scope.kind === "everything") return {};
  const machines = await db.$queryRaw<{ id: string }[]>`
    SELECT machines.id FROM machines
    CROSS JOIN LATERAL (
      SELECT location_id FROM location_assignments WHERE machine_id = machines.id
      ORDER BY effective_from DESC LIMIT 1
    ) AS latest
    WHERE latest.location_id = ANY(${scope.locationIds}::uuid[])`;
  return { id: { in: machines.map((machine) => machine.id) } };
}

/**
 * Refuses a Machine the scope does not include as if there were none, so
 * Staff cannot tell a Machine elsewhere from a Machine that does not exist.
 */
export async function requireMachineInScope(db: Prisma.TransactionClient, machineId: string, scope: Scope): Promise<void> {
  const [machine] = await db.$queryRaw<{ locationId: string | null }[]>`
    SELECT (
      SELECT location_id FROM location_assignments WHERE machine_id = machines.id
      ORDER BY effective_from DESC LIMIT 1
    ) AS "locationId"
    FROM machines WHERE id = ${machineId}::uuid`;
  if (!machine || !seesLocation(scope, machine.locationId)) throw machineNotFound();
}
