import { LIBRARY_ITEM_KINDS, dye2GlobalIdOf, dye2Records, isRecordId } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import type { PrismaService } from "../prisma.service.js";
import { type EditOutcome, editContent, holdsWrittenContent, lockItems, recordJoined, recordLinked } from "./content-edits.js";
import { type MappedEquipment, beforeWriteAfter, equipmentContent, heldBefore, planEquipmentIntake, readReportedEquipment } from "./equipment-intake.js";
import { setAsideDeleted } from "./hard-deletes.js";
import { tabletSource } from "./history.js";
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
import { standing } from "./join-plan.js";
import { currentEntry, takenIn } from "./joining.js";
import { leaveOut, offersAny, screenLeftOut } from "./left-out.js";
import { listedIds } from "./listed.js";
import { deletedAt, lockLocation, showAt, transactionTime } from "./location-state.js";
import { changedFields } from "./merge.js";

// The Library's Baskets and Tools and the tablets that hold them (ADR-0005,
// ADR-0006, ADR-0008, ADR-0018, ADR-0019): DYE2's baskets and equipment,
// which DYE2 keeps whole in a list under one key of Decaid's store, since
// Decaid has no resource for them. A tablet at a Location reports each list
// as a collection; new records join the Library, shown at that Location
// only, or are linked to a Library item of the same name, but for those the
// Library leaves out as the tablet joins the Location (left-out.ts). An edit
// of one on a tablet is merged per field (content-edits.ts, ADR-0020),
// timed by when the plugin first read it, as DYE2's records carry no edit
// time, and reaches every tablet that holds it. Deleting a Tool on a tablet
// hides it at that Location (location-state.ts); DYE2 cannot delete a
// Basket. DYE2 cannot archive or hide a record either, so one its Location
// does not show is removed from the tablet's list (`LibraryRemove`). Every
// record carries its global id in a top-level field of its own, which DYE2
// and Streamline keep when they save, beside the server's map per tablet.
//
// A list in a shape neither the plugin nor the server recognises
// (`dye2Records`) is neither taken in nor written to on that tablet until it
// is reported in one they do, and shows in its Machine's sharing status
// (`tablet_unrecognised_lists`); the tablet's other lists keep syncing.
//
// Under the locks beans.ts takes, in the same order: the Machine's row, the
// tablet's, the kind's matching lock for a report with records new to the
// map, the Location's, then the items' rows.

/** The kinds DYE2 keeps that are Library items: its baskets, and its tools (DYE2's equipment). */
export type EquipmentKind = "basket" | "tool";

/** Whether a kind is one DYE2 keeps that is a Library item. */
export function isEquipmentKind(kind: string): kind is EquipmentKind {
  return kind === "basket" || kind === "tool";
}

/** Each kind's tables: its items', and each tablet's map of its records, with the column there naming the item. */
const TABLES: Readonly<Record<EquipmentKind, { table: string; map: string; column: string; matchingLock: number }>> = {
  basket: { table: "baskets", map: "tablet_baskets", column: "basket_id", matchingLock: 4_000_009 },
  tool: { table: "tools", map: "tablet_tools", column: "tool_id", matchingLock: 4_000_010 },
};

/** Holds the lock the kind's new records are matched by name under until the transaction ends, so two tablets entering the same one at once make one. */
async function lockMatching(tx: Prisma.TransactionClient, kind: EquipmentKind): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${TABLES[kind].matchingLock}::bigint)`;
}

/**
 * Takes a tablet's report of its list of Baskets or Tools into the Library,
 * as `takeInBeans` takes its beans, in the transaction storing the report,
 * if its Machine takes part. A list in a shape that is not recognised takes
 * nothing in, and keeps the tablet's map as it was, so nothing it held reads
 * as deleted: it is marked so for the tablet, which its writer then writes
 * nothing to. Returns where the report was taken in (`standing`), or null if
 * nowhere.
 */
export async function takeInEquipment(
  tx: Prisma.TransactionClient,
  kind: EquipmentKind,
  tablet: ReportingTablet,
  value: unknown,
  updatedAt: readonly (string | null)[] | undefined,
): Promise<string | null> {
  const entry = await currentEntry(tx, tablet.machineId);
  if (entry === null) return null;
  const { locationId } = entry;
  /** Where it is taken in, which its writer compares with where the Machine takes part as it looks. */
  const takenInAt = standing(entry);
  await lockTablet(tx, tablet.tabletId);
  const recognised = dye2Records(value) !== null;
  if (await markUnrecognised(tx, tablet.tabletId, kind, !recognised)) await notify(tx, "library_changes", locationId);
  if (!recognised) return takenInAt;
  const { map, column } = TABLES[kind];
  /** Whether the report is part of the tablet joining the Location, so takes nothing of the tablet's into the Library (left-out.ts). */
  const joining = await takenIn(tx, tablet.tabletId, LIBRARY_ITEM_KINDS[kind].list, entry);
  const read = readReportedEquipment(value, updatedAt);
  const listed = listedIds(value);
  const mapped = await tx.$queryRaw<(MappedEquipment & { seenAt: Date | null; contentSeenAt: Date | null })[]>`
    SELECT ${Prisma.raw(column)}::text AS "itemId", local_id AS "localId", record_updated_at AS "updatedAt", record, before_write AS "beforeWrite", listed,
      ${seenAtSql(locationId)} AS "seenAt", content_seen_at AS "contentSeenAt"
    FROM ${Prisma.raw(map)} WHERE tablet_id = ${tablet.tabletId}::uuid`;
  /** The Location's latest decision of each item that the tablet's record of it has seen there. */
  const seenAt = new Map(mapped.map((record) => [record.itemId, record.seenAt]));
  /** The latest edit of its content that each record the map holds has seen. */
  const contentSeenAt = new Map(mapped.map((record) => [record.itemId, record.contentSeenAt]));
  const mappedById = new Map(mapped.map((record) => [record.itemId, record]));
  const mappedIds = new Set(mapped.map((record) => record.localId));
  // A record the server's write created is listed now, so gone from a later report it was deleted there.
  const newlyListed = mapped.filter((record) => !record.listed && listed.has(record.localId)).map((record) => record.localId);
  if (newlyListed.length > 0) {
    await tx.$executeRaw`UPDATE ${Prisma.raw(map)} SET listed = true WHERE tablet_id = ${tablet.tabletId}::uuid AND local_id = ANY(${newlyListed}::text[])`;
  }
  // Records of items an Admin hard-deleted are deleted on the tablet rather than taken in.
  const screened = await setAsideDeleted(tx, tablet.tabletId, kind, read, listed, mappedIds);
  const reportedNew = screened.kept.filter((record) => !mappedIds.has(record.localId));
  /** Whether the report joins a Location that shows none of the kind yet, so brings the tablet's own, decided under the Location's lock. */
  let bringing = false;
  if (joining) {
    if (reportedNew.length > 0) await lockMatching(tx, kind);
    await lockLocation(tx, locationId);
    bringing = !(await offersAny(tx, locationId, kind));
  }
  // DYE2's records cannot be set aside, only removed from the list, so one listed is never set aside.
  const left = await screenLeftOut(tx, tablet.tabletId, kind, reportedNew, (record) => ({ localId: record.localId, setAside: false }), listed, mappedIds, joining, true);
  const kept = new Set(left.kept);
  const reported = screened.kept.filter((record) => mappedIds.has(record.localId) || kept.has(record));
  const unmapped = reported.filter((record) => !mappedIds.has(record.localId));
  if (unmapped.length > 0 && !joining) await lockMatching(tx, kind);
  // The items the new records may name: by their global ids, or by name, the oldest first.
  const library =
    unmapped.length === 0
      ? []
      : await tx.$queryRaw<{ id: string; matchKey: string; archived: boolean }[]>`
          SELECT id::text AS id, match_key AS "matchKey", archived FROM ${Prisma.raw(TABLES[kind].table)}
          WHERE id = ANY(${unmapped.flatMap((record) => (record.globalId === null ? [] : [record.globalId]))}::uuid[])
            OR match_key = ANY(${unmapped.map((record) => record.matchKey)}::text[])
          ORDER BY created_at, id`;
  const steps = planEquipmentIntake(reported, mapped, library, listed);
  if (steps.length === 0) {
    if (screened.due || left.due) await notify(tx, "library_changes", locationId);
    return takenInAt;
  }
  await lockLocation(tx, locationId);
  // The items whose content the report edits, or that records link to, compared with their content.
  await lockItems(
    tx,
    kind,
    steps.flatMap((step) => ((step.kind === "update" && !joining && Object.keys(step.content).length > 0) || (step.kind === "link" && !joining) ? [step.itemId] : [])),
  );
  const source = tabletSource(tablet);

  /** Whether the Location's tablets, this one included, may have something to be written. */
  let writesDue = screened.due || left.due;
  for (const step of steps) {
    if (step.kind === "delete" || step.kind === "forget") {
      await tx.$executeRaw`DELETE FROM ${Prisma.raw(map)} WHERE tablet_id = ${tablet.tabletId}::uuid AND ${Prisma.raw(column)} = ${step.itemId}::uuid`;
      // Deleted before the tablet joined, it is written again if the Location shows it; lost as it was written, it is written again.
      if (step.kind === "delete" && !joining) {
        await showAt(tx, kind, step.itemId, locationId, source, false, deletedAt(await transactionTime(tx), step.updatedAt), seenAt.get(step.itemId) ?? null);
      }
      writesDue = true;
      continue;
    }
    const { reported: record } = step;
    // A joining tablet brings its own only to a Location that shows none of the kind yet.
    if (step.kind === "add" && joining && !bringing) {
      writesDue = (await leaveOut(tx, tablet.tabletId, kind, { localId: record.localId, setAside: false })) || writesDue;
      continue;
    }
    let itemId: string;
    /** When the record's own edit decided whether the Location shows the item, which it has seen then; null if it did not. */
    let decided: Date | null = null;
    if (step.kind === "add") {
      const content = equipmentContent(record.record);
      const [created] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO ${Prisma.raw(TABLES[kind].table)} (id, content, match_key, created_location_id)
        VALUES (gen_random_uuid(), ${JSON.stringify(content)}::jsonb, ${record.matchKey}, ${locationId}::uuid)
        RETURNING id::text AS id`;
      itemId = created!.id;
      await recordJoined(tx, { kind, id: itemId }, content, record.updatedAt, source);
      // New, it is shown where it was created only (ADR-0008).
      decided = await showAt(tx, kind, itemId, locationId, source, true, record.updatedAt, null);
      writesDue = true;
    } else {
      itemId = step.itemId;
    }
    if (step.kind === "link") {
      // A linked record takes the item's content: each field it held otherwise is kept as a Conflict (ADR-0018), but as the
      // tablet joins the Location, whose state wins, and which shows it only if it shows none of the kind yet.
      if (!joining) await recordLinked(tx, { kind, id: itemId }, equipmentContent(record.record), record.updatedAt, source);
      if (bringing || !joining) decided = await showAt(tx, kind, itemId, locationId, source, true, record.updatedAt, null);
      writesDue = true;
    } else if (step.kind === "map" || (step.kind === "update" && joining)) {
      // The tablet holds it as the Location has it, or is written so: what it changed before it joined is written over.
      writesDue = true;
    } else if (step.kind === "update") {
      const edit = { values: step.content, at: record.updatedAt, seenAt: contentSeenAt.get(itemId) ?? null };
      await editContent(tx, { kind, id: itemId }, edit, source);
      // The record changed, so may differ from the item now, as a field set back to what it held before the server's write.
      writesDue = true;
    }
    // A record whose global id is lost has it written back.
    if (record.globalId !== itemId) writesDue = true;
    const seen = decided === null ? null : { at: decided, locationId };
    const known = step.kind === "update" ? mappedById.get(itemId) : undefined;
    // A field the tablet set to a value of its own no longer takes setting it back for a stale save.
    const beforeWrite = known ? { beforeWrite: beforeWriteAfter(known.beforeWrite, known.record, record.record) } : {};
    await saveRecord(tx, kind, tablet.tabletId, itemId, record.localId, record.record, record.updatedAt, { seen, contentSeen: null, listed: true, ...beforeWrite });
  }
  if (writesDue) await notify(tx, "library_changes", locationId);
  return takenInAt;
}

/**
 * Marks the tablet's list of the kind as in a shape that is not recognised,
 * or, false, recognised, under the tablet's row lock, and says whether that
 * changed.
 */
export async function markUnrecognised(tx: Prisma.TransactionClient, tabletId: string, kind: EquipmentKind, unrecognised: boolean): Promise<boolean> {
  const list = LIBRARY_ITEM_KINDS[kind].list;
  const changed = unrecognised
    ? await tx.$executeRaw`INSERT INTO tablet_unrecognised_lists (tablet_id, list) VALUES (${tabletId}::uuid, ${list}) ON CONFLICT DO NOTHING`
    : await tx.$executeRaw`DELETE FROM tablet_unrecognised_lists WHERE tablet_id = ${tabletId}::uuid AND list = ${list}`;
  return changed > 0;
}

/**
 * Records that the plugin found the tablet's list of the kind in a shape it
 * does not recognise as it carried out a write (`ListUnrecognised`), under
 * the tablet's row lock, whether or not its connection still holds the
 * Machine: it says only what the tablet holds. Its writer writes nothing
 * more to that list until the tablet reports it in a shape it recognises.
 */
export async function recordUnrecognised(prisma: PrismaService, tabletId: string, kind: EquipmentKind): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockTablet(tx, tabletId);
    await markUnrecognised(tx, tabletId, kind, true);
  });
}

/**
 * Records a Basket's or Tool's record as the plugin wrote it, as
 * `recordBeanWritten` does a Bean's: the tablet's record of that item from
 * now on. A field of its content the write did not set that differs from the
 * record known was edited on the tablet since its last report, and is merged
 * as a report's edit would be (ADR-0020), timed when the plugin wrote it. A
 * record the plugin `linked`, one of the same name entered there before the
 * tablet reported it, takes the item's content, each field it held otherwise
 * kept as a Conflict (ADR-0018). What the record held for each field the
 * write set is kept (`before_write`), so a report setting it back is taken
 * as unchanged, but for a field the write puts back over such a report, so
 * that setting it back again is an edit (`heldBefore`). A record the write
 * created is not yet listed by a report. Recorded only while the answering
 * connection holds its Machine, under the Machine's and the tablet's locks.
 * Nothing is recorded when the record does not carry the item's global id,
 * when the map holds it as another item's, or when the Library no longer
 * has the item.
 */
export async function recordEquipmentWritten(
  prisma: PrismaService,
  kind: EquipmentKind,
  tablet: AnsweringTablet,
  itemId: string,
  written: ReadonlySet<string>,
  record: Record<string, unknown>,
  updatedAt: string | null,
  seen: SeenDecision | null,
  contentSeen: Date | null,
  linked: boolean,
): Promise<AnswerRecorded> {
  if (!isRecordId(record.id) || dye2GlobalIdOf(record) !== itemId.toLowerCase()) return "notTheItem";
  const localId = record.id;
  const { table, map, column } = TABLES[kind];
  return prisma.$transaction(async (tx): Promise<AnswerRecorded> => {
    if (!(await lockHeldMachine(tx, tablet))) return "released";
    await lockTablet(tx, tablet.tabletId);
    const [item] = await tx.$queryRaw<unknown[]>`SELECT 1 FROM ${Prisma.raw(table)} WHERE id = ${itemId}::uuid`;
    if (!item) return "notTheItem";
    const [other] = await tx.$queryRaw<{ itemId: string }[]>`
      SELECT ${Prisma.raw(column)}::text AS "itemId" FROM ${Prisma.raw(map)} WHERE tablet_id = ${tablet.tabletId}::uuid AND local_id = ${localId}`;
    if (other && other.itemId !== itemId.toLowerCase()) return "notTheItem";
    const locationId = await sharingLocation(tx, tablet.machineId);
    const [known] = await tx.$queryRaw<{ record: Record<string, unknown>; contentSeenAt: Date | null; listed: boolean; beforeWrite: Record<string, unknown> | null }[]>`
      SELECT record, content_seen_at AS "contentSeenAt", listed, before_write AS "beforeWrite" FROM ${Prisma.raw(map)}
      WHERE tablet_id = ${tablet.tabletId}::uuid AND ${Prisma.raw(column)} = ${itemId}::uuid`;
    const at = updatedAt === null ? await transactionTime(tx) : new Date(updatedAt);
    const source = tabletSource(tablet);
    const ref = { kind, id: itemId } as const;
    let changed = false;
    let edited: EditOutcome | null = null;
    if (known) {
      // Edited on the tablet before the plugin wrote: judged by what the record had seen before.
      const values = Object.fromEntries(Object.entries(changedFields(equipmentContent(known.record), equipmentContent(record))).filter(([field]) => !written.has(field)));
      edited = await editContent(tx, ref, { values, at, seenAt: known.contentSeenAt }, source);
      changed = edited.writesDue;
    } else if (linked) {
      changed = await recordLinked(tx, ref, equipmentContent(record), at, source);
    }
    if (changed && locationId !== null) await notify(tx, "library_changes", locationId);
    const holds = contentSeen !== null && (await holdsWrittenContent(tx, ref, equipmentContent(record), edited));
    await saveRecord(tx, kind, tablet.tabletId, itemId, localId, record, at, {
      seen: seen?.locationId === locationId ? seen : null,
      contentSeen: holds ? contentSeen : null,
      listed: known?.listed ?? false,
      ...(known && written.size > 0 ? { beforeWrite: heldBefore(known.record, written, known.beforeWrite) } : {}),
    });
    return "recorded";
  }, INTAKE_TRANSACTION);
}

/**
 * The plugin removed the tablet's record from the kind's list, as its
 * Location no longer shows the item, or found it gone: the tablet holds it
 * no more, so its next report does not read it as the tablet's delete, and
 * it is written again should its Location show it once more. Under the
 * tablet's row lock, whether or not the answering connection still holds its
 * Machine: it says only what the tablet holds.
 */
export async function recordEquipmentRemoved(prisma: PrismaService, kind: EquipmentKind, tabletId: string, localId: string): Promise<void> {
  const { map } = TABLES[kind];
  await prisma.$transaction(async (tx) => {
    await lockTablet(tx, tabletId);
    await tx.$executeRaw`DELETE FROM ${Prisma.raw(map)} WHERE tablet_id = ${tabletId}::uuid AND local_id = ${localId}`;
  });
}

/**
 * Saves the tablet's record of an item as the one it holds, under its local
 * id, keeping the latest decision of the item's showing at one Location it
 * has seen (`keepSeenSql`) and the latest edit of its content it has seen;
 * null keeps the one known. `beforeWrite`, when given, replaces what it held
 * before the server's latest write, null for nothing; otherwise that is kept.
 */
async function saveRecord(
  tx: Prisma.TransactionClient,
  kind: EquipmentKind,
  tabletId: string,
  itemId: string,
  localId: string,
  record: Record<string, unknown>,
  updatedAt: Date | null,
  state: { seen: SeenDecision | null; contentSeen: Date | null; listed: boolean; beforeWrite?: Record<string, unknown> | null },
): Promise<void> {
  const { map, column } = TABLES[kind];
  const table = Prisma.raw(map);
  const beforeWrite = state.beforeWrite === undefined || state.beforeWrite === null ? null : JSON.stringify(state.beforeWrite);
  await tx.$executeRaw`
    INSERT INTO ${table} AS held (tablet_id, ${Prisma.raw(column)}, local_id, record, record_updated_at, before_write, listed, seen_at, seen_location_id, content_seen_at)
    VALUES (${tabletId}::uuid, ${itemId}::uuid, ${localId}, ${JSON.stringify(record)}::jsonb, ${updatedAt}::timestamptz, ${beforeWrite}::jsonb, ${state.listed},
      ${state.seen?.at ?? null}::timestamptz, ${state.seen?.locationId ?? null}::uuid, ${state.contentSeen}::timestamptz)
    ON CONFLICT (tablet_id, ${Prisma.raw(column)}) DO UPDATE SET
      local_id = EXCLUDED.local_id, record = EXCLUDED.record, record_updated_at = EXCLUDED.record_updated_at, listed = EXCLUDED.listed,
      before_write = ${state.beforeWrite === undefined ? Prisma.sql`held.before_write` : Prisma.sql`EXCLUDED.before_write`},
      ${keepSeenSql("held")}, ${keepContentSeenSql("held")}`;
}
