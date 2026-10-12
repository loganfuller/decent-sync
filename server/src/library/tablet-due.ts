import { Prisma } from "../generated/prisma/client.js";
import type { PrismaService } from "../prisma.service.js";
import { type DeletedKind, LIBRARY_ITEM_KINDS, LIBRARY_KINDS, REMOVAL_ORDER, type WrittenKind, isLibraryKind } from "@decent-sync/protocol";
import {
  type LocationOffer,
  type PlannedChange,
  type PlannedDelete,
  type PlannedWrite,
  type TabletHoldings,
  batchesAwaitingBeans,
  deleteKey,
  plannedWrites,
  writeKey,
} from "./holdings.js";
import { standing } from "./join-plan.js";
import { workflowClearDue } from "./joining.js";
import { KINDS } from "./kinds.js";
import { leaveOutsDue } from "./left-out.js";
import { settingsDue } from "./location-settings.js";

// What a connection's tablet is due: the next write that brings it to what
// its Machine's Location offers, and each record it holds to its item's
// content (holdings.ts), its Workflow to the Location's steam and rinse
// settings (location-settings.ts), its Workflow's grinder and
// batch cleared as it joined a Location that does not offer them
// (joining.ts), the deletes of its records
// of items an Admin hard-deleted (hard-deletes.ts), and the setting aside of
// its records the Library leaves out as it joined (left-out.ts), read from the database
// each time, so it reflects changes made through any instance. Nothing is
// written to one of DYE2's lists the tablet holds in a shape that is not
// recognised (equipment.ts).

/** A connection whose tablet is written to: its session, which must still hold its Machine, the Machine and its tablet. */
export interface WrittenTablet {
  sessionId: string;
  machineId: string;
  tabletId: string;
}

/** What a connection's tablet is due: where its Machine takes part now, and the writes due there. */
export interface TabletDue {
  /** The Location its Machine takes part at now, or null if none, as it is capture-only. */
  locationId: string | null;
  /** Where its reports are to be taken in now (`standing`), or null if nowhere. */
  standing: string | null;
  /** The writes, deletes and records to set aside due, in the order they are made; null while none is planned, as the Machine is not where they were reported. */
  writes: PlannedChange[] | null;
}

/**
 * Where the connection's Machine takes part now, and the writes its tablet
 * is due, leaving out the changes in `skipped` (`changeKey`), as the deletes
 * its writer deferred. None is due while
 * it is capture-only, at no Location or with sharing turned off, nor while
 * it does not take part where its tablet's latest reports of its beans, bean
 * batches, grinders and profiles were all taken in (`reportedAt`, a
 * `standing`), as before sharing was turned off and on again, so a
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
      const [holder] = await tx.$queryRaw<{ sharing: boolean; id: string | null; locationId: string | null; sharingSince: Date | null }[]>`
        SELECT machines.sharing, latest.id, latest.location_id AS "locationId", machines.sharing_since AS "sharingSince"
        FROM machines
        LEFT JOIN LATERAL (
          SELECT id, location_id FROM location_assignments WHERE machine_id = machines.id ORDER BY effective_from DESC LIMIT 1
        ) AS latest ON true
        WHERE machines.id = ${tablet.machineId}::uuid AND machines.connected_session_id = ${tablet.sessionId}::uuid`;
      if (!holder) return null;
      const { id, locationId, sharingSince } = holder;
      if (!holder.sharing || id === null || locationId === null) return { locationId: null, standing: null, writes: null };
      const where = standing({ id, locationId, sharingSince });
      if (where !== reportedAt) return { locationId, standing: where, writes: null };
      return { locationId, standing: where, writes: (await changesDue(tx, tablet, locationId, skipped)).changes };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

/** What is due to a tablet at a Location. */
export interface ChangesDue {
  /** The writes, deletes and records to set aside due, in the order they are made. */
  changes: PlannedChange[];
  /** The Bean of each batch to be created once its Bean's record is (`batchesAwaitingBeans`). */
  batchesAwaitingBeans: string[];
}

/**
 * The writes, deletes and records to set aside due to the tablet at the
 * Location, in the order they are made, leaving out those in `skipped`, and
 * the batches waiting for their Bean's record to be written first. Read in
 * the caller's transaction, which reads in one snapshot.
 */
export async function changesDue(
  tx: Prisma.TransactionClient,
  tablet: { machineId: string; tabletId: string },
  locationId: string,
  skipped: ReadonlySet<string>,
): Promise<ChangesDue> {
  // Each kind's part of what the Location offers, and of what the tablet holds, with its items' content, which a write to it carries.
  const offer: Partial<Record<keyof LocationOffer, unknown>> = {};
  const held: Partial<Record<keyof TabletHoldings, unknown>> = {};
  for (const kind of LIBRARY_KINDS) {
    const { holdings } = KINDS[kind];
    offer[holdings.key] = await holdings.offered(tx, tablet.tabletId, locationId);
    held[holdings.key] = await holdings.held(tx, tablet.tabletId, locationId);
  }
  // The Location's settings first, then the clearing of the Workflow's grinder and batch as the tablet joined it: they
  // need no item written before them.
  const workflow = [await settingsDue(tx, tablet, locationId), await workflowClearDue(tx, tablet.tabletId, locationId)];
  const writes = workflow.filter((write): write is PlannedWrite => write !== null && !skipped.has(writeKey(write.kind, write.globalId)));
  // Nothing is written to one of DYE2's lists the tablet holds in a shape that is not recognised (ADR-0005).
  const unrecognised = await unrecognisedLists(tx, tablet.tabletId);
  const writable = (change: { kind: WrittenKind }) => !isLibraryKind(change.kind) || !unrecognised.has(LIBRARY_ITEM_KINDS[change.kind].list);
  return {
    changes: [
      ...writes,
      ...(await deletesDue(tx, tablet.tabletId, skipped)),
      ...(await leaveOutsDue(tx, tablet.tabletId, skipped)),
      ...plannedWrites(offer as LocationOffer, held as TabletHoldings, skipped),
    ].filter(writable),
    batchesAwaitingBeans: batchesAwaitingBeans(offer as LocationOffer, held as TabletHoldings),
  };
}

/** The tablet's lists of DYE2's that it last reported, or the plugin last found, in a shape that is not recognised (`tablet_unrecognised_lists`). */
export async function unrecognisedLists(tx: Prisma.TransactionClient, tabletId: string): Promise<Set<string>> {
  const rows = await tx.$queryRaw<{ list: string }[]>`SELECT list FROM tablet_unrecognised_lists WHERE tablet_id = ${tabletId}::uuid`;
  return new Set(rows.map((row) => row.list));
}

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
  const held = Prisma.join(
    LIBRARY_KINDS.map((kind) => Prisma.sql`(kind = ${kind} AND ${KINDS[kind].deleteHeldSql(Prisma.raw("due"))})`),
    " OR ",
  );
  const rows = await tx.$queryRaw<{ kind: DeletedKind; localId: string; itemId: string }[]>`
    SELECT kind, local_id AS "localId", item_id AS "itemId" FROM tablet_deletions AS due
    WHERE tablet_id = ${tabletId}::uuid AND NOT (${held})
    ORDER BY local_id`;
  // A bean's batches before it, as Decaid refuses to delete a bean that has any.
  return rows
    .filter((row) => REMOVAL_ORDER.includes(row.kind) && !skipped.has(deleteKey(row.kind, row.localId)))
    .sort((a, b) => REMOVAL_ORDER.indexOf(a.kind) - REMOVAL_ORDER.indexOf(b.kind))
    .map((row) => ({ delete: true, kind: row.kind, globalId: row.itemId, localId: row.localId }));
}
