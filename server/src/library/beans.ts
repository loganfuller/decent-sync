import { GLOBAL_ID_KEY, globalIdOf, isRecordId } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import type { PrismaService } from "../prisma.service.js";
import { archivingInAnswer, beanContent, planIntake, readReportedBeans } from "./bean-intake.js";
import { editContent, lockItems, recordJoined, recordLinked } from "./content-edits.js";
import { tabletSource } from "./history.js";
import {
  type AnswerRecorded,
  type AnsweringTablet,
  INTAKE_TRANSACTION,
  type ReportingTablet,
  type SeenDecision,
  currentLocation,
  keepContentSeenSql,
  keepSeenSql,
  lockHeldMachine,
  lockTablet,
  seenAtSql,
} from "./intake.js";
import { listedIds } from "./listed.js";
import { deletedAt, lockLocation, offerBeanAt, takeBeanFrom, transactionTime } from "./location-state.js";
import { changedFields, heldBefore } from "./merge.js";

// The Library's Beans and the tablets that hold them (ADR-0003, ADR-0006,
// ADR-0008, ADR-0018, ADR-0019). A tablet at a Location reports its beans as
// a collection; new ones join the Library at that Location, or are linked to
// a Library Bean with the same roaster and name. Archiving or deleting one
// on the tablet takes it away from that Location, and un-archiving it offers
// it there again (location-state.ts). The instance holding each of a
// Location's tablets' connections writes it what the Location offers
// (server/src/sync/tablet-writer.ts). The server keeps, per tablet, each
// Bean's local id there, the record as the tablet last had it, and the
// latest decision of its batches' presence at the Location that a write to
// the record carried, by which taking the Bean away is judged (ADR-0020).
//
// Everything that changes a tablet's map holds its tablet's row lock, so
// reports and the answers to writes are decided one at a time, on any
// instance. A report's new Beans are matched against the Library under one
// advisory lock, so two tablets entering the same coffee at once make one
// Bean. What it changes at the Location is decided under the Location's
// lock. A Bean's content is edited under its row lock, taken last, for every
// Bean the report edits at once (content-edits.ts). Locks are taken in that
// order, after the reporting Machine's.

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
  const mapped = await tx.$queryRaw<
    {
      beanId: string;
      localId: string;
      updatedAt: Date | null;
      globalId: string | null;
      archived: boolean;
      record: Record<string, unknown>;
      seenAt: Date | null;
      contentSeenAt: Date | null;
      savedAt: Date | null;
    }[]
  >`
    SELECT bean_id AS "beanId", local_id AS "localId", record_updated_at AS "updatedAt", record,
      lower(record -> 'extras' ->> ${GLOBAL_ID_KEY}::text) AS "globalId", (record ->> 'archived') = 'true' AS archived, ${seenAtSql(locationId)} AS "seenAt",
      content_seen_at AS "contentSeenAt", record_saved_at AS "savedAt"
    FROM tablet_beans WHERE tablet_id = ${tablet.tabletId}::uuid`;
  /** The latest decision of its batches' presence at the Location that each record the map holds has seen there. */
  const seenAt = new Map(mapped.map((bean) => [bean.beanId, bean.seenAt]));
  /** The latest edit of its content that each record the map holds has seen. */
  const contentSeenAt = new Map(mapped.map((bean) => [bean.beanId, bean.contentSeenAt]));
  /** When each record the map holds was saved, by PostgreSQL's clock. */
  const savedAt = new Map(mapped.map((bean) => [bean.beanId, bean.savedAt]));
  /** The content of each record the map holds, as the tablet last had it. */
  const knownContent = new Map(mapped.map((bean) => [bean.beanId, beanContent(bean.record)]));
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
  // The Beans whose content the report edits, or that records link to, compared with their content.
  await lockItems(
    tx,
    "bean",
    steps.flatMap((step) => ((step.kind === "update" && Object.keys(step.content).length > 0) || step.kind === "link" ? [step.beanId] : [])),
  );
  const source = tabletSource(tablet);

  /** Whether the Location's tablets, this one included, may have something to be written. */
  let writesDue = false;
  for (const step of steps) {
    if (step.kind === "delete") {
      await tx.$executeRaw`DELETE FROM tablet_beans WHERE tablet_id = ${tablet.tabletId}::uuid AND bean_id = ${step.beanId}::uuid`;
      await takeBeanFrom(tx, step.beanId, locationId, deletedAt(await transactionTime(tx), step.updatedAt), seenAt.get(step.beanId) ?? null, source);
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
      await recordJoined(tx, { kind: "bean", id: beanId }, beanContent(bean.record), bean.updatedAt, source);
    } else {
      beanId = step.beanId;
    }
    // A linked record takes the Bean's content: each field it held otherwise is kept as a Conflict (ADR-0018).
    if (step.kind === "link") await recordLinked(tx, { kind: "bean", id: beanId }, beanContent(bean.record), bean.updatedAt, source);
    if (step.kind === "update") {
      const edit = { values: step.content, at: bean.updatedAt, seenAt: contentSeenAt.get(beanId) ?? null, had: heldBefore(knownContent.get(beanId) ?? {}, step.content), heldAt: savedAt.get(beanId) ?? null };
      writesDue = (await editContent(tx, { kind: "bean", id: beanId }, edit, source)) || writesDue;
    }
    if (step.kind === "add" || step.kind === "link") {
      // One archived on the tablet joins the Library, but is not offered at its Location.
      if (!bean.archived) await offerBeanAt(tx, beanId, locationId);
      writesDue = true;
    } else if (step.kind === "map") {
      // The tablet holds it as the Location has it, or is written so.
      writesDue = true;
    } else if (step.archived === true) {
      writesDue = (await takeBeanFrom(tx, beanId, locationId, bean.updatedAt, seenAt.get(beanId) ?? null, source)) || writesDue;
    } else if (step.archived === false) {
      writesDue = (await offerBeanAt(tx, beanId, locationId)) || writesDue;
    }
    // A report shows nothing of what the tablet saw of others' decisions. Nor does its own archiving, which may
    // leave batches added since in place: one time of the record's could not say which it saw.
    await saveRecord(tx, tablet.tabletId, beanId, bean.localId, bean.record, bean.updatedAt, null, null);
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
 * the write kept (`written`, the fields it set), means at the tablet's
 * Location what it would in a report. Recorded only while the answering
 * connection holds its Machine, under the Machine's, the tablet's and the
 * Location's locks, in the order a report takes them. The record has seen
 * the latest decision of the Bean's batches' presence at the Location that
 * the write carried (`seen`), as Decaid answered after it, if its Machine is
 * still at that Location, and the latest edit of the Bean's content the write
 * carried (`contentSeen`); null says nothing new, as for an answer to a write
 * no longer awaited. A field of its content the write did not set that
 * differs from the record known was edited on the tablet since its last
 * report, and is merged as a report's edit would be (ADR-0020). A record the
 * plugin `linked` to the Bean, a bean of the same roaster and name entered
 * there before the tablet reported it, takes the Bean's content, each field
 * it held otherwise kept as a Conflict (ADR-0018). Nothing is recorded when
 * the record does not carry the
 * Bean's global id, when the map holds the record as another Bean's, or when
 * the Library no longer has the Bean, and writing the Bean again would
 * change nothing.
 */
export async function recordBeanWritten(
  prisma: PrismaService,
  tablet: AnsweringTablet,
  beanId: string,
  written: ReadonlySet<string>,
  record: Record<string, unknown>,
  updatedAt: string | null,
  seen: SeenDecision | null,
  contentSeen: Date | null,
  linked: boolean,
): Promise<AnswerRecorded> {
  if (!isRecordId(record.id) || globalIdOf(record) !== beanId.toLowerCase()) return "notTheItem";
  const localId = record.id;
  return prisma.$transaction(async (tx): Promise<AnswerRecorded> => {
    if (!(await lockHeldMachine(tx, tablet))) return "released";
    await lockTablet(tx, tablet.tabletId);
    if ((await tx.bean.count({ where: { id: beanId } })) === 0) return "notTheItem";
    const other = await tx.tabletBean.findUnique({ where: { tabletId_localId: { tabletId: tablet.tabletId, localId } }, select: { beanId: true } });
    if (other && other.beanId !== beanId) return "notTheItem";
    const locationId = await currentLocation(tx, tablet.machineId);
    const [known] = await tx.$queryRaw<{ archived: boolean; seenAt: Date | null; record: Record<string, unknown>; contentSeenAt: Date | null; savedAt: Date | null }[]>`
      SELECT (record ->> 'archived') = 'true' AS archived, ${seenAtSql(locationId)} AS "seenAt", record, content_seen_at AS "contentSeenAt", record_saved_at AS "savedAt"
      FROM tablet_beans WHERE tablet_id = ${tablet.tabletId}::uuid AND bean_id = ${beanId}::uuid`;
    const at = updatedAt === null ? null : new Date(updatedAt);
    const archived = archivingInAnswer(known?.archived ?? null, record, written);
    const source = tabletSource(tablet);
    if (locationId !== null && archived !== undefined) {
      await lockLocation(tx, locationId);
      // The tablet archived it before Decaid answered: judged by what the record had seen before.
      const changed = archived
        ? await takeBeanFrom(tx, beanId, locationId, at ?? (await transactionTime(tx)), known?.seenAt ?? null, source)
        : await offerBeanAt(tx, beanId, locationId);
      if (changed) await notify(tx, "library_changes", locationId);
    }
    const item = { kind: "bean", id: beanId } as const;
    let contentChanged = false;
    if (known) {
      // Edited on the tablet before Decaid answered: judged by what the record had seen before.
      const edited = Object.fromEntries(Object.entries(changedFields(beanContent(known.record), beanContent(record))).filter(([field]) => !written.has(field)));
      const edit = { values: edited, at: at ?? (await transactionTime(tx)), seenAt: known.contentSeenAt, had: heldBefore(beanContent(known.record), edited), heldAt: known.savedAt };
      contentChanged = await editContent(tx, item, edit, source);
    } else if (linked) {
      contentChanged = await recordLinked(tx, item, beanContent(record), at ?? (await transactionTime(tx)), source);
    }
    if (contentChanged && locationId !== null) await notify(tx, "library_changes", locationId);
    await saveRecord(tx, tablet.tabletId, beanId, localId, record, at, seen?.locationId === locationId ? seen : null, contentSeen);
    return "recorded";
  }, INTAKE_TRANSACTION);
}

/**
 * Saves the tablet's record of a Bean as the one it holds, under its local
 * id, with the latest decision of its batches' presence at its Location it
 * has now seen (`seen`): one the server's write carried. Its own archiving
 * does not count, as it may leave batches added since in place, which one
 * time could not tell apart. It keeps the latest it has seen at one Location
 * (`keepSeenSql`); null keeps the one known. So does it keep the latest edit
 * of the Bean's content it has seen (`contentSeen`), one the server's write
 * carried. Whether a reported record
 * replaces the one known is decided by `planIntake`, under the tablet's row
 * lock; a record Decaid has just returned for a write always does.
 */
async function saveRecord(
  tx: Prisma.TransactionClient,
  tabletId: string,
  beanId: string,
  localId: string,
  record: Record<string, unknown>,
  updatedAt: Date | null,
  seen: SeenDecision | null,
  contentSeen: Date | null,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO tablet_beans (tablet_id, bean_id, local_id, record, record_updated_at, seen_at, seen_location_id, content_seen_at, record_saved_at)
    VALUES (${tabletId}::uuid, ${beanId}::uuid, ${localId}, ${JSON.stringify(record)}::jsonb, ${updatedAt}::timestamptz,
      ${seen?.at ?? null}::timestamptz, ${seen?.locationId ?? null}::uuid, ${contentSeen}::timestamptz, clock_timestamp())
    ON CONFLICT (tablet_id, bean_id) DO UPDATE SET
      local_id = EXCLUDED.local_id, record = EXCLUDED.record, record_saved_at = EXCLUDED.record_saved_at, record_updated_at = EXCLUDED.record_updated_at, ${keepSeenSql("tablet_beans")},
      ${keepContentSeenSql("tablet_beans")}`;
}
