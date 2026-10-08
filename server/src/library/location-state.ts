import type { Prisma } from "../generated/prisma/client.js";

// Each Location's state of the Library's Beans, Bean Batches and Profiles
// (ADR-0008): whether a batch is at the Location and its remaining weight
// there (`batch_locations`), the Locations offering a Bean that has no batch
// there yet (`bean_origins`), and whether a Profile is shown there
// (`profile_locations`). A Location offers a Bean while one of its batches
// is there, or while it has an origin there, offers a batch while it is
// there, and shows a Profile while it is shown there; nothing Archived is
// offered or shown anywhere.
//
// A batch is never finished before it was added, nor added again before it
// was finished, whatever the clock of the tablet that timed the edit.
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
 * Adds the batch at the Location, if it is not there, timed by the edit, and,
 * unless the batch is Archived, ends its Bean's origin there: from then on
 * the Bean is offered there while one of its batches is. Says whether it was
 * not there before.
 */
export async function addBatchAt(tx: Prisma.TransactionClient, batchId: string, locationId: string, at: Date): Promise<boolean> {
  const added = await tx.$executeRaw`
    INSERT INTO batch_locations (batch_id, location_id, added_at) VALUES (${batchId}::uuid, ${locationId}::uuid, ${at}::timestamptz)
    ON CONFLICT (batch_id, location_id) DO UPDATE SET added_at = GREATEST(EXCLUDED.added_at, batch_locations.finished_at), finished_at = NULL
      WHERE batch_locations.added_at IS NULL OR batch_locations.finished_at IS NOT NULL`;
  await tx.$executeRaw`
    DELETE FROM bean_origins
    WHERE location_id = ${locationId}::uuid AND bean_id = (SELECT bean_id FROM bean_batches WHERE id = ${batchId}::uuid AND NOT archived)`;
  return added > 0;
}

/** Finishes the batch at the Location, if it is there, timed by the edit. Says whether it was there. */
export async function finishBatchAt(tx: Prisma.TransactionClient, batchId: string, locationId: string, at: Date): Promise<boolean> {
  const finished = await tx.$executeRaw`
    UPDATE batch_locations SET finished_at = GREATEST(added_at, ${at}::timestamptz)
    WHERE batch_id = ${batchId}::uuid AND location_id = ${locationId}::uuid AND added_at IS NOT NULL AND finished_at IS NULL`;
  return finished > 0;
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
): Promise<boolean> {
  const entered = await tx.$executeRaw`
    INSERT INTO batch_locations (batch_id, location_id, remaining_weight, remaining_weight_at)
    VALUES (${batchId}::uuid, ${locationId}::uuid, ${weight.value}::double precision, ${at}::timestamptz)
    ON CONFLICT (batch_id, location_id) DO UPDATE SET
      remaining_weight = EXCLUDED.remaining_weight, remaining_weight_at = EXCLUDED.remaining_weight_at
      WHERE batch_locations.remaining_weight_at IS NULL
        OR batch_locations.remaining_weight IS NOT DISTINCT FROM ${weight.had}::double precision
        OR batch_locations.remaining_weight_at < EXCLUDED.remaining_weight_at`;
  return entered > 0;
}

/**
 * Takes a Bean away from the Location, as archiving or deleting it on a
 * tablet there does (ADR-0019): ends its origin there, and finishes its
 * batches there, since Decaid deletes a bean only with its batches. A batch
 * the tablet held there, not archived, is finished whenever it was added;
 * one it did not, added after the edit, which the tablet had not seen,
 * stays. Says whether anything changed.
 */
export async function takeBeanFrom(
  tx: Prisma.TransactionClient,
  beanId: string,
  locationId: string,
  tabletId: string,
  at: Date,
): Promise<boolean> {
  const origins = await tx.$executeRaw`DELETE FROM bean_origins WHERE bean_id = ${beanId}::uuid AND location_id = ${locationId}::uuid`;
  const finished = await tx.$executeRaw`
    UPDATE batch_locations AS here SET finished_at = GREATEST(here.added_at, ${at}::timestamptz)
    FROM bean_batches AS batch
    LEFT JOIN tablet_bean_batches AS held ON held.batch_id = batch.id AND held.tablet_id = ${tabletId}::uuid
    WHERE here.batch_id = batch.id AND batch.bean_id = ${beanId}::uuid AND here.location_id = ${locationId}::uuid
      AND here.added_at IS NOT NULL AND here.finished_at IS NULL
      AND ((held.record ->> 'archived') = 'false' OR here.added_at < ${at}::timestamptz)`;
  return origins + finished > 0;
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
 * hiding, deleting or replacing it does, timed by the edit (ADR-0020): an
 * edit older than the one that decided the Location's state, which its
 * tablet had not seen, loses to it, and the Location's state is written back
 * to that tablet. Conflicts, which will keep it, come with ticket #84. Says
 * whether that changed it.
 */
export async function showProfileAt(tx: Prisma.TransactionClient, profileId: string, locationId: string, shown: boolean, at: Date): Promise<boolean> {
  const changed = await tx.$executeRaw`
    INSERT INTO profile_locations (profile_id, location_id, shown, changed_at) VALUES (${profileId}, ${locationId}::uuid, ${shown}, ${at}::timestamptz)
    ON CONFLICT (profile_id, location_id) DO UPDATE SET shown = EXCLUDED.shown, changed_at = EXCLUDED.changed_at
      WHERE profile_locations.shown <> EXCLUDED.shown AND profile_locations.changed_at <= EXCLUDED.changed_at`;
  return changed > 0;
}

/**
 * Decides whether the Profile is shown at the Location where nothing has
 * decided it there yet, as a tablet there that holds it but was not known
 * to does, timed by its record. Says whether it did.
 */
export async function decideProfileAt(tx: Prisma.TransactionClient, profileId: string, locationId: string, shown: boolean, at: Date): Promise<boolean> {
  const decided = await tx.$executeRaw`
    INSERT INTO profile_locations (profile_id, location_id, shown, changed_at) VALUES (${profileId}, ${locationId}::uuid, ${shown}, ${at}::timestamptz)
    ON CONFLICT (profile_id, location_id) DO NOTHING`;
  return decided > 0;
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
