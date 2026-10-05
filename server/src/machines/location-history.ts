import { Prisma } from "../generated/prisma/client.js";
import { type LocationView, viewLocation } from "../locations/locations.service.js";
import { unknownLocation } from "./input.js";

// A Machine's Location History: which Location it was at from which time.
// Each entry lasts until the next one's time; before the first, or without
// any, the Machine's Location is unknown. A record is credited to the
// Location its Machine was at when it was recorded, and every change to the
// history credits the Machine's records again. Both hold the Machine's row
// lock (`lockMachine`), so a record stored during a change, on any server
// instance, is credited by the changed history.

/** One entry of a Machine's Location History, as the REST API returns it. */
export interface LocationHistoryEntryView {
  id: string;
  location: LocationView;
  /** When the Machine arrived there. It stayed until the next entry's time. */
  effectiveFrom: string;
}

export const withLocationHistory = {
  locationHistory: { orderBy: { effectiveFrom: "asc" }, include: { location: true } },
} as const satisfies Prisma.MachineInclude;

type Entry = Prisma.LocationAssignmentGetPayload<{ include: { location: true } }>;

/** The history, oldest first, and where the Machine is now: its latest entry's Location. */
export function viewLocationHistory(history: Entry[]): { location: LocationView | null; locationHistory: LocationHistoryEntryView[] } {
  const latest = history.at(-1);
  return {
    location: latest ? viewLocation(latest.location) : null,
    locationHistory: history.map((entry) => ({
      id: entry.id,
      location: viewLocation(entry.location),
      effectiveFrom: entry.effectiveFrom.toISOString(),
    })),
  };
}

/**
 * Starts a new machine entry's Location History at a Location, from now by
 * PostgreSQL's clock, which every instance shares. Its earlier records, such
 * as a tablet's backfilled history, keep an unknown Location until an Admin
 * moves the start earlier.
 */
export async function startLocationHistory(tx: Prisma.TransactionClient, machineId: string, locationId: string | null): Promise<void> {
  if (locationId === null) return;
  if (!(await tx.location.findUnique({ where: { id: locationId }, select: { id: true } }))) throw unknownLocation();
  await tx.locationAssignment.create({ data: { machineId, locationId, effectiveFrom: await databaseNow(tx) } });
}

/** Now, by PostgreSQL's clock rather than this instance's. */
export async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
  const [{ now }] = await tx.$queryRaw<[{ now: Date }]>`SELECT now() AS now`;
  return now;
}

/** Credits every record of the Machine by its Location History. Its row lock must be held. */
export async function creditLocations(tx: Prisma.TransactionClient, machineId: string): Promise<void> {
  for (const records of ["shots", "steam_records"] as const) await credit(tx, records, Prisma.sql`machine_id = ${machineId}::uuid`);
}

/** Credits one Shot by its Machine's Location History. The Machine's row lock must be held. */
export async function creditShotLocation(tx: Prisma.TransactionClient, shotId: string): Promise<void> {
  await credit(tx, "shots", Prisma.sql`id = ${shotId}`);
}

/** Credits one Steam Record by its Machine's Location History. The Machine's row lock must be held. */
export async function creditSteamRecordLocation(tx: Prisma.TransactionClient, steamRecordId: string): Promise<void> {
  await credit(tx, "steam_records", Prisma.sql`id = ${steamRecordId}`);
}

/** When each kind of record was recorded, by the column its Location is credited by. */
const RECORDED_AT = { shots: "pulled_at", steam_records: "steamed_at" } as const;

/**
 * Sets each chosen record's Location to the one its Machine's latest entry
 * from or before the time it was recorded names. A record from before the
 * first entry, without a time, or held by a Pending Machine gets none. Only
 * records whose Location changes are written.
 */
async function credit(tx: Prisma.TransactionClient, table: keyof typeof RECORDED_AT, chosen: Prisma.Sql): Promise<void> {
  const records = Prisma.raw(table);
  const recordedAt = Prisma.raw(RECORDED_AT[table]);
  await tx.$executeRaw`
    WITH credited AS (
      SELECT id, (
        SELECT location_id FROM location_assignments
        WHERE location_assignments.machine_id = ${records}.machine_id AND effective_from <= ${records}.${recordedAt}
        ORDER BY effective_from DESC
        LIMIT 1
      ) AS location_id
      FROM ${records}
      WHERE ${chosen}
    )
    UPDATE ${records} SET location_id = credited.location_id
    FROM credited
    WHERE ${records}.id = credited.id AND ${records}.location_id IS DISTINCT FROM credited.location_id`;
}
