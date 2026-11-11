import { Prisma } from "../generated/prisma/client.js";

// A Shot Summary (#466; #465, The numbers): what the Shots a list's filters
// find have in common, worked out as it is read, in one statement, from each
// Shot's columns and its record. Nothing is stored for it, so a Shot edit
// shows in the next one.

/**
 * A number of a summary: the median of the Shots that had a value for it,
 * with the 25th and 75th percentiles, between which the middle half of them
 * fall, each interpolated between the two Shots nearest it
 * (`percentile_cont`), and how many Shots had a value, which the three rest
 * on; each null where none had.
 */
export interface SummaryNumber {
  shots: number;
  median: number | null;
  p25: number | null;
  p75: number | null;
}

/** A share of a summary: of the Shots that either did or didn't, how many there are, and the part that did, from 0 to 1, null where there are none. */
export interface SummaryShare {
  shots: number;
  share: number | null;
}

/** What a set of Shots have in common. */
export interface SummaryGroup {
  counts: {
    /** The Shots its numbers cover. */
    shots: number;
    /** The Shots left out of them, as cleaning or calibration (`LEFT_OUT`). With `shots`, the Shots list's total for the same filters. */
    cleaningAndCalibration: number;
  };
  numbers: {
    /** Yield weighed less target yield, in grams; a Shot whose target is 0 or missing, or that weighed none, has no value. */
    yieldAgainstTarget: SummaryNumber;
    /** How long each Shot's profile ran, in seconds: the recording less its Preheat, as the Shots list shows it (`shownDuration`). */
    duration: SummaryNumber;
    /** Among the Shots that recorded a stop reason, those Decaid stopped at the target weight (`targetWeight`). */
    stoppedOnWeight: SummaryShare;
  };
}

/** A Shot Summary: every Shot the filters find, as one group. */
export interface ShotSummary {
  groups: SummaryGroup[];
}

/**
 * Whether the Shot of `shots` aliased `s` is left out of a summary's
 * numbers: its Workflow's profile's type, as it recorded it, is `cleaning`
 * or `calibrate`, ignoring case, as Decaid reads one (`_parseBeverageType`
 * in decaid:lib/src/models/data/profile.dart). A Shot that recorded no type,
 * which Decaid reads as espresso, or any other, counts.
 */
const LEFT_OUT = Prisma.sql`coalesce(lower(s.record -> 'workflow' -> 'profile' ->> 'beverage_type') IN ('cleaning', 'calibrate'), false)`;

interface SummaryRow {
  shots: number;
  leftOut: number;
  yieldShots: number;
  yieldQuartiles: number[] | null;
  durationShots: number;
  durationQuartiles: number[] | null;
  stopShots: number;
  stoppedOnWeight: number;
}

/**
 * The summary of the Shots `from` finds: the rest of a query from its `FROM`
 * on, over `shots` aliased `s`, as the Shots list's own, so the two count
 * the same Shots. Each Shot's numbers are worked out in decimal, as its
 * columns print, so 35.9 less 36 is -0.1, and its duration to the
 * millisecond, as the list shows it. They are worked out once for each Shot
 * (`MATERIALIZED`) before they are put together: left to itself, PostgreSQL
 * writes what is read from a Shot's record into each place that uses it,
 * and reads the record again for each, which took five times as long.
 */
export async function summarise(db: Prisma.TransactionClient, from: Prisma.Sql): Promise<ShotSummary> {
  const covered = Prisma.sql`FILTER (WHERE NOT shot.left_out)`;
  const quartiles = (number: string) => Prisma.sql`percentile_cont(ARRAY[0.25, 0.5, 0.75]) WITHIN GROUP (ORDER BY shot.${Prisma.raw(number)}) ${covered}`;
  const [row] = await db.$queryRaw<SummaryRow[]>`
    WITH shot AS MATERIALIZED (
      SELECT ${LEFT_OUT} AS left_out,
        CASE WHEN s.target_yield <> 0 THEN (s.actual_yield::numeric - s.target_yield::numeric)::float8 END AS yield_against_target,
        round((s.duration - coalesce(s.preheat, 0))::numeric, 3)::float8 AS duration,
        nullif(btrim(s.record ->> 'stopReason'), '') AS stop_reason
      ${from}
    )
    SELECT
      count(*) ${covered}::int AS shots,
      count(*) FILTER (WHERE shot.left_out)::int AS "leftOut",
      count(shot.yield_against_target) ${covered}::int AS "yieldShots",
      ${quartiles("yield_against_target")} AS "yieldQuartiles",
      count(shot.duration) ${covered}::int AS "durationShots",
      ${quartiles("duration")} AS "durationQuartiles",
      count(shot.stop_reason) ${covered}::int AS "stopShots",
      count(*) FILTER (WHERE NOT shot.left_out AND shot.stop_reason = 'targetWeight')::int AS "stoppedOnWeight"
    FROM shot`;
  const number = (shots: number, quartiles: number[] | null): SummaryNumber => ({
    shots,
    median: quartiles?.[1] ?? null,
    p25: quartiles?.[0] ?? null,
    p75: quartiles?.[2] ?? null,
  });
  return {
    groups: [
      {
        counts: { shots: row!.shots, cleaningAndCalibration: row!.leftOut },
        numbers: {
          yieldAgainstTarget: number(row!.yieldShots, row!.yieldQuartiles),
          duration: number(row!.durationShots, row!.durationQuartiles),
          stoppedOnWeight: { shots: row!.stopShots, share: row!.stopShots === 0 ? null : row!.stoppedOnWeight / row!.stopShots },
        },
      },
    ],
  };
}
