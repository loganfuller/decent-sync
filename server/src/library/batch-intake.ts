import { BATCH_CODE_FIELD, BATCH_CODE_KEY, globalIdOf, isRecordId, sameValue } from "@decent-sync/protocol";
import { isObject } from "./listed.js";
import { changedFields } from "./merge.js";

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

/**
 * A weight a tablet's record of a batch has held as its `weightRemaining`,
 * or the server has written it (ADR-0037): the batch's Remaining Weight at
 * the tablet's Location as it was worked out then, or as its barista entered
 * it, null for one cleared, and the count it was of
 * (`remaining_weight_version_id`), null where none is known.
 */
export interface WrittenWeight {
  weight: number | null;
  count: string | null;
}

/** How many of the weights a record has held or been written are kept: the latest, enough for a form left open across a busy spell of Shots. */
export const WRITTEN_WEIGHTS_KEPT = 16;

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
  /** The record known, as the tablet reported it or Decaid returned the plugin's write of it. */
  record: Record<string, unknown>;
  /**
   * The weights the record has held or the server has written it under the
   * count its weight is of, with the writes noted since, oldest first: a
   * record holding one of them again holds no weight a barista entered, as
   * when the answer to a write was lost with the connection, or a form
   * opened on the tablet before a Shot was saved after it.
   */
  writtenWeights?: readonly WrittenWeight[];
  /** The count the weight the record known holds was written from, or that its own entry started; null or absent where none is known. */
  weightCount?: string | null;
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
 * Location's decision the tablet's record had seen, and otherwise by the
 * edits' times (location-state.ts).
 */
export type LocationEdit =
  /** Un-archived on the tablet, it is added there (true); archived or deleted, it is finished there (false). */
  | { field: "at"; value: boolean }
  /**
   * Its remaining weight there, null when cleared, changed from `had`, which
   * the server wrote from the count `hadCount` or the tablet's own entry
   * started it, where that is known: the tablet had seen that count.
   */
  | { field: "remainingWeight"; value: number | null; had: number | null; hadCount?: string | null };

/** One thing a report changes. */
export type BatchIntakeStep =
  /**
   * The tablet's record of a batch the map holds is newer than the one known,
   * which it replaces, with the changes it made at its Location since, and
   * the fields of the batch's content it changed since, each with its value
   * (`content`): its edit (ADR-0020).
   */
  | { kind: "update"; batchId: string; batch: ReportedBatch; edits: LocationEdit[]; content: Record<string, unknown> }
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
 * A Bean Batch's content, from a tablet's record of it, as a tablet's edit
 * gives it: Decaid's fields, those this server does not know included, but
 * its id, its bean's id on that tablet, its times and `extras`, which belong
 * to that tablet's record, and `archived` and `weightRemaining`, which are
 * each Location's (ADR-0008). And no Batch Code, wherever the record holds
 * one: a tablet is not a source of Batch Code edits (ADR-0036), so one
 * changed there is no edit, and is written over (`batchRecordValues`).
 */
export function batchContent(record: Record<string, unknown>): Record<string, unknown> {
  const { id, beanId, createdAt, updatedAt, archived, weightRemaining, extras, [BATCH_CODE_FIELD]: batchCode, ...content } = record;
  return content;
}

/**
 * What a tablet's record of a Bean Batch holds of the batch's content, as
 * the server compares it with the batch's to plan a write: `batchContent`,
 * and the Batch Code it holds in its `extras` (`heldBatchCode`).
 */
export function batchRecordValues(record: Record<string, unknown>): Record<string, unknown> {
  const code = heldBatchCode(record);
  return code === null ? batchContent(record) : { ...batchContent(record), [BATCH_CODE_FIELD]: code };
}

/**
 * What a tablet's record of a Bean Batch holds as its Batch Code, in its
 * `extras` under BATCH_CODE_KEY, where the plugin writes it (ADR-0036):
 * whatever is there, as a write of it expects the record to hold exactly
 * that, or null for none.
 */
export function heldBatchCode(record: Record<string, unknown>): unknown {
  const { extras } = record;
  return isObject(extras) ? (extras[BATCH_CODE_KEY] ?? null) : null;
}

/**
 * What a report changes, as `planIntake` decides it for beans. A record the
 * tablet's map holds by its local id stays that batch whatever global id it
 * carries; its record replaces the one known when it is newer, or as old but
 * changed within the millisecond the plugin reads times to (at the Location,
 * in its content, or in the Batch Code it holds, which is written over),
 * or when it no longer carries the batch's global id while the one known
 * does, whatever its time. Each such record brings the changes made to it since the one
 * known: un-archived, the batch is added at the tablet's Location; archived,
 * finished there; its `weightRemaining` changed, its remaining weight there
 * (ADR-0008), unless it holds again a weight it held or was written (`writtenWeightHeld`),
 * which is no entry (ADR-0037); any other field changed, an edit of the batch's content. Otherwise a record carrying a Library batch's global id is
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
      const content = changedFields(batchContent(mine.record), batchContent(batch.record));
      const newer = mine.updatedAt === null || batch.updatedAt.getTime() > mine.updatedAt.getTime();
      // Times are read to the millisecond, so one as old that was changed since was changed within it, its Batch Code included, to be written over.
      // So is one whose weight is the server's write, which is no edit but is the record held now.
      const changed =
        edits.length > 0 ||
        batch.weightRemaining !== mine.weightRemaining ||
        Object.keys(content).length > 0 ||
        !sameValue(heldBatchCode(mine.record), heldBatchCode(batch.record));
      const sameTime = mine.updatedAt !== null && batch.updatedAt.getTime() === mine.updatedAt.getTime() && changed;
      const lostId = batch.globalId !== mine.batchId && mine.globalId === mine.batchId;
      if (newer || sameTime || lostId) steps.push({ kind: "update", batchId: mine.batchId, batch, edits, content });
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
 * write created, there is none. A weight the write left as it found it is
 * none either where it is one the record held or was written before
 * (`writtenWeightHeld`), as when that write's answer was lost and this one
 * expected the weight before it.
 */
export function editsInAnswer(
  known: Pick<MappedBatch, "archived" | "weightRemaining" | "writtenWeights" | "weightCount"> | null,
  record: Record<string, unknown>,
  written: ReadonlySet<string>,
): LocationEdit[] {
  if (known === null) return [];
  return editsSince(known, { archived: record.archived === true, weightRemaining: weightOf(record) }).filter((edit) =>
    edit.field === "at" ? !written.has("archived") : !written.has("weightRemaining"),
  );
}

/**
 * The weight kept that a record holding this weight holds again, of those
 * it has held or been written under its count (`MappedBatch.writtenWeights`):
 * the latest of that weight, or null if there is none such. Only a weight
 * that differs from those is a barista's entry (ADR-0037), so a zero the
 * server wrote after Shots finishes nothing, and a form saved with the
 * weight it was opened with enters nothing.
 */
export function writtenWeightHeld(written: readonly WrittenWeight[] | undefined, weight: number | null): WrittenWeight | null {
  for (let index = (written?.length ?? 0) - 1; index >= 0; index--) if (written![index]!.weight === weight) return written![index]!;
  return null;
}

/** A row's `written_weights` as read from the database: its entries that are well formed. */
export function readWrittenWeights(value: unknown): WrittenWeight[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown): WrittenWeight[] => {
    if (!isObject(entry)) return [];
    const { weight, count } = entry;
    if (weight !== null && (typeof weight !== "number" || !Number.isFinite(weight))) return [];
    return [{ weight, count: typeof count === "string" ? count : null }];
  });
}

/** What a tablet changed at its Location between the record known and one it holds now. */
function editsSince(
  known: Pick<MappedBatch, "archived" | "weightRemaining" | "writtenWeights" | "weightCount">,
  now: Pick<ReportedBatch, "archived" | "weightRemaining">,
): LocationEdit[] {
  const edits: LocationEdit[] = [];
  if (now.archived !== known.archived) edits.push({ field: "at", value: !now.archived });
  if (now.weightRemaining !== known.weightRemaining && writtenWeightHeld(known.writtenWeights, now.weightRemaining) === null) {
    edits.push({ field: "remainingWeight", value: now.weightRemaining, had: known.weightRemaining, ...(known.weightCount ? { hadCount: known.weightCount } : {}) });
  }
  return edits;
}
