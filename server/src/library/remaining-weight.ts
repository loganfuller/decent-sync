import type { Prisma } from "../generated/prisma/client.js";

// A Bean Batch's Remaining Weight at a Location, worked out as it is read
// (ADR-0037): the weight its count there starts from, less the dose of each
// Shot linked to the batch that was pulled there since, plus what Batch Moves
// have brought there since, less what they have taken away, and never below
// zero. Nothing here is kept: the count's start is a row of
// `batch_locations`, the Shots are the Shots, and the moves are the rows of
// `batch_moves`. Every read of a weight, and a move deciding what a Location
// has, works it out through here and nowhere else.

/**
 * A Location's count of a batch: when it started, which is when Shots count
 * from, and the version that started it (`remaining_weight_version_id`),
 * which is what moves count by, null where none is known.
 */
export interface Count {
  batchId: string;
  locationId: string;
  at: Date;
  versionId: string | null;
}

/** The Shots that count against a count, and the coffee they used, unrounded, so that only what is shown is rounded. */
export interface Used {
  shots: number;
  weight: number;
}

/** What Batch Moves have done to a count since it started, in grams, unrounded. */
export interface Moved {
  /** The amounts moved to the Location, in all and from each Location they left, null for one deleted since. */
  in: number;
  from: { locationId: string | null; weight: number }[];
  /** The amounts moved away from it, in all and to each Location they joined. */
  away: number;
  to: { locationId: string | null; weight: number }[];
  /** For a count that started with a move, the Location it arrived from, null within it for one deleted since; null for a count that a weight entered started. */
  startedBy: { fromLocationId: string | null } | null;
}

/** No move since a count started, which a weight entered started. */
export const NOT_MOVED: Moved = { in: 0, from: [], away: 0, to: [], startedBy: null };

export function countKey(batchId: string, locationId: string): string {
  return `${batchId} ${locationId}`;
}

/**
 * What the Shots pulled at each Location since its count of the batch
 * started used, by `countKey`, for the counts given, each with the time it
 * started as the batch's row was read (ADR-0037). The time is taken from
 * that read, not looked up again, so a weight entered in between is never
 * paired with the Shots of another. Every Shot linked to the batch whose
 * Location is that one and that was pulled after the count started,
 * Unfinished Shots and Trial Shots among them, each by its measured dose,
 * else the dose its Workflow was set to, else nothing. A Shot with no
 * Location, or pulled where the batch has no weight, is in none. Nothing is
 * kept: a Shot edited, linked to another batch, deleted or arriving late
 * changes the answer the next time it is read.
 */
export async function usedSince(db: Pick<Prisma.TransactionClient, "$queryRaw">, counts: readonly Count[]): Promise<Map<string, Used>> {
  if (counts.length === 0) return new Map();
  const rows = await db.$queryRaw<{ batchId: string; locationId: string; shots: number; weight: number }[]>`
    SELECT here.batch_id::text AS "batchId", here.location_id::text AS "locationId", count(*)::integer AS shots,
      COALESCE(sum(COALESCE(shot.actual_dose, shot.target_dose, 0)), 0)::double precision AS weight
    FROM unnest(${counts.map((count) => count.batchId)}::uuid[], ${counts.map((count) => count.locationId)}::uuid[], ${counts.map((count) => count.at)}::timestamptz[])
      AS here(batch_id, location_id, entered_at)
    JOIN shots AS shot ON shot.library_batch_id = here.batch_id AND shot.location_id = here.location_id AND shot.pulled_at > here.entered_at
    GROUP BY here.batch_id, here.location_id`;
  return new Map(rows.map((row) => [countKey(row.batchId, row.locationId), { shots: row.shots, weight: row.weight }]));
}

/**
 * What Batch Moves have brought to each Location and taken from it since its
 * count of the batch started, by `countKey`, for the counts given, in one
 * query however many there are. A move counts at a Location while the count
 * it found there (`from_count_version_id`, `to_count_version_id`) is still
 * that Location's: a weight entered since, through this release or the
 * previous one, is a new version and so a new count, which no earlier move
 * bears on. This compares no clocks, so a tablet's entry timed by a clock
 * that is behind never takes a move made before it for one made since. The
 * move a count started with is what the count starts from, not a move
 * since. A move of a batch with no weight moved none, and is in none.
 */
export async function movedSince(db: Pick<Prisma.TransactionClient, "$queryRaw">, counts: readonly Count[]): Promise<Map<string, Moved>> {
  if (counts.length === 0) return new Map();
  const rows = await db.$queryRaw<{ batchId: string; locationId: string; fromLocationId: string | null; toLocationId: string | null; starts: boolean; weight: number }[]>`
    SELECT here.batch_id::text AS "batchId", here.location_id::text AS "locationId",
      move.from_location_id::text AS "fromLocationId", move.to_location_id::text AS "toLocationId",
      (move.to_location_id = here.location_id AND move.version_id IS NOT NULL AND move.version_id = here.count_version_id) AS starts,
      sum(move.amount)::double precision AS weight
    FROM unnest(${counts.map((count) => count.batchId)}::uuid[], ${counts.map((count) => count.locationId)}::uuid[], ${counts.map((count) => count.versionId)}::uuid[])
      AS here(batch_id, location_id, count_version_id)
    JOIN batch_moves AS move ON move.batch_id = here.batch_id AND move.amount IS NOT NULL
      AND (
        (move.to_location_id = here.location_id AND move.to_count_version_id IS NOT DISTINCT FROM here.count_version_id)
        OR (move.from_location_id = here.location_id AND move.from_count_version_id IS NOT DISTINCT FROM here.count_version_id)
      )
    GROUP BY 1, 2, 3, 4, 5
    ORDER BY 1, 2, 3, 4`;
  const moved = new Map<string, Moved>();
  for (const row of rows) {
    const key = countKey(row.batchId, row.locationId);
    const at = moved.get(key) ?? { in: 0, from: [], away: 0, to: [], startedBy: null };
    if (row.starts) at.startedBy = { fromLocationId: row.fromLocationId };
    else if (row.toLocationId === row.locationId) {
      at.in += row.weight;
      at.from.push({ locationId: row.fromLocationId, weight: row.weight });
    } else {
      at.away += row.weight;
      at.to.push({ locationId: row.toLocationId, weight: row.weight });
    }
    moved.set(key, at);
  }
  return moved;
}

/**
 * What a count holds, unrounded and below zero where Shots have used more
 * than it had: the weight it starts from, less what Shots have used since,
 * plus what was moved to it, less what was moved away.
 */
export function heldAfter(start: number, used: number, moved: Pick<Moved, "in" | "away"> = NOT_MOVED): number {
  return start - used + moved.in - moved.away;
}

/** A Remaining Weight: what a count holds, never below zero: a weight entered too low reads zero, and finishes nothing. */
export function remainingAfter(start: number, used: number, moved: Pick<Moved, "in" | "away"> = NOT_MOVED): number {
  return Math.max(0, grams(heldAfter(start, used, moved)));
}

/** A weight to the tenth of a gram, as doses are measured, so a sum of them shows no floating-point remainder. */
export function grams(weight: number): number {
  return Math.round(weight * 10) / 10;
}
