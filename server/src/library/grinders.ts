import { GLOBAL_ID_KEY, globalIdOf, isRecordId } from "@decent-sync/protocol";
import type { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import type { PrismaService } from "../prisma.service.js";
import { archivingInAnswer } from "./bean-intake.js";
import { grinderContent, planGrinderIntake, readReportedGrinders } from "./grinder-intake.js";
import { type AnswerRecorded, type AnsweringTablet, INTAKE_TRANSACTION, type ReportingTablet, currentLocation, lockHeldMachine, lockTablet } from "./intake.js";
import { listedIds } from "./listed.js";
import { archiveGrinderAt, lockLocation } from "./location-state.js";

// The Library's Grinders and the tablets that hold them (ADR-0003, ADR-0006,
// ADR-0008, ADR-0018, ADR-0019). A Grinder is equipment, and belongs to one
// Location: the one where a tablet created it. A tablet at a Location reports
// its grinders as a collection; new ones join the Library belonging to that
// Location, and are never matched, so two grinders of one model are two
// Grinders. Archiving or deleting one on a tablet there Archives it, and
// un-archiving it restores it (location-state.ts). The instance holding each
// of a Location's tablets' connections writes it the Location's Grinders
// (server/src/sync/tablet-writer.ts). The server keeps, per tablet, each
// Grinder's local id there and the record as the tablet last had it, as for
// Beans (beans.ts), under the same locks: the reporting Machine's, the
// tablet's, then the Location's.

/**
 * Takes a tablet's report of its grinders into the Library, as `takeInBeans`
 * takes its beans, in the transaction storing the report. Returns the
 * Location the report was taken in at, or null if none.
 */
export async function takeInGrinders(
  tx: Prisma.TransactionClient,
  tablet: ReportingTablet,
  value: unknown,
  updatedAt: readonly (string | null)[] | undefined,
): Promise<string | null> {
  const locationId = await currentLocation(tx, tablet.machineId);
  if (locationId === null) return null;
  const reported = readReportedGrinders(value, updatedAt);
  await lockTablet(tx, tablet.tabletId);
  const mapped = await tx.$queryRaw<{ grinderId: string; localId: string; updatedAt: Date | null; globalId: string | null; archived: boolean }[]>`
    SELECT grinder_id AS "grinderId", local_id AS "localId", record_updated_at AS "updatedAt",
      lower(record -> 'extras' ->> ${GLOBAL_ID_KEY}::text) AS "globalId", (record ->> 'archived') = 'true' AS archived
    FROM tablet_grinders WHERE tablet_id = ${tablet.tabletId}::uuid`;
  const mappedIds = new Set(mapped.map((grinder) => grinder.localId));
  const named = reported.flatMap((grinder) => (grinder.globalId !== null && !mappedIds.has(grinder.localId) ? [grinder.globalId] : []));
  const library = named.length === 0 ? [] : await tx.grinder.findMany({ where: { id: { in: named } }, select: { id: true } });
  const steps = planGrinderIntake(reported, mapped, new Set(library.map((grinder) => grinder.id)), listedIds(value));
  if (steps.length === 0) return locationId;
  await lockLocation(tx, locationId);

  /** Whether the Location's tablets, this one included, may have something to be written. */
  let writesDue = false;
  for (const step of steps) {
    if (step.kind === "delete") {
      await tx.$executeRaw`DELETE FROM tablet_grinders WHERE tablet_id = ${tablet.tabletId}::uuid AND grinder_id = ${step.grinderId}::uuid`;
      if (step.archived) await archiveGrinderAt(tx, step.grinderId, locationId, true);
      writesDue = true;
      continue;
    }
    const { grinder } = step;
    let grinderId: string;
    if (step.kind === "add") {
      const created = await tx.grinder.create({
        data: { content: grinderContent(grinder.record) as Prisma.InputJsonObject, archived: grinder.archived, locationId },
        select: { id: true },
      });
      grinderId = created.id;
      writesDue = true;
    } else {
      grinderId = step.grinderId;
    }
    await saveRecord(tx, tablet.tabletId, grinderId, grinder.localId, grinder.record, grinder.updatedAt);
    // The tablet holds it as the Library has it, or is written so.
    if (step.kind === "map") writesDue = true;
    if (step.kind === "update" && step.archived !== undefined) writesDue = (await archiveGrinderAt(tx, grinderId, locationId, step.archived)) || writesDue;
    // A record whose global id is lost has it written back.
    if (grinder.globalId !== grinderId) writesDue = true;
  }
  if (writesDue) await notify(tx, "library_changes", locationId);
  return locationId;
}

/**
 * Records a Grinder's record as Decaid returned the plugin's write of it
 * (`written`, the fields it set), as `recordBeanWritten` does a Bean's: a
 * record archived or un-archived on the tablet since its last report, which
 * the write kept, Archives or restores the Grinder as a report would.
 * Recorded only while the answering connection holds its Machine. Nothing
 * is recorded when the record does not carry the Grinder's global id, when
 * the map holds the record as another Grinder's, or when the Library no
 * longer has the Grinder.
 */
export async function recordGrinderWritten(
  prisma: PrismaService,
  tablet: AnsweringTablet,
  grinderId: string,
  written: ReadonlySet<string>,
  record: Record<string, unknown>,
  updatedAt: string | null,
): Promise<AnswerRecorded> {
  if (!isRecordId(record.id) || globalIdOf(record) !== grinderId.toLowerCase()) return "notTheItem";
  const localId = record.id;
  return prisma.$transaction(async (tx): Promise<AnswerRecorded> => {
    if (!(await lockHeldMachine(tx, tablet))) return "released";
    await lockTablet(tx, tablet.tabletId);
    if ((await tx.grinder.count({ where: { id: grinderId } })) === 0) return "notTheItem";
    const other = await tx.tabletGrinder.findUnique({ where: { tabletId_localId: { tabletId: tablet.tabletId, localId } }, select: { grinderId: true } });
    if (other && other.grinderId !== grinderId) return "notTheItem";
    const [known] = await tx.$queryRaw<{ archived: boolean }[]>`
      SELECT (record ->> 'archived') = 'true' AS archived FROM tablet_grinders WHERE tablet_id = ${tablet.tabletId}::uuid AND grinder_id = ${grinderId}::uuid`;
    const archived = archivingInAnswer(known?.archived ?? null, record, written);
    const locationId = archived === undefined ? null : await currentLocation(tx, tablet.machineId);
    if (locationId !== null) {
      await lockLocation(tx, locationId);
      if (await archiveGrinderAt(tx, grinderId, locationId, archived!)) await notify(tx, "library_changes", locationId);
    }
    await saveRecord(tx, tablet.tabletId, grinderId, localId, record, updatedAt === null ? null : new Date(updatedAt));
    return "recorded";
  }, INTAKE_TRANSACTION);
}

/** Saves the tablet's record of a Grinder as the one it holds, under its local id, as `saveRecord` in beans.ts does a Bean's. */
async function saveRecord(
  tx: Prisma.TransactionClient,
  tabletId: string,
  grinderId: string,
  localId: string,
  record: Record<string, unknown>,
  updatedAt: Date | null,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO tablet_grinders (tablet_id, grinder_id, local_id, record, record_updated_at)
    VALUES (${tabletId}::uuid, ${grinderId}::uuid, ${localId}, ${JSON.stringify(record)}::jsonb, ${updatedAt}::timestamptz)
    ON CONFLICT (tablet_id, grinder_id) DO UPDATE SET
      local_id = EXCLUDED.local_id, record = EXCLUDED.record, record_updated_at = EXCLUDED.record_updated_at`;
}
