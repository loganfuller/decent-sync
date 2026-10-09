import { sameValue } from "@decent-sync/protocol";
import type { Prisma } from "../generated/prisma/client.js";
import { type EditSource, type ItemRef, recordConflict, recordReplaced, recordVersion } from "./history.js";

// Each Location's state of the Library's Beans, Bean Batches, Grinders and
// Profiles (ADR-0008): whether a batch is at the Location and its remaining
// weight there (`batch_locations`), the Locations offering a Bean that has no
// batch there yet (`bean_origins`), the Grinders belonging to it
// (`grinders.location_id`), and whether a Profile is shown there
// (`profile_locations`). A Location offers a Bean while one of its batches
// is there, or while it has an origin there, offers a batch while it is
// there, offers the Grinders that belong to it, and shows a Profile while it
// is shown there; nothing Archived is offered or shown anywhere.
//
// Whether a batch is at a Location, and whether a Profile is shown there, are
// each a field of its own (ADR-0020), whose latest edit wins. Each decision
// of one is stamped with PostgreSQL's clock (`decided_at`,
// `presence_decided_at`). An edit made after its tablet saw the field's
// current value applies: the tablet's record of the item, or for taking a
// Bean away its record of the Bean, had seen that decision at this Location
// (`seenAt`, the latest it has seen there: one the server wrote it after, or
// one its own edit made). Otherwise, as from a tablet that was offline, it
// applies only if it is timed no earlier than the edit that set the field,
// and else loses to it, and the Location's state is written back to that
// tablet, and kept as a Conflict. One that applies over a value its tablet
// had not seen, set by another tablet's edit, keeps that value as a Conflict
// instead, as neither edit saw the other (ADR-0020). An edit that applies
// decides the field even when it leaves the value as it was, since it is the
// field's latest edit, and is kept as a version of the item (history.ts),
// whose id the field keeps, so a Conflict it becomes knows where it came
// from. Each change says when it decided the field, or null if it did not,
// so the tablet's record can be known to have seen that.
//
// Every change to a Location's state runs under that Location's advisory
// lock, taken after the reporting tablet's row lock, so origins are kept to
// Beans with no batch at the Location, and one tablet's change is decided
// after another's at the same Location, on any instance. Each change is
// timed by its edit: a tablet's by its record's `updatedAt` in UTC, a delete,
// which Decaid does not time, by PostgreSQL's clock, but never before the
// record the tablet was last known to have (`deletedAt`).

/** The namespace of the advisory locks each Location's state changes under, with the Location's hash as the second key. */
const LOCATION_LOCK = 4_000_007;

/** Holds the Location's lock until the transaction ends, so its state changes one report at a time. */
export async function lockLocation(tx: Prisma.TransactionClient, locationId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCATION_LOCK}::integer, hashtext(${locationId}))`;
}

/**
 * Adds the batch at the Location, timed by the edit, unless it was finished
 * there by an edit its tablet had not seen (as of `seenAt`, the latest
 * decision its record of the batch has seen, or none) and timed later; and,
 * unless the batch is Archived, ends its Bean's origin there while the batch
 * is there: from then on the Bean is offered there while one of its batches
 * is. One already there is added again, as the field's latest edit, if that
 * edit wins as one changing it would (ADR-0020), so an older edit the tablet
 * had not seen cannot undo it. It is never added before it was finished,
 * whatever the clock that timed the edit. Says when it decided it, or null
 * if the edit lost.
 */
export async function addBatchAt(
  tx: Prisma.TransactionClient,
  batchId: string,
  locationId: string,
  at: Date,
  seenAt: Date | null,
  source: EditSource,
): Promise<Date | null> {
  const before = await presenceAt(tx, batchId, locationId);
  const [added] = await tx.$queryRaw<{ decidedAt: Date }[]>`
    INSERT INTO batch_locations (batch_id, location_id, added_at, presence_decided_at)
    VALUES (${batchId}::uuid, ${locationId}::uuid, ${at}::timestamptz, clock_timestamp())
    ON CONFLICT (batch_id, location_id) DO UPDATE SET
      added_at = CASE WHEN batch_locations.finished_at IS NULL THEN GREATEST(batch_locations.added_at, EXCLUDED.added_at)
        ELSE GREATEST(EXCLUDED.added_at, batch_locations.finished_at) END,
      finished_at = NULL, presence_decided_at = clock_timestamp()
      WHERE COALESCE(batch_locations.finished_at, batch_locations.added_at) IS NULL
        OR COALESCE(batch_locations.finished_at, batch_locations.added_at) <= EXCLUDED.added_at
        OR batch_locations.presence_decided_at <= ${seenAt}::timestamptz
    RETURNING presence_decided_at AS "decidedAt"`;
  await keepPresenceEdit(tx, batchId, locationId, true, before, added?.decidedAt ?? null, seenAt, source, at);
  await tx.$executeRaw`
    DELETE FROM bean_origins
    WHERE location_id = ${locationId}::uuid AND bean_id = (SELECT bean_id FROM bean_batches WHERE id = ${batchId}::uuid AND NOT archived)
      AND EXISTS (
        SELECT 1 FROM batch_locations
        WHERE batch_id = ${batchId}::uuid AND location_id = ${locationId}::uuid AND added_at IS NOT NULL AND finished_at IS NULL
      )`;
  return added?.decidedAt ?? null;
}

/**
 * Finishes the batch at the Location, timed by the edit, unless it was added
 * there by an edit its tablet had not seen (`seenAt`, as `addBatchAt` reads
 * it) and timed later. One finished there already is finished again, as
 * `addBatchAt` adds one there again. It is never finished before it was
 * added, whatever the clock that timed the edit. Says when it decided it, or
 * null if it was never added there or the edit lost.
 */
export async function finishBatchAt(
  tx: Prisma.TransactionClient,
  batchId: string,
  locationId: string,
  at: Date,
  seenAt: Date | null,
  source: EditSource,
): Promise<Date | null> {
  const before = await presenceAt(tx, batchId, locationId);
  const [finished] = await tx.$queryRaw<{ decidedAt: Date }[]>`
    UPDATE batch_locations SET finished_at = GREATEST(added_at, finished_at, ${at}::timestamptz), presence_decided_at = clock_timestamp()
    WHERE batch_id = ${batchId}::uuid AND location_id = ${locationId}::uuid AND added_at IS NOT NULL
      AND (COALESCE(finished_at, added_at) <= ${at}::timestamptz OR presence_decided_at <= ${seenAt}::timestamptz)
    RETURNING presence_decided_at AS "decidedAt"`;
  await keepPresenceEdit(tx, batchId, locationId, false, before, finished?.decidedAt ?? null, seenAt, source, at);
  return finished?.decidedAt ?? null;
}

/** A batch's presence at a Location as an edit finds it: whether it is there, null if it was never added there, and its latest decision. */
interface Presence {
  at: boolean | null;
  decidedAt: Date | null;
  versionId: string | null;
  /** The tablet whose edit decided it last, if one did. */
  tabletId: string | null;
}

async function presenceAt(tx: Prisma.TransactionClient, batchId: string, locationId: string): Promise<Presence | null> {
  const [row] = await tx.$queryRaw<Presence[]>`
    SELECT CASE WHEN here.added_at IS NULL THEN NULL ELSE here.finished_at IS NULL END AS at, here.presence_decided_at AS "decidedAt",
      here.presence_version_id AS "versionId", version.tablet_id AS "tabletId"
    FROM batch_locations AS here LEFT JOIN item_versions AS version ON version.id = here.presence_version_id
    WHERE here.batch_id = ${batchId}::uuid AND here.location_id = ${locationId}::uuid`;
  return row ?? null;
}

/**
 * Keeps an edit of whether a batch is at a Location (`value`): as a version
 * if it decided it (at `decidedAt`), else, if it would have changed it, as a
 * Conflict. One that decided it over another tablet's edit its own had not
 * seen, which it changed, keeps that edit's value as a Conflict.
 */
async function keepPresenceEdit(
  tx: Prisma.TransactionClient,
  batchId: string,
  locationId: string,
  value: boolean,
  before: Presence | null,
  decidedAt: Date | null,
  seenAt: Date | null,
  source: EditSource,
  at: Date,
): Promise<void> {
  const item: ItemRef = { kind: "beanBatch", id: batchId };
  const was = before?.at ?? null;
  if (decidedAt === null) {
    if (was !== null && was !== value) await recordConflict(tx, item, locationId, "atLocation", value, source, at);
    return;
  }
  const versionId = await recordVersion(tx, item, locationId, { atLocation: value }, source, at);
  await tx.$executeRaw`
    UPDATE batch_locations SET presence_version_id = ${versionId}::uuid WHERE batch_id = ${batchId}::uuid AND location_id = ${locationId}::uuid`;
  if (was !== null && was !== value && unseen(before!, seenAt, source)) await recordReplaced(tx, item, locationId, "atLocation", was, before!.versionId);
}

/** Whether a field's latest decision was another tablet's, which the editing tablet's record had not seen (`seenAt`). */
function unseen(before: { decidedAt: Date | null; tabletId: string | null }, seenAt: Date | null, source: EditSource): boolean {
  if (before.tabletId !== null && before.tabletId === source.tabletId) return false;
  return before.decidedAt === null || seenAt === null || before.decidedAt.getTime() > seenAt.getTime();
}

/**
 * Records a remaining weight entered for the batch at the Location (ADR-0020):
 * it replaces the one known if the tablet that entered it had that value, or
 * no value was ever entered there, or it was entered later than the value
 * known, which the tablet had not seen. Says whether it did.
 */
export async function enterRemainingWeight(
  tx: Prisma.TransactionClient,
  batchId: string,
  locationId: string,
  weight: { value: number | null; had: number | null },
  at: Date,
  source: EditSource,
): Promise<boolean> {
  const [before] = await tx.$queryRaw<{ value: number | null; enteredAt: Date | null; versionId: string | null; tabletId: string | null }[]>`
    SELECT here.remaining_weight AS value, here.remaining_weight_at AS "enteredAt", here.remaining_weight_version_id AS "versionId",
      version.tablet_id AS "tabletId"
    FROM batch_locations AS here LEFT JOIN item_versions AS version ON version.id = here.remaining_weight_version_id
    WHERE here.batch_id = ${batchId}::uuid AND here.location_id = ${locationId}::uuid`;
  const entered = await tx.$executeRaw`
    INSERT INTO batch_locations (batch_id, location_id, remaining_weight, remaining_weight_at)
    VALUES (${batchId}::uuid, ${locationId}::uuid, ${weight.value}::double precision, ${at}::timestamptz)
    ON CONFLICT (batch_id, location_id) DO UPDATE SET
      remaining_weight = EXCLUDED.remaining_weight, remaining_weight_at = EXCLUDED.remaining_weight_at
      WHERE batch_locations.remaining_weight_at IS NULL
        OR batch_locations.remaining_weight IS NOT DISTINCT FROM ${weight.had}::double precision
        OR batch_locations.remaining_weight_at < EXCLUDED.remaining_weight_at`;
  const item: ItemRef = { kind: "beanBatch", id: batchId };
  const known = before?.enteredAt ? before : null;
  if (entered === 0) {
    if (known && !sameValue(known.value, weight.value)) await recordConflict(tx, item, locationId, "remainingWeight", weight.value, source, at);
    return false;
  }
  const versionId = await recordVersion(tx, item, locationId, { remainingWeight: weight.value }, source, at);
  await tx.$executeRaw`
    UPDATE batch_locations SET remaining_weight_version_id = ${versionId}::uuid WHERE batch_id = ${batchId}::uuid AND location_id = ${locationId}::uuid`;
  // A value the tablet had not had, entered by another tablet before this one, is replaced without either seeing the other.
  if (known && !sameValue(known.value, weight.had) && !sameValue(known.value, weight.value) && known.tabletId !== source.tabletId) {
    await recordReplaced(tx, item, locationId, "remainingWeight", known.value, known.versionId);
  }
  return true;
}

/**
 * Takes a Bean away from the Location, as archiving or deleting it on a
 * tablet there does (ADR-0019): ends its origin there, and finishes its
 * batches there, as a bean is deleted only with its batches (DYE2 deletes
 * them first, since Decaid refuses to delete a bean that has any). A batch
 * added there by an edit the tablet had not seen, as of `seenAt`, the latest
 * decision of its batches' presence there that the tablet's record of the
 * Bean has seen, and timed later, stays. What its records of the batches
 * have seen says nothing of when the Bean was archived. Its batches finished
 * there already are finished again, as `finishBatchAt` finishes one, where
 * the archiving wins. Says whether anything changed.
 */
export async function takeBeanFrom(
  tx: Prisma.TransactionClient,
  beanId: string,
  locationId: string,
  at: Date,
  seenAt: Date | null,
  source: EditSource,
): Promise<boolean> {
  const origins = await tx.$executeRaw`DELETE FROM bean_origins WHERE bean_id = ${beanId}::uuid AND location_id = ${locationId}::uuid`;
  const batches = await tx.$queryRaw<{ id: string }[]>`
    SELECT batch.id FROM bean_batches AS batch JOIN batch_locations AS here ON here.batch_id = batch.id AND here.location_id = ${locationId}::uuid
    WHERE batch.bean_id = ${beanId}::uuid AND here.added_at IS NOT NULL ORDER BY batch.id`;
  let finished = false;
  for (const batch of batches) finished = (await finishBatchAt(tx, batch.id, locationId, at, seenAt, source)) !== null || finished;
  return origins > 0 || finished;
}

/**
 * Offers a Bean at the Location while it has no batch there, as when a
 * tablet there creates it, links a bean of its own to it, or un-archives its
 * record. With one of its batches there, it is offered already. Says whether
 * it was not offered there before.
 */
export async function offerBeanAt(tx: Prisma.TransactionClient, beanId: string, locationId: string): Promise<boolean> {
  const offered = await tx.$executeRaw`
    INSERT INTO bean_origins (bean_id, location_id)
    SELECT ${beanId}::uuid, ${locationId}::uuid
    WHERE NOT EXISTS (
      SELECT 1 FROM bean_batches AS batch
      JOIN batch_locations AS here ON here.batch_id = batch.id AND here.location_id = ${locationId}::uuid
      WHERE batch.bean_id = ${beanId}::uuid AND NOT batch.archived AND here.added_at IS NOT NULL AND here.finished_at IS NULL
    )
    ON CONFLICT (bean_id, location_id) DO NOTHING`;
  return offered > 0;
}

/** The Locations offering each of the Beans, by their ids: none for an Archived Bean. */
export async function offeringLocations(db: Prisma.TransactionClient, beanIds: readonly string[]): Promise<Map<string, string[]>> {
  const rows =
    beanIds.length === 0
      ? []
      : await db.$queryRaw<{ beanId: string; locationId: string }[]>`
          SELECT DISTINCT offer.bean_id AS "beanId", offer.location_id AS "locationId"
          FROM (
            SELECT bean_id, location_id FROM bean_origins
            UNION ALL
            SELECT batch.bean_id, here.location_id
            FROM bean_batches AS batch JOIN batch_locations AS here ON here.batch_id = batch.id
            WHERE NOT batch.archived AND here.added_at IS NOT NULL AND here.finished_at IS NULL
          ) AS offer
          JOIN beans ON beans.id = offer.bean_id AND NOT beans.archived
          WHERE offer.bean_id = ANY(${[...beanIds]}::uuid[])`;
  const offering = new Map<string, string[]>();
  for (const row of rows) offering.set(row.beanId, [...(offering.get(row.beanId) ?? []), row.locationId]);
  return offering;
}

/**
 * Shows or hides the Profile at the Location, as a tablet there showing,
 * hiding, deleting or replacing it does, timed by the edit (ADR-0020),
 * unless the Location's state was decided by an edit the tablet had not seen
 * (as of `seenAt`, the latest decision its record of the Profile has seen,
 * or none) and timed later: that wins, and is written back to the tablet,
 * and the edit, if it would have changed it, is kept as a Conflict. One that
 * wins over another tablet's decision it had not seen, which it changes,
 * keeps that decision as a Conflict. One shown or hidden there as the edit
 * has it is decided again, as the field's latest edit, if that edit wins as
 * one changing it would, so an older edit the tablet had not seen cannot
 * undo it. The decision keeps the tablet that made it (`source`) and its
 * version. Says when it decided it, or null if the edit lost.
 */
export async function showProfileAt(
  tx: Prisma.TransactionClient,
  profileId: string,
  locationId: string,
  source: EditSource,
  shown: boolean,
  at: Date,
  seenAt: Date | null,
): Promise<Date | null> {
  const [before] = await tx.$queryRaw<{ shown: boolean; decidedAt: Date; versionId: string | null; tabletId: string | null }[]>`
    SELECT here.shown, here.decided_at AS "decidedAt", here.version_id AS "versionId", here.decided_by_tablet_id AS "tabletId"
    FROM profile_locations AS here WHERE here.profile_id = ${profileId} AND here.location_id = ${locationId}::uuid`;
  const tabletId = source.tabletId;
  const [changed] = await tx.$queryRaw<{ decidedAt: Date }[]>`
    INSERT INTO profile_locations (profile_id, location_id, shown, changed_at, decided_at, decided_by_tablet_id)
    VALUES (${profileId}, ${locationId}::uuid, ${shown}, ${at}::timestamptz, clock_timestamp(), ${tabletId}::uuid)
    ON CONFLICT (profile_id, location_id) DO UPDATE SET
      shown = EXCLUDED.shown, changed_at = GREATEST(EXCLUDED.changed_at, profile_locations.changed_at), decided_at = clock_timestamp(),
      decided_by_tablet_id = EXCLUDED.decided_by_tablet_id
      WHERE profile_locations.changed_at <= EXCLUDED.changed_at OR profile_locations.decided_at <= ${seenAt}::timestamptz
    RETURNING decided_at AS "decidedAt"`;
  const item: ItemRef = { kind: "profile", id: profileId };
  if (!changed) {
    if (before && before.shown !== shown) await recordConflict(tx, item, locationId, "shown", shown, source, at);
    return null;
  }
  await keepProfileVersion(tx, profileId, locationId, shown, source, at);
  if (before && before.shown !== shown && unseen(before, seenAt, source)) await recordReplaced(tx, item, locationId, "shown", before.shown, before.versionId);
  return changed.decidedAt;
}

/** Keeps a decision of whether the Profile is shown at the Location as a version, whose id the decision keeps. */
async function keepProfileVersion(tx: Prisma.TransactionClient, profileId: string, locationId: string, shown: boolean, source: EditSource, at: Date): Promise<void> {
  const versionId = await recordVersion(tx, { kind: "profile", id: profileId }, locationId, { shown }, source, at);
  await tx.$executeRaw`
    UPDATE profile_locations SET version_id = ${versionId}::uuid WHERE profile_id = ${profileId} AND location_id = ${locationId}::uuid`;
}

/**
 * Decides whether the Profile is shown at the Location where nothing has
 * decided it there yet, as a tablet there that holds it but was not known
 * to does, timed by its record, as `showProfileAt` keeps the tablet's.
 * Says when it decided it, or null if it did not.
 */
export async function decideProfileAt(
  tx: Prisma.TransactionClient,
  profileId: string,
  locationId: string,
  source: EditSource,
  shown: boolean,
  at: Date,
): Promise<Date | null> {
  const [decided] = await tx.$queryRaw<{ decidedAt: Date }[]>`
    INSERT INTO profile_locations (profile_id, location_id, shown, changed_at, decided_at, decided_by_tablet_id)
    VALUES (${profileId}, ${locationId}::uuid, ${shown}, ${at}::timestamptz, clock_timestamp(), ${source.tabletId}::uuid)
    ON CONFLICT (profile_id, location_id) DO NOTHING
    RETURNING decided_at AS "decidedAt"`;
  if (decided) await keepProfileVersion(tx, profileId, locationId, shown, source, at);
  return decided?.decidedAt ?? null;
}

/**
 * When a delete on a tablet is taken to have happened: now, by PostgreSQL's
 * clock as the transaction read it, but no earlier than the record the
 * tablet was last known to have, whose time is the tablet's.
 */
export function deletedAt(now: Date, known: Date | null): Date {
  return known !== null && known.getTime() > now.getTime() ? known : now;
}

/** PostgreSQL's time for the transaction, as `now()` reads it throughout. */
export async function transactionTime(tx: Prisma.TransactionClient): Promise<Date> {
  const [row] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  return row!.now;
}
