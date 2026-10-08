import { GLOBAL_ID_KEY, globalIdOf, isRecordId } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import type { PrismaService } from "../prisma.service.js";
import { lockMachine } from "../machines/machines.service.js";
import { type LocationEdit, batchContent, editsInAnswer, planBatchIntake, readReportedBatches } from "./batch-intake.js";
import { INTAKE_TRANSACTION, type ReportingTablet, currentLocation, lockTablet } from "./intake.js";
import { listedIds } from "./listed.js";
import { addBatchAt, deletedAt, enterRemainingWeight, finishBatchAt, lockLocation, transactionTime } from "./location-state.js";

// The Library's Bean Batches and the tablets that hold them (ADR-0006,
// ADR-0008, ADR-0018, ADR-0019). A tablet at a Location reports its batches
// as a collection, after its beans; a new one joins the Library as a batch of
// the Bean its tablet's record of its bean is, at that Location. On a
// tablet, a batch's `archived` says it is not at the tablet's Location and
// its `weightRemaining` is the remaining weight there: un-archiving one adds
// it there, archiving or deleting it finishes it there, and a new
// `weightRemaining` is the remaining weight there (location-state.ts). The
// server keeps, per tablet, each batch's local id there and the record as
// the tablet last had it, as for Beans (beans.ts), under the same locks.

/**
 * Takes a tablet's report of its bean batches into the Library, as
 * `takeInBeans` takes its beans, in the transaction storing the report.
 * Returns the Location the report was taken in at, or null if none.
 */
export async function takeInBatches(
  tx: Prisma.TransactionClient,
  tablet: ReportingTablet,
  value: unknown,
  updatedAt: readonly (string | null)[] | undefined,
): Promise<string | null> {
  const locationId = await currentLocation(tx, tablet.machineId);
  if (locationId === null) return null;
  const reported = readReportedBatches(value, updatedAt);
  await lockTablet(tx, tablet.tabletId);
  const mapped = await tx.$queryRaw<
    { batchId: string; localId: string; updatedAt: Date | null; globalId: string | null; archived: boolean; weightRemaining: number | null }[]
  >`
    SELECT batch_id AS "batchId", local_id AS "localId", record_updated_at AS "updatedAt",
      lower(record -> 'extras' ->> ${GLOBAL_ID_KEY}::text) AS "globalId", (record ->> 'archived') = 'true' AS archived,
      CASE WHEN jsonb_typeof(record -> 'weightRemaining') = 'number' THEN (record ->> 'weightRemaining')::double precision END AS "weightRemaining"
    FROM tablet_bean_batches WHERE tablet_id = ${tablet.tabletId}::uuid`;
  // The Library Beans the tablet's records of its beans are, by their ids there.
  const beans = await tx.tabletBean.findMany({ where: { tabletId: tablet.tabletId }, select: { localId: true, beanId: true } });
  const mappedIds = new Set(mapped.map((batch) => batch.localId));
  const named = reported.flatMap((batch) => (batch.globalId !== null && !mappedIds.has(batch.localId) ? [batch.globalId] : []));
  const library = named.length === 0 ? [] : await tx.beanBatch.findMany({ where: { id: { in: named } }, select: { id: true } });
  const steps = planBatchIntake(reported, mapped, new Map(beans.map((bean) => [bean.localId, bean.beanId])), library, listedIds(value));
  if (steps.length === 0) return locationId;
  await lockLocation(tx, locationId);

  /** Whether the Location's tablets, this one included, may have something to be written. */
  let writesDue = false;
  for (const step of steps) {
    if (step.kind === "delete") {
      await tx.$executeRaw`DELETE FROM tablet_bean_batches WHERE tablet_id = ${tablet.tabletId}::uuid AND batch_id = ${step.batchId}::uuid`;
      await applyEdits(tx, step.batchId, locationId, step.edits, deletedAt(await transactionTime(tx), step.updatedAt));
      writesDue = true;
      continue;
    }
    const { batch } = step;
    let batchId: string;
    if (step.kind === "add") {
      const created = await tx.beanBatch.create({
        data: { beanId: step.beanId, content: batchContent(batch.record) as Prisma.InputJsonObject, createdLocationId: locationId },
        select: { id: true },
      });
      batchId = created.id;
    } else {
      batchId = step.batchId;
    }
    await saveRecord(tx, tablet.tabletId, batchId, batch.localId, batch.record, batch.updatedAt);
    if (step.kind === "add" || step.kind === "map") writesDue = true;
    if (step.kind !== "map") writesDue = (await applyEdits(tx, batchId, locationId, step.edits, batch.updatedAt)) || writesDue;
    // A record whose global id is lost has it written back.
    if (batch.globalId !== batchId) writesDue = true;
  }
  if (writesDue) await notify(tx, "library_changes", locationId);
  return locationId;
}

/** Makes a tablet's changes to a batch at its Location, timed by the edit. Says whether any changed the Location's state. */
async function applyEdits(tx: Prisma.TransactionClient, batchId: string, locationId: string, edits: readonly LocationEdit[], at: Date): Promise<boolean> {
  let changed = false;
  for (const edit of edits) {
    if (edit.field === "at") {
      changed = (edit.value ? await addBatchAt(tx, batchId, locationId, at) : await finishBatchAt(tx, batchId, locationId, at)) || changed;
    } else {
      changed = (await enterRemainingWeight(tx, batchId, locationId, edit, at)) || changed;
    }
  }
  return changed;
}

/**
 * Records a batch's record as Decaid returned the plugin's write of it (whose
 * fields were `written`), as `recordBeanWritten` does a Bean's: a change the
 * tablet made at its Location since its last report, which the write kept,
 * such as archiving the batch just before the server wrote its global id, is
 * taken in as a report would take it (`editsInAnswer`). Says whether the
 * tablet holds the batch now.
 */
export async function recordBatchWritten(
  prisma: PrismaService,
  tablet: ReportingTablet,
  batchId: string,
  written: Readonly<Record<string, unknown>>,
  record: Record<string, unknown>,
  updatedAt: string | null,
): Promise<boolean> {
  if (!isRecordId(record.id) || globalIdOf(record) !== batchId.toLowerCase()) return false;
  const localId = record.id;
  return prisma.$transaction(async (tx) => {
    await lockMachine(tx, tablet.machineId);
    await lockTablet(tx, tablet.tabletId);
    if ((await tx.beanBatch.count({ where: { id: batchId } })) === 0) return false;
    const other = await tx.tabletBeanBatch.findUnique({ where: { tabletId_localId: { tabletId: tablet.tabletId, localId } }, select: { batchId: true } });
    if (other && other.batchId !== batchId) return false;
    const [known] = await tx.$queryRaw<{ archived: boolean; weightRemaining: number | null }[]>`
      SELECT (record ->> 'archived') = 'true' AS archived,
        CASE WHEN jsonb_typeof(record -> 'weightRemaining') = 'number' THEN (record ->> 'weightRemaining')::double precision END AS "weightRemaining"
      FROM tablet_bean_batches WHERE tablet_id = ${tablet.tabletId}::uuid AND batch_id = ${batchId}::uuid`;
    const at = updatedAt === null ? null : new Date(updatedAt);
    await saveRecord(tx, tablet.tabletId, batchId, localId, record, at);
    const edits = editsInAnswer(known ?? null, record, written);
    const locationId = edits.length === 0 ? null : await currentLocation(tx, tablet.machineId);
    if (locationId !== null) {
      await lockLocation(tx, locationId);
      if (await applyEdits(tx, batchId, locationId, edits, at ?? (await transactionTime(tx)))) await notify(tx, "library_changes", locationId);
    }
    return true;
  }, INTAKE_TRANSACTION);
}

/** Saves the tablet's record of a batch as the one it holds, under its local id, as `saveRecord` in beans.ts does a Bean's. */
async function saveRecord(
  tx: Prisma.TransactionClient,
  tabletId: string,
  batchId: string,
  localId: string,
  record: Record<string, unknown>,
  updatedAt: Date | null,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO tablet_bean_batches (tablet_id, batch_id, local_id, record, record_updated_at)
    VALUES (${tabletId}::uuid, ${batchId}::uuid, ${localId}, ${JSON.stringify(record)}::jsonb, ${updatedAt}::timestamptz)
    ON CONFLICT (tablet_id, batch_id) DO UPDATE SET
      local_id = EXCLUDED.local_id, record = EXCLUDED.record, record_updated_at = EXCLUDED.record_updated_at`;
}
