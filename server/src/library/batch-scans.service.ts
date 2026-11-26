import { Injectable } from "@nestjs/common";
import { MAX_BATCH_MATCHES, type SkinBatchBrought, type SkinBatchMatch } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import { type EditSource, recordVersion, tabletSource } from "./history.js";
import type { ReportingTablet } from "./intake.js";
import { editTime } from "./library-edits.service.js";
import { isObject } from "./listed.js";
import { addBatchAt, lockLocation, moveBatchBetween, startCount } from "./location-state.js";
import { codeCandidates, namesBean, scannedWords } from "./scanned-text.js";

// A Bean Batch brought to a Machine's Location by a scan (ticket #708,
// ADR-0030, ADR-0008): a Skin on a tablet read a QR code and its plugin sent
// the text it held (`ask: "bringBatch"`, `SkinRequestsService`). The text is
// matched against the batches that are not Archived of Beans that are not,
// and one batch matched, or one a barista chose among several, is brought to
// the Location the asking Machine is served at. Nothing here decodes a
// code, creates a batch or brings an Archived one back: a scan changes only
// where a batch is.

/** The tablet a scan was made on: its Machine and id, the Location its Machine is served at, and the barista its Workflow named, if any. */
export interface ScanningTablet extends ReportingTablet {
  locationId: string;
  barista: string | null;
}

/** What a scan asks to have brought: the text its code held, or the batch a barista chose from an earlier answer's matches. */
export type Scanned = { text: string } | { batchId: string };

/**
 * Told by `bring` where the batch's Locations changed between its read of
 * them and its locks, so the locks it holds are not those the change needs:
 * the caller makes the request again, in a transaction of its own.
 */
export const TRY_AGAIN = Symbol("try again");

@Injectable()
export class BatchScansService {
  /**
   * Matches what a scan asks for and, where that is one batch, brings it to
   * the tablet's Location, in the caller's transaction, which holds the
   * Machine's row and has found it served there (`SkinRequestsService`).
   * Several matches and none change nothing. Returns what came of it, or
   * TRY_AGAIN.
   */
  async bring(tx: Prisma.TransactionClient, scanned: Scanned, tablet: ScanningTablet): Promise<SkinBatchBrought | typeof TRY_AGAIN> {
    const matches = "batchId" in scanned ? await chosen(tx, scanned.batchId) : await matching(tx, scanned.text);
    if (matches.length === 0) return { outcome: "noMatch" };
    if (matches.length > 1) return { outcome: "several", matches: matches.slice(0, MAX_BATCH_MATCHES), more: matches.length > MAX_BATCH_MATCHES };
    const batchId = matches[0]!.id;
    const outcome = await bringTo(tx, batchId, tablet);
    if (outcome === TRY_AGAIN) return TRY_AGAIN;
    return outcome === "noMatch" ? { outcome } : { outcome, batchId };
  }
}

/**
 * Brings the batch to the tablet's Location by where it is (ADR-0008):
 *
 * - at that Location already: nothing changes;
 * - at exactly one other Location: all of it is moved from there, as a
 *   Batch Move of all (`moveBatchBetween`, ADR-0037), with what that
 *   Location had of it, and it is finished there;
 * - at several other Locations, or at none: it is added at the tablet's
 *   Location and no weight moves, since nothing says which Location's
 *   coffee arrived. It is untracked there: where it was finished there
 *   before with a weight, the weight that count was left with is cleared,
 *   not taken up again, as a Batch Move of no weight clears it.
 *
 * The move or the add is one version of the batch, made as the Machine and
 * tablet with the barista its Workflow named and no account, and announced
 * as an account's is, so the tablets of each Location it changed are
 * written.
 *
 * A change at a Location is made under that Location's lock, and one at two
 * under both, taken in id order (`LibraryEditsService.moveBatch`), after the
 * Machine's row, as a tablet's report takes them. Where the batch is, is
 * read before the locks, to know which to take, and again under them: a
 * batch that came to be at another single Location meanwhile would need a
 * lock not held, perhaps one before those held, so the caller tries again.
 * A batch Archived meanwhile, or its Bean, is brought nowhere.
 */
async function bringTo(tx: Prisma.TransactionClient, batchId: string, tablet: ScanningTablet): Promise<"moved" | "added" | "alreadyThere" | "noMatch" | typeof TRY_AGAIN> {
  const here = tablet.locationId;
  const planned = await locationsOf(tx, batchId);
  if (planned.includes(here)) return "alreadyThere";
  const from = planned.length === 1 ? planned[0]! : null;
  for (const locationId of [here, ...(from === null ? [] : [from])].sort((a, b) => a.localeCompare(b))) await lockLocation(tx, locationId);
  // Under its key's lock, so it is not hard-deleted until its state at those Locations changes.
  const [batch] = await tx.$queryRaw<{ archived: boolean }[]>`
    SELECT batch.archived OR bean.archived AS archived
    FROM bean_batches AS batch JOIN beans AS bean ON bean.id = batch.bean_id
    WHERE batch.id = ${batchId}::uuid
    FOR KEY SHARE OF batch`;
  if (!batch || batch.archived) return "noMatch";

  const others = await locationsOf(tx, batchId);
  if (others.includes(here)) return "alreadyThere";
  const leaving = others.length === 1 ? others[0]! : null;
  if (leaving !== null && leaving !== from) return TRY_AGAIN;

  const source: EditSource = { ...tabletSource(tablet), barista: tablet.barista };
  const at = await editTime(tx);
  if (leaving === null) {
    // Having seen every decision made here before it, as an account's add has.
    const [{ seenAt }] = await tx.$queryRaw<[{ seenAt: Date }]>`SELECT clock_timestamp() AS "seenAt"`;
    const [was] = await tx.$queryRaw<{ weight: number | null }[]>`
      SELECT remaining_weight AS weight FROM batch_locations WHERE batch_id = ${batchId}::uuid AND location_id = ${here}::uuid`;
    if (was?.weight == null) await addBatchAt(tx, batchId, here, at, seenAt, source);
    else {
      // One version, the add with the weight it clears, as a Batch Move's is one with what it set where it joined.
      const versionId = await recordVersion(tx, { kind: "beanBatch", id: batchId }, here, { atLocation: true, remainingWeight: null }, source, at);
      await addBatchAt(tx, batchId, here, at, seenAt, source, undefined, versionId);
      await startCount(tx, batchId, here, null, at, versionId);
    }
    await notify(tx, "library_changes", here);
    return "added";
  }
  await moveBatchBetween(tx, batchId, leaving, here, "all", at, source);
  await notify(tx, "library_changes", batchId);
  return "moved";
}

/** The Locations the batch is at now, by their ids. */
async function locationsOf(tx: Prisma.TransactionClient, batchId: string): Promise<string[]> {
  const rows = await tx.$queryRaw<{ locationId: string }[]>`
    SELECT location_id::text AS "locationId" FROM batch_locations
    WHERE batch_id = ${batchId}::uuid AND added_at IS NOT NULL AND finished_at IS NULL`;
  return rows.map((row) => row.locationId);
}

/** A batch as matching reads it, with its Bean. */
interface BatchRow {
  id: string;
  content: unknown;
  beanContent: unknown;
}

/** The batches a scan may match, of those the condition picks: not Archived, of a Bean that is not. */
function offered(tx: Prisma.TransactionClient, where: Prisma.Sql): Promise<BatchRow[]> {
  return tx.$queryRaw<BatchRow[]>`
    SELECT batch.id::text AS id, batch.content, bean.content AS "beanContent"
    FROM bean_batches AS batch JOIN beans AS bean ON bean.id = batch.bean_id
    WHERE NOT batch.archived AND NOT bean.archived AND ${where}`;
}

/** The batch a barista chose, by its id: none where it is Archived, its Bean is, or the Library holds no such batch. */
async function chosen(tx: Prisma.TransactionClient, batchId: string): Promise<SkinBatchMatch[]> {
  return (await offered(tx, Prisma.sql`batch.id = ${batchId}::uuid`)).map(matchOf);
}

/**
 * The batches the text of a scanned code matches, newest roast first,
 * stopping at the first step that finds any:
 *
 * 1. the whole text, trimmed, is a Batch Code;
 * 2. the text is a URL or JSON, and its last path segment, one of its
 *    query values, its fragment or one of its string values is one
 *    (`codeCandidates`);
 * 3. the text names a Bean (`namesBean`): that Bean's batches, or, where
 *    the text holds a date read without guessing, those with that roast
 *    date. A date none of them was roasted on leaves none.
 *
 * A Batch Code is compared as the index that keeps one to a batch compares
 * it, ignoring case and the spaces around it (`refuseTakenCode`).
 */
async function matching(tx: Prisma.TransactionClient, scannedText: string): Promise<SkinBatchMatch[]> {
  const text = scannedText.trim();
  if (text === "") return [];
  const byCodes = (codes: readonly string[]) =>
    offered(tx, Prisma.sql`lower(btrim(batch.content ->> 'batchCode')) IN (SELECT lower(btrim(code)) FROM unnest(${[...codes]}::text[]) AS code)`);

  let rows = await byCodes([text]);
  if (rows.length === 0) {
    const candidates = codeCandidates(text);
    if (candidates.length > 0) rows = await byCodes(candidates);
  }
  if (rows.length === 0) {
    const scanned = scannedWords(text);
    const beans = await tx.$queryRaw<{ id: string; content: unknown }[]>`SELECT id::text AS id, content FROM beans WHERE NOT archived`;
    const named = beans.filter((bean) => namesBean(scanned, { roaster: textOf(bean.content, "roaster"), name: textOf(bean.content, "name") })).map((bean) => bean.id);
    if (named.length > 0) {
      const batches = await offered(tx, Prisma.sql`batch.bean_id = ANY(${named}::uuid[])`);
      rows = scanned.dates.length === 0 ? batches : batches.filter((batch) => scanned.dates.includes(roastDateOf(batch.content) ?? ""));
    }
  }
  return rows.map(matchOf).sort((a, b) => latestFirst(a.roastDate, b.roastDate) || a.id.localeCompare(b.id));
}

function matchOf(row: BatchRow): SkinBatchMatch {
  return {
    id: row.id,
    roaster: textOf(row.beanContent, "roaster"),
    name: textOf(row.beanContent, "name"),
    roastDate: roastDateOf(row.content),
    batchCode: textOf(row.content, "batchCode"),
  };
}

/** A field of an item's content that is text, and not empty; null otherwise. */
function textOf(content: unknown, field: string): string | null {
  const value = isObject(content) ? content[field] : undefined;
  return typeof value === "string" && value !== "" ? value : null;
}

/** The day a batch's content gives as its roast date, as `YYYY-MM-DD`; null where it gives none. */
function roastDateOf(content: unknown): string | null {
  const roastDate = textOf(content, "roastDate");
  return roastDate !== null && /^\d{4}-\d\d-\d\d/.test(roastDate) ? roastDate.slice(0, 10) : null;
}

/** Dates the latest first, with none last. */
function latestFirst(a: string | null, b: string | null): number {
  if (a === null || b === null) return Number(a === null) - Number(b === null);
  return b.localeCompare(a);
}
