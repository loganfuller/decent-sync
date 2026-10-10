import { createHash } from "node:crypto";
import type { WrittenKind } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { machineNotFound } from "../machines/input.js";
import type { PrismaService } from "../prisma.service.js";
import { itemView } from "./history.service.js";
import { type PlannedChange, deleteKey, leaveOutKey, writeKey } from "./holdings.js";
import { changesDue } from "./tablet-due.js";

// Each Machine's sharing status (stories 48 and 56 of milestone 2): the
// changes its tablet is due and has not refused, the last change it applied,
// and the changes it refused, each with Decaid's answer. A refusal is kept
// for the tablet (`tablet_refusals`) until a change of the same item, or the
// same record, is carried out there; its writer skips the item while what is
// due to it stays as it was refused (`changeSignature`), and asks again once
// that changes, as when the item is edited, or on the tablet's next
// connection. Everything is in PostgreSQL, so every instance reads the same.

/** A change the writer makes to a tablet: a write of an item or the settings, a delete, or setting aside a record. */
export type ChangeType = "write" | "delete" | "leaveOut";

/** A change made to a tablet, as its sharing status records it. */
export interface TabletChange {
  /** What the writer skips it under (`changeKey`). */
  key: string;
  change: ChangeType;
  kind: WrittenKind;
  /** The item's global id, a Profile's, the settings' or the tablet's for a Workflow; null for a leave-out. */
  itemId: string | null;
  /** The tablet's record changed; null for a create, the settings and the Workflow. */
  localId: string | null;
}

/** The key a planned write, delete or leave-out is skipped and remembered under. */
export function changeKey(change: PlannedChange): string {
  if ("delete" in change) return deleteKey(change.kind, change.localId);
  return "leaveOut" in change ? leaveOutKey(change.kind, change.localId) : writeKey(change.kind, change.globalId);
}

/** A planned change as its sharing status records it. */
export function tabletChange(change: PlannedChange): TabletChange {
  const key = changeKey(change);
  if ("delete" in change) return { key, change: "delete", kind: change.kind, itemId: change.globalId, localId: change.localId };
  if ("leaveOut" in change) return { key, change: "leaveOut", kind: change.kind, itemId: null, localId: change.localId };
  return { key, change: "write", kind: change.kind, itemId: change.globalId, localId: change.localId };
}

/**
 * What is due to a tablet for an item, as it was planned: the fields it sets,
 * the values it expects, and the decisions of the Location's state and the
 * item's content it carries. One refused stays refused while the same is
 * due, and is tried again once anything of it changes, as when the item is
 * edited, the Location changes it, or the tablet's record does.
 */
export function changeSignature(change: PlannedChange): string {
  return createHash("sha256").update(JSON.stringify(change)).digest("hex");
}

/**
 * Records that the tablet refused a change, with Decaid's HTTP status, or
 * null if it gave none, as when it did not answer, the plugin did not ask it,
 * or the server could not take in what it answered; and its answer, or why,
 * without the NUL characters PostgreSQL's text cannot hold.
 */
export async function recordRefused(prisma: PrismaService, tabletId: string, refused: TabletChange & { signature: string }, status: number | null, answer: string): Promise<void> {
  const error = answer.replaceAll("\u0000", "");
  await prisma.$executeRaw`
    INSERT INTO tablet_refusals (tablet_id, change_key, change, kind, item_id, local_id, signature, status, error)
    VALUES (${tabletId}::uuid, ${refused.key}, ${refused.change}, ${refused.kind}, ${refused.itemId}, ${refused.localId}, ${refused.signature}, ${status}, ${error})
    ON CONFLICT (tablet_id, change_key) DO UPDATE SET
      change = EXCLUDED.change, kind = EXCLUDED.kind, item_id = EXCLUDED.item_id, local_id = EXCLUDED.local_id,
      signature = EXCLUDED.signature, status = EXCLUDED.status, error = EXCLUDED.error, refused_at = EXCLUDED.refused_at`;
}

/** Records the change as the last the tablet applied, now by PostgreSQL's clock, and forgets any refusal of its item or record. */
export async function recordApplied(prisma: PrismaService, tabletId: string, applied: TabletChange): Promise<void> {
  await prisma.$transaction([
    prisma.$executeRaw`
      INSERT INTO tablet_last_applied (tablet_id, change, kind, item_id, local_id, applied_at)
      VALUES (${tabletId}::uuid, ${applied.change}, ${applied.kind}, ${applied.itemId}, ${applied.localId}, now())
      ON CONFLICT (tablet_id) DO UPDATE SET
        change = EXCLUDED.change, kind = EXCLUDED.kind, item_id = EXCLUDED.item_id, local_id = EXCLUDED.local_id, applied_at = EXCLUDED.applied_at`,
    prisma.$executeRaw`DELETE FROM tablet_refusals WHERE tablet_id = ${tabletId}::uuid AND change_key = ${applied.key}`,
  ]);
}

/**
 * Forgets the tablet's refusals of items and records no longer due to it,
 * those `due` does not name (`changeKey`), and says how many it still has.
 * Its writer prunes them as it plans, so one refused before the item stopped
 * being due is not shown again should it be due once more.
 */
export async function pruneRefusals(prisma: PrismaService, tabletId: string, due: readonly string[]): Promise<number> {
  const [{ remaining }] = await prisma.$queryRaw<[{ remaining: number }]>`
    WITH gone AS (DELETE FROM tablet_refusals WHERE tablet_id = ${tabletId}::uuid AND change_key <> ALL(${[...due]}::text[]) RETURNING 1)
    SELECT ((SELECT count(*) FROM tablet_refusals WHERE tablet_id = ${tabletId}::uuid) - (SELECT count(*) FROM gone))::int AS remaining`;
  return remaining;
}

/** Forgets a refusal of the item or record the key names, as when the tablet answers that its record is gone. */
export async function forgetRefusal(prisma: PrismaService, tabletId: string, key: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM tablet_refusals WHERE tablet_id = ${tabletId}::uuid AND change_key = ${key}`;
}

/**
 * The item a change was of, as the management interface names it: a Bean's
 * roaster and name, a batch's Bean and roast date, a Grinder's model, a
 * Profile's title, the settings' "Steam, hot water and rinse", the
 * Workflow's "Grinder and batch"; null where its content has none.
 */
export interface ChangedItemView {
  kind: WrittenKind;
  id: string;
  name: string | null;
}

/** A change, as a Machine's sharing status shows it. */
export interface ChangeView {
  change: ChangeType;
  kind: WrittenKind;
  /** The item; null for a leave-out, whose record is none of the Library's, and for an item deleted since. */
  item: ChangedItemView | null;
  /** The tablet's record, Decaid's id for it; null for a create, the settings and the Workflow. */
  localId: string | null;
}

/** A change the tablet refused. */
export interface RefusalView extends ChangeView {
  /** Decaid's HTTP status, or null if it gave none: it did not answer, the plugin did not ask it, or the server could not take in its answer. */
  status: number | null;
  /** What Decaid answered, or why it could not be asked or its answer taken in. */
  error: string;
  /** When it was last refused. */
  refusedAt: string;
}

/** A Machine's sharing status, as the REST API returns it. */
export interface SharingStatusView {
  /** The tablet its latest connection came from, whose status this is; null if none has connected. */
  tabletId: string | null;
  /**
   * How many changes its tablet is due and has not refused, offline or not;
   * null while it is written nothing: it is capture-only, or no tablet has
   * connected.
   */
  waiting: number | null;
  /** The last change its tablet applied, and when; null if none. */
  lastApplied: (ChangeView & { appliedAt: string }) | null;
  /** The changes its tablet refused that are still due, latest first; none while it is written nothing. */
  refused: RefusalView[];
}

/**
 * The Machine's sharing status, read in one snapshot, for the tablet its
 * latest connection came from: what that tablet is due where the Machine
 * takes part now, as its writer plans it from what the tablet last reported,
 * whether or not it is connected, with each batch to be created once its
 * Bean's record is. A change it refused counts as refused rather than
 * waiting while the same is still due, and so does a batch waiting for a
 * Bean refused; one no longer due is not shown. 404 if there is no such
 * Machine.
 */
export async function sharingStatus(prisma: PrismaService, machineId: string): Promise<SharingStatusView> {
  return prisma.$transaction(
    async (tx) => {
      const [machine] = await tx.$queryRaw<{ sharing: boolean; locationId: string | null; tabletId: string | null }[]>`
        SELECT machines.sharing,
          (SELECT location_id FROM location_assignments WHERE machine_id = machines.id ORDER BY effective_from DESC LIMIT 1) AS "locationId",
          (SELECT tablet_id FROM machine_tablets WHERE machine_id = machines.id ORDER BY last_hello DESC NULLS LAST LIMIT 1) AS "tabletId"
        FROM machines WHERE machines.id = ${machineId}::uuid`;
      if (!machine) throw machineNotFound();
      const { tabletId, locationId } = machine;
      if (tabletId === null) return { tabletId: null, waiting: null, lastApplied: null, refused: [] };
      const [applied] = await tx.$queryRaw<(Omit<TabletChange, "key"> & { appliedAt: Date })[]>`
        SELECT change, kind, item_id AS "itemId", local_id AS "localId", applied_at AS "appliedAt" FROM tablet_last_applied WHERE tablet_id = ${tabletId}::uuid`;
      const takesPart = machine.sharing && locationId !== null;
      const { changes: planned, batchesAwaitingBeans } = takesPart
        ? await changesDue(tx, { machineId, tabletId }, locationId, new Set())
        : { changes: [], batchesAwaitingBeans: [] };
      const rows = takesPart
        ? await tx.$queryRaw<(TabletChange & { signature: string; status: number | null; error: string; refusedAt: Date })[]>`
            SELECT change_key AS key, change, kind, item_id AS "itemId", local_id AS "localId", signature, status, error, refused_at AS "refusedAt"
            FROM tablet_refusals WHERE tablet_id = ${tabletId}::uuid ORDER BY refused_at DESC, change_key`
        : [];
      const due = new Map(planned.map((change) => [changeKey(change), change]));
      const refused = rows.filter((row) => due.has(row.key));
      const stillRefused = new Set(refused.filter((row) => changeSignature(due.get(row.key)!) === row.signature).map((row) => row.key));
      // A batch waiting for its Bean's record waits with it, unless the Bean's create is refused.
      const awaiting = batchesAwaitingBeans.filter((beanId) => {
        const key = writeKey("bean", beanId);
        return due.has(key) && !stillRefused.has(key);
      }).length;
      const names = await itemNames(tx, [...(applied ? [applied] : []), ...refused]);
      const view = (change: Omit<TabletChange, "key">): ChangeView => ({
        change: change.change,
        kind: change.kind,
        item: change.itemId === null ? null : (names.get(`${change.kind}:${change.itemId}`) ?? null),
        localId: change.localId,
      });
      return {
        tabletId,
        waiting: takesPart ? planned.length - stillRefused.size + awaiting : null,
        lastApplied: applied ? { ...view(applied), appliedAt: applied.appliedAt.toISOString() } : null,
        refused: refused.map((row) => ({ ...view(row), status: row.status, error: row.error, refusedAt: row.refusedAt.toISOString() })),
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

/** The items the changes were of, by kind and id, as `ChangedItemView` names them; an item deleted since is absent. */
async function itemNames(tx: Prisma.TransactionClient, changes: readonly Omit<TabletChange, "key">[]): Promise<Map<string, ChangedItemView>> {
  const ids = (kind: WrittenKind) => [...new Set(changes.filter((change) => change.kind === kind && change.itemId !== null).map((change) => change.itemId!))];
  const empty = { beanId: null, batchId: null, grinderId: null, profileId: null, bean: null, batch: null, grinder: null, profile: null, settingsId: null };
  const named = new Map<string, ChangedItemView>();
  const add = (view: ChangedItemView) => named.set(`${view.kind}:${view.id}`, view);
  const uuids = (kind: WrittenKind) => ids(kind).filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  for (const bean of await tx.bean.findMany({ where: { id: { in: uuids("bean") } }, select: { id: true, content: true } })) {
    add(itemView({ ...empty, beanId: bean.id, bean }) as ChangedItemView);
  }
  for (const batch of await tx.beanBatch.findMany({ where: { id: { in: uuids("beanBatch") } }, select: { id: true, content: true, bean: { select: { content: true } } } })) {
    add(itemView({ ...empty, batchId: batch.id, batch }) as ChangedItemView);
  }
  for (const grinder of await tx.grinder.findMany({ where: { id: { in: uuids("grinder") } }, select: { id: true, content: true } })) {
    add(itemView({ ...empty, grinderId: grinder.id, grinder }) as ChangedItemView);
  }
  for (const profile of await tx.profile.findMany({ where: { id: { in: ids("profile") } }, select: { id: true, content: true } })) {
    add(itemView({ ...empty, profileId: profile.id, profile }) as ChangedItemView);
  }
  for (const id of ids("settings")) add({ kind: "settings", id, name: "Steam, hot water and rinse" });
  for (const id of ids("workflow")) add({ kind: "workflow", id, name: "Grinder and batch" });
  return named;
}
