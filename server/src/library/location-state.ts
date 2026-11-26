import { sameValue } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { type EditSource, type ItemRef, heldValue, recordLostEdit, recordReplaced, recordVersion } from "./history.js";
import { type Count, countKey, grams, heldAfter, movedSince, remainingAfter, usedSince } from "./remaining-weight.js";

// Each Location's state of the Library's Beans, Bean Batches, Grinders,
// Profiles, Baskets and Tools (ADR-0008): whether a batch is at the Location and its remaining
// weight there (`batch_locations`), the Locations offering a Bean that has no
// batch there yet (`bean_origins`), the Grinders belonging to it
// (`grinders.location_id`), and whether a Profile, Basket or Tool is shown
// there (`profile_locations`, `basket_locations`, `tool_locations`). A Location offers a Bean while one of its batches
// is there, or while it has an origin there, offers a batch while it is
// there, offers the Grinders that belong to it, and shows a Profile while it
// is shown there; nothing Archived is offered or shown anywhere.
//
// A batch's remaining weight at a Location is worked out as it is read
// (ADR-0037, `remaining-weight.ts`): the weight its count there starts from,
// which is the one entered there last, or the amount a Batch Move brought
// where the batch had none, less what the Shots pulled there since have
// used, plus what moves have brought since, less what they have taken away.
// Only the count's start is kept here, and each move in `batch_moves`
// (`moveBatchBetween`).
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
// tablet, and kept as a Lost Edit (ADR-0033). One that applies over a value
// its tablet had not seen, set by another tablet's edit, keeps that value as
// a Lost Edit instead, as neither edit saw the other (ADR-0020), unless the
// tablet's last known record of the item held that value (`held`): it
// replaced what it had, though the server cannot show it saw the edit that
// set it. An edit that applies decides the field even when it leaves the
// value as it was, since it is the field's latest edit, and is kept as a
// version of the item (history.ts), whose id the field keeps, so a Lost
// Edit it becomes knows where it came from, and one it wins over knows what
// it lost to. Each change says when it decided the field, or null if it did
// not, so the tablet's record can be known to have seen that.
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
 * whatever the clock that timed the edit. `held` is whether the tablet's
 * last known record of the batch had it there, absent where the server
 * holds no such record. Says when it decided it, or null if the edit lost.
 * `versionId` is the version the add is part of, as a Batch Move's is, kept
 * in place of one of its own.
 */
export async function addBatchAt(
  tx: Prisma.TransactionClient,
  batchId: string,
  locationId: string,
  at: Date,
  seenAt: Date | null,
  source: EditSource,
  held?: boolean,
  versionId?: string,
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
  await keepPresenceEdit(tx, batchId, locationId, true, before, added?.decidedAt ?? null, seenAt, source, at, held, {}, versionId);
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
 * added, whatever the clock that timed the edit. `held` is as `addBatchAt`
 * reads it. Says when it decided it, or null if it was never added there or
 * the edit lost. `by` is what else its version says the edit set: the weight
 * of zero whose entry made the finish (`enterRemainingWeight`). `versionId`
 * is as `addBatchAt` reads it.
 */
export async function finishBatchAt(
  tx: Prisma.TransactionClient,
  batchId: string,
  locationId: string,
  at: Date,
  seenAt: Date | null,
  source: EditSource,
  held?: boolean,
  by: Readonly<Record<string, unknown>> = {},
  versionId?: string,
): Promise<Date | null> {
  const before = await presenceAt(tx, batchId, locationId);
  const [finished] = await tx.$queryRaw<{ decidedAt: Date }[]>`
    UPDATE batch_locations SET finished_at = GREATEST(added_at, finished_at, ${at}::timestamptz), presence_decided_at = clock_timestamp()
    WHERE batch_id = ${batchId}::uuid AND location_id = ${locationId}::uuid AND added_at IS NOT NULL
      AND (COALESCE(finished_at, added_at) <= ${at}::timestamptz OR presence_decided_at <= ${seenAt}::timestamptz)
    RETURNING presence_decided_at AS "decidedAt"`;
  await keepPresenceEdit(tx, batchId, locationId, false, before, finished?.decidedAt ?? null, seenAt, source, at, held, by, versionId);
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
 * Lost Edit, lost to the edit that decided it last. One that decided it
 * over another tablet's edit its own had not seen, which it changed, keeps
 * that edit's value as a Lost Edit, lost to this one, unless the tablet's
 * last known record held that value (`held`). Given `within`, the version
 * it is part of, it is kept as that one, which its maker recorded.
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
  held: boolean | undefined,
  by: Readonly<Record<string, unknown>> = {},
  within?: string,
): Promise<void> {
  const item: ItemRef = { kind: "beanBatch", id: batchId };
  const was = before?.at ?? null;
  if (decidedAt === null) {
    if (was !== null && was !== value) await recordLostEdit(tx, item, locationId, "atLocation", value, source, at, before!.versionId);
    return;
  }
  const versionId = within ?? (await recordVersion(tx, item, locationId, { ...by, atLocation: value }, source, at));
  await tx.$executeRaw`
    UPDATE batch_locations SET presence_version_id = ${versionId}::uuid WHERE batch_id = ${batchId}::uuid AND location_id = ${locationId}::uuid`;
  if (was !== null && was !== value && unseen(before!, seenAt, source) && !heldValue(held, was)) {
    await recordReplaced(tx, item, locationId, "atLocation", was, before!.versionId, versionId);
  }
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
 * known, which the tablet had not seen. Its time is never earlier than the
 * one known, so an entry timed between the two cannot undo it. Says whether
 * it did.
 *
 * It is where the Location's count starts (ADR-0037): the batch's Remaining
 * Weight there is this weight less the doses of the Shots pulled there after
 * `at`, worked out as it is read (`usedSince`), so nothing here is ever
 * lowered by a Shot. Its version names the count, so no Batch Move made
 * before it bears on the weight (`movedSince`). Null leaves the batch
 * untracked there.
 *
 * A weight of zero that is entered finishes the batch there, as a finish
 * does, where `finishing` says the entry may: what its maker had seen of the
 * batch's presence there, as `finishBatchAt` reads it. The two are one
 * version, a finish made by a weight of zero (`{ remainingWeight: 0,
 * atLocation: false }`), unless the finish loses or the batch is not there,
 * finished already or never added, when the weight is kept alone: a zero
 * typed on a record of a batch finished there finishes nothing again.
 * `finished` is when the finish decided the batch's presence, or null.
 */
export async function enterRemainingWeight(
  tx: Prisma.TransactionClient,
  batchId: string,
  locationId: string,
  weight: { value: number | null; had: number | null },
  at: Date,
  source: EditSource,
  finishing?: { seenAt: Date | null; held?: boolean },
): Promise<{ entered: boolean; finished: Date | null }> {
  const [before] = await tx.$queryRaw<{ value: number | null; enteredAt: Date | null; versionId: string | null; tabletId: string | null; there: boolean }[]>`
    SELECT here.remaining_weight AS value, here.remaining_weight_at AS "enteredAt", here.remaining_weight_version_id AS "versionId",
      version.tablet_id AS "tabletId", here.added_at IS NOT NULL AND here.finished_at IS NULL AS there
    FROM batch_locations AS here LEFT JOIN item_versions AS version ON version.id = here.remaining_weight_version_id
    WHERE here.batch_id = ${batchId}::uuid AND here.location_id = ${locationId}::uuid`;
  const entered = await tx.$executeRaw`
    INSERT INTO batch_locations (batch_id, location_id, remaining_weight, remaining_weight_at)
    VALUES (${batchId}::uuid, ${locationId}::uuid, ${weight.value}::double precision, ${at}::timestamptz)
    ON CONFLICT (batch_id, location_id) DO UPDATE SET
      remaining_weight = EXCLUDED.remaining_weight,
      remaining_weight_at = GREATEST(EXCLUDED.remaining_weight_at, batch_locations.remaining_weight_at)
      WHERE batch_locations.remaining_weight_at IS NULL
        OR batch_locations.remaining_weight IS NOT DISTINCT FROM ${weight.had}::double precision
        OR batch_locations.remaining_weight_at < EXCLUDED.remaining_weight_at`;
  const item: ItemRef = { kind: "beanBatch", id: batchId };
  const known = before?.enteredAt ? before : null;
  if (entered === 0) {
    if (known && !sameValue(known.value, weight.value)) await recordLostEdit(tx, item, locationId, "remainingWeight", weight.value, source, at, known.versionId);
    return { entered: false, finished: null };
  }
  const finished = weight.value === 0 && finishing && before?.there ? await finishBatchAt(tx, batchId, locationId, at, finishing.seenAt, source, finishing.held, { remainingWeight: 0 }) : null;
  const versionId =
    finished === null
      ? await recordVersion(tx, item, locationId, { remainingWeight: weight.value }, source, at)
      : (
          await tx.$queryRaw<[{ id: string }]>`
            SELECT presence_version_id AS id FROM batch_locations WHERE batch_id = ${batchId}::uuid AND location_id = ${locationId}::uuid`
        )[0].id;
  await tx.$executeRaw`
    UPDATE batch_locations SET remaining_weight_version_id = ${versionId}::uuid WHERE batch_id = ${batchId}::uuid AND location_id = ${locationId}::uuid`;
  if (known) {
    // A move of an amount leaves the stored weight as it was, so a tablet's entry timed before the move and received after
    // it still replaces the count. The moves made since it was timed came after the weighing it records: they go on
    // counting, against the count it starts, as the Shots pulled since it do. The move a count arrived with is what that
    // count started from, which an entry made with it held already.
    await tx.$executeRaw`
      UPDATE batch_moves SET from_count_version_id = ${versionId}::uuid
      WHERE batch_id = ${batchId}::uuid AND from_location_id = ${locationId}::uuid AND amount IS NOT NULL AND moved_at > ${at}::timestamptz
        AND from_count_version_id IS NOT DISTINCT FROM ${known.versionId}::uuid`;
    await tx.$executeRaw`
      UPDATE batch_moves SET to_count_version_id = ${versionId}::uuid
      WHERE batch_id = ${batchId}::uuid AND to_location_id = ${locationId}::uuid AND amount IS NOT NULL AND moved_at > ${at}::timestamptz
        AND to_count_version_id IS NOT DISTINCT FROM ${known.versionId}::uuid AND version_id IS DISTINCT FROM ${known.versionId}::uuid`;
  }
  // A value the tablet had not had, entered by another tablet before this one, is replaced without either seeing the other.
  if (known && !sameValue(known.value, weight.had) && !sameValue(known.value, weight.value) && known.tabletId !== source.tabletId) {
    await recordReplaced(tx, item, locationId, "remainingWeight", known.value, known.versionId, versionId);
  }
  return { entered: true, finished };
}

/** How much of a batch a Batch Move takes: an amount in grams, all of it, or, of a batch with no weight where it is, some of it. */
export type MoveAmount = number | "all" | "some";

/** A Batch Move as it was made: the weight moved, in grams, null for a batch with no weight where it was, and whether it was all of it. */
export interface BatchMoved {
  amount: number | null;
  all: boolean;
}

/** A Batch Move the batch's state at its Locations refuses, with why, for whoever asked. */
export class MoveRefused extends Error {}

/** A Location's state of a batch as a Batch Move finds it. */
interface MovePlace {
  locationId: string;
  name: string;
  there: boolean;
  weight: number | null;
  countAt: Date | null;
  countVersionId: string | null;
}

/**
 * Moves the batch from one Location it is at to another (ADR-0037), under
 * both Locations' locks, which the caller holds: an amount in grams, all of
 * it, or, of a batch with no weight at the Location left, all or some of it,
 * moving no weight.
 *
 * - **An amount** is above zero, which the request's reader has checked, and
 *   below what the Location left has, as worked out now. It is taken from
 *   that Location's count and added to the joined Location's, by the move's
 *   row alone: neither count starts again, so a Shot pulled at the Location
 *   left before the move and stored after it still counts there.
 * - **All** takes what the Location left has and finishes the batch there, in
 *   the same change. Its count there ends at zero.
 * - **At the Location joined,** a batch not there is added. Where it had no
 *   weight, or was not there, the amount arriving is where its count starts.
 *   The same holds where Shots had used more than its count held, which
 *   read zero: the count starts again from the amount, as adding to what it
 *   held would give less than arrived, and the batch's total would fall.
 * - **With no weight at the Location left,** all finishes it there and adds
 *   it at the Location joined, and some adds it there and leaves it. Neither
 *   moves any weight. Where either adds it at a Location it was finished at,
 *   it is untracked there, as nothing arrived: the weight that count was
 *   left with is cleared, not taken up again. Some to a Location it is at
 *   already would change nothing, and is refused.
 *
 * It is one version of the batch, at the Location joined, naming the
 * Location left, the amount and whether it was all (`movedFrom`,
 * `movedAmount`, `movedAll`), with what it set at the Location joined
 * (`atLocation`, `remainingWeight`), and one row of `batch_moves`. Made as
 * having seen every decision at both Locations, as an account's edit is.
 * Throws `MoveRefused` for a move the batch's state refuses.
 */
export async function moveBatchBetween(
  tx: Prisma.TransactionClient,
  batchId: string,
  fromLocationId: string,
  toLocationId: string,
  amount: MoveAmount,
  at: Date,
  source: EditSource,
): Promise<BatchMoved> {
  const places = await tx.$queryRaw<MovePlace[]>`
    SELECT location.id::text AS "locationId", location.name,
      COALESCE(here.added_at IS NOT NULL AND here.finished_at IS NULL, false) AS there,
      here.remaining_weight AS weight, here.remaining_weight_at AS "countAt", here.remaining_weight_version_id::text AS "countVersionId"
    FROM locations AS location
    LEFT JOIN batch_locations AS here ON here.location_id = location.id AND here.batch_id = ${batchId}::uuid
    WHERE location.id IN (${fromLocationId}::uuid, ${toLocationId}::uuid)`;
  const left = places.find((place) => place.locationId === fromLocationId);
  const joined = places.find((place) => place.locationId === toLocationId);
  if (!left || !joined) throw new MoveRefused("No such Location");
  if (!left.there) throw new MoveRefused(`The batch is not at ${left.name}: it is moved from a Location it is at`);

  const counts = [left, joined].flatMap((place): Count[] =>
    place.there && place.weight !== null && place.countAt !== null ? [{ batchId, locationId: place.locationId, at: place.countAt, versionId: place.countVersionId }] : [],
  );
  const used = await usedSince(tx, counts);
  const moved = await movedSince(tx, counts);
  /** What the Location's count holds, below zero where Shots have used more than it had; null where the batch has no weight there. */
  const held = (place: MovePlace): number | null => {
    if (!counts.some((count) => count.locationId === place.locationId)) return null;
    const key = countKey(batchId, place.locationId);
    return heldAfter(place.weight!, used.get(key)?.weight ?? 0, moved.get(key));
  };
  const leftHeld = held(left);
  const leftHas = leftHeld === null ? null : remainingAfter(leftHeld, 0);
  if (leftHas === null) {
    if (typeof amount === "number") {
      throw new MoveRefused(`No weight is entered for the batch at ${left.name}, so no amount of it can be moved: move all of it or some of it, or enter its weight there first`);
    }
    if (amount === "some" && joined.there) throw new MoveRefused(`The batch is at ${joined.name} already, and has no weight at ${left.name} to move: nothing would change`);
  } else {
    if (amount === "some") throw new MoveRefused(`${left.name} has ${leftHas} g of the batch: move all of it, or an amount in grams`);
    if (typeof amount === "number" && amount >= leftHas) {
      throw new MoveRefused(`${left.name} has ${leftHas} g of the batch, and an amount moved is less than what is there: move all of it, or enter a corrected weight there first`);
    }
  }
  const all = amount === "all";
  const moving = leftHas === null ? null : typeof amount === "number" ? grams(amount) : leftHas;
  const joinedHeld = held(joined);
  // The amount arriving is where the joined Location's count starts, where it had none or Shots had overdrawn it.
  const starts = moving !== null && (joinedHeld === null || joinedHeld < 0);
  // A batch added where it was finished, by a move of no weight, is untracked there, whatever its count there was left with.
  const clears = moving === null && !joined.there && joined.weight !== null;

  const item: ItemRef = { kind: "beanBatch", id: batchId };
  const fields = { movedFrom: fromLocationId, movedAmount: moving, movedAll: all, ...(joined.there ? {} : { atLocation: true }), ...(starts || clears ? { remainingWeight: moving } : {}) };
  const versionId = await recordVersion(tx, item, toLocationId, fields, source, at);
  await tx.batchMove.create({
    data: {
      batchId,
      fromLocationId,
      toLocationId,
      amount: moving,
      movedAll: all,
      movedAt: at,
      versionId,
      fromCountVersionId: leftHas === null ? null : left.countVersionId,
      toCountVersionId: moving === null ? null : starts ? versionId : joined.countVersionId,
    },
  });
  const [{ seenAt }] = await tx.$queryRaw<[{ seenAt: Date }]>`SELECT clock_timestamp() AS "seenAt"`;
  if (!joined.there) await addBatchAt(tx, batchId, toLocationId, at, seenAt, source, undefined, versionId);
  if (starts || clears) await startCount(tx, batchId, toLocationId, moving, at, versionId);
  if (all) {
    await finishBatchAt(tx, batchId, fromLocationId, at, seenAt, source, undefined, {}, versionId);
    // Everything it had went with the move.
    if (leftHas !== null) await startCount(tx, batchId, fromLocationId, 0, at, versionId);
  }
  return { amount: moving, all };
}

/** Starts the Location's count of the batch at the weight, as a Batch Move does, by its version, or, given null, leaves it untracked there. Its time is never earlier than the one known, as a weight entered's is not. */
async function startCount(tx: Prisma.TransactionClient, batchId: string, locationId: string, weight: number | null, at: Date, versionId: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE batch_locations
    SET remaining_weight = ${weight}::double precision, remaining_weight_at = GREATEST(${at}::timestamptz, remaining_weight_at),
      remaining_weight_version_id = ${versionId}::uuid
    WHERE batch_id = ${batchId}::uuid AND location_id = ${locationId}::uuid`;
}

/**
 * Takes a Bean away from the Location, as archiving or deleting it on a
 * tablet there does (ADR-0019): ends its origin there, and finishes its
 * batches there, as a bean is deleted only with its batches (DYE2 deletes
 * them first, since Decaid refuses to delete a bean that has any). A batch
 * added there by an edit the tablet had not seen, as of `seenAt`, the latest
 * decision of its batches' presence there that the tablet's record of the
 * Bean has seen, and timed later, stays. What its records of the batches
 * have seen says nothing of when the Bean was archived, nor does what they
 * held: the edit was worked out from its record of the Bean, so a batch's
 * presence it replaces unseen is kept as a Lost Edit whatever they held. Its batches finished
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

/** The kinds shown or hidden at each Location (ADR-0008): Profiles, Baskets and Tools. */
export type ShownKind = "profile" | "basket" | "tool";

/** Where each Location's showing of the items of a kind is kept: its table, the column naming the item, and that column's type. */
const SHOWN: Readonly<Record<ShownKind, { table: string; column: string; idType: "text" | "uuid" }>> = {
  profile: { table: "profile_locations", column: "profile_id", idType: "text" },
  basket: { table: "basket_locations", column: "basket_id", idType: "uuid" },
  tool: { table: "tool_locations", column: "tool_id", idType: "uuid" },
};

/**
 * Shows or hides the Profile at the Location, as a tablet there showing,
 * hiding, deleting or replacing it does, timed by the edit (ADR-0020),
 * unless the Location's state was decided by an edit the tablet had not seen
 * (as of `seenAt`, the latest decision its record of the Profile has seen,
 * or none) and timed later: that wins, and is written back to the tablet,
 * and the edit, if it would have changed it, is kept as a Lost Edit. One
 * that wins over another tablet's decision it had not seen, which it
 * changes, keeps that decision as a Lost Edit, unless the tablet's last
 * known record of the Profile held it so (`held`, whether that record had
 * it shown; absent where the server holds no such record). One shown or hidden there as the edit
 * has it is decided again, as the field's latest edit, if that edit wins as
 * one changing it would, so an older edit the tablet had not seen cannot
 * undo it. The decision keeps the tablet that made it (`source`) and its
 * version. Says when it decided it, or null if the edit lost.
 */
export function showProfileAt(
  tx: Prisma.TransactionClient,
  profileId: string,
  locationId: string,
  source: EditSource,
  shown: boolean,
  at: Date,
  seenAt: Date | null,
  held?: boolean,
): Promise<Date | null> {
  return showAt(tx, "profile", profileId, locationId, source, shown, at, seenAt, held);
}

/** Shows or hides an item of a kind shown per Location at the Location, as `showProfileAt` does a Profile. */
export async function showAt(
  tx: Prisma.TransactionClient,
  kind: ShownKind,
  itemId: string,
  locationId: string,
  source: EditSource,
  shown: boolean,
  at: Date,
  seenAt: Date | null,
  held?: boolean,
): Promise<Date | null> {
  const { table, column, idType } = shownSql(kind);
  const [before] = await tx.$queryRaw<{ shown: boolean; decidedAt: Date; versionId: string | null; tabletId: string | null }[]>`
    SELECT here.shown, here.decided_at AS "decidedAt", here.version_id AS "versionId", here.decided_by_tablet_id AS "tabletId"
    FROM ${table} AS here WHERE here.${column} = ${itemId}::${idType} AND here.location_id = ${locationId}::uuid`;
  const tabletId = source.tabletId;
  const [changed] = await tx.$queryRaw<{ decidedAt: Date }[]>`
    INSERT INTO ${table} AS here (${column}, location_id, shown, changed_at, decided_at, decided_by_tablet_id)
    VALUES (${itemId}::${idType}, ${locationId}::uuid, ${shown}, ${at}::timestamptz, clock_timestamp(), ${tabletId}::uuid)
    ON CONFLICT (${column}, location_id) DO UPDATE SET
      shown = EXCLUDED.shown, changed_at = GREATEST(EXCLUDED.changed_at, here.changed_at), decided_at = clock_timestamp(),
      decided_by_tablet_id = EXCLUDED.decided_by_tablet_id
      WHERE here.changed_at <= EXCLUDED.changed_at OR here.decided_at <= ${seenAt}::timestamptz
    RETURNING decided_at AS "decidedAt"`;
  const item: ItemRef = { kind, id: itemId };
  if (!changed) {
    if (before && before.shown !== shown) await recordLostEdit(tx, item, locationId, "shown", shown, source, at, before.versionId);
    return null;
  }
  const versionId = await keepShownVersion(tx, kind, itemId, locationId, shown, source, at);
  if (before && before.shown !== shown && unseen(before, seenAt, source) && !heldValue(held, before.shown)) {
    await recordReplaced(tx, item, locationId, "shown", before.shown, before.versionId, versionId);
  }
  return changed.decidedAt;
}

/** Keeps a decision of whether the item is shown at the Location as a version, whose id the decision keeps, and returns. */
async function keepShownVersion(tx: Prisma.TransactionClient, kind: ShownKind, itemId: string, locationId: string, shown: boolean, source: EditSource, at: Date): Promise<string> {
  const { table, column, idType } = shownSql(kind);
  const versionId = await recordVersion(tx, { kind, id: itemId }, locationId, { shown }, source, at);
  await tx.$executeRaw`
    UPDATE ${table} SET version_id = ${versionId}::uuid WHERE ${column} = ${itemId}::${idType} AND location_id = ${locationId}::uuid`;
  return versionId;
}

/**
 * Decides whether the Profile is shown at the Location where nothing has
 * decided it there yet, as a tablet there that holds it but was not known
 * to does, timed by its record, as `showProfileAt` keeps the tablet's.
 * Says when it decided it, or null if it did not.
 */
export function decideProfileAt(
  tx: Prisma.TransactionClient,
  profileId: string,
  locationId: string,
  source: EditSource,
  shown: boolean,
  at: Date,
): Promise<Date | null> {
  return decideAt(tx, "profile", profileId, locationId, source, shown, at);
}

/** Decides whether an item of a kind shown per Location is shown at the Location where nothing has decided it there yet, as `decideProfileAt` does a Profile. */
async function decideAt(
  tx: Prisma.TransactionClient,
  kind: ShownKind,
  itemId: string,
  locationId: string,
  source: EditSource,
  shown: boolean,
  at: Date,
): Promise<Date | null> {
  const { table, column, idType } = shownSql(kind);
  const [decided] = await tx.$queryRaw<{ decidedAt: Date }[]>`
    INSERT INTO ${table} (${column}, location_id, shown, changed_at, decided_at, decided_by_tablet_id)
    VALUES (${itemId}::${idType}, ${locationId}::uuid, ${shown}, ${at}::timestamptz, clock_timestamp(), ${source.tabletId}::uuid)
    ON CONFLICT (${column}, location_id) DO NOTHING
    RETURNING decided_at AS "decidedAt"`;
  if (decided) await keepShownVersion(tx, kind, itemId, locationId, shown, source, at);
  return decided?.decidedAt ?? null;
}

/** A kind's table, column and id type as SQL. */
function shownSql(kind: ShownKind): { table: Prisma.Sql; column: Prisma.Sql; idType: Prisma.Sql } {
  const { table, column, idType } = SHOWN[kind];
  return { table: Prisma.raw(table), column: Prisma.raw(column), idType: Prisma.raw(idType) };
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
