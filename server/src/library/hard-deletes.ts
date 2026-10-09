import type { DeletedKind } from "@decent-sync/protocol";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import type { PrismaService } from "../prisma.service.js";
import { INTAKE_TRANSACTION, lockTablet } from "./intake.js";
import { lockLocation } from "./location-state.js";

// Hard deletes (ADR-0003, ADR-0019): an Admin removes a Bean, Bean Batch or
// Grinder no Shot names from the Library and from every tablet that holds it,
// the one thing the server deletes from tablets. A Bean goes with its
// batches, as Decaid refuses to delete a bean that has any. A Shot names a
// batch or Grinder by its id on the tablet that pulled it, so an item whose
// record has that id on any tablet's map is named; a Bean is named when one
// of its batches is.
//
// The item is gone from the Library at once, with its versions, Conflicts
// and each Location's state of it. Its global id is kept (`deleted_items`),
// and so is each tablet's record of it (`tablet_deletions`), which that
// tablet's writer deletes (tablet-due.ts), now or once the tablet connects
// again. A record carrying a deleted item's global id that a tablet reports
// later, as one that was offline, or one written it whose answer was lost, is
// not taken in as new: it is deleted there too.
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

/** Each kind's table, its tablets' map, and the column naming the item in versions, Conflicts and maps. A batch's map names its Bean through the batch's row. */
const TABLES: Readonly<Record<DeletedKind, { table: string; map: string; column: string }>> = {
  bean: { table: "beans", map: "tablet_beans", column: "bean_id" },
  beanBatch: { table: "bean_batches", map: "tablet_bean_batches", column: "batch_id" },
  grinder: { table: "grinders", map: "tablet_grinders", column: "grinder_id" },
};

const NAMES: Readonly<Record<DeletedKind, string>> = { bean: "Bean", beanBatch: "Bean Batch", grinder: "Grinder" };

/**
 * Deletes the item from the Library, a Bean with its batches, and has every
 * tablet that holds it delete its record. 404 if the Library does not have
 * it; 409 if a Shot names it, or for a Bean one of its batches.
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
  const byKind = (wanted: DeletedKind) => items.filter((item) => item.kind === wanted).map((item) => item.id);
  const beans = byKind("bean");
  const batches = byKind("beanBatch");
  const grinders = byKind("grinder");

  await tx.$queryRaw`
    SELECT 1 FROM conflicts
    WHERE state = 'OPEN' AND (bean_id = ANY(${beans}::uuid[]) OR batch_id = ANY(${batches}::uuid[]) OR grinder_id = ANY(${grinders}::uuid[]))
    ORDER BY id FOR UPDATE`;
  const holders = async () => ({
    tablets: (
      await tx.$queryRaw<{ id: string }[]>`
        SELECT tablet_id::text AS id FROM tablet_beans WHERE bean_id = ANY(${beans}::uuid[])
        UNION SELECT tablet_id::text FROM tablet_bean_batches WHERE batch_id = ANY(${batches}::uuid[])
        UNION SELECT tablet_id::text FROM tablet_grinders WHERE grinder_id = ANY(${grinders}::uuid[])
        ORDER BY 1`
    ).map((row) => row.id),
    locations: (
      await tx.$queryRaw<{ id: string }[]>`
        SELECT location_id::text AS id FROM batch_locations WHERE batch_id = ANY(${batches}::uuid[])
        UNION SELECT location_id::text FROM bean_origins WHERE bean_id = ANY(${beans}::uuid[])
        UNION SELECT location_id::text FROM grinders WHERE id = ANY(${grinders}::uuid[]) AND location_id IS NOT NULL
        ORDER BY 1`
    ).map((row) => row.id),
  });
  const locked = await holders();
  for (const tabletId of locked.tablets) await lockTablet(tx, tabletId);
  for (const locationId of locked.locations) await lockLocation(tx, locationId);
  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    await tx.$queryRaw`SELECT 1 FROM ${Prisma.raw(TABLES[item.kind].table)} WHERE id = ${item.id}::uuid FOR UPDATE`;
  }
  // Under the items' locks, nothing else comes to hold them: a map or a Location's state referencing one waits for them.
  const now = await holders();
  if (now.tablets.some((tabletId) => !locked.tablets.includes(tabletId)) || now.locations.some((locationId) => !locked.locations.includes(locationId))) {
    return false;
  }
  const stillDeleted = (await deletedWith(tx, kind, id))?.map((item) => item.id).sort() ?? [];
  if (stillDeleted.join() !== items.map((item) => item.id).sort().join()) return false;

  // Read under the tablets' locks, which every change to their maps takes.
  const [named] = await tx.$queryRaw<{ named: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM shots JOIN tablet_bean_batches AS held ON held.local_id = shots.bean_batch_id WHERE held.batch_id = ANY(${batches}::uuid[]))
      OR EXISTS (SELECT 1 FROM shots JOIN tablet_grinders AS held ON held.local_id = shots.grinder_id WHERE held.grinder_id = ANY(${grinders}::uuid[]))
      AS named`;
  if (named?.named) {
    const what = kind === "bean" ? "one of this Bean's batches" : `this ${NAMES[kind]}`;
    throw new ConflictException(`A Shot names ${what}, so it cannot be deleted. Archive it instead.`);
  }

  for (const item of items) {
    const { table, map, column } = TABLES[item.kind];
    // A batch's records keep its Bean, so a record of the Bean is deleted only once theirs are.
    const bean = item.kind === "beanBatch" ? Prisma.sql`(SELECT bean_id FROM bean_batches WHERE id = ${item.id}::uuid)` : Prisma.sql`NULL::uuid`;
    await tx.$executeRaw`
      INSERT INTO tablet_deletions (tablet_id, kind, local_id, item_id, bean_id)
      SELECT tablet_id, ${item.kind}, local_id, ${Prisma.raw(column)}, ${bean} FROM ${Prisma.raw(map)} WHERE ${Prisma.raw(column)} = ${item.id}::uuid
      ON CONFLICT DO NOTHING`;
    await tx.$executeRaw`INSERT INTO deleted_items (kind, item_id) VALUES (${item.kind}, ${item.id}::uuid) ON CONFLICT DO NOTHING`;
    // A Bean's batches go first, as their rows reference it.
    if (item.kind !== "bean") await tx.$executeRaw`DELETE FROM ${Prisma.raw(table)} WHERE id = ${item.id}::uuid`;
  }
  if (beans.length > 0) await tx.$executeRaw`DELETE FROM beans WHERE id = ANY(${beans}::uuid[])`;
  if (now.tablets.length > 0 || now.locations.length > 0) await notify(tx, "library_changes", id);
  return true;
}

/** The item and what goes with it, a Bean's batches; null if the Library does not have it. */
async function deletedWith(tx: Prisma.TransactionClient, kind: DeletedKind, id: string): Promise<Deleted[] | null> {
  const [found] = await tx.$queryRaw<unknown[]>`SELECT 1 FROM ${Prisma.raw(TABLES[kind].table)} WHERE id = ${id}::uuid`;
  if (!found) return null;
  if (kind !== "bean") return [{ kind, id }];
  const batches = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM bean_batches WHERE bean_id = ${id}::uuid ORDER BY id`;
  return [{ kind, id }, ...batches.map((batch) => ({ kind: "beanBatch" as const, id: batch.id }))];
}

/** The tablet deleted its record of a hard-deleted item, or found it gone: it is not due to be deleted again. */
export async function recordDeleted(prisma: PrismaService, tabletId: string, kind: DeletedKind, localId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockTablet(tx, tabletId);
    await tx.$executeRaw`DELETE FROM tablet_deletions WHERE tablet_id = ${tabletId}::uuid AND kind = ${kind} AND local_id = ${localId}`;
  });
}

/** A record a tablet reported: its id there, and the global id it carries, if any. */
interface ReportedRecord {
  localId: string;
  globalId: string | null;
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
        INSERT INTO tablet_deletions (tablet_id, kind, local_id, item_id) VALUES (${tabletId}::uuid, ${kind}, ${record.localId}, ${record.globalId}::uuid)
        ON CONFLICT DO NOTHING`;
      deleting.add(record.localId);
      due = true;
      continue;
    }
    kept.push(record);
  }
  return { kept, due };
}
