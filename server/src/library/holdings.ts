import { globalIdOf } from "@decent-sync/protocol";
import type { LibraryKind } from "@decent-sync/protocol";
import { weightOf } from "./batch-intake.js";

// What a tablet should hold for its Location (ADR-0008), and the writes that
// bring it there. A tablet holds only what its Location offers: each Bean
// and Bean Batch offered there, not archived, and each batch with the
// remaining weight entered there. What it holds that the Location does not
// offer is archived on it, never deleted, so its Shots still find it. Pure,
// so module tests can drive it; tablet-due.ts reads what it needs.

/** A Bean a Location offers, with its content. */
export interface OfferedBean {
  id: string;
  content: Record<string, unknown>;
}

/** A Bean Batch, as the Location has it: offered there or not, and its remaining weight there. */
export interface LocationBatch {
  id: string;
  beanId: string;
  content: Record<string, unknown>;
  /** Whether the Location offers it: it is at the Location, and neither it nor its Bean is Archived. */
  offered: boolean;
  /** The remaining weight entered at the Location last, null if cleared; undefined if none ever was. */
  remainingWeight: number | null | undefined;
}

/** What a Location offers, and its state of each batch the tablet holds. Each list is in the order to write it: oldest first. */
export interface LocationOffer {
  beans: readonly OfferedBean[];
  /** The batches it offers, then the other batches the tablet holds. */
  batches: readonly LocationBatch[];
}

/** A Library item's record on the tablet, as its map holds it. */
export interface HeldRecord {
  itemId: string;
  localId: string;
  record: Record<string, unknown>;
}

/** What the tablet holds, by its map. */
export interface TabletHoldings {
  beans: readonly HeldRecord[];
  batches: readonly HeldRecord[];
}

/** A write that brings the tablet closer to what its Location offers. */
export interface PlannedWrite {
  kind: LibraryKind;
  globalId: string;
  /** The tablet's record to update, or null to create one. */
  localId: string | null;
  /** The fields to set, as Decaid names them: on creating, the item's content; otherwise only those that differ. */
  fields: Record<string, unknown>;
}

/** The key a write's item is skipped under, for the rest of a connection. */
export function writeKey(kind: LibraryKind, globalId: string): string {
  return `${kind}:${globalId}`;
}

/**
 * The writes due, in the order they are made: first each Bean the Location
 * offers that the tablet lacks, holds archived, or holds without its global
 * id; then each batch the tablet lacks, or holds archived, without its
 * global id or with another remaining weight than the Location's; then
 * each batch the tablet holds that the Location does not offer, archived,
 * and each Bean the same way. Beans so come before their batches, and
 * batches are archived before their Beans. Items in `skipped`
 * (`writeKey`) are left out, and so is a batch whose Bean the tablet holds
 * no record of yet: its Bean is written first. Every update sets only the
 * fields that differ, writing the global id beside them.
 */
export function plannedWrites(offer: LocationOffer, held: TabletHoldings, skipped: ReadonlySet<string> = new Set()): PlannedWrite[] {
  const beans = new Map(held.beans.map((record) => [record.itemId, record]));
  const batches = new Map(held.batches.map((record) => [record.itemId, record]));
  const offeredBeans = new Set(offer.beans.map((bean) => bean.id));
  const writes: PlannedWrite[] = [];
  for (const bean of offer.beans) {
    const record = beans.get(bean.id);
    if (!record) writes.push({ kind: "bean", globalId: bean.id, localId: null, fields: bean.content });
    else pushUpdate(writes, "bean", bean.id, record, record.record.archived === true ? { archived: false } : {});
  }
  for (const batch of offer.batches) {
    const record = batches.get(batch.id);
    const weight = batch.remainingWeight;
    if (!record) {
      const bean = beans.get(batch.beanId);
      if (!batch.offered || !bean) continue;
      writes.push({
        kind: "beanBatch",
        globalId: batch.id,
        localId: null,
        fields: { ...batch.content, beanId: bean.localId, ...(weight === undefined ? {} : { weightRemaining: weight }) },
      });
      continue;
    }
    const fields: Record<string, unknown> = {};
    if ((record.record.archived === true) === batch.offered) fields.archived = !batch.offered;
    if (weight !== undefined && weightOf(record.record) !== weight) fields.weightRemaining = weight;
    pushUpdate(writes, "beanBatch", batch.id, record, fields);
  }
  for (const record of held.beans) {
    if (!offeredBeans.has(record.itemId)) pushUpdate(writes, "bean", record.itemId, record, record.record.archived === true ? {} : { archived: true });
  }
  return writes.filter((write) => !skipped.has(writeKey(write.kind, write.globalId)));
}

/** Adds an update of the tablet's record, if it lacks its global id or any of `fields`. */
function pushUpdate(writes: PlannedWrite[], kind: LibraryKind, globalId: string, record: HeldRecord, fields: Record<string, unknown>): void {
  if (Object.keys(fields).length === 0 && globalIdOf(record.record) === globalId.toLowerCase()) return;
  writes.push({ kind, globalId, localId: record.localId, fields });
}
