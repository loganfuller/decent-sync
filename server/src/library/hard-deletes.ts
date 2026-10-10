import type { DeletedKind } from "@decent-sync/protocol";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import type { PrismaService } from "../prisma.service.js";
import { shotLinkedSql } from "../shots/links.js";
import { INTAKE_TRANSACTION, lockTablet } from "./intake.js";
import { lockLocation } from "./location-state.js";

// Hard deletes (ADR-0003, ADR-0019): an Admin removes a Bean, Bean Batch,
// Grinder or Profile no Shot names from the Library and from every tablet that
// holds it, the one thing the server deletes from tablets. A Bean goes with
// its batches, as Decaid refuses to delete a bean that has any. A Shot names a
// batch or Grinder by its id on the tablet that pulled it, so an item whose
// record has that id on any tablet's map is named, as is one a Shot is linked
// to (shots/links.ts), whose record may have left the map since; a Bean is
// named when one of its batches is. A Shot names a Profile by the steps it
// executed, which its Workflow records with the rest of its profile, or by
// the profile id a skin recorded there. Decaid's bundled Profiles, which
// every tablet has and Decaid refuses to delete, are never deleted.
//
// The item is gone from the Library at once, with its versions, Conflicts
// and each Location's state of it. Its global id is kept (`deleted_items`),
// and so is each tablet's record of it (`tablet_deletions`), which that
// tablet's writer deletes (tablet-due.ts), now or once the tablet connects
// again. A record carrying a deleted item's global id that a tablet reports
// later, as one that was offline, or one written it whose answer was lost, is
// not taken in as new: it is deleted there too. A Profile's id is Decaid's,
// a hash of what the machine executes, so a record of it a tablet reports
// later is not told apart from one a barista made again: but for a record a
// delete is due for, it joins the Library anew, as a Profile made there. A
// delete of a Profile's record is due only while the Library lacks that id:
// once the Profile joins it again, the tablet's record is the Library's.
//
// Locks, in the order every other change takes them, so none waits on
// another in turn: the item's open Conflicts, which resolving one locks
// before its Location's lock; the tablets that hold it, whose reports lock
// them before their Location's; the Locations whose state of it changes;
// then the items.

/** An item a hard delete removes: its kind and global id. */
interface Deleted {
  kind: DeletedKind;
  id: string;
}

/**
 * Each kind's table, its tablets' map, the column naming the item in
 * versions, Conflicts and maps, and its id's type. A batch's map names its
 * Bean through the batch's row.
 */
const TABLES: Readonly<Record<DeletedKind, { table: string; map: string; column: string; cast: string }>> = {
  bean: { table: "beans", map: "tablet_beans", column: "bean_id", cast: "uuid" },
  beanBatch: { table: "bean_batches", map: "tablet_bean_batches", column: "batch_id", cast: "uuid" },
  grinder: { table: "grinders", map: "tablet_grinders", column: "grinder_id", cast: "uuid" },
  profile: { table: "profiles", map: "tablet_profiles", column: "profile_id", cast: "text" },
};

const NAMES: Readonly<Record<DeletedKind, string>> = { bean: "Bean", beanBatch: "Bean Batch", grinder: "Grinder", profile: "Profile" };

/**
 * Whether a Shot names a Profile, given its id and its steps, from the
 * `profile` of its content, which Decaid writes as it writes a Shot's
 * Workflow's: the Shot's Workflow's profile has the same steps, found by the
 * index on them, or a skin recorded the Profile's id there. Steps alone are
 * compared, not the rest of what Decaid hashes for a Profile's id
 * (`ProfileHash` in decaid:lib/src/models/data/profile_hash.dart): a skin
 * sets the Workflow's profile's target weight to the Shot's yield, so a
 * Shot pulled with a Profile can hold other targets. Refusing more deletes
 * than Shots used is the safe side. PostgreSQL compares JSON numbers by
 * value, so a whole double Decaid writes as `92.0` equals 92.
 */
export function shotNamesProfileSql(id: Prisma.Sql, steps: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM shots WHERE shots.profile_id = ${id} OR shots.record -> 'workflow' -> 'profile' -> 'steps' = ${steps}
  )`;
}

/**
 * Deletes the item from the Library, a Bean with its batches, and has every
 * tablet that holds it delete its record. 404 if the Library does not have
 * it; 409 if a Shot names it, or for a Bean one of its batches, or it is one
 * of Decaid's bundled Profiles.
 */
export async function hardDelete(prisma: PrismaService, kind: DeletedKind, id: string): Promise<void> {
  // A tablet or Location that comes to hold the item while its locks are taken is found once they are, and the
  // delete starts again, as its locks cannot be taken after the items' in order.
  for (let attempt = 1; ; attempt++) {
    const done = await prisma.$transaction((tx) => deleteOnce(tx, kind, id), INTAKE_TRANSACTION);
    if (done) return;
    if (attempt === 3) throw new ConflictException(`The ${NAMES[kind]} is changing on tablets: try again`);
  }
}

/** Deletes the item as `hardDelete` does, under the locks it needs; false if more came to hold it as they were taken, changing nothing. */
async function deleteOnce(tx: Prisma.TransactionClient, kind: DeletedKind, id: string): Promise<boolean> {
  const items = await deletedWith(tx, kind, id);
  if (items === null) throw new NotFoundException(`No such ${NAMES[kind]}`);
  if (kind === "profile" && (await tx.profile.count({ where: { id, bundled: true } })) > 0) {
    throw new ConflictException("Decaid's bundled Profiles cannot be deleted from tablets: hide it at each Location, or Archive it");
  }
  const byKind = (wanted: DeletedKind) => items.filter((item) => item.kind === wanted).map((item) => item.id);
  const beans = byKind("bean");
  const batches = byKind("beanBatch");
  const grinders = byKind("grinder");
  const profiles = byKind("profile");

  await tx.$queryRaw`
    SELECT 1 FROM conflicts
    WHERE state = 'OPEN' AND (bean_id = ANY(${beans}::uuid[]) OR batch_id = ANY(${batches}::uuid[]) OR grinder_id = ANY(${grinders}::uuid[])
      OR profile_id = ANY(${profiles}::text[]))
    ORDER BY id FOR UPDATE`;
  const holders = async () => ({
    tablets: (
      await tx.$queryRaw<{ id: string }[]>`
        SELECT tablet_id::text AS id FROM tablet_beans WHERE bean_id = ANY(${beans}::uuid[])
        UNION SELECT tablet_id::text FROM tablet_bean_batches WHERE batch_id = ANY(${batches}::uuid[])
        UNION SELECT tablet_id::text FROM tablet_grinders WHERE grinder_id = ANY(${grinders}::uuid[])
        UNION SELECT tablet_id::text FROM tablet_profiles WHERE profile_id = ANY(${profiles}::text[])
        ORDER BY 1`
    ).map((row) => row.id),
    locations: (
      await tx.$queryRaw<{ id: string }[]>`
        SELECT location_id::text AS id FROM batch_locations WHERE batch_id = ANY(${batches}::uuid[])
        UNION SELECT location_id::text FROM bean_origins WHERE bean_id = ANY(${beans}::uuid[])
        UNION SELECT location_id::text FROM grinders WHERE id = ANY(${grinders}::uuid[]) AND location_id IS NOT NULL
        UNION SELECT location_id::text FROM profile_locations WHERE profile_id = ANY(${profiles}::text[])
        ORDER BY 1`
    ).map((row) => row.id),
  });
  const locked = await holders();
  for (const tabletId of locked.tablets) await lockTablet(tx, tabletId);
  for (const locationId of locked.locations) await lockLocation(tx, locationId);
  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    await tx.$queryRaw`SELECT 1 FROM ${Prisma.raw(TABLES[item.kind].table)} WHERE id = ${item.id}::${Prisma.raw(TABLES[item.kind].cast)} FOR UPDATE`;
  }
  // Under the items' locks, nothing else comes to hold them: a map or a Location's state referencing one waits for them.
  const now = await holders();
  if (now.tablets.some((tabletId) => !locked.tablets.includes(tabletId)) || now.locations.some((locationId) => !locked.locations.includes(locationId))) {
    return false;
  }
  const stillDeleted = (await deletedWith(tx, kind, id))?.map((item) => item.id).sort() ?? [];
  if (stillDeleted.join() !== items.map((item) => item.id).sort().join()) return false;

  // Read under the tablets' locks, which every change to their maps takes, and which linking a Shot to one waits for.
  const [named] = await tx.$queryRaw<{ named: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM shots JOIN tablet_bean_batches AS held ON held.local_id = shots.bean_batch_id WHERE held.batch_id = ANY(${batches}::uuid[]))
      OR EXISTS (SELECT 1 FROM shots JOIN tablet_grinders AS held ON held.local_id = shots.grinder_id WHERE held.grinder_id = ANY(${grinders}::uuid[]))
      OR ${shotLinkedSql("beanBatch", batches)} OR ${shotLinkedSql("grinder", grinders)}
      OR EXISTS (
        SELECT 1 FROM profiles WHERE id = ANY(${profiles}::text[])
          AND ${shotNamesProfileSql(Prisma.sql`profiles.id`, Prisma.sql`profiles.content -> 'profile' -> 'steps'`)}
      )
      AS named`;
  if (named?.named) {
    const what = kind === "bean" ? "one of this Bean's batches" : `this ${NAMES[kind]}`;
    throw new ConflictException(`A Shot names ${what}, so it cannot be deleted. Archive it instead.`);
  }

  for (const item of items) {
    const { table, map, column, cast } = TABLES[item.kind];
    if (item.kind === "profile") {
      // A Profile's record is named by its id, which is Decaid's, and keeps its steps, which a Shot that used it recorded.
      await tx.$executeRaw`
        INSERT INTO tablet_deletions (tablet_id, kind, local_id, item_id, profile_steps)
        SELECT held.tablet_id, 'profile', held.profile_id, held.profile_id, profiles.content -> 'profile' -> 'steps'
        FROM tablet_profiles AS held JOIN profiles ON profiles.id = held.profile_id WHERE held.profile_id = ${item.id}
        ON CONFLICT DO NOTHING`;
    } else {
      // A batch's records keep their bean's id there, so a bean's record is deleted only once its batches' are.
      const bean = item.kind === "beanBatch" ? Prisma.sql`record ->> 'beanId'` : Prisma.sql`NULL::text`;
      await tx.$executeRaw`
        INSERT INTO tablet_deletions (tablet_id, kind, local_id, item_id, bean_local_id)
        SELECT tablet_id, ${item.kind}, local_id, ${Prisma.raw(column)}::text, ${bean} FROM ${Prisma.raw(map)} WHERE ${Prisma.raw(column)} = ${item.id}::uuid
        ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`INSERT INTO deleted_items (kind, item_id) VALUES (${item.kind}, ${item.id}::uuid) ON CONFLICT DO NOTHING`;
    }
    // A Bean's batches go first, as their rows reference it.
    if (item.kind !== "bean") await tx.$executeRaw`DELETE FROM ${Prisma.raw(table)} WHERE id = ${item.id}::${Prisma.raw(cast)}`;
  }
  if (beans.length > 0) await tx.$executeRaw`DELETE FROM beans WHERE id = ANY(${beans}::uuid[])`;
  if (now.tablets.length > 0 || now.locations.length > 0) await notify(tx, "library_changes", id);
  return true;
}

/** The item and what goes with it, a Bean's batches; null if the Library does not have it. */
async function deletedWith(tx: Prisma.TransactionClient, kind: DeletedKind, id: string): Promise<Deleted[] | null> {
  const [found] = await tx.$queryRaw<unknown[]>`SELECT 1 FROM ${Prisma.raw(TABLES[kind].table)} WHERE id = ${id}::${Prisma.raw(TABLES[kind].cast)}`;
  if (!found) return null;
  if (kind !== "bean") return [{ kind, id }];
  const batches = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM bean_batches WHERE bean_id = ${id}::uuid ORDER BY id`;
  return [{ kind, id }, ...batches.map((batch) => ({ kind: "beanBatch" as const, id: batch.id }))];
}

/**
 * The tablet deleted its record of a hard-deleted item, or found it gone: it
 * is not due to be deleted again. A Profile's record may have been mapped
 * again meanwhile, as the Profile joined the Library again before the purge
 * was carried out: the tablet no longer holds it, so it is not mapped either,
 * and its next report does not read it as the tablet's delete.
 */
export async function recordDeleted(prisma: PrismaService, tabletId: string, kind: DeletedKind, localId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockTablet(tx, tabletId);
    await tx.$executeRaw`DELETE FROM tablet_deletions WHERE tablet_id = ${tabletId}::uuid AND kind = ${kind} AND local_id = ${localId}`;
    if (kind === "profile") await tx.$executeRaw`DELETE FROM tablet_profiles WHERE tablet_id = ${tabletId}::uuid AND profile_id = ${localId}`;
  });
}

/** A record a tablet reported: its id there, the global id it carries, if any, and for a batch its bean's id there. */
interface ReportedRecord {
  localId: string;
  globalId: string | null;
  beanLocalId?: string;
}

/**
 * Sets apart the records of a tablet's report that are of hard-deleted
 * items, under the tablet's row lock: each it is due to delete, and each it
 * does not map carrying a deleted item's global id, which it is then due to
 * delete too. The rest are taken in as ever. A record it was due to delete
 * that the list (`listed`, every id it holds) no longer holds is gone. Says
 * whether the tablet is newly due a delete.
 */
export async function setAsideDeleted<T extends ReportedRecord>(
  tx: Prisma.TransactionClient,
  tabletId: string,
  kind: DeletedKind,
  reported: readonly T[],
  listed: ReadonlySet<string>,
  mapped: ReadonlySet<string>,
): Promise<{ kept: T[]; due: boolean }> {
  const pending = await tx.$queryRaw<{ localId: string }[]>`
    SELECT local_id AS "localId" FROM tablet_deletions WHERE tablet_id = ${tabletId}::uuid AND kind = ${kind}`;
  const gone = pending.filter((row) => !listed.has(row.localId)).map((row) => row.localId);
  if (gone.length > 0) {
    await tx.$executeRaw`DELETE FROM tablet_deletions WHERE tablet_id = ${tabletId}::uuid AND kind = ${kind} AND local_id = ANY(${gone}::text[])`;
  }
  const deleting = new Set(pending.map((row) => row.localId));
  const named = [...new Set(reported.flatMap((record) => (record.globalId !== null && !mapped.has(record.localId) && !deleting.has(record.localId) ? [record.globalId] : [])))];
  const deleted =
    named.length === 0
      ? new Set<string>()
      : new Set(
          (
            await tx.$queryRaw<{ itemId: string }[]>`
              SELECT item_id::text AS "itemId" FROM deleted_items WHERE kind = ${kind} AND item_id = ANY(${named}::uuid[])`
          ).map((row) => row.itemId),
        );
  let due = false;
  const kept: T[] = [];
  for (const record of reported) {
    if (deleting.has(record.localId)) continue;
    if (record.globalId !== null && !mapped.has(record.localId) && deleted.has(record.globalId)) {
      await tx.$executeRaw`
        INSERT INTO tablet_deletions (tablet_id, kind, local_id, item_id, bean_local_id)
        VALUES (${tabletId}::uuid, ${kind}, ${record.localId}, ${record.globalId}::uuid::text, ${record.beanLocalId ?? null})
        ON CONFLICT DO NOTHING`;
      deleting.add(record.localId);
      due = true;
      continue;
    }
    kept.push(record);
  }
  return { kept, due };
}
