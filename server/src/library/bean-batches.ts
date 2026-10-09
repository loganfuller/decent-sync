import { GLOBAL_ID_KEY, globalIdOf, isRecordId } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import type { PrismaService } from "../prisma.service.js";
import { type LocationEdit, batchContent, editsInAnswer, planBatchIntake, readReportedBatches } from "./batch-intake.js";
import {
  type AnswerRecorded,
  type AnsweringTablet,
  INTAKE_TRANSACTION,
  type ReportingTablet,
  type SeenDecision,
  currentLocation,
  keepSeenSql,
  lockHeldMachine,
  lockTablet,
  seenAtSql,
} from "./intake.js";
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
    { batchId: string; localId: string; updatedAt: Date | null; globalId: string | null; archived: boolean; weightRemaining: number | null; seenAt: Date | null }[]
  >`
    SELECT batch_id AS "batchId", local_id AS "localId", record_updated_at AS "updatedAt", ${seenAtSql(locationId)} AS "seenAt",
      lower(record -> 'extras' ->> ${GLOBAL_ID_KEY}::text) AS "globalId", (record ->> 'archived') = 'true' AS archived,
      CASE WHEN jsonb_typeof(record -> 'weightRemaining') = 'number' THEN (record ->> 'weightRemaining')::double precision END AS "weightRemaining"
    FROM tablet_bean_batches WHERE tablet_id = ${tablet.tabletId}::uuid`;
  /** The Location's latest decision of each batch that the tablet's record the map holds has seen there: one decided by then, the tablet had seen. */
  const seenAt = new Map(mapped.map((batch) => [batch.batchId, batch.seenAt]));
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
      await applyEdits(tx, step.batchId, locationId, step.edits, deletedAt(await transactionTime(tx), step.updatedAt), seenAt.get(step.batchId) ?? null);
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
    if (step.kind === "add" || step.kind === "map") writesDue = true;
    const applied = step.kind === "map" ? null : await applyEdits(tx, batchId, locationId, step.edits, batch.updatedAt, seenAt.get(batchId) ?? null);
    if (applied?.changed) writesDue = true;
    // A report shows nothing of what the tablet saw of others' decisions, only of the one its own edit made.
    const decided = applied?.decidedAt ?? null;
    await saveRecord(tx, tablet.tabletId, batchId, batch.localId, batch.record, batch.updatedAt, decided === null ? null : { at: decided, locationId });
    // A record whose global id is lost has it written back.
    if (batch.globalId !== batchId) writesDue = true;
  }
  if (writesDue) await notify(tx, "library_changes", locationId);
  return locationId;
}

/**
 * Makes a tablet's changes to a batch at its Location, timed by the edit,
 * from a tablet whose record of the batch had seen the Location's decision of
 * its presence there at `seenAt`, or none. Says whether any changed the
 * Location's state, and when the edit decided the batch's presence there,
 * which the tablet's record has seen then; null if it did not.
 */
async function applyEdits(
  tx: Prisma.TransactionClient,
  batchId: string,
  locationId: string,
  edits: readonly LocationEdit[],
  at: Date,
  seenAt: Date | null,
): Promise<{ changed: boolean; decidedAt: Date | null }> {
  let changed = false;
  let decidedAt: Date | null = null;
  for (const edit of edits) {
    if (edit.field === "at") {
      decidedAt = edit.value ? await addBatchAt(tx, batchId, locationId, at, seenAt) : await finishBatchAt(tx, batchId, locationId, at, seenAt);
      changed = decidedAt !== null || changed;
    } else {
      changed = (await enterRemainingWeight(tx, batchId, locationId, edit, at)) || changed;
    }
  }
  return { changed, decidedAt };
}

/**
 * Records a batch's record as Decaid returned the plugin's write of it (whose
 * fields were `written`), as `recordBeanWritten` does a Bean's: a change the
 * tablet made at its Location since its last report, which the write kept,
 * such as archiving the batch just before the server wrote its global id, is
 * taken in as a report would take it (`editsInAnswer`). The record has seen
 * the Location's decision of the batch's presence that the write carried
 * (`seen`), as Decaid answered after it, if its Machine is still at that
 * Location, or, deciding it itself, its own; null says nothing new, as for
 * an answer to a write no longer awaited.
 */
export async function recordBatchWritten(
  prisma: PrismaService,
  tablet: AnsweringTablet,
  batchId: string,
  written: ReadonlySet<string>,
  record: Record<string, unknown>,
  updatedAt: string | null,
  seen: SeenDecision | null,
): Promise<AnswerRecorded> {
  if (!isRecordId(record.id) || globalIdOf(record) !== batchId.toLowerCase()) return "notTheItem";
  const localId = record.id;
  return prisma.$transaction(async (tx): Promise<AnswerRecorded> => {
    if (!(await lockHeldMachine(tx, tablet))) return "released";
    await lockTablet(tx, tablet.tabletId);
    if ((await tx.beanBatch.count({ where: { id: batchId } })) === 0) return "notTheItem";
    const other = await tx.tabletBeanBatch.findUnique({ where: { tabletId_localId: { tabletId: tablet.tabletId, localId } }, select: { batchId: true } });
    if (other && other.batchId !== batchId) return "notTheItem";
    const locationId = await currentLocation(tx, tablet.machineId);
    const [known] = await tx.$queryRaw<{ archived: boolean; weightRemaining: number | null; seenAt: Date | null }[]>`
      SELECT (record ->> 'archived') = 'true' AS archived, ${seenAtSql(locationId)} AS "seenAt",
        CASE WHEN jsonb_typeof(record -> 'weightRemaining') = 'number' THEN (record ->> 'weightRemaining')::double precision END AS "weightRemaining"
      FROM tablet_bean_batches WHERE tablet_id = ${tablet.tabletId}::uuid AND batch_id = ${batchId}::uuid`;
    const at = updatedAt === null ? null : new Date(updatedAt);
    const edits = editsInAnswer(known ?? null, record, written);
    let decided: SeenDecision | null = null;
    if (locationId !== null && edits.length > 0) {
      await lockLocation(tx, locationId);
      const applied = await applyEdits(tx, batchId, locationId, edits, at ?? (await transactionTime(tx)), known?.seenAt ?? null);
      if (applied.changed) await notify(tx, "library_changes", locationId);
      decided = applied.decidedAt === null ? null : { at: applied.decidedAt, locationId };
    }
    await saveRecord(tx, tablet.tabletId, batchId, localId, record, at, decided ?? (seen?.locationId === locationId ? seen : null));
    return "recorded";
  }, INTAKE_TRANSACTION);
}

/**
 * Saves the tablet's record of a batch as the one it holds, under its local
 * id, as `saveRecord` in beans.ts does a Bean's, with a decision of the
 * batch's presence at its Location it has now seen (`seen`): one the
 * server's write carried, or one its own edit made. It keeps the latest it
 * has seen at one Location (`keepSeenSql`): a write planned before the
 * tablet's own later decision, such as one of a remaining weight answered
 * after a report that archived the batch, shows that decision no less. Null
 * keeps the one known.
 */
async function saveRecord(
  tx: Prisma.TransactionClient,
  tabletId: string,
  batchId: string,
  localId: string,
  record: Record<string, unknown>,
  updatedAt: Date | null,
  seen: SeenDecision | null,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO tablet_bean_batches (tablet_id, batch_id, local_id, record, record_updated_at, seen_at, seen_location_id)
    VALUES (${tabletId}::uuid, ${batchId}::uuid, ${localId}, ${JSON.stringify(record)}::jsonb, ${updatedAt}::timestamptz,
      ${seen?.at ?? null}::timestamptz, ${seen?.locationId ?? null}::uuid)
    ON CONFLICT (tablet_id, batch_id) DO UPDATE SET
      local_id = EXCLUDED.local_id, record = EXCLUDED.record, record_updated_at = EXCLUDED.record_updated_at, ${keepSeenSql("tablet_bean_batches")}`;
}
