import type { Prisma } from "../generated/prisma/client.js";

// What taking a tablet's reports into the Library shares across kinds
// (beans.ts, bean-batches.ts): who reported, the Location it is taken in at,
// and the tablet's row lock that every change to its map holds.

/**
 * Limits for the transaction storing a report of a tablet's Library list,
 * which takes it in. A tablet reporting 1,000 beans new to the Library took
 * 0.75 s on the development database (2026-10-07). A slower host could pass
 * Prisma's default of 5 s, and the report would then fail the same way each
 * time it was sent again.
 */
export const INTAKE_TRANSACTION = { maxWait: 2_000, timeout: 60_000 } as const;

/** A tablet whose Library lists are taken in: the Machine whose token its connection used, and its tablet id. */
export interface ReportingTablet {
  machineId: string;
  tabletId: string;
}

/** Holds the tablet's row lock until the transaction ends, so its map changes one report or write at a time. */
export async function lockTablet(tx: Prisma.TransactionClient, tabletId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM tablets WHERE id = ${tabletId}::uuid FOR NO KEY UPDATE`;
}

/** The Location the Machine is at now: its Location History's latest entry's, or null without one. */
export async function currentLocation(tx: Prisma.TransactionClient, machineId: string): Promise<string | null> {
  const latest = await tx.locationAssignment.findFirst({ where: { machineId }, orderBy: { effectiveFrom: "desc" }, select: { locationId: true } });
  return latest?.locationId ?? null;
}
