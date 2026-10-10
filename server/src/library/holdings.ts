import { globalIdOf, sameValue } from "@decent-sync/protocol";
import type { DeletedKind, LibraryKind, WrittenKind } from "@decent-sync/protocol";
import { batchContent, weightOf } from "./batch-intake.js";
import { beanContent } from "./bean-intake.js";
import { grinderContent } from "./grinder-intake.js";
import { isObject } from "./listed.js";
import { PROFILE_TEXT, profileText } from "./profile-intake.js";

// What a tablet should hold for its Location (ADR-0008), and the writes that
// bring it there. A tablet holds only what its Location offers: each Bean,
// Bean Batch and Grinder offered there, not archived, each batch with the
// remaining weight entered there, and each Profile shown there, visible. What it holds
// that the Location does not offer is archived or hidden on it, never
// deleted, so its Shots still find it. Every record it holds is written the
// item's content where it differs, so an edit reaches every tablet that
// holds the item, at every Location (ADR-0020). Pure, so module tests can
// drive it; tablet-due.ts reads what it needs.

/** A Bean a Location offers, with its content. */
export interface OfferedBean {
  id: string;
  content: Record<string, unknown>;
  /** When the latest edit of its content was decided, by PostgreSQL's clock: a record written it has seen that. Null if none was. */
  contentDecidedAt: Date | null;
  /** When the Location last decided whether any of its batches is there, by PostgreSQL's clock; null if it never did. */
  decidedAt: Date | null;
}

/** A Grinder a Location offers, with its content. */
export interface OfferedGrinder {
  id: string;
  content: Record<string, unknown>;
  contentDecidedAt: Date | null;
}

/** A Bean Batch, as the Location has it: offered there or not, and its remaining weight there. */
export interface LocationBatch {
  id: string;
  beanId: string;
  content: Record<string, unknown>;
  contentDecidedAt: Date | null;
  /** Whether the Location offers it: it is at the Location, and neither it nor its Bean is Archived. */
  offered: boolean;
  /** The remaining weight entered at the Location last, null if cleared; undefined if none ever was. */
  remainingWeight: number | null | undefined;
  /** When the Location last decided whether it is there, by PostgreSQL's clock; null if it never did. */
  decidedAt: Date | null;
}

/** A Profile a Location shows (ADR-0008). */
export interface ShownProfile {
  /** Decaid's id, the same on every tablet. */
  id: string;
  /** One of Decaid's bundled Profiles, which a tablet has already or lacks for its Decaid's version: never written. */
  bundled: boolean;
  /** Its content, to create its record with; null where the tablet holds it already. */
  content: Record<string, unknown> | null;
  /** When the Location decided to show it, by PostgreSQL's clock. */
  decidedAt: Date;
  contentDecidedAt: Date | null;
}

/** What a Location offers, and its state of each batch the tablet holds. Each list is in the order to write it: oldest first. */
export interface LocationOffer {
  beans: readonly OfferedBean[];
  /** The batches it offers, then the other batches the tablet holds. */
  batches: readonly LocationBatch[];
  /** The Grinders belonging to it, but those Archived. */
  grinders: readonly OfferedGrinder[];
  /** The Profiles it shows. */
  profiles: readonly ShownProfile[];
}

/** A Library item's record on the tablet, as its map holds it. */
export interface HeldRecord {
  itemId: string;
  localId: string;
  record: Record<string, unknown>;
  /**
   * For a Bean, when the tablet's Location last decided whether any of its
   * batches is there; for a Profile, whether it shows it. By PostgreSQL's
   * clock; null if it never did.
   */
  decidedAt?: Date | null;
  /**
   * The item's content as the Library has it, as edits merge it: a Bean's,
   * a batch's or a Grinder's record fields (`beanContent`, `batchContent`,
   * `grinderContent`), a Profile's title, author and notes (`profileText`).
   * Null for one of Decaid's bundled Profiles, whose Decaid refuses changes.
   */
  content: Record<string, unknown> | null;
  /** When the latest edit of that content was decided, by PostgreSQL's clock; null if none was. */
  contentDecidedAt: Date | null;
}

/** What the tablet holds, by its map. A Profile's local id is its id. */
export interface TabletHoldings {
  beans: readonly HeldRecord[];
  batches: readonly HeldRecord[];
  grinders: readonly HeldRecord[];
  profiles: readonly HeldRecord[];
}

/** A write that brings the tablet closer to what its Location offers, or to its settings (location-settings.ts). */
export interface PlannedWrite {
  kind: WrittenKind;
  globalId: string;
  /** The tablet's record to update, or null to create one. */
  localId: string | null;
  /** The fields to set, as Decaid names them: on creating, the item's content; otherwise only those that differ. */
  fields: Record<string, unknown>;
  /** On updating, the value the tablet's record holds for each of `fields`, as it last reported it: the plugin sets a field only while it still does. */
  expected?: Record<string, unknown>;
  /**
   * The Location's latest decision of the batch's presence, of the presence
   * of any of the Bean's batches, or of the Profile's showing, by
   * PostgreSQL's clock, as the write was planned: Decaid answers it after
   * that, so its answer has seen it. Null where the Location never decided
   * it, and for a Grinder, which belongs to one Location.
   */
  decidedAt: Date | null;
  /**
   * When the latest edit of the item's content was decided, by PostgreSQL's
   * clock, as the write was planned: once Decaid answers it, the record
   * holds that content, but for what the tablet changed meanwhile, which
   * its answer shows. Null if none was.
   */
  contentDecidedAt: Date | null;
}

/**
 * A tablet's record of an item an Admin hard-deleted, to be deleted there
 * (hard-deletes.ts): its global id, and its id on the tablet.
 */
export interface PlannedDelete {
  delete: true;
  kind: DeletedKind;
  globalId: string;
  localId: string;
}

/** A tablet's record the Library leaves out, to be set aside there, archived or hidden (left-out.ts): its kind, and its id on the tablet. */
export interface PlannedLeaveOut {
  leaveOut: true;
  kind: DeletedKind;
  localId: string;
}

/** What the writer does next to a tablet: a write, a delete, or setting aside a record the Library leaves out. */
export type PlannedChange = PlannedWrite | PlannedDelete | PlannedLeaveOut;

/** The key a planned delete is skipped and its refusal kept under. */
export function deleteKey(kind: DeletedKind, localId: string): string {
  return `delete:${kind}:${localId}`;
}

/** The key setting aside a record the Library leaves out is skipped and its refusal kept under. */
export function leaveOutKey(kind: DeletedKind, localId: string): string {
  return `leaveOut:${kind}:${localId}`;
}

/** The key a write's item is skipped and its refusal kept under. */
export function writeKey(kind: WrittenKind, globalId: string): string {
  return `${kind}:${globalId}`;
}

/**
 * The writes due, in the order they are made: first each Bean the Location
 * offers that the tablet lacks, holds archived, or holds without its global
 * id; then each batch the tablet lacks, or holds archived, without its
 * global id or with another remaining weight than the Location's; then
 * each batch the tablet holds that the Location does not offer, archived,
 * and each Bean the same way. Beans so come before their batches, and
 * batches are archived before their Beans. Then each Grinder the Location
 * offers that the tablet lacks, holds archived, or holds without its global
 * id, and each the tablet holds that it does not offer, archived. Last, each
 * Profile the Location shows that the tablet lacks, created, unless it is one
 * of Decaid's bundled Profiles, after the Profile it was saved from if that
 * is created too, so the tablet keeps its parent; or that the tablet holds
 * hidden or deleted, made visible. Then each the tablet holds visible that
 * the Location does not show, hidden. Items in `skipped`
 * (`writeKey`) are left out, and so is a batch whose Bean the tablet holds
 * no record of yet: its Bean is written first. Every record the tablet holds
 * whose content differs from the item's, offered there or not, is written the
 * item's content, in the same update. Every update sets only the fields that
 * differ, writing the global id beside them; a Profile's records carry none.
 */
export function plannedWrites(offer: LocationOffer, held: TabletHoldings, skipped: ReadonlySet<string> = new Set()): PlannedWrite[] {
  const beans = new Map(held.beans.map((record) => [record.itemId, record]));
  const batches = new Map(held.batches.map((record) => [record.itemId, record]));
  const offeredBeans = new Set(offer.beans.map((bean) => bean.id));
  const writes: PlannedWrite[] = [];
  for (const bean of offer.beans) {
    const record = beans.get(bean.id);
    if (!record) {
      writes.push({ kind: "bean", globalId: bean.id, localId: null, fields: bean.content, decidedAt: bean.decidedAt, contentDecidedAt: bean.contentDecidedAt });
    } else {
      pushUpdate(writes, "bean", bean.id, record, record.record.archived === true ? { archived: false } : {}, bean.decidedAt);
    }
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
        decidedAt: batch.decidedAt,
        contentDecidedAt: batch.contentDecidedAt,
      });
      continue;
    }
    const fields: Record<string, unknown> = {};
    if ((record.record.archived === true) === batch.offered) fields.archived = !batch.offered;
    if (weight !== undefined && weightOf(record.record) !== weight) fields.weightRemaining = weight;
    pushUpdate(writes, "beanBatch", batch.id, record, fields, batch.decidedAt);
  }
  for (const record of held.beans) {
    if (!offeredBeans.has(record.itemId)) pushUpdate(writes, "bean", record.itemId, record, record.record.archived === true ? {} : { archived: true }, record.decidedAt ?? null);
  }
  const grinders = new Map(held.grinders.map((record) => [record.itemId, record]));
  const offeredGrinders = new Set(offer.grinders.map((grinder) => grinder.id));
  for (const grinder of offer.grinders) {
    const record = grinders.get(grinder.id);
    if (!record) writes.push({ kind: "grinder", globalId: grinder.id, localId: null, fields: grinder.content, decidedAt: null, contentDecidedAt: grinder.contentDecidedAt });
    else pushUpdate(writes, "grinder", grinder.id, record, record.record.archived === true ? { archived: false } : {}, null);
  }
  for (const record of held.grinders) {
    if (!offeredGrinders.has(record.itemId)) pushUpdate(writes, "grinder", record.itemId, record, record.record.archived === true ? {} : { archived: true }, null);
  }
  const profiles = new Map(held.profiles.map((record) => [record.itemId, record]));
  const shownProfiles = new Set(offer.profiles.map((profile) => profile.id));
  for (const profile of parentsFirst(offer.profiles)) {
    const record = profiles.get(profile.id);
    if (record) {
      pushUpdate(writes, "profile", profile.id, record, record.record.visibility === "visible" ? {} : { visibility: "visible" }, profile.decidedAt);
    } else if (!profile.bundled && profile.content !== null) {
      writes.push({
        kind: "profile",
        globalId: profile.id,
        localId: null,
        fields: { ...profileToCreate(profile.content), visibility: "visible" },
        decidedAt: profile.decidedAt,
        contentDecidedAt: profile.contentDecidedAt,
      });
    }
  }
  for (const record of held.profiles) {
    if (shownProfiles.has(record.itemId)) continue;
    // One hidden or deleted on the tablet is not shown there already.
    pushUpdate(writes, "profile", record.itemId, record, record.record.visibility === "visible" ? { visibility: "hidden" } : {}, record.decidedAt ?? null);
  }
  return writes.filter((write) => !skipped.has(writeKey(write.kind, write.globalId)));
}

/**
 * The Bean of each batch the Location offers that the tablet lacks while it
 * lacks the Bean's record too, one for each such batch: `plannedWrites`
 * plans the batch once the Bean's record is written, so it is waiting on
 * that write.
 */
export function batchesAwaitingBeans(offer: LocationOffer, held: TabletHoldings): string[] {
  const beans = new Set(held.beans.map((record) => record.itemId));
  const batches = new Set(held.batches.map((record) => record.itemId));
  return offer.batches.filter((batch) => batch.offered && !batches.has(batch.id) && !beans.has(batch.beanId)).map((batch) => batch.beanId);
}

/**
 * The Profiles in the order given, but each to be created after the Profile
 * it was saved from where that is to be created too: Decaid refuses a parent
 * it lacks, so the plugin would create it without one. Only Profiles to be
 * created carry their content, and so their parent.
 */
function parentsFirst(profiles: readonly ShownProfile[]): ShownProfile[] {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const ordered: ShownProfile[] = [];
  const placed = new Set<string>();
  const place = (profile: ShownProfile) => {
    if (placed.has(profile.id)) return;
    // Marked before its parent is placed, so a lineage that loops, which Decaid's hashes make unlikely, still ends.
    placed.add(profile.id);
    const parentId = profile.content?.parentId;
    const parent = typeof parentId === "string" ? byId.get(parentId) : undefined;
    if (parent?.content) place(parent);
    ordered.push(profile);
  };
  for (const profile of profiles) place(profile);
  return ordered;
}

/** What Decaid's `POST /profiles` takes to create a Profile's record, from its content: the profile, its parent and its metadata. */
function profileToCreate(content: Record<string, unknown>): Record<string, unknown> {
  return { profile: content.profile, parentId: content.parentId ?? null, metadata: content.metadata ?? null };
}

/**
 * Adds an update of the tablet's record, if it lacks its global id (but a
 * Profile's, which carries none), any of `location`, the fields of its
 * Location's state to set, or the item's content where it differs, with the
 * value the record holds for each field to set.
 */
function pushUpdate(writes: PlannedWrite[], kind: LibraryKind, globalId: string, record: HeldRecord, location: Record<string, unknown>, decidedAt: Date | null): void {
  const fields = { ...contentToWrite(kind, record), ...location };
  const lacksId = kind !== "profile" && globalIdOf(record.record) !== globalId.toLowerCase();
  if (Object.keys(fields).length === 0 && !lacksId) return;
  const expected = Object.fromEntries(Object.keys(fields).map((field) => [field, heldValue(kind, record.record, field)]));
  writes.push({ kind, globalId, localId: record.localId, fields, expected, decidedAt, contentDecidedAt: record.contentDecidedAt });
}

/** The item's content where the tablet's record of it differs: each field the record is to be written, with the item's value, null to clear it. */
function contentToWrite(kind: LibraryKind, held: HeldRecord): Record<string, unknown> {
  if (!held.content) return {};
  const tablet = recordContent(kind, held.record);
  const fields: Record<string, unknown> = {};
  for (const field of new Set([...Object.keys(held.content), ...Object.keys(tablet)])) {
    if (!sameValue(held.content[field], tablet[field])) fields[field] = held.content[field] ?? null;
  }
  return fields;
}

/** A tablet's record's content, as edits merge it. */
function recordContent(kind: LibraryKind, record: Record<string, unknown>): Record<string, unknown> {
  switch (kind) {
    case "bean":
      return beanContent(record);
    case "beanBatch":
      return batchContent(record);
    case "grinder":
      return grinderContent(record);
    case "profile":
      return profileText(record);
  }
}

/** The value a tablet's record holds for a field a write sets, as Decaid names it: a Profile's title, author and notes are in its `profile`. */
function heldValue(kind: LibraryKind, record: Record<string, unknown>, field: string): unknown {
  if (kind === "profile" && (PROFILE_TEXT as readonly string[]).includes(field)) return (isObject(record.profile) ? record.profile[field] : undefined) ?? null;
  return record[field] ?? null;
}
