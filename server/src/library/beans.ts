import { GLOBAL_ID_KEY, globalIdOf, isRecordId } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import type { PrismaService } from "../prisma.service.js";
import { beanContent, planIntake, readReportedBeans } from "./bean-intake.js";

// The Library's Beans and the tablets that hold them (ADR-0003, ADR-0006,
// ADR-0008, ADR-0018). A tablet at a Location reports its beans as a
// collection; new ones join the Library at that Location, or are linked to a
// Library Bean with the same roaster and name. Each Location offers the Beans
// created or linked there, and the instance holding each of its tablets'
// connections writes them to it (server/src/sync/tablet-writer.ts). The
// server keeps, per tablet, each Bean's local id there and the record as the
// tablet last had it.
//
// Everything that changes a tablet's map holds its tablet's row lock, so
// reports and the answers to writes are decided one at a time, on any
// instance. A report's new Beans are matched against the Library under one
// advisory lock, so two tablets entering the same coffee at once make one
// Bean. Locks are taken in that order, after the reporting Machine's.

// Every report with beans new to the tablet's map takes this advisory lock before it matches them.
const BEAN_MATCHING_LOCK = 4_000_006;

/**
 * Limits for the transaction storing a report of a tablet's beans, which
 * takes them in. A tablet reporting 1,000 beans new to the Library took
 * 0.75 s on the development database (2026-10-07). A slower host could pass
 * Prisma's default of 5 s, and the report would then fail the same way each
 * time it was sent again.
 */
export const INTAKE_TRANSACTION = { maxWait: 2_000, timeout: 60_000 } as const;

/** A tablet whose beans are taken in: the Machine whose token its connection used, and its tablet id. */
export interface ReportingTablet {
  machineId: string;
  tabletId: string;
}

/**
 * Takes a tablet's report of its beans into the Library, if its Machine is
 * at a Location: a Machine without one is capture-only. Runs in the
 * transaction storing the report, holding the Machine's row lock, which
 * Location History changes take too. Tells every instance when the tablets
 * at its Location have something to be written. Returns the Location the
 * report was taken in at, or null if none.
 */
export async function takeInBeans(
  tx: Prisma.TransactionClient,
  tablet: ReportingTablet,
  value: unknown,
  updatedAt: readonly (string | null)[] | undefined,
): Promise<string | null> {
  const locationId = await currentLocation(tx, tablet.machineId);
  if (locationId === null) return null;
  const reported = readReportedBeans(value, updatedAt);
  await lockTablet(tx, tablet.tabletId);
  const mapped = await tx.$queryRaw<{ beanId: string; localId: string; updatedAt: Date | null; globalId: string | null }[]>`
    SELECT bean_id AS "beanId", local_id AS "localId", record_updated_at AS "updatedAt",
      lower(record -> 'extras' ->> ${GLOBAL_ID_KEY}::text) AS "globalId"
    FROM tablet_beans WHERE tablet_id = ${tablet.tabletId}::uuid`;
  const mappedIds = new Set(mapped.map((bean) => bean.localId));
  const unmapped = reported.filter((bean) => !mappedIds.has(bean.localId));
  if (unmapped.length > 0) await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BEAN_MATCHING_LOCK}::bigint)`;
  // The Beans the new records may name: by their global ids, or by roaster and name, the oldest first.
  const library =
    unmapped.length === 0
      ? []
      : await tx.bean.findMany({
          where: {
            OR: [
              { id: { in: unmapped.flatMap((bean) => (bean.globalId === null ? [] : [bean.globalId])) } },
              { matchKey: { in: unmapped.map((bean) => bean.matchKey) } },
            ],
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, matchKey: true, archived: true },
        });
  const steps = planIntake(reported, mapped, library);

  let writesDue = false;
  for (const step of steps) {
    const { bean } = step;
    let beanId: string;
    if (step.kind === "add") {
      const created = await tx.bean.create({
        data: { content: beanContent(bean.record) as Prisma.InputJsonObject, matchKey: bean.matchKey, createdLocationId: locationId },
        select: { id: true },
      });
      beanId = created.id;
    } else {
      beanId = step.beanId;
    }
    if (step.kind === "add" || step.kind === "link") {
      await tx.$executeRaw`
        INSERT INTO bean_origins (bean_id, location_id) VALUES (${beanId}::uuid, ${locationId}::uuid) ON CONFLICT DO NOTHING`;
    }
    await saveRecord(tx, tablet.tabletId, beanId, bean.localId, bean.record, bean.updatedAt);
    // A Bean new to this Location, or one whose global id the tablet's record lacks.
    if (step.kind === "add" || step.kind === "link" || bean.globalId !== beanId) writesDue = true;
  }
  if (writesDue) await notify(tx, "library_changes", locationId);
  return locationId;
}

/** A write a tablet is due: a Bean its Location offers that it lacks, or whose global id its record lacks. */
export interface BeanWrite {
  beanId: string;
  /** The tablet's record of it, or null if it holds none. */
  localId: string | null;
  /** The fields to set: all of a Bean's content when the tablet lacks it; none when only its global id is written. */
  fields: Record<string, unknown>;
}

/** A connection whose tablet is written to: its session, which must still hold its Machine, the Machine and its tablet. */
export interface WrittenTablet {
  sessionId: string;
  machineId: string;
  tabletId: string;
}

/** What a connection's tablet is due: where its Machine is now, and the next write, if any. */
export interface TabletDue {
  /** The Location its Machine is at now, or null if none. */
  locationId: string | null;
  /** The next write, or null if none is due. */
  write: BeanWrite | null;
}

/**
 * Where the connection's Machine is now, and the next write its tablet is
 * due, the Beans that joined the Library first, leaving out those in
 * `skipped`. No write is due while the Machine is not at the Location its
 * tablet's latest report of its beans was taken in at (`reportedAt`), or the
 * tablet holds every Bean that Location offers with its global id: a tablet
 * is written only what the Library knows it lacks once its beans are taken
 * in there, so a bean it holds already is linked rather than written again.
 * Null while the connection no longer holds its Machine.
 */
export async function tabletDue(
  prisma: PrismaService,
  tablet: WrittenTablet,
  reportedAt: string | null,
  skipped: readonly string[],
): Promise<TabletDue | null> {
  const [due] = await prisma.$queryRaw<{ locationId: string | null; beanId: string | null; content: Record<string, unknown> | null; localId: string | null }[]>`
    WITH holder AS (
      SELECT (
        SELECT location_id FROM location_assignments WHERE machine_id = machines.id ORDER BY effective_from DESC LIMIT 1
      ) AS location_id
      FROM machines WHERE id = ${tablet.machineId}::uuid AND connected_session_id = ${tablet.sessionId}::uuid
    )
    SELECT holder.location_id AS "locationId", next.id AS "beanId", next.content, next.local_id AS "localId"
    FROM holder
    LEFT JOIN LATERAL (
      SELECT beans.id, beans.content, held.local_id
      FROM bean_origins AS origin
      JOIN beans ON beans.id = origin.bean_id AND NOT beans.archived
      LEFT JOIN tablet_beans AS held ON held.tablet_id = ${tablet.tabletId}::uuid AND held.bean_id = beans.id
      WHERE origin.location_id = holder.location_id AND holder.location_id = ${reportedAt}::uuid
        AND (held.bean_id IS NULL OR lower(held.record -> 'extras' ->> ${GLOBAL_ID_KEY}::text) IS DISTINCT FROM beans.id::text)
        AND beans.id <> ALL(${[...skipped]}::uuid[])
      ORDER BY beans.created_at, beans.id
      LIMIT 1
    ) AS next ON true`;
  if (!due) return null;
  const write = due.beanId === null ? null : { beanId: due.beanId, localId: due.localId, fields: due.localId === null ? due.content ?? {} : {} };
  return { locationId: due.locationId, write };
}

/**
 * Records a Bean's record as Decaid returned the plugin's write of it: the
 * tablet's record of that Bean from now on, whatever the time of the record
 * known, since Decaid has just returned it. Says whether the tablet holds the
 * Bean now. It does not
 * when the record does not carry the Bean's global id, when the map holds
 * the record as another Bean's, or when the Library no longer has the Bean;
 * nothing is recorded then, and writing the Bean again would change nothing.
 */
export async function recordBeanWritten(
  prisma: PrismaService,
  tabletId: string,
  beanId: string,
  record: Record<string, unknown>,
  updatedAt: string | null,
): Promise<boolean> {
  if (!isRecordId(record.id) || globalIdOf(record) !== beanId.toLowerCase()) return false;
  const localId = record.id;
  return prisma.$transaction(async (tx) => {
    await lockTablet(tx, tabletId);
    if ((await tx.bean.count({ where: { id: beanId } })) === 0) return false;
    const other = await tx.tabletBean.findUnique({ where: { tabletId_localId: { tabletId, localId } }, select: { beanId: true } });
    if (other && other.beanId !== beanId) return false;
    await saveRecord(tx, tabletId, beanId, localId, record, updatedAt === null ? null : new Date(updatedAt));
    return true;
  });
}

/**
 * Saves the tablet's record of a Bean as the one it holds, under its local
 * id. Whether a reported record replaces the one known is decided by
 * `planIntake`, under the tablet's row lock; a record Decaid has just
 * returned for a write always does.
 */
async function saveRecord(
  tx: Prisma.TransactionClient,
  tabletId: string,
  beanId: string,
  localId: string,
  record: Record<string, unknown>,
  updatedAt: Date | null,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO tablet_beans (tablet_id, bean_id, local_id, record, record_updated_at)
    VALUES (${tabletId}::uuid, ${beanId}::uuid, ${localId}, ${JSON.stringify(record)}::jsonb, ${updatedAt}::timestamptz)
    ON CONFLICT (tablet_id, bean_id) DO UPDATE SET
      local_id = EXCLUDED.local_id, record = EXCLUDED.record, record_updated_at = EXCLUDED.record_updated_at`;
}

/** Holds the tablet's row lock until the transaction ends, so its map changes one report or write at a time. */
async function lockTablet(tx: Prisma.TransactionClient, tabletId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM tablets WHERE id = ${tabletId}::uuid FOR NO KEY UPDATE`;
}

/** The Location the Machine is at now: its Location History's latest entry's, or null without one. */
async function currentLocation(tx: Prisma.TransactionClient, machineId: string): Promise<string | null> {
  const latest = await tx.locationAssignment.findFirst({ where: { machineId }, orderBy: { effectiveFrom: "desc" }, select: { locationId: true } });
  return latest?.locationId ?? null;
}
