import { GLOBAL_ID_KEY, globalIdOf, isRecordId } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import type { PrismaService } from "../prisma.service.js";
import { type LocationEdit, type ReportedBatch, batchContent, editsInAnswer, planBatchIntake, readReportedBatches } from "./batch-intake.js";
import { type EditOutcome, editContent, holdsWrittenContent, lockItems, recordJoined } from "./content-edits.js";
import { type EditSource, tabletSource } from "./history.js";
import {
  type AnswerRecorded,
  type AnsweringTablet,
  INTAKE_TRANSACTION,
  type ReportingTablet,
  type SeenDecision,
  keepContentSeenSql,
  keepSeenSql,
  lockHeldMachine,
  lockTablet,
  seenAtSql,
  sharingLocation,
} from "./intake.js";
import { setAsideDeleted } from "./hard-deletes.js";
import { standing } from "./join-plan.js";
import { currentEntry, takenIn } from "./joining.js";
import { leaveOut, leftOutIds, offersAny, screenLeftOut } from "./left-out.js";
import { listedIds } from "./listed.js";
import { addBatchAt, deletedAt, enterRemainingWeight, finishBatchAt, lockLocation, transactionTime } from "./location-state.js";
import { changedFields } from "./merge.js";

// The Library's Bean Batches and the tablets that hold them (ADR-0006,
// ADR-0008, ADR-0018, ADR-0019). A tablet at a Location reports its batches
// as a collection, after its beans; a new one joins the Library as a batch of
// the Bean its tablet's record of its bean is, at that Location, but for
// those the Library leaves out as the tablet joins the Location, and the
// batches of a bean it leaves out (left-out.ts). On a
// tablet, a batch's `archived` says it is not at the tablet's Location and
// its `weightRemaining` is the remaining weight there: un-archiving one adds
// it there, archiving or deleting it finishes it there, and a new
// `weightRemaining` is the remaining weight there (location-state.ts). The
// server keeps, per tablet, each batch's local id there and the record as
// the tablet last had it, as for Beans (beans.ts), under the same locks. An
// edit of a batch's content is merged per field, as a Bean's is.

/**
 * Takes a tablet's report of its bean batches into the Library, as
 * `takeInBeans` takes its beans, in the transaction storing the report.
 * Returns where the report was taken in (`standing`), or null if nowhere.
 */
export async function takeInBatches(
  tx: Prisma.TransactionClient,
  tablet: ReportingTablet,
  value: unknown,
  updatedAt: readonly (string | null)[] | undefined,
): Promise<string | null> {
  const entry = await currentEntry(tx, tablet.machineId);
  if (entry === null) return null;
  const { locationId } = entry;
  /** Where it is taken in, which its writer compares with where the Machine takes part as it looks. */
  const takenInAt = standing(entry);
  const read = readReportedBatches(value, updatedAt);
  await lockTablet(tx, tablet.tabletId);
  /** Whether the report is part of the tablet joining the Location, so takes nothing of the tablet's into the Library (left-out.ts). */
  const joining = await takenIn(tx, tablet.tabletId, "beanBatches", entry);
  const mapped = await tx.$queryRaw<
    {
      batchId: string;
      localId: string;
      updatedAt: Date | null;
      globalId: string | null;
      archived: boolean;
      weightRemaining: number | null;
      record: Record<string, unknown>;
      seenAt: Date | null;
      contentSeenAt: Date | null;
    }[]
  >`
    SELECT batch_id AS "batchId", local_id AS "localId", record_updated_at AS "updatedAt", ${seenAtSql(locationId)} AS "seenAt", record,
      content_seen_at AS "contentSeenAt",
      lower(record -> 'extras' ->> ${GLOBAL_ID_KEY}::text) AS "globalId", (record ->> 'archived') = 'true' AS archived,
      CASE WHEN jsonb_typeof(record -> 'weightRemaining') = 'number' THEN (record ->> 'weightRemaining')::double precision END AS "weightRemaining"
    FROM tablet_bean_batches WHERE tablet_id = ${tablet.tabletId}::uuid`;
  /** The Location's latest decision of each batch that the tablet's record the map holds has seen there: one decided by then, the tablet had seen. */
  const seenAt = new Map(mapped.map((batch) => [batch.batchId, batch.seenAt]));
  /** The latest edit of its content that each record the map holds has seen. */
  const contentSeenAt = new Map(mapped.map((batch) => [batch.batchId, batch.contentSeenAt]));
  // The Library Beans the tablet's records of its beans are, by their ids there.
  const beans = await tx.tabletBean.findMany({ where: { tabletId: tablet.tabletId }, select: { localId: true, beanId: true } });
  const mappedIds = new Set(mapped.map((batch) => batch.localId));
  // Records of items an Admin hard-deleted are deleted on the tablet rather than taken in.
  const screened = await setAsideDeleted(tx, tablet.tabletId, "beanBatch", read, listedIds(value), mappedIds);
  /** Whether the report joins a Location that offers no batch yet, so brings the tablet's own, decided under the Location's lock. */
  let bringing = false;
  if (joining) {
    await lockLocation(tx, locationId);
    bringing = !(await offersAny(tx, locationId, "beanBatch"));
  }
  const reportedNew = screened.kept.filter((batch) => !mappedIds.has(batch.localId));
  const left = await screenLeftOut(tx, tablet.tabletId, "beanBatch", reportedNew, leftOutRecord, listedIds(value), mappedIds, joining);
  const kept = new Set(left.kept);
  // A batch of a bean the Library leaves out is left out with it as the tablet joins; otherwise it waits for its bean.
  const beansLeftOut = joining ? await leftOutIds(tx, tablet.tabletId, "bean") : new Set<string>();
  let leftOutDue = left.due;
  for (const batch of left.kept) {
    if (!beansLeftOut.has(batch.beanLocalId)) continue;
    kept.delete(batch);
    leftOutDue = (await leaveOut(tx, tablet.tabletId, "beanBatch", leftOutRecord(batch))) || leftOutDue;
  }
  const reported = screened.kept.filter((batch) => mappedIds.has(batch.localId) || kept.has(batch));
  const named = reported.flatMap((batch) => (batch.globalId !== null && !mappedIds.has(batch.localId) ? [batch.globalId] : []));
  const library = named.length === 0 ? [] : await tx.beanBatch.findMany({ where: { id: { in: named } }, select: { id: true } });
  const steps = planBatchIntake(reported, mapped, new Map(beans.map((bean) => [bean.localId, bean.beanId])), library, listedIds(value));
  if (steps.length === 0) {
    if (screened.due || leftOutDue) await notify(tx, "library_changes", locationId);
    return takenInAt;
  }
  await lockLocation(tx, locationId);
  await lockItems(
    tx,
    "beanBatch",
    steps.flatMap((step) => (step.kind === "update" && !joining && Object.keys(step.content).length > 0 ? [step.batchId] : [])),
  );
  const source = tabletSource(tablet);

  /** Whether the Location's tablets, this one included, may have something to be written. */
  let writesDue = screened.due || leftOutDue;
  for (const step of steps) {
    if (step.kind === "delete") {
      await tx.$executeRaw`DELETE FROM tablet_bean_batches WHERE tablet_id = ${tablet.tabletId}::uuid AND batch_id = ${step.batchId}::uuid`;
      // Deleted before the tablet joined, it is written again if the Location offers it.
      if (!joining) {
        const at = deletedAt(await transactionTime(tx), step.updatedAt);
        await applyEdits(tx, step.batchId, locationId, step.edits, at, seenAt.get(step.batchId) ?? null, source);
      }
      writesDue = true;
      continue;
    }
    const { batch } = step;
    // A joining tablet brings only what it offers itself: one it archived stays out, to be taken up if un-archived.
    if (step.kind === "add" && joining && (!bringing || batch.archived)) {
      writesDue = (await leaveOut(tx, tablet.tabletId, "beanBatch", leftOutRecord(batch))) || writesDue;
      continue;
    }
    let batchId: string;
    if (step.kind === "add") {
      const created = await tx.beanBatch.create({
        data: { beanId: step.beanId, content: batchContent(batch.record) as Prisma.InputJsonObject, createdLocationId: locationId },
        select: { id: true },
      });
      batchId = created.id;
      await recordJoined(tx, { kind: "beanBatch", id: batchId }, batchContent(batch.record), batch.updatedAt, source);
    } else {
      batchId = step.batchId;
    }
    // What a joining tablet changed before it joined is written over.
    if (step.kind === "add" || step.kind === "map" || joining) writesDue = true;
    if (step.kind === "update" && !joining) {
      const edit = { values: step.content, at: batch.updatedAt, seenAt: contentSeenAt.get(batchId) ?? null };
      writesDue = (await editContent(tx, { kind: "beanBatch", id: batchId }, edit, source)).writesDue || writesDue;
    }
    const applied =
      step.kind === "map" || (step.kind === "update" && joining)
        ? null
        : await applyEdits(tx, batchId, locationId, step.edits, batch.updatedAt, seenAt.get(batchId) ?? null, source);
    if (applied?.changed) writesDue = true;
    // A report shows nothing of what the tablet saw of others' decisions, only of the one its own edit made.
    const decided = applied?.decidedAt ?? null;
    await saveRecord(tx, tablet.tabletId, batchId, batch.localId, batch.record, batch.updatedAt, decided === null ? null : { at: decided, locationId }, null);
    // A record whose global id is lost has it written back.
    if (batch.globalId !== batchId) writesDue = true;
  }
  if (writesDue) await notify(tx, "library_changes", locationId);
  return takenInAt;
}

/** A reported batch as what the Library leaves out is judged: set aside when archived on the tablet. */
function leftOutRecord(batch: ReportedBatch): { localId: string; setAside: boolean } {
  return { localId: batch.localId, setAside: batch.archived };
}

/**
 * Makes a tablet's changes to a batch at its Location, timed by the edit,
 * from a tablet whose record of the batch had seen the Location's decision of
 * its presence there at `seenAt`, or none, each kept as a version, or, if it
 * lost, as a Conflict (location-state.ts). Says whether any changed the
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
  source: EditSource,
): Promise<{ changed: boolean; decidedAt: Date | null }> {
  let changed = false;
  let decidedAt: Date | null = null;
  for (const edit of edits) {
    if (edit.field === "at") {
      decidedAt = edit.value ? await addBatchAt(tx, batchId, locationId, at, seenAt, source) : await finishBatchAt(tx, batchId, locationId, at, seenAt, source);
      changed = decidedAt !== null || changed;
    } else {
      changed = (await enterRemainingWeight(tx, batchId, locationId, edit, at, source)) || changed;
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
 * Location, or, deciding it itself, its own, and the latest edit of the
 * batch's content the write carried (`contentSeen`), if it holds that content
 * (`holdsWrittenContent`); null says nothing new,
 * as for an answer to a write no longer awaited. A field of its content the
 * write did not set that differs from the record known was edited on the
 * tablet since, and is merged as a report's edit would be (ADR-0020).
 */
export async function recordBatchWritten(
  prisma: PrismaService,
  tablet: AnsweringTablet,
  batchId: string,
  written: ReadonlySet<string>,
  record: Record<string, unknown>,
  updatedAt: string | null,
  seen: SeenDecision | null,
  contentSeen: Date | null,
): Promise<AnswerRecorded> {
  if (!isRecordId(record.id) || globalIdOf(record) !== batchId.toLowerCase()) return "notTheItem";
  const localId = record.id;
  return prisma.$transaction(async (tx): Promise<AnswerRecorded> => {
    if (!(await lockHeldMachine(tx, tablet))) return "released";
    await lockTablet(tx, tablet.tabletId);
    if ((await tx.beanBatch.count({ where: { id: batchId } })) === 0) return "notTheItem";
    const other = await tx.tabletBeanBatch.findUnique({ where: { tabletId_localId: { tabletId: tablet.tabletId, localId } }, select: { batchId: true } });
    if (other && other.batchId !== batchId) return "notTheItem";
    const locationId = await sharingLocation(tx, tablet.machineId);
    const [known] = await tx.$queryRaw<
      { archived: boolean; weightRemaining: number | null; seenAt: Date | null; record: Record<string, unknown>; contentSeenAt: Date | null }[]
    >`
      SELECT (record ->> 'archived') = 'true' AS archived, ${seenAtSql(locationId)} AS "seenAt", record, content_seen_at AS "contentSeenAt",
        CASE WHEN jsonb_typeof(record -> 'weightRemaining') = 'number' THEN (record ->> 'weightRemaining')::double precision END AS "weightRemaining"
      FROM tablet_bean_batches WHERE tablet_id = ${tablet.tabletId}::uuid AND batch_id = ${batchId}::uuid`;
    const at = updatedAt === null ? null : new Date(updatedAt);
    const edits = editsInAnswer(known ?? null, record, written);
    const source = tabletSource(tablet);
    let decided: SeenDecision | null = null;
    let changed = false;
    if (locationId !== null && edits.length > 0) {
      await lockLocation(tx, locationId);
      const applied = await applyEdits(tx, batchId, locationId, edits, at ?? (await transactionTime(tx)), known?.seenAt ?? null, source);
      changed = applied.changed;
      decided = applied.decidedAt === null ? null : { at: applied.decidedAt, locationId };
    }
    let edited: EditOutcome | null = null;
    if (known) {
      // Edited on the tablet before Decaid answered: judged by what the record had seen before.
      const values = Object.fromEntries(Object.entries(changedFields(batchContent(known.record), batchContent(record))).filter(([field]) => !written.has(field)));
      edited = await editContent(tx, { kind: "beanBatch", id: batchId }, { values, at: at ?? (await transactionTime(tx)), seenAt: known.contentSeenAt }, source);
      changed = edited.writesDue || changed;
    }
    if (changed && locationId !== null) await notify(tx, "library_changes", locationId);
    const holds = contentSeen !== null && (await holdsWrittenContent(tx, { kind: "beanBatch", id: batchId }, batchContent(record), edited));
    await saveRecord(tx, tablet.tabletId, batchId, localId, record, at, decided ?? (seen?.locationId === locationId ? seen : null), holds ? contentSeen : null);
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
 * keeps the one known. So does it keep the latest edit of the batch's
 * content it has seen (`contentSeen`).
 */
async function saveRecord(
  tx: Prisma.TransactionClient,
  tabletId: string,
  batchId: string,
  localId: string,
  record: Record<string, unknown>,
  updatedAt: Date | null,
  seen: SeenDecision | null,
  contentSeen: Date | null,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO tablet_bean_batches (tablet_id, batch_id, local_id, record, record_updated_at, seen_at, seen_location_id, content_seen_at)
    VALUES (${tabletId}::uuid, ${batchId}::uuid, ${localId}, ${JSON.stringify(record)}::jsonb, ${updatedAt}::timestamptz,
      ${seen?.at ?? null}::timestamptz, ${seen?.locationId ?? null}::uuid, ${contentSeen}::timestamptz)
    ON CONFLICT (tablet_id, batch_id) DO UPDATE SET
      local_id = EXCLUDED.local_id, record = EXCLUDED.record, record_updated_at = EXCLUDED.record_updated_at, ${keepSeenSql("tablet_bean_batches")},
      ${keepContentSeenSql("tablet_bean_batches")}`;
}
