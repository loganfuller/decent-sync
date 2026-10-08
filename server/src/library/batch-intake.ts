import { globalIdOf, isRecordId } from "@decent-sync/protocol";
import { isObject } from "./listed.js";

// How a tablet's report of its bean batches is taken into the Library
// (ADR-0006, ADR-0018), and what each change means at the tablet's Location
// (ADR-0008, ADR-0019): the mapping from tablet records to per-Location
// state. Decided from the report, the tablet's maps of its batches and
// beans, and the Library Bean Batches the report may name. Pure, so module
// tests can drive it; bean-batches.ts reads what it needs and carries the
// plan out.

/** A bean batch as a tablet reported it, one Decent Sync can take in. */
export interface ReportedBatch {
  /** Decaid's id for it on that tablet. */
  localId: string;
  /** Decaid's id, on that tablet, for the bean it is a batch of. */
  beanLocalId: string;
  /** The global id its `extras` carry, if any. */
  globalId: string | null;
  /** Whether it is archived on the tablet: not at the tablet's Location (ADR-0008). */
  archived: boolean;
  /** Its `weightRemaining`, the remaining weight entered at the tablet's Location; null without one. */
  weightRemaining: number | null;
  /** Its `updatedAt`, placed in UTC by the plugin: the time of its edits. */
  updatedAt: Date;
  /** The record, as Decaid sent it. */
  record: Record<string, unknown>;
}

/** A Library Bean Batch the tablet's map holds a record of: the record as the tablet last had it. */
export interface MappedBatch {
  batchId: string;
  localId: string;
  /** When the record known was updated, by the tablet's clock; null if its time could not be read. */
  updatedAt: Date | null;
  /** The global id the record known carries, if any. */
  globalId: string | null;
  archived: boolean;
  weightRemaining: number | null;
}

/** A Library Bean Batch the report may name by the global id a record carries. */
export interface LibraryBatch {
  id: string;
}

/**
 * A change a tablet made to a batch's state at its Location, each a field of
 * its own (ADR-0020), timed by its record. A remaining weight carries the
 * value the tablet last had, so that it can be told whether the tablet saw
 * the Location's current value; whether the batch is there is judged by the
 * edits' times alone.
 */
export type LocationEdit =
  /** Un-archived on the tablet, it is added there (true); archived or deleted, it is finished there (false). */
  | { field: "at"; value: boolean }
  /** Its remaining weight there, null when cleared, changed from `had`. */
  | { field: "remainingWeight"; value: number | null; had: number | null };

/** One thing a report changes. */
export type BatchIntakeStep =
  /**
   * The tablet's record of a batch the map holds is newer than the one known,
   * which it replaces, with the changes it made at its Location since.
   */
  | { kind: "update"; batchId: string; batch: ReportedBatch; edits: LocationEdit[] }
  /** The tablet holds a Library batch the map did not know it held, by the global id its record carries. */
  | { kind: "map"; batchId: string; batch: ReportedBatch }
  /**
   * A batch new to the Library, which joins it as a batch of the Library Bean
   * the tablet's record of its bean is. Unless it is archived on the tablet,
   * it is at the tablet's Location from then, with the remaining weight its
   * record has.
   */
  | { kind: "add"; beanId: string; batch: ReportedBatch; edits: LocationEdit[] }
  /** A record the map holds is gone from the tablet's list: deleted there, it is finished there, and held no more. */
  | { kind: "delete"; batchId: string; localId: string; updatedAt: Date | null; edits: LocationEdit[] };

/**
 * The batches of a reported `beanBatches` list that Decent Sync can take in,
 * each with its time in UTC as the plugin placed it beside the list. A
 * record without what every supported Decaid sends (its id, its bean's id,
 * and an `updatedAt` the plugin could place) is left out.
 */
export function readReportedBatches(value: unknown, updatedAt: readonly (string | null)[] | undefined): ReportedBatch[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((record: unknown, index) => {
    const time = updatedAt?.[index];
    if (!isObject(record) || !isRecordId(record.id) || !isRecordId(record.beanId) || !time) return [];
    return [
      {
        localId: record.id,
        beanLocalId: record.beanId,
        globalId: globalIdOf(record),
        archived: record.archived === true,
        weightRemaining: weightOf(record),
        updatedAt: new Date(time),
        record,
      },
    ];
  });
}

/** A batch record's `weightRemaining`, or null if it has none. */
export function weightOf(record: Record<string, unknown>): number | null {
  return typeof record.weightRemaining === "number" && Number.isFinite(record.weightRemaining) ? record.weightRemaining : null;
}

/**
 * A Bean Batch's content, from a tablet's record of it: Decaid's fields,
 * those this server does not know included, but its id, its bean's id on
 * that tablet, its times and `extras`, which belong to that tablet's record,
 * and `archived` and `weightRemaining`, which are each Location's (ADR-0008).
 */
export function batchContent(record: Record<string, unknown>): Record<string, unknown> {
  const { id, beanId, createdAt, updatedAt, archived, weightRemaining, extras, ...content } = record;
  return content;
}

/**
 * What a report changes, as `planIntake` decides it for beans. A record the
 * tablet's map holds by its local id stays that batch whatever global id it
 * carries; its record replaces the one known when it is newer, or as old but
 * changed at the Location within the millisecond the plugin reads times to,
 * or when it no longer carries the batch's global id while the one known
 * does, whatever its time. Each such record brings the changes made to it since the one
 * known: un-archived, the batch is added at the tablet's Location; archived,
 * finished there; its `weightRemaining` changed, its remaining weight there
 * (ADR-0008). Otherwise a record carrying a Library batch's global id is
 * that batch, and changes nothing at the Location: the Location's state is
 * then written to it.
 *
 * Every other record is new: Bean Batches are never matched (ADR-0018). It
 * joins the Library as a batch of the Bean the tablet's map holds its bean's
 * record as (`beans`, by the tablet's ids), or, if the map holds no such
 * record yet, waits for a report taken in once it does. A new record
 * archived on the tablet joins the Library but is at no Location.
 *
 * Last, each record the map holds whose id the list no longer holds
 * (`listed`) was deleted on the tablet, unless another record it reports is
 * that batch now: it is finished at the tablet's Location. A new or reset
 * tablet's map holds nothing, so it deletes nothing (ADR-0019).
 */
export function planBatchIntake(
  reported: readonly ReportedBatch[],
  mapped: readonly MappedBatch[],
  beans: ReadonlyMap<string, string>,
  library: readonly LibraryBatch[],
  listed: ReadonlySet<string> = new Set(reported.map((batch) => batch.localId)),
): BatchIntakeStep[] {
  const byLocalId = new Map(mapped.map((batch) => [batch.localId, batch]));
  const reportedIds = new Set(reported.map((batch) => batch.localId));
  /** Library batches one of the tablet's reported records is, or is about to be. */
  const held = new Set(mapped.filter((batch) => reportedIds.has(batch.localId)).map((batch) => batch.batchId));
  const known = new Set(library.map((batch) => batch.id));
  const seen = new Set<string>();
  const steps: BatchIntakeStep[] = [];
  const unknown: ReportedBatch[] = [];
  for (const batch of reported) {
    if (seen.has(batch.localId)) continue;
    seen.add(batch.localId);
    const mine = byLocalId.get(batch.localId);
    if (mine) {
      const edits = editsSince(mine, batch);
      const newer = mine.updatedAt === null || batch.updatedAt.getTime() > mine.updatedAt.getTime();
      // Times are read to the millisecond, so one as old that differs at the Location was changed within it.
      const sameTime = mine.updatedAt !== null && batch.updatedAt.getTime() === mine.updatedAt.getTime() && edits.length > 0;
      const lostId = batch.globalId !== mine.batchId && mine.globalId === mine.batchId;
      if (newer || sameTime || lostId) steps.push({ kind: "update", batchId: mine.batchId, batch, edits });
      continue;
    }
    if (batch.globalId !== null && known.has(batch.globalId) && !held.has(batch.globalId)) {
      held.add(batch.globalId);
      steps.push({ kind: "map", batchId: batch.globalId, batch });
      continue;
    }
    unknown.push(batch);
  }
  for (const batch of unknown) {
    const beanId = beans.get(batch.beanLocalId);
    if (beanId === undefined) continue;
    const edits: LocationEdit[] = batch.archived ? [] : [{ field: "at", value: true }];
    if (batch.weightRemaining !== null) edits.push({ field: "remainingWeight", value: batch.weightRemaining, had: null });
    steps.push({ kind: "add", beanId, batch, edits });
  }
  for (const batch of mapped) {
    if (listed.has(batch.localId) || held.has(batch.batchId)) continue;
    steps.push({ kind: "delete", batchId: batch.batchId, localId: batch.localId, updatedAt: batch.updatedAt, edits: batch.archived ? [] : [{ field: "at", value: false }] });
  }
  return steps;
}

/**
 * What a tablet changed at its Location that the record Decaid returned for
 * one of the server's writes shows: each field the write did not set
 * (`written`, the names the answer lists) that differs from the record known.
 * The plugin reads a record before it updates it, and Decaid keeps the
 * fields it is not sent, so a change made on the tablet since its last
 * report reaches the server in the answer, not in a later report, which
 * holds the record as answered. Without a record known, as for one the
 * write created, there is none.
 */
export function editsInAnswer(
  known: Pick<MappedBatch, "archived" | "weightRemaining"> | null,
  record: Record<string, unknown>,
  written: ReadonlySet<string>,
): LocationEdit[] {
  if (known === null) return [];
  return editsSince(known, { archived: record.archived === true, weightRemaining: weightOf(record) }).filter((edit) =>
    edit.field === "at" ? !written.has("archived") : !written.has("weightRemaining"),
  );
}

/** What a tablet changed at its Location between the record known and one it holds now. */
function editsSince(known: Pick<MappedBatch, "archived" | "weightRemaining">, now: Pick<ReportedBatch, "archived" | "weightRemaining">): LocationEdit[] {
  const edits: LocationEdit[] = [];
  if (now.archived !== known.archived) edits.push({ field: "at", value: !now.archived });
  if (now.weightRemaining !== known.weightRemaining) edits.push({ field: "remainingWeight", value: now.weightRemaining, had: known.weightRemaining });
  return edits;
}
