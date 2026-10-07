import { Prisma } from "../generated/prisma/client.js";
import { type LocationView, viewLocation } from "../locations/locations.service.js";
import type { Hardware } from "../sync/identity.js";
import { unknownLocation } from "./input.js";

// A Machine's Location History: which Location it was at from which time.
// Each entry lasts until the next one's time; before the first, or without
// any, the Machine's Location is unknown. A record is credited to the
// Location its Machine was at when it was recorded. A change to the history
// credits again only the records recorded in the span it affects; outside
// it, the latest entry from or before a record's time names the same
// Location as before. Storing a record and changing the history both hold
// the Machine's row lock (`lockMachine`), so a record stored during a change,
// on any server instance, is credited either before it, and then again by it
// if in its span, or after it, by the changed history.

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

/**
 * Limits for a transaction that changes a Location History or hands a
 * Pending Machine's records over, which credits up to every record of the
 * Machine and may take many seconds on a long history. It holds the
 * Machine's row lock throughout, so that Machine's deliveries wait, and may
 * fail and be resent. Waiting for a connection is limited as for any other
 * transaction.
 */
export const CREDITING_TRANSACTION = { maxWait: 2_000, timeout: 60_000 } as const;

/**
 * The recorded times a change to a Location History may change the Location
 * of: from `from`, and before `until` unless it is null.
 */
export interface Span {
  from: Date;
  until: Date | null;
}

/**
 * Credits the Machine's records recorded in the span by its Location
 * History, reading and writing no others. Its row lock must be held.
 */
export async function creditLocations(tx: Prisma.TransactionClient, machineId: string, span: Span): Promise<void> {
  if (span.until !== null && span.until.getTime() <= span.from.getTime()) return;
  for (const records of ["shots", "steam_records"] as const) {
    const recordedAt = Prisma.raw(RECORDED_AT[records]);
    const until = span.until === null ? Prisma.empty : Prisma.sql`AND ${recordedAt} < ${span.until}::timestamptz`;
    await credit(tx, records, Prisma.sql`machine_id = ${machineId}::uuid AND ${recordedAt} >= ${span.from}::timestamptz ${until}`);
  }
}

/**
 * Hands the Machine the Shots and Steam Records a Pending Machine holds for
 * its hardware, crediting each by the Machine's Location History. The
 * Machine's own records keep their Locations: its history has not changed.
 * Its row lock must be held, or the Machine created in this transaction.
 */
export async function handOverRecords(tx: Prisma.TransactionClient, hardware: Hardware, machineId: string): Promise<void> {
  for (const table of ["shots", "steam_records"] as const) {
    const records = Prisma.raw(table);
    const location = locationAt(Prisma.sql`${machineId}::uuid`, Prisma.sql`${records}.${Prisma.raw(RECORDED_AT[table])}`);
    // Written once each, with their Machine and Location together.
    await tx.$executeRaw`
      UPDATE ${records} SET machine_id = ${machineId}::uuid, pending_machine_id = NULL, location_id = ${location}
      WHERE pending_machine_id = (SELECT id FROM pending_machines WHERE model = ${hardware.model} AND serial = ${hardware.serial})`;
  }
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
 * records whose Location changes are written, in one pass: joining the
 * records to their new Locations instead wrote nearly twice the WAL, and
 * took twice as long, on a long history.
 */
async function credit(tx: Prisma.TransactionClient, table: keyof typeof RECORDED_AT, chosen: Prisma.Sql): Promise<void> {
  const records = Prisma.raw(table);
  const location = locationAt(Prisma.sql`${records}.machine_id`, Prisma.sql`${records}.${Prisma.raw(RECORDED_AT[table])}`);
  await tx.$executeRaw`UPDATE ${records} SET location_id = ${location} WHERE ${chosen} AND location_id IS DISTINCT FROM ${location}`;
}

/**
 * The Location the Machine's latest entry from or before a time names: null
 * before its first entry, without any, or without a time.
 */
function locationAt(machineId: Prisma.Sql, recordedAt: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(
    SELECT location_id FROM location_assignments
    WHERE location_assignments.machine_id = ${machineId} AND effective_from <= ${recordedAt}
    ORDER BY effective_from DESC
    LIMIT 1
  )`;
}
