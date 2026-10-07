import { Prisma } from "../generated/prisma/client.js";
import type { PrismaService } from "../prisma.service.js";
import type { Hardware } from "../sync/identity.js";

// Tablets (ADR-0006): each connection's `hello` names the tablet it comes
// from, and the tablet is recorded against whoever the connection resolved to,
// as its records are (ADR-0015). A tablet seen on several Machines has a
// record on each. Times are PostgreSQL's clock, so every instance agrees.

/** A tablet as a Machine's view lists it. */
export interface TabletView {
  /** The id its plugin made on its first run. */
  id: string;
  /** When a connection from it to this Machine was first accepted. */
  firstSeenAt: string;
  /** When one was last accepted, or last sent a heartbeat. */
  lastSeenAt: string;
}

/** Whoever a connection's records go to: a Machine, or the Pending Machine holding hardware no Machine has. */
export type TabletHolder = { machineId: string } | { pendingMachineId: string };

// Advisory locks on a tablet holder use this as their first key, and a hash of
// the holder's id as their second, as hardware locks do with theirs. Holders
// whose hashes collide only wait for each other.
const TABLET_HOLDER_LOCK = 4_000_005;

/**
 * Records that a `hello` from the tablet was accepted for the holder, now,
 * creating the tablet if the server has never seen it. Concurrent hellos, on
 * any instance, find one record.
 *
 * It first locks the holder until the hello commits, the last lock a hello
 * takes and one nothing else does, so hellos record tablets for one holder
 * one at a time, whatever tokens they use. The number each takes for its
 * record (`last_hello`, from the column's sequence, which the inserted row's
 * default draws) therefore rises in the order they are accepted.
 */
export async function recordTablet(tx: Prisma.TransactionClient, tabletId: string, holder: TabletHolder): Promise<void> {
  const holderId = "machineId" in holder ? holder.machineId : holder.pendingMachineId;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${TABLET_HOLDER_LOCK}::int, hashtext(${holderId}::text))`;
  await tx.$executeRaw`INSERT INTO tablets (id, first_seen_at) VALUES (${tabletId}::uuid, now()) ON CONFLICT (id) DO NOTHING`;
  if ("machineId" in holder) {
    await tx.$executeRaw`
      INSERT INTO machine_tablets (tablet_id, machine_id, first_seen_at, last_seen_at)
      VALUES (${tabletId}::uuid, ${holder.machineId}::uuid, now(), now())
      ON CONFLICT (tablet_id, machine_id) DO UPDATE SET
        last_hello = EXCLUDED.last_hello,
        last_seen_at = GREATEST(machine_tablets.last_seen_at, EXCLUDED.last_seen_at)`;
  } else {
    await tx.$executeRaw`
      INSERT INTO machine_tablets (tablet_id, pending_machine_id, first_seen_at, last_seen_at)
      VALUES (${tabletId}::uuid, ${holder.pendingMachineId}::uuid, now(), now())
      ON CONFLICT (tablet_id, pending_machine_id) DO UPDATE SET
        last_hello = EXCLUDED.last_hello,
        last_seen_at = GREATEST(machine_tablets.last_seen_at, EXCLUDED.last_seen_at)`;
  }
}

/** A welcomed connection, as a heartbeat finds the record of its tablet. */
export interface TabletConnection {
  tabletId: string;
  /** The Machine whose token it uses. */
  machineId: string;
  /** For a mismatch, the hardware it reports. */
  mismatch: Hardware | null;
}

/**
 * Matches the record of the connection's tablet against whoever its records
 * go to now: its token's Machine, or for a mismatch the Machine that has the
 * reported hardware, or else its Pending Machine. Looked up afresh, since a
 * Machine may have taken that hardware over, and its Pending Machine's
 * records with it, since the connection's `hello`.
 */
export function recordOf(connection: TabletConnection): Prisma.Sql {
  const hardware = connection.mismatch;
  const holder = hardware
    ? Prisma.sql`(machine_id = (SELECT id FROM machines WHERE model = ${hardware.model} AND serial = ${hardware.serial})
        OR pending_machine_id = (SELECT id FROM pending_machines WHERE model = ${hardware.model} AND serial = ${hardware.serial}))`
    : Prisma.sql`machine_id = ${connection.machineId}::uuid`;
  return Prisma.sql`tablet_id = ${connection.tabletId}::uuid AND ${holder}`;
}

/**
 * Gives the Machine the tablets recorded against its hardware's Pending
 * Machine, even a dismissed one. A tablet both have keeps the Machine's
 * record, with the earliest first sighting and the latest hello and last
 * sighting of the two. The held record is deleted and read in one
 * statement, so a heartbeat it waits for is kept. Taken over in place
 * otherwise. Its row lock must be held, as transferPendingRecords requires.
 */
export async function transferPendingTablets(tx: Prisma.TransactionClient, hardware: Hardware, machineId: string): Promise<void> {
  await tx.$executeRaw`
    WITH held AS (
      DELETE FROM machine_tablets AS held
      USING pending_machines AS pending
      WHERE pending.id = held.pending_machine_id AND pending.model = ${hardware.model} AND pending.serial = ${hardware.serial}
        AND EXISTS (SELECT 1 FROM machine_tablets AS mine WHERE mine.machine_id = ${machineId}::uuid AND mine.tablet_id = held.tablet_id)
      RETURNING held.tablet_id, held.first_seen_at, held.last_hello, held.last_seen_at
    )
    UPDATE machine_tablets AS mine SET
      first_seen_at = LEAST(mine.first_seen_at, held.first_seen_at),
      last_hello = GREATEST(mine.last_hello, held.last_hello),
      last_seen_at = GREATEST(mine.last_seen_at, held.last_seen_at)
    FROM held
    WHERE mine.machine_id = ${machineId}::uuid AND mine.tablet_id = held.tablet_id`;
  await tx.machineTablet.updateMany({ where: { pendingMachine: hardware }, data: { machineId, pendingMachineId: null } });
}

/**
 * Each Machine's tablets: the one its latest accepted connection came from
 * first, then the earlier ones, most recently connected first. Heartbeats
 * never change the order.
 */
export async function tabletsOf(prisma: PrismaService, machineIds: string[]): Promise<Map<string, TabletView[]>> {
  const records =
    machineIds.length === 0
      ? []
      : await prisma.machineTablet.findMany({
          where: { machineId: { in: machineIds } },
          orderBy: { lastHello: "desc" },
          select: { machineId: true, tabletId: true, firstSeenAt: true, lastSeenAt: true },
        });
  const byMachine = new Map<string, TabletView[]>(machineIds.map((id) => [id, []]));
  for (const record of records) {
    byMachine.get(record.machineId!)!.push({
      id: record.tabletId,
      firstSeenAt: record.firstSeenAt.toISOString(),
      lastSeenAt: record.lastSeenAt.toISOString(),
    });
  }
  return byMachine;
}
