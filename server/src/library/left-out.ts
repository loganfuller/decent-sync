import type { DeletedKind } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import type { PrismaService } from "../prisma.service.js";
import { type PlannedLeaveOut, leaveOutKey } from "./holdings.js";
import { lockTablet } from "./intake.js";

// What a Machine's tablet holds as it joins a Location that the Library
// leaves out (ADR-0008, ADR-0018). The Location's state wins: a report that
// is part of joining takes nothing of the tablet's into the Library, but for
// a kind of item the Location offers none of yet, as at a cafe's first
// Machine, whose items it brings. Its records of items the Library has are
// that item's, a Bean matched by roaster and name and a Profile by its id,
// and are written the Location's state. Every other record it holds is left
// out (`tablet_left_out`): its writer sets it aside there, archiving a bean,
// bean batch or grinder, or hiding a profile, never deleting it, so the
// tablet's Shots still find it. A record left out stays out of the Library
// while the tablet holds it, until a barista un-archives or shows it there
// once it was set aside, which takes it in as a new record, as if entered
// then. Under the locks of the report that takes it in: the Machine's row,
// the tablet's, then the Location's.

/** A record a tablet reported, as what the Library leaves out is judged: its id there, and whether it is archived there, or a profile hidden or deleted. */
export interface ReportedRecord {
  localId: string;
  setAside: boolean;
}

/**
 * Whether the Location offers any item of the kind, but Decaid's bundled
 * Profiles, which every tablet has: if not, a tablet joining it brings its
 * own. Read under the Location's lock, so of two tablets joining it at once
 * only the first brings them.
 */
export async function offersAny(tx: Prisma.TransactionClient, locationId: string, kind: DeletedKind): Promise<boolean> {
  const query = {
    bean: Prisma.sql`
      SELECT 1 FROM beans WHERE NOT beans.archived AND (
        EXISTS (SELECT 1 FROM bean_origins AS origin WHERE origin.bean_id = beans.id AND origin.location_id = ${locationId}::uuid)
        OR EXISTS (
          SELECT 1 FROM bean_batches AS batch
          JOIN batch_locations AS here ON here.batch_id = batch.id AND here.location_id = ${locationId}::uuid
          WHERE batch.bean_id = beans.id AND NOT batch.archived AND here.added_at IS NOT NULL AND here.finished_at IS NULL
        )
      ) LIMIT 1`,
    beanBatch: Prisma.sql`
      SELECT 1 FROM bean_batches AS batch
      JOIN beans AS bean ON bean.id = batch.bean_id
      JOIN batch_locations AS here ON here.batch_id = batch.id AND here.location_id = ${locationId}::uuid
      WHERE here.added_at IS NOT NULL AND here.finished_at IS NULL AND NOT batch.archived AND NOT bean.archived LIMIT 1`,
    grinder: Prisma.sql`SELECT 1 FROM grinders WHERE location_id = ${locationId}::uuid AND NOT archived LIMIT 1`,
    profile: Prisma.sql`
      SELECT 1 FROM profiles
      JOIN profile_locations AS here ON here.profile_id = profiles.id AND here.location_id = ${locationId}::uuid AND here.shown
      WHERE NOT profiles.archived AND NOT profiles.bundled LIMIT 1`,
  }[kind];
  const [found] = await tx.$queryRaw<unknown[]>(query);
  return found !== undefined;
}

/**
 * Sets apart the reported records of a kind that the map does not hold and
 * the Library leaves out, under the tablet's row lock: each stays out, and
 * is set aside on the tablet if it is not, unless a barista un-archived or
 * showed it there once it was set aside, which takes it in as any new
 * record. A report that is part of joining judges every record afresh, so
 * one the Library has come to hold since, as a Bean of its roaster and name,
 * is linked, and the rest are left out again. One the list (`listed`, every
 * id it holds) no longer holds, or that the map holds now, as a write made
 * it a Library item's, is forgotten. Returns the rest, and whether a record
 * is newly due to be set aside.
 */
export async function screenLeftOut<T>(
  tx: Prisma.TransactionClient,
  tabletId: string,
  kind: DeletedKind,
  unmapped: readonly T[],
  read: (record: T) => ReportedRecord,
  listed: ReadonlySet<string>,
  mapped: ReadonlySet<string>,
  joining: boolean,
): Promise<{ kept: T[]; due: boolean }> {
  const rows = await tx.$queryRaw<{ localId: string; setAside: boolean }[]>`
    SELECT local_id AS "localId", set_aside AS "setAside" FROM tablet_left_out WHERE tablet_id = ${tabletId}::uuid AND kind = ${kind}`;
  const forgotten = rows.filter((row) => !listed.has(row.localId) || mapped.has(row.localId)).map((row) => row.localId);
  const left = new Map(rows.filter((row) => !forgotten.includes(row.localId)).map((row) => [row.localId, row.setAside]));
  const released: string[] = [];
  const changed: ReportedRecord[] = [];
  let due = false;
  const kept: T[] = [];
  for (const record of unmapped) {
    const { localId, setAside } = read(record);
    const wasSetAside = left.get(localId);
    if (wasSetAside === undefined) {
      kept.push(record);
      continue;
    }
    if (joining || (wasSetAside && !setAside)) {
      released.push(localId);
      kept.push(record);
      continue;
    }
    if (setAside !== wasSetAside) changed.push({ localId, setAside });
    due = due || !setAside;
  }
  const gone = [...forgotten, ...released];
  if (gone.length > 0) {
    await tx.$executeRaw`DELETE FROM tablet_left_out WHERE tablet_id = ${tabletId}::uuid AND kind = ${kind} AND local_id = ANY(${gone}::text[])`;
  }
  for (const record of changed) {
    await tx.$executeRaw`
      UPDATE tablet_left_out SET set_aside = ${record.setAside} WHERE tablet_id = ${tabletId}::uuid AND kind = ${kind} AND local_id = ${record.localId}`;
  }
  return { kept, due };
}

/** The ids there of the tablet's records of a kind that the Library leaves out. */
export async function leftOutIds(tx: Prisma.TransactionClient, tabletId: string, kind: DeletedKind): Promise<Set<string>> {
  const rows = await tx.$queryRaw<{ localId: string }[]>`
    SELECT local_id AS "localId" FROM tablet_left_out WHERE tablet_id = ${tabletId}::uuid AND kind = ${kind}`;
  return new Set(rows.map((row) => row.localId));
}

/** Leaves the tablet's record out of the Library; its writer sets it aside there unless it is already. Says whether it is due to be. */
export async function leaveOut(tx: Prisma.TransactionClient, tabletId: string, kind: DeletedKind, record: ReportedRecord): Promise<boolean> {
  await tx.$executeRaw`
    INSERT INTO tablet_left_out (tablet_id, kind, local_id, set_aside) VALUES (${tabletId}::uuid, ${kind}, ${record.localId}, ${record.setAside})
    ON CONFLICT (tablet_id, kind, local_id) DO UPDATE SET set_aside = EXCLUDED.set_aside`;
  return !record.setAside;
}

/**
 * The tablet's records the Library leaves out that are still to be set aside
 * there, but those in `skipped` (`leaveOutKey`): batches before beans, as a
 * barista sees them, then grinders and profiles.
 */
export async function leaveOutsDue(tx: Prisma.TransactionClient, tabletId: string, skipped: ReadonlySet<string>): Promise<PlannedLeaveOut[]> {
  const order: readonly DeletedKind[] = ["beanBatch", "bean", "grinder", "profile"];
  const rows = await tx.$queryRaw<{ kind: DeletedKind; localId: string }[]>`
    SELECT kind, local_id AS "localId" FROM tablet_left_out WHERE tablet_id = ${tabletId}::uuid AND NOT set_aside ORDER BY local_id`;
  return rows
    .filter((row) => order.includes(row.kind) && !skipped.has(leaveOutKey(row.kind, row.localId)))
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
    .map((row) => ({ leaveOut: true, kind: row.kind, localId: row.localId }));
}

/**
 * Records the plugin's answer to a `leaveOut`: the record is set aside on
 * the tablet now, or the tablet holds no such record, or it carries a global
 * id now, as a Library item's, and is left out no more. A refusal changes
 * nothing; the writer skips it until the tablet reconnects. Recorded
 * whether or not the answering connection still holds its Machine, unlike
 * an answer to a write: it says only what the tablet itself holds, under its
 * row lock, which its reports take too.
 */
export async function recordLeftOut(
  prisma: PrismaService,
  tabletId: string,
  kind: DeletedKind,
  localId: string,
  outcome: "setAside" | "gone" | "taken",
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockTablet(tx, tabletId);
    if (outcome === "setAside") {
      await tx.$executeRaw`UPDATE tablet_left_out SET set_aside = true WHERE tablet_id = ${tabletId}::uuid AND kind = ${kind} AND local_id = ${localId}`;
    } else {
      await tx.$executeRaw`DELETE FROM tablet_left_out WHERE tablet_id = ${tabletId}::uuid AND kind = ${kind} AND local_id = ${localId}`;
    }
  });
}
