import { type DeletedKind, REMOVAL_ORDER, childKinds } from "@decent-sync/protocol";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import type { PrismaService } from "../prisma.service.js";
import { INTAKE_TRANSACTION, lockTablet } from "./intake.js";
import { KINDS, idSql, idsSql } from "./kinds.js";
import { lockLocation } from "./location-state.js";

// Hard deletes (ADR-0003, ADR-0019): an Admin removes a Bean, Bean Batch,
// Grinder, Profile, Basket, Tool or Recipe no Shot names from the Library and
// from every tablet that holds it, the one thing the server deletes from
// tablets, and a Basket or Tool only where no Recipe names it either (#147). A
// Bean goes with its batches, as Decaid refuses to delete a bean that has any.
// A Shot names a batch or Grinder by its id on the tablet that pulled it, so
// an item whose record has that id on any tablet's map is named, as is one a
// Shot is linked to (shots/links.ts), whose record may have left the map
// since; a Bean is named when one of its batches is. A Shot names a Profile by
// the steps it executed, which its Workflow records with the rest of its
// profile, or by the profile id a skin recorded there. A Basket is named as a
// batch is, and a Tool by its id there among the Tools DYE2 recorded; a Recipe
// only by a Shot linked to it, pulled while its Machine had it loaded
// (shots/links.ts), whose storage holds the Recipe's row for key share.
// Decaid's bundled Profiles, which every tablet has and Decaid refuses to
// delete, are never deleted.
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
 * Deletes the item from the Library, with the items of the kinds made under
 * it, a Bean with its batches, and has every tablet that holds any of them
 * delete its record. 404 if the Library does not have it; 409 if a Shot
 * names it, or for a Bean one of its batches, or it cannot be deleted at all,
 * as one of Decaid's bundled Profiles.
 */
export async function hardDelete(prisma: PrismaService, kind: DeletedKind, id: string): Promise<void> {
  // A tablet or Location that comes to hold the item while its locks are taken is found once they are, and the
  // delete starts again, as its locks cannot be taken after the items' in order.
  for (let attempt = 1; ; attempt++) {
    const done = await prisma.$transaction((tx) => deleteOnce(tx, kind, id), INTAKE_TRANSACTION);
    if (done) return;
    if (attempt === 3) throw new ConflictException(`The ${KINDS[kind].name} is changing on tablets: try again`);
  }
}

/** Deletes the item as `hardDelete` does, under the locks it needs; false if more came to hold it as they were taken, changing nothing. */
async function deleteOnce(tx: Prisma.TransactionClient, kind: DeletedKind, id: string): Promise<boolean> {
  const items = await deletedWith(tx, kind, id);
  if (items === null) throw new NotFoundException(`No such ${KINDS[kind].name}`);
  const undeletable = await KINDS[kind].undeletable(tx, id);
  if (undeletable !== null) throw new ConflictException(undeletable);
  // Each kind of the items, with their ids, in REMOVAL_ORDER: a Bean's batches go first, as their rows reference it.
  const byKind = REMOVAL_ORDER.flatMap((wanted) => {
    const ids = items.filter((item) => item.kind === wanted).map((item) => item.id);
    return ids.length === 0 ? [] : [{ kind: KINDS[wanted], ids }];
  });

  await tx.$queryRaw`
    SELECT 1 FROM conflicts
    WHERE state = 'OPEN' AND (kind, item_id) IN (SELECT * FROM unnest(${items.map((item) => item.kind)}::text[], ${items.map((item) => item.id)}::text[]))
    ORDER BY id FOR UPDATE`;
  /** The ids every kind's query finds, as `id` text, in order. */
  const found = async (query: (group: (typeof byKind)[number]) => Prisma.Sql) =>
    (await tx.$queryRaw<{ id: string }[]>`SELECT id FROM (${Prisma.join(byKind.map(query), " UNION ")}) AS found ORDER BY 1`).map((row) => row.id);
  const holders = async () => ({
    tablets: await found(({ kind, ids }) => Prisma.sql`SELECT tablet_id::text AS id FROM ${Prisma.raw(kind.map.table)} WHERE ${Prisma.raw(kind.map.column)} = ANY(${idsSql(kind, ids)})`),
    locations: await found(({ kind, ids }) => kind.stateLocationsSql(ids)),
  });
  const locked = await holders();
  for (const tabletId of locked.tablets) await lockTablet(tx, tabletId);
  for (const locationId of locked.locations) await lockLocation(tx, locationId);
  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    const description = KINDS[item.kind];
    await tx.$queryRaw`SELECT 1 FROM ${Prisma.raw(description.table)} WHERE id = ${idSql(description, item.id)} FOR UPDATE`;
  }
  // Under the items' locks, nothing else comes to hold them: a map or a Location's state referencing one waits for them.
  const now = await holders();
  if (now.tablets.some((tabletId) => !locked.tablets.includes(tabletId)) || now.locations.some((locationId) => !locked.locations.includes(locationId))) {
    return false;
  }
  const stillDeleted = (await deletedWith(tx, kind, id))?.map((item) => item.id).sort() ?? [];
  if (stillDeleted.join() !== items.map((item) => item.id).sort().join()) return false;

  // Read under the tablets' locks, which every change to their maps takes, and which linking a Shot to one waits for.
  const [named] = await tx.$queryRaw<{ named: boolean }[]>`SELECT (${Prisma.join(byKind.map(({ kind, ids }) => kind.shotsNameSql(ids)), " OR ")}) AS named`;
  if (named?.named) throw new ConflictException(`A Shot names ${KINDS[kind].namedAs}, so it cannot be deleted. Archive it instead.`);
  // Read under the items' locks, which a Recipe's edit naming one takes (recipe-edits.service.ts), and the tablets', which a
  // tablet's report of its recipes takes as it names one by its record there.
  const byRecipes = byKind.flatMap(({ kind, ids }) => (kind.recipesNameSql ? [kind.recipesNameSql(ids)] : []));
  if (byRecipes.length > 0) {
    const [inRecipes] = await tx.$queryRaw<{ named: boolean }[]>`SELECT (${Prisma.join(byRecipes, " OR ")}) AS named`;
    if (inRecipes?.named) throw new ConflictException(`A Recipe names ${KINDS[kind].namedAs}, so it cannot be deleted. Take it out of the Recipe, or Archive it instead.`);
  }

  for (const item of items) await KINDS[item.kind].keepDeletion(tx, item.id);
  for (const { kind: description, ids } of byKind) {
    await tx.$executeRaw`DELETE FROM ${Prisma.raw(description.table)} WHERE id = ANY(${idsSql(description, ids)})`;
  }
  if (now.tablets.length > 0 || now.locations.length > 0) await notify(tx, "library_changes", id);
  return true;
}

/** The item and what goes with it, the items of the kinds made under it, as a Bean's batches; null if the Library does not have it. */
async function deletedWith(tx: Prisma.TransactionClient, kind: DeletedKind, id: string): Promise<Deleted[] | null> {
  const description = KINDS[kind];
  // Its id as PostgreSQL writes it, as versions and Conflicts name it.
  const [found] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM ${Prisma.raw(description.table)} WHERE id = ${idSql(description, id)}`;
  if (!found) return null;
  const children: Deleted[] = [];
  for (const child of childKinds(kind)) {
    const { table, parent } = KINDS[child];
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM ${Prisma.raw(table)} WHERE ${Prisma.raw(parent!.column)} = ${idSql(description, id)} ORDER BY id`;
    children.push(...rows.map((row) => ({ kind: child, id: row.id })));
  }
  return [{ kind, id: found.id }, ...children];
}

/**
 * The tablet deleted its record of a hard-deleted item, or found it gone: it
 * is not due to be deleted again. A Profile's record may have been mapped
 * again meanwhile, as the Profile joined the Library again before the purge
 * was carried out: the tablet no longer holds it, so it is not mapped either,
 * and its next report does not read it as the tablet's delete.
 */
export async function recordDeleted(prisma: PrismaService, tabletId: string, kind: DeletedKind, localId: string): Promise<void> {
  const { carriesGlobalId, map } = KINDS[kind];
  await prisma.$transaction(async (tx) => {
    await lockTablet(tx, tabletId);
    await tx.$executeRaw`DELETE FROM tablet_deletions WHERE tablet_id = ${tabletId}::uuid AND kind = ${kind} AND local_id = ${localId}`;
    // A record of a kind whose records carry no global id is mapped by its id, which is the item's.
    if (!carriesGlobalId) await tx.$executeRaw`DELETE FROM ${Prisma.raw(map.table)} WHERE tablet_id = ${tabletId}::uuid AND ${Prisma.raw(map.column)} = ${localId}`;
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
