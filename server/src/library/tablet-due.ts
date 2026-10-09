import { Prisma } from "../generated/prisma/client.js";
import type { PrismaService } from "../prisma.service.js";
import type { DeletedKind } from "@decent-sync/protocol";
import {
  type HeldRecord,
  type LocationBatch,
  type OfferedBean,
  type OfferedGrinder,
  type PlannedChange,
  type PlannedDelete,
  type ShownProfile,
  deleteKey,
  plannedWrites,
  writeKey,
} from "./holdings.js";
import { shotNamesProfileSql } from "./hard-deletes.js";
import { settingsDue } from "./location-settings.js";
import { latestDecision, readFieldEdits } from "./merge.js";
import { profileText } from "./profile-intake.js";

// What a connection's tablet is due: the next write that brings it to what
// its Machine's Location offers, and each record it holds to its item's
// content (holdings.ts), its Workflow to the Location's steam, hot water
// and rinse settings (location-settings.ts), and the deletes of its records
// of items an Admin hard-deleted (hard-deletes.ts), read from the database
// each time, so it reflects changes made through any instance.

/** A connection whose tablet is written to: its session, which must still hold its Machine, the Machine and its tablet. */
export interface WrittenTablet {
  sessionId: string;
  machineId: string;
  tabletId: string;
}

/** What a connection's tablet is due: where its Machine is now, and the writes due there. */
export interface TabletDue {
  /** The Location its Machine is at now, or null if none. */
  locationId: string | null;
  /** The writes and deletes due, in the order they are made; null while none is planned, as the Machine is not where they were reported. */
  writes: PlannedChange[] | null;
}

/**
 * Where the connection's Machine is now, and the writes its tablet is due,
 * leaving out the items in `skipped` (`writeKey`). No write is due while
 * the Machine is not at the Location its tablet's latest reports of its
 * beans, bean batches, grinders and profiles were all taken in at (`reportedAt`), so a
 * tablet is written only what the Library knows it lacks once what it holds
 * is taken in there, and a bean it holds already is linked rather than
 * written again. Read in one snapshot. Null while the connection no longer
 * holds its Machine.
 */
export async function tabletDue(
  prisma: PrismaService,
  tablet: WrittenTablet,
  reportedAt: string | null,
  skipped: ReadonlySet<string>,
): Promise<TabletDue | null> {
  return prisma.$transaction(
    async (tx) => {
      const [holder] = await tx.$queryRaw<{ locationId: string | null }[]>`
        SELECT (
          SELECT location_id FROM location_assignments WHERE machine_id = machines.id ORDER BY effective_from DESC LIMIT 1
        ) AS "locationId"
        FROM machines WHERE id = ${tablet.machineId}::uuid AND connected_session_id = ${tablet.sessionId}::uuid`;
      if (!holder) return null;
      const { locationId } = holder;
      if (locationId === null || locationId !== reportedAt) return { locationId, writes: null };
      // Each with the latest decision of whether any of its batches is there: a write to the Bean carries it.
      const beans = await tx.$queryRaw<(Omit<OfferedBean, "contentDecidedAt"> & Edited)[]>`
        SELECT beans.id, beans.content, ${presenceDecidedSql(Prisma.raw("beans.id"), locationId)} AS "decidedAt", beans.field_edits AS "fieldEdits" FROM beans
        WHERE NOT beans.archived AND (
          EXISTS (SELECT 1 FROM bean_origins AS origin WHERE origin.bean_id = beans.id AND origin.location_id = ${locationId}::uuid)
          OR EXISTS (
            SELECT 1 FROM bean_batches AS batch
            JOIN batch_locations AS here ON here.batch_id = batch.id AND here.location_id = ${locationId}::uuid
            WHERE batch.bean_id = beans.id AND NOT batch.archived AND here.added_at IS NOT NULL AND here.finished_at IS NULL
          )
        )
        ORDER BY beans.created_at, beans.id`;
      // The batches the Location offers, then the others the tablet holds, each with its state there.
      const batches = await tx.$queryRaw<(Omit<LocationBatch, "remainingWeight" | "contentDecidedAt"> & Edited & { remainingWeight: number | null; entered: boolean })[]>`
        SELECT batch.id, batch.bean_id AS "beanId", batch.content, batch.field_edits AS "fieldEdits",
          (here.added_at IS NOT NULL AND here.finished_at IS NULL AND NOT batch.archived AND NOT bean.archived) AS offered,
          here.remaining_weight AS "remainingWeight", here.remaining_weight_at IS NOT NULL AS entered, here.presence_decided_at AS "decidedAt"
        FROM bean_batches AS batch
        JOIN beans AS bean ON bean.id = batch.bean_id
        LEFT JOIN batch_locations AS here ON here.batch_id = batch.id AND here.location_id = ${locationId}::uuid
        WHERE (here.added_at IS NOT NULL AND here.finished_at IS NULL AND NOT batch.archived AND NOT bean.archived)
          OR EXISTS (SELECT 1 FROM tablet_bean_batches AS held WHERE held.batch_id = batch.id AND held.tablet_id = ${tablet.tabletId}::uuid)
        ORDER BY 5 DESC, batch.created_at, batch.id`;
      // Each record the tablet holds, with its item's content, which a write to it carries.
      const heldBeans = await tx.$queryRaw<HeldRow[]>`
        SELECT held.bean_id AS "itemId", held.local_id AS "localId", held.record, ${presenceDecidedSql(Prisma.raw("held.bean_id"), locationId)} AS "decidedAt",
          beans.content, beans.field_edits AS "fieldEdits"
        FROM tablet_beans AS held JOIN beans ON beans.id = held.bean_id WHERE held.tablet_id = ${tablet.tabletId}::uuid ORDER BY held.bean_id`;
      const heldBatches = await tx.$queryRaw<HeldRow[]>`
        SELECT held.batch_id AS "itemId", held.local_id AS "localId", held.record, batch.content, batch.field_edits AS "fieldEdits"
        FROM tablet_bean_batches AS held JOIN bean_batches AS batch ON batch.id = held.batch_id
        WHERE held.tablet_id = ${tablet.tabletId}::uuid ORDER BY held.batch_id`;
      const grinders = await tx.$queryRaw<(Omit<OfferedGrinder, "contentDecidedAt"> & Edited)[]>`
        SELECT id, content, field_edits AS "fieldEdits" FROM grinders WHERE location_id = ${locationId}::uuid AND NOT archived ORDER BY created_at, id`;
      const heldGrinders = await tx.$queryRaw<HeldRow[]>`
        SELECT held.grinder_id AS "itemId", held.local_id AS "localId", held.record, grinders.content, grinders.field_edits AS "fieldEdits"
        FROM tablet_grinders AS held JOIN grinders ON grinders.id = held.grinder_id WHERE held.tablet_id = ${tablet.tabletId}::uuid ORDER BY held.grinder_id`;
      // Each Profile's content only where the tablet lacks it, to create its record with: what a Location shows is many and large.
      const profiles = await tx.$queryRaw<(Omit<ShownProfile, "contentDecidedAt"> & Edited)[]>`
        SELECT profiles.id, profiles.bundled, here.decided_at AS "decidedAt", profiles.field_edits AS "fieldEdits",
          CASE WHEN held.profile_id IS NULL AND NOT profiles.bundled THEN profiles.content END AS content
        FROM profiles
        JOIN profile_locations AS here ON here.profile_id = profiles.id AND here.location_id = ${locationId}::uuid AND here.shown
        LEFT JOIN tablet_profiles AS held ON held.profile_id = profiles.id AND held.tablet_id = ${tablet.tabletId}::uuid
        WHERE NOT profiles.archived
        ORDER BY profiles.created_at, profiles.id`;
      // Each with when the Location last decided whether it shows it: a write hiding it carries that decision. Only a Profile's
      // visibility and its title, author and notes are compared, of each record and of a user's Profile's content.
      const heldProfiles = await tx.$queryRaw<HeldRow[]>`
        SELECT held.profile_id AS "itemId", held.profile_id AS "localId",
          jsonb_build_object('visibility', held.record -> 'visibility', 'profile', ${profileTextSql(Prisma.raw("held.record"))}) AS record,
          here.decided_at AS "decidedAt", CASE WHEN NOT profiles.bundled THEN jsonb_build_object('profile', ${profileTextSql(Prisma.raw("profiles.content"))}) END AS content,
          profiles.field_edits AS "fieldEdits"
        FROM tablet_profiles AS held
        JOIN profiles ON profiles.id = held.profile_id
        LEFT JOIN profile_locations AS here ON here.profile_id = held.profile_id AND here.location_id = ${locationId}::uuid
        WHERE held.tablet_id = ${tablet.tabletId}::uuid ORDER BY held.profile_id`;
      const offer = {
        beans: beans.map(edited),
        batches: batches.map(({ entered, remainingWeight, ...batch }) => ({ ...edited(batch), remainingWeight: entered ? remainingWeight : undefined })),
        grinders: grinders.map(edited),
        profiles: profiles.map(edited),
      };
      const held = {
        beans: heldBeans.map((row) => heldRecord(row)),
        batches: heldBatches.map((row) => heldRecord(row)),
        grinders: heldGrinders.map((row) => heldRecord(row)),
        profiles: heldProfiles.map((row) => heldRecord(row, (content) => profileText(content))),
      };
      // The Location's settings first: they need no item written before them.
      const settings = await settingsDue(tx, tablet, locationId);
      const writes = settings && !skipped.has(writeKey(settings.kind, settings.globalId)) ? [settings] : [];
      return { locationId, writes: [...writes, ...(await deletesDue(tx, tablet.tabletId, skipped)), ...plannedWrites(offer, held, skipped)] };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

/** An item's fields' latest edits, as read with it. */
interface Edited {
  fieldEdits: unknown;
}

/** An item read with its fields' latest edits, with when the latest of them was decided instead. */
function edited<T extends Edited>({ fieldEdits, ...item }: T): Omit<T, "fieldEdits"> & { contentDecidedAt: Date | null } {
  return { ...item, contentDecidedAt: latestDecision(readFieldEdits(fieldEdits)) };
}

/** A record the tablet holds, read with its item's content and its fields' latest edits. */
type HeldRow = Omit<HeldRecord, "content" | "contentDecidedAt"> & Edited & { content: Record<string, unknown> | null };

/** A record the tablet holds, with its item's content as edits merge it (`HeldRecord.content`), read by `values`. */
function heldRecord({ content, fieldEdits, ...row }: HeldRow, values: (content: Record<string, unknown>) => Record<string, unknown> = (content) => content): HeldRecord {
  return { ...row, content: content === null ? null : values(content), contentDecidedAt: latestDecision(readFieldEdits(fieldEdits)) };
}

/** A Profile's title, author and notes, from a record or content holding its `profile`, as a JSON object. */
function profileTextSql(value: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`jsonb_build_object('title', ${value} -> 'profile' -> 'title', 'author', ${value} -> 'profile' -> 'author', 'notes', ${value} -> 'profile' -> 'notes')`;
}

/** The latest decision of whether any of a Bean's batches is at the Location, by PostgreSQL's clock; null if none was ever decided. */
function presenceDecidedSql(beanId: Prisma.Sql, locationId: string): Prisma.Sql {
  return Prisma.sql`(
    SELECT max(here.presence_decided_at) FROM batch_locations AS here JOIN bean_batches AS batch ON batch.id = here.batch_id
    WHERE batch.bean_id = ${beanId} AND here.location_id = ${locationId}::uuid
  )`;
}

/** The order records are deleted in: a bean's batches before it, as Decaid refuses to delete a bean that has any. */
const DELETE_ORDER: readonly DeletedKind[] = ["beanBatch", "bean", "grinder", "profile"];

/**
 * The tablet's records of hard-deleted items still to be deleted there, but
 * those in `skipped` (`deleteKey`), and a batch or Grinder record a Shot
 * names by its id, or a Profile's a Shot used, as one the tablet pulled, or
 * sent, after the item was deleted: that record is kept on its tablet, out
 * of the Library, and so is the record of a batch's Bean there, as the
 * plugin deletes a bean's batches with it. Nor is a Profile's record whose
 * id the Library has again, as when a barista saved the same profile since:
 * it is that Profile's, and the tablet's next report takes it in.
 */
async function deletesDue(tx: Prisma.TransactionClient, tabletId: string, skipped: ReadonlySet<string>): Promise<PlannedDelete[]> {
  const rows = await tx.$queryRaw<{ kind: DeletedKind; localId: string; itemId: string }[]>`
    SELECT kind, local_id AS "localId", item_id AS "itemId" FROM tablet_deletions AS due
    WHERE tablet_id = ${tabletId}::uuid
      AND NOT (kind = 'beanBatch' AND EXISTS (SELECT 1 FROM shots WHERE shots.bean_batch_id = due.local_id))
      AND NOT (kind = 'grinder' AND EXISTS (SELECT 1 FROM shots WHERE shots.grinder_id = due.local_id))
      AND NOT (kind = 'bean' AND EXISTS (
        SELECT 1 FROM tablet_deletions AS batch JOIN shots ON shots.bean_batch_id = batch.local_id
        WHERE batch.tablet_id = due.tablet_id AND batch.kind = 'beanBatch' AND batch.bean_local_id = due.local_id
      ))
      AND NOT (kind = 'profile' AND (
        ${shotNamesProfileSql(Prisma.sql`due.local_id`, Prisma.sql`due.profile_steps`)}
        -- Joined the Library again: the record is the Library's Profile's.
        OR EXISTS (SELECT 1 FROM profiles WHERE profiles.id = due.local_id)
      ))
    ORDER BY local_id`;
  return rows
    .filter((row) => DELETE_ORDER.includes(row.kind) && !skipped.has(deleteKey(row.kind, row.localId)))
    .sort((a, b) => DELETE_ORDER.indexOf(a.kind) - DELETE_ORDER.indexOf(b.kind))
    .map((row) => ({ delete: true, kind: row.kind, globalId: row.itemId, localId: row.localId }));
}
