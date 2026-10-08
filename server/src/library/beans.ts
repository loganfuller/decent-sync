import { GLOBAL_ID_KEY, globalIdOf, isRecordId } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import type { PrismaService } from "../prisma.service.js";
import { lockMachine } from "../machines/machines.service.js";
import { archivingInAnswer, beanContent, planIntake, readReportedBeans } from "./bean-intake.js";
import { INTAKE_TRANSACTION, type ReportingTablet, currentLocation, lockTablet } from "./intake.js";
import { listedIds } from "./listed.js";
import { deletedAt, lockLocation, offerBeanAt, takeBeanFrom, transactionTime } from "./location-state.js";

// The Library's Beans and the tablets that hold them (ADR-0003, ADR-0006,
// ADR-0008, ADR-0018, ADR-0019). A tablet at a Location reports its beans as
// a collection; new ones join the Library at that Location, or are linked to
// a Library Bean with the same roaster and name. Archiving or deleting one
// on the tablet takes it away from that Location, and un-archiving it offers
// it there again (location-state.ts). The instance holding each of a
// Location's tablets' connections writes it what the Location offers
// (server/src/sync/tablet-writer.ts). The server keeps, per tablet, each
// Bean's local id there and the record as the tablet last had it.
//
// Everything that changes a tablet's map holds its tablet's row lock, so
// reports and the answers to writes are decided one at a time, on any
// instance. A report's new Beans are matched against the Library under one
// advisory lock, so two tablets entering the same coffee at once make one
// Bean. What it changes at the Location is decided under the Location's
// lock. Locks are taken in that order, after the reporting Machine's.

// Every report with beans new to the tablet's map takes this advisory lock before it matches them.
const BEAN_MATCHING_LOCK = 4_000_006;

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
  const mapped = await tx.$queryRaw<{ beanId: string; localId: string; updatedAt: Date | null; globalId: string | null; archived: boolean }[]>`
    SELECT bean_id AS "beanId", local_id AS "localId", record_updated_at AS "updatedAt",
      lower(record -> 'extras' ->> ${GLOBAL_ID_KEY}::text) AS "globalId", (record ->> 'archived') = 'true' AS archived
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
  const steps = planIntake(reported, mapped, library, listedIds(value));
  if (steps.length === 0) return locationId;
  await lockLocation(tx, locationId);

  /** Whether the Location's tablets, this one included, may have something to be written. */
  let writesDue = false;
  for (const step of steps) {
    if (step.kind === "delete") {
      await tx.$executeRaw`DELETE FROM tablet_beans WHERE tablet_id = ${tablet.tabletId}::uuid AND bean_id = ${step.beanId}::uuid`;
      await takeBeanFrom(tx, step.beanId, locationId, deletedAt(await transactionTime(tx), step.updatedAt));
      writesDue = true;
      continue;
    }
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
    await saveRecord(tx, tablet.tabletId, beanId, bean.localId, bean.record, bean.updatedAt);
    if (step.kind === "add" || step.kind === "link") {
      // One archived on the tablet joins the Library, but is not offered at its Location.
      if (!bean.archived) await offerBeanAt(tx, beanId, locationId);
      writesDue = true;
    } else if (step.kind === "map") {
      // The tablet holds it as the Location has it, or is written so.
      writesDue = true;
    } else if (step.archived === true) {
      writesDue = (await takeBeanFrom(tx, beanId, locationId, bean.updatedAt)) || writesDue;
    } else if (step.archived === false) {
      writesDue = (await offerBeanAt(tx, beanId, locationId)) || writesDue;
    }
    // A record whose global id is lost has it written back.
    if (bean.globalId !== beanId) writesDue = true;
  }
  if (writesDue) await notify(tx, "library_changes", locationId);
  return locationId;
}

/**
 * Records a Bean's record as Decaid returned the plugin's write of it (whose
 * fields were `written`): the tablet's record of that Bean from now on,
 * whatever the time of the record known, since Decaid has just returned it.
 * A record archived or un-archived on the tablet since its last report, which
 * the write kept, means at the tablet's Location what it would in a report.
 * Holds the Machine's, the tablet's and the Location's locks, in the order a
 * report takes them. Says whether the tablet holds the Bean now. It does not
 * when the record does not carry the Bean's global id, when the map holds the
 * record as another Bean's, or when the Library no longer has the Bean;
 * nothing is recorded then, and writing the Bean again would change nothing.
 */
export async function recordBeanWritten(
  prisma: PrismaService,
  tablet: ReportingTablet,
  beanId: string,
  written: Readonly<Record<string, unknown>>,
  record: Record<string, unknown>,
  updatedAt: string | null,
): Promise<boolean> {
  if (!isRecordId(record.id) || globalIdOf(record) !== beanId.toLowerCase()) return false;
  const localId = record.id;
  return prisma.$transaction(async (tx) => {
    await lockMachine(tx, tablet.machineId);
    await lockTablet(tx, tablet.tabletId);
    if ((await tx.bean.count({ where: { id: beanId } })) === 0) return false;
    const other = await tx.tabletBean.findUnique({ where: { tabletId_localId: { tabletId: tablet.tabletId, localId } }, select: { beanId: true } });
    if (other && other.beanId !== beanId) return false;
    const [known] = await tx.$queryRaw<{ archived: boolean }[]>`
      SELECT (record ->> 'archived') = 'true' AS archived FROM tablet_beans WHERE tablet_id = ${tablet.tabletId}::uuid AND bean_id = ${beanId}::uuid`;
    const at = updatedAt === null ? null : new Date(updatedAt);
    await saveRecord(tx, tablet.tabletId, beanId, localId, record, at);
    const archived = archivingInAnswer(known?.archived ?? null, record, written);
    const locationId = archived === undefined ? null : await currentLocation(tx, tablet.machineId);
    if (locationId !== null) {
      await lockLocation(tx, locationId);
      const changed = archived
        ? await takeBeanFrom(tx, beanId, locationId, at ?? (await transactionTime(tx)))
        : await offerBeanAt(tx, beanId, locationId);
      if (changed) await notify(tx, "library_changes", locationId);
    }
    return true;
  }, INTAKE_TRANSACTION);
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
