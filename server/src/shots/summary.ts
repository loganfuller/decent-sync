import { BadRequestException } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { queryValue } from "../record-filters.js";
import { BLANK, baristaKeySql, baristaNamesSql } from "./filters.js";
import { shotListedSql, shotRecipeSql } from "./links.js";

// A Shot Summary (#466, #468, #469, #470, #473; #465, Which Shots a summary
// counts, The numbers, Groupings, The summary's contract): what the Shots a
// list's filters find have in common, by group, and within a group by day or
// week, worked out as it is read, in one statement, from each Shot's columns
// and its record, with the Reference Shot of each Recipe they are grouped
// by. Nothing is stored for it, so a Shot edit shows in the next one.

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

/** A rating: the median of the ratings given, and `rated`, the part of the group's Shots that were rated, from 0 to 1, null where it has none. */
export interface RatingNumber extends SummaryNumber {
  rated: number | null;
}

/** A number with the lowest and highest of the Shots' values too, each null where none had a value. */
export interface RangedNumber extends SummaryNumber {
  lowest: number | null;
  highest: number | null;
}

/**
 * The steps of their Profiles the Shots ended in: how many Shots ended in a
 * step, and `mostCommon`, the `LAST_STEPS` steps most of them ended in, each
 * by its frame and name with how many, most first, then by frame and name.
 * It is not called `steps`, which the MCP endpoint's budget keeps whole as a
 * Profile's (`Shape` in mcp/budget.ts): its names are free text.
 */
export interface LastSteps {
  shots: number;
  mostCommon: { frame: number; name: string | null; shots: number }[];
}

/** The most steps a group's `lastStep` names, so a group stays small whatever its Shots' Profiles. */
export const LAST_STEPS = 10;

/** Each number a summary can give (#465, The numbers), as a group gives it. */
export interface SummaryNumbers {
  /** Yield weighed less target yield, in grams; a Shot whose target is 0 or missing, or that weighed none, has no value. */
  yieldAgainstTarget: SummaryNumber;
  /** How long each Shot's profile ran, in seconds: the recording less its Preheat, as the Shots list shows it (`shownDuration`). */
  duration: SummaryNumber;
  /** Among the Shots that recorded a stop reason, those Decaid stopped at the target weight (`targetWeight`). */
  stoppedOnWeight: SummaryShare;
  /** Yield weighed over dose weighed; a Shot whose dose is 0 or missing, or that weighed no yield, has no value. */
  ratio: SummaryNumber;
  /** As the Shots keep them, leaving out the Preheat: in bar, and in ml/s. */
  peakPressure: SummaryNumber;
  peakFlow: SummaryNumber;
  /** The Shot's enjoyment, on Decaid's scale of 0 to 10, where above 0: DYE2 writes 0 for no stars, so 0 is unrated. */
  rating: RatingNumber;
  /** The grind setting its Workflow recorded, where its whole text is a decimal number (`GRIND_SETTING`). */
  grindSetting: RangedNumber;
  /** Total dissolved solids and extraction yield, in %, where the tablet recorded a number. */
  tds: SummaryNumber;
  extractionYield: SummaryNumber;
  /** Seconds from the start of its profile to the scale's first reading of 1 g or more, as the Shot keeps it (`timeToFirstDrip`). */
  timeToFirstDrip: SummaryNumber;
  /** The step of its Profile each Shot ended in, as the Shot keeps it. */
  lastStep: LastSteps;
}

/**
 * What one Shot has of each number, as a Recipe's Reference Shot gives them
 * (`SummaryReference`): its own value, null where it has none, as a Shot
 * with no value of a number is not counted in a group's. Whether it stopped
 * on weight is true or false, null where it recorded no stop reason, and its
 * last step the step of its Profile it ended in.
 */
export type ShotNumbers = {
  [Name in keyof SummaryNumbers]: (Name extends "stoppedOnWeight" ? boolean : Name extends "lastStep" ? { frame: number; name: string | null } : number) | null;
};

/** The numbers a summary can give, in the order a group gives them. */
export const NUMBERS = [
  "yieldAgainstTarget",
  "duration",
  "stoppedOnWeight",
  "ratio",
  "peakPressure",
  "peakFlow",
  "rating",
  "grindSetting",
  "tds",
  "extractionYield",
  "timeToFirstDrip",
  "lastStep",
] as const satisfies readonly (keyof SummaryNumbers)[];
export type NumberName = (typeof NUMBERS)[number];

/** The numbers a summary gives where none are named: with the count, the Overview's four (#465). */
export const DEFAULT_NUMBERS: readonly NumberName[] = ["yieldAgainstTarget", "duration", "stoppedOnWeight"];

/**
 * What a summary's Shots are grouped by (#465, Groupings), each by what the
 * Shots list's filter of the same name takes, so every group opens as that
 * filter and the Shots it finds are the group's.
 */
export const GROUPINGS = ["location", "machine", "recipe", "bean", "beanBatch", "profile", "grinder", "basket", "barista"] as const;
export type Grouping = (typeof GROUPINGS)[number];

/** The most groupings a summary takes at once. */
export const MAX_GROUPINGS = 2;

/** A Location, as a group names one: the one a Shot is credited to, or the one a Recipe or Grinder belongs to. */
interface NamedLocation {
  id: string;
  name: string;
}

/**
 * What a group is grouped by: an entry for each grouping asked for, in their
 * order, and none without one. Each is null for the group of Shots with
 * none, but a grouping by Machine, where none occur: its group is a
 * Machine's, or a Pending Machine's, the other being null.
 */
export interface GroupedBy {
  /** The Location the Shots are credited to. */
  location?: NamedLocation | null;
  machine?: { id: string; name: string } | null;
  pendingMachine?: { id: string; model: string; serial: string } | null;
  /** The Recipe the Shots were pulled with (`shotRecipeSql`), with the Location it belongs to, as the list's filter names it. */
  recipe?: { id: string; name: string | null; location: NamedLocation | null } | null;
  /** The roaster and name the Shots recorded, either of which may be missing. */
  bean?: { roaster: string | null; name: string | null } | null;
  /** The Library's Bean Batch the Shots are linked to, as the list names one. */
  beanBatch?: { id: string; bean: { id: string; roaster: string | null; name: string | null }; roastDate: string | null } | null;
  /** The profile title the Shots recorded. */
  profile?: string | null;
  /** The Library's Grinder the Shots are linked to, with the Location it belongs to. */
  grinder?: { id: string; model: string | null; location: NamedLocation | null } | null;
  /** The Library's Basket the Shots are linked to. */
  basket?: { id: string; name: string | null } | null;
  /** The Barista the Shots name, whatever its case and the blanks around it (`baristaKeySql`), by the most recent spelling among listed Shots. */
  barista?: string | null;
}

/**
 * What a set of Shots have in common: a group's, or one of its buckets'.
 * Its first three counts add up to the Shots list's total for the same
 * filters and the group's.
 */
export interface SummaryFigures {
  counts: {
    /** The Shots its numbers cover. */
    shots: number;
    /** The Unfinished Shots left out of them (`UNFINISHED`), counted apart. */
    unfinished: number;
    /** The Shots left out of them as cleaning or calibration (`LEFT_OUT`), whether they poured or not. */
    cleaningAndCalibration: number;
    /** Of `shots`, those whose stored values aren't worked out yet (`AWAITING`), which count as poured and have none of those values. */
    awaitingValues: number;
  };
  /** The numbers asked for, in the order of `NUMBERS`. */
  numbers: Partial<SummaryNumbers>;
}

/** What a summary's Shots are bucketed by within each group (#465, The summary's contract): the day, or the week from its Monday, each Shot was pulled in (`bucketSql`). */
export const BUCKETS = ["day", "week"] as const;
export type Bucket = (typeof BUCKETS)[number];

/**
 * A group's Shots of one day or week: `start`, the day, or the Monday its
 * week starts on, as a date, such as `2026-03-02`, and what they have in
 * common. `start` is null for the Shots whose time is unknown, which are in
 * no day.
 */
export interface SummaryBucket extends SummaryFigures {
  start: string | null;
}

/** What a group is and, of a Recipe's, what its numbers are read against. */
interface Grouped {
  by: GroupedBy;
  /**
   * With a grouping by Recipe, where the group's Recipe has a Reference Shot
   * (ADR-0029) the Shots list lists: that Shot, to read the group's numbers
   * against. It is the Recipe's, so each group of the Recipe gives the same
   * one, whatever else they are grouped by and whatever the filters, which
   * need not find it. No group has one otherwise: not a Recipe's with none,
   * or whose Reference Shot is hidden, its Pending Machine dismissed, nor
   * the group of Shots with no Recipe.
   */
  reference?: SummaryReference;
}

/** A group of a summary with no bucket: what its Shots have in common. */
export interface SummaryGroup extends Grouped, SummaryFigures {}

/**
 * A group of a summary with a bucket: in place of its own counts and
 * numbers, its buckets, one for each day or week it has Shots of, oldest
 * first, then that of the Shots whose time is unknown. Their counts add up
 * to what the group's would be. Its `reference` is given once, on the group.
 */
export interface BucketedGroup extends Grouped {
  buckets: SummaryBucket[];
}

/**
 * A Recipe's Reference Shot beside a group of the Recipe's Shots: its id,
 * and its own value of each number asked for, in the order of `NUMBERS`,
 * whatever kind of Shot it is, a cleaning or an Unfinished Shot too. Nothing
 * is worked out of the two: no score, and no judgement of the group's Shots
 * against it (#465, Out of Scope).
 */
export interface SummaryReference {
  id: string;
  numbers: Partial<ShotNumbers>;
}

/**
 * A Shot Summary: a page of its groups, in their order, with how many
 * groups there are, as a list gives its page. Without a grouping it is one
 * group, every Shot the filters find, there even where they find none; with
 * one, a group is there only for Shots found. With a bucket its groups are
 * `BucketedGroup`s.
 */
export interface ShotSummary<Group = SummaryGroup> {
  groups: Group[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Whether the Shot of `shots` aliased `s` is left out of a summary's
 * numbers: its Workflow's profile's type, as it recorded it, is `cleaning`
 * or `calibrate`, ignoring case, as Decaid reads one (`_parseBeverageType`
 * in decaid:lib/src/models/data/profile.dart). A Shot that recorded no type,
 * which Decaid reads as espresso, or any other, counts.
 */
const LEFT_OUT = Prisma.sql`coalesce(lower(s.record -> 'workflow' -> 'profile' ->> 'beverage_type') IN ('cleaning', 'calibrate'), false)`;

/**
 * Whether the Shot of `shots` aliased `s` is an Unfinished Shot (GLOSSARY.md):
 * nothing poured, as its stored values show it. The Machine never reported
 * pouring (`poured`) and the scale never read 1 g or more after its Preheat
 * (`time_to_first_drip`), so it was stopped in its Preheat or early in its
 * preinfusion. Both are needed: a Shot that reaches its yield while its
 * profile is still in the steps it counts as preinfusion, as a fast one
 * stopped on weight in a long preinfusion step, never reports pouring,
 * though it ran whole. A Shot with no scale is unfinished where it never
 * reported pouring. The scale's reading is the Shot's as `time_to_first_drip`
 * takes it, so a cup put on the scale during Preheat, read before Decaid's
 * tare lands, or a cup on a scale in full gateway mode, which is never
 * tared, reads as a first drip, and such a Shot counts as poured though
 * nothing poured. A Shot whose stored values aren't worked out yet
 * (`AWAITING`) counts as poured.
 */
const UNFINISHED = Prisma.sql`coalesce(NOT s.poured AND s.time_to_first_drip IS NULL, false)`;

/**
 * Whether the Shot of `shots` aliased `s` awaits its stored values: stored
 * at an earlier curves revision, they are worked out again in the
 * background (`CurvesRefresh`). Whether it poured is never null once they
 * are, as no other of them promises.
 */
const AWAITING = Prisma.sql`s.poured IS NULL`;

/**
 * The most a yield or target may be, in grams, to have a yield against
 * target: a record may hold any number, and the difference of two beyond
 * this fits no float8, which would fail the whole summary.
 */
const MAX_GRAMS = 1e307;

/**
 * The most a Shot's value of a number may be, in size, to count in its
 * quartiles: a record may hold any number, and PostgreSQL interpolates a
 * percentile between two values from their difference, which for two
 * beyond this fits no float8 and makes it infinite. No Shot records one.
 */
const MAX_VALUE = 1e307;

/**
 * The most a yield may be over its dose, as a multiple, to have a ratio: a
 * record may hold any number, and a quotient beyond what a float8 holds
 * would fail the whole summary. A ratio is rounded to millionths, so one
 * too small for a float8 is 0.
 */
const MAX_RATIO = 1e300;

/**
 * Where a Shot's record holds its grind setting, as its Workflow recorded it
 * (`recordedDetails`), read as a number where its whole text is a decimal
 * number, such as "8.8", "2.00", "12" or "-.5", with only spaces, tabs and
 * line ends around it (`BLANK`), or the record holds a number there; none
 * for a text setting, such as "8.8 fine" or "1e3". The path is strict, so a
 * record that holds something else on the way has none, as the Shot page
 * reads it, and silent, so a number too large for a float8 has none rather
 * than failing the summary.
 */
const GRIND_SETTING = String.raw`strict $.workflow.context.grinderSetting ? (@.type() == "number" || @ like_regex "^[ \t\n\r\f\v]*[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)[ \t\n\r\f\v]*$").double()`;

/** A number a Shot's record holds at a path of its annotations (`recordedDetails`), none where it holds anything else, as a text. */
function annotatedNumberSql(field: "drinkTds" | "drinkEy"): Prisma.Sql {
  return Prisma.sql`jsonb_path_query_first(s.record, ${`strict $.annotations.${field} ? (@.type() == "number")`}::jsonpath, '{}', true)::float8`;
}

/** What a number reads of a summary's statement. */
interface NumberSql {
  /** What each Shot of `shots` aliased `s` gives for it: columns of the Shots' query, each with its name. */
  columns: Prisma.Sql[];
  /** What a group puts together of them, as columns of the groups' query, of `shot`, with `covered` the condition its Shots meet. */
  aggregates(covered: Prisma.Sql): Prisma.Sql[];
  /** The number, from a group's row, of a group of `shots` Shots its numbers cover. */
  read(row: Record<string, unknown>, shots: number): unknown;
  /** One Shot's own value of it (`ShotNumbers`), from its `columns`. */
  own(shot: Record<string, unknown>): unknown;
}

/** A column or a group's aggregate named by `name`, one of this file's, as it is written into the statement. */
function quoted(name: string): Prisma.Sql {
  return Prisma.raw(`"${name}"`);
}

/** Whether a Shot covered has a value of the column `name` to count (`MAX_VALUE`): null, none, is not. */
function countedSql(name: string, covered: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`${covered} AND abs(shot.${quoted(name)}) < ${MAX_VALUE}::float8`;
}

/** The quartiles of the column `name` of the Shots covered that count it, as `percentile_cont` interpolates them. */
function quartilesSql(name: string, covered: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`percentile_cont(ARRAY[0.25, 0.5, 0.75]) WITHIN GROUP (ORDER BY shot.${quoted(name)}) FILTER (WHERE ${countedSql(name, covered)})`;
}

/** A number from its quartiles and the Shots that had a value. */
function numberOf(shots: number, quartiles: number[] | null): SummaryNumber {
  return { shots, median: quartiles?.[1] ?? null, p25: quartiles?.[0] ?? null, p75: quartiles?.[2] ?? null };
}

/** A median number of each Shot's `value`, null where it has none, or one too large to count (`MAX_VALUE`), named `name` in the statement. */
function medianSql(name: string, value: Prisma.Sql): NumberSql {
  return {
    columns: [Prisma.sql`${value} AS ${quoted(name)}`],
    aggregates: (covered) => [
      Prisma.sql`count(*) FILTER (WHERE ${countedSql(name, covered)})::int AS ${quoted(`${name}Shots`)}`,
      Prisma.sql`${quartilesSql(name, covered)} AS ${quoted(`${name}Quartiles`)}`,
    ],
    read: (row) => numberOf(row[`${name}Shots`] as number, row[`${name}Quartiles`] as number[] | null),
    // A value too large to count in a group's is none here too.
    own: (shot) => {
      const value = shot[name] as number | null;
      return value !== null && Math.abs(value) < MAX_VALUE ? value : null;
    },
  };
}

/**
 * Each number in the summary's statement, over `shots` aliased `s`. Each is
 * worked out in decimal where it is of two columns, as they print, so 35.9
 * less 36 is -0.1 and 36 over 18 is 2. A step's Shots are put together
 * apart (`summarise`), so `lastStep` here counts the Shots that ended in
 * one.
 */
function numberSql(name: NumberName): NumberSql {
  switch (name) {
    case "yieldAgainstTarget":
      return medianSql(
        name,
        Prisma.sql`CASE WHEN s.target_yield <> 0 AND greatest(abs(s.actual_yield), abs(s.target_yield)) < ${MAX_GRAMS}::float8
          THEN (s.actual_yield::numeric - s.target_yield::numeric)::float8 END`,
      );
    case "duration":
      return medianSql(name, Prisma.sql`round((s.duration - coalesce(s.preheat, 0))::numeric, 3)::float8`);
    case "stoppedOnWeight":
      return {
        columns: [Prisma.sql`nullif(btrim(s.record ->> 'stopReason', ${BLANK}), '') AS "stopReason"`],
        aggregates: (covered) => [
          Prisma.sql`count(shot."stopReason") FILTER (WHERE ${covered})::int AS "stopShots"`,
          Prisma.sql`count(*) FILTER (WHERE ${covered} AND shot."stopReason" = 'targetWeight')::int AS "stoppedOnWeight"`,
        ],
        read: (row) => {
          const shots = row.stopShots as number;
          return { shots, share: shots === 0 ? null : (row.stoppedOnWeight as number) / shots } satisfies SummaryShare;
        },
        own: (shot) => (shot.stopReason === null ? null : shot.stopReason === "targetWeight"),
      };
    case "ratio":
      return medianSql(
        name,
        Prisma.sql`CASE WHEN s.actual_dose <> 0 AND abs(s.actual_yield::numeric) < abs(s.actual_dose::numeric) * ${MAX_RATIO}::numeric
          THEN round(s.actual_yield::numeric / s.actual_dose::numeric, 6)::float8 END`,
      );
    case "peakPressure":
      return medianSql(name, Prisma.sql`s.peak_pressure`);
    case "peakFlow":
      return medianSql(name, Prisma.sql`s.peak_flow`);
    case "rating": {
      const median = medianSql(name, Prisma.sql`CASE WHEN s.enjoyment > 0 THEN s.enjoyment END`);
      return {
        ...median,
        read: (row, shots) => {
          const number = median.read(row, shots) as SummaryNumber;
          return { ...number, rated: shots === 0 ? null : number.shots / shots } satisfies RatingNumber;
        },
      };
    }
    case "grindSetting": {
      const median = medianSql(name, Prisma.sql`jsonb_path_query_first(s.record, ${GRIND_SETTING}::jsonpath, '{}', true)::float8`);
      return {
        columns: median.columns,
        aggregates: (covered) => [
          ...median.aggregates(covered),
          Prisma.sql`min(shot."grindSetting") FILTER (WHERE ${countedSql("grindSetting", covered)}) AS "grindSettingLowest"`,
          Prisma.sql`max(shot."grindSetting") FILTER (WHERE ${countedSql("grindSetting", covered)}) AS "grindSettingHighest"`,
        ],
        read: (row, shots) =>
          ({ ...(median.read(row, shots) as SummaryNumber), lowest: row.grindSettingLowest as number | null, highest: row.grindSettingHighest as number | null }) satisfies RangedNumber,
        own: median.own,
      };
    }
    case "tds":
      return medianSql(name, annotatedNumberSql("drinkTds"));
    case "extractionYield":
      return medianSql(name, annotatedNumberSql("drinkEy"));
    case "timeToFirstDrip":
      return medianSql(name, Prisma.sql`s.time_to_first_drip`);
    case "lastStep":
      return {
        columns: [Prisma.sql`s.last_step_frame AS "stepFrame"`, Prisma.sql`s.last_step_name AS "stepName"`],
        aggregates: (covered) => [Prisma.sql`count(shot."stepFrame") FILTER (WHERE ${covered})::int AS "lastStepShots"`],
        // Each step's fields in one order, whichever way it was read: a bucket's come through jsonb, which orders an object's keys its own way.
        read: (row) =>
          ({
            shots: row.lastStepShots as number,
            mostCommon: ((row.lastSteps as LastSteps["mostCommon"] | null) ?? []).map(({ frame, name, shots }) => ({ frame, name, shots })),
          }) satisfies LastSteps,
        own: (shot) => (shot.stepFrame === null ? null : { frame: shot.stepFrame as number, name: shot.stepName as string | null }),
      };
  }
}

/** Reads a summary's numbers from its query's `numbers`: one or more separated by a comma, such as `ratio,rating`, or the default four. */
export function readNumbers(query: Record<string, unknown>): NumberName[] {
  const problems: string[] = [];
  const given = queryValue(query, "numbers", problems);
  if (problems.length > 0) throw new BadRequestException(problems);
  return given === undefined ? [...DEFAULT_NUMBERS] : numbersOf(given.split(","));
}

/** The numbers named, each one of `NUMBERS`, at least one, none twice. */
export function numbersOf(names: readonly string[]): NumberName[] {
  const known = names.filter((name): name is NumberName => (NUMBERS as readonly string[]).includes(name));
  if (known.length < names.length || names.length === 0) {
    throw new BadRequestException(`Enter numbers as one or more of ${NUMBERS.slice(0, -1).join(", ")} and ${NUMBERS.at(-1)}, separated by a comma`);
  }
  if (new Set(known).size < known.length) throw new BadRequestException("Give each number once");
  return known;
}

/**
 * Reads a summary's groupings from its query's `groupBy`: none, one, or two
 * separated by a comma, such as `recipe,machine`.
 */
export function readGroupBy(query: Record<string, unknown>): Grouping[] {
  const problems: string[] = [];
  const given = queryValue(query, "groupBy", problems);
  if (problems.length > 0) throw new BadRequestException(problems);
  return given === undefined ? [] : groupingsOf(given.split(","));
}

/** The groupings named, each one of `GROUPINGS`, at most `MAX_GROUPINGS` of them, and none twice. */
export function groupingsOf(names: readonly string[]): Grouping[] {
  const known = names.filter((name): name is Grouping => (GROUPINGS as readonly string[]).includes(name));
  if (known.length < names.length || names.length > MAX_GROUPINGS) {
    throw new BadRequestException(`Enter groupBy as one or two of ${GROUPINGS.slice(0, -1).join(", ")} and ${GROUPINGS.at(-1)}, separated by a comma`);
  }
  if (new Set(known).size < known.length) throw new BadRequestException("Give each grouping once");
  return known;
}

/** Reads a summary's bucket from its query's `bucket`: `day` or `week`, or none. */
export function readBucket(query: Record<string, unknown>): Bucket | undefined {
  const problems: string[] = [];
  const given = queryValue(query, "bucket", problems);
  if (problems.length > 0) throw new BadRequestException(problems);
  return given === undefined ? undefined : bucketOf(given);
}

/** The bucket named, one of `BUCKETS`. */
export function bucketOf(name: string): Bucket {
  if (!(BUCKETS as readonly string[]).includes(name)) throw new BadRequestException("Enter bucket as day or week");
  return name as Bucket;
}

/**
 * The day or week the Shot of `shots` aliased `s`, joined to its Location
 * as `l`, was pulled in, as the date it starts on: its own Location's, on
 * that Location's wall clock, or UTC's for a Shot with none, as the date
 * filters read a day (`recordFilterSql`), so the Shots a day's bucket holds
 * are those the filters `from` and `to` that day find, and one bucket may
 * hold Shots of Locations in different zones, pulled hours apart. A week
 * starts on Monday (`date_trunc`'s, ISO 8601's). Null for a Shot whose time
 * is unknown.
 */
function bucketSql(bucket: Bucket): Prisma.Sql {
  return Prisma.sql`date_trunc(${bucket}::text, s.pulled_at AT TIME ZONE coalesce(l.time_zone, 'UTC'))::date`;
}

/** A grouping, in the summary's statement. */
interface GroupingSql {
  /** What each Shot of `shots` aliased `s` is in a group by: columns of the Shots' query, by name. */
  keys: Record<string, Prisma.Sql>;
  /** A query the statement names before its others, as the Baristas' names. */
  named?: Prisma.Sql;
  /** What names its groups, joined to them, aliased `g`. */
  joins?: Prisma.Sql;
  /** What a group gives for it (`GroupedBy`), by its name there. */
  by: Record<string, Prisma.Sql>;
  /** The id of the Reference Shot of what a group is grouped by, of its `joins`: a grouping by Recipe's alone. */
  referenceShotId?: Prisma.Sql;
  /** The order of its groups: by name, ignoring case, then by id, the group of Shots with none last. */
  order: Prisma.Sql;
}

/** A Location joined as `alias`, as a group names one, or null where there is none. */
function locationSql(alias: string): Prisma.Sql {
  const location = Prisma.raw(alias);
  return Prisma.sql`CASE WHEN ${location}.id IS NOT NULL THEN json_build_object('id', ${location}.id, 'name', ${location}.name) END`;
}

/**
 * A grouping by the Library item the Shots are linked to by `link`, of
 * `table`, named by its content's `name` field, with the Location it
 * belongs to where `located`.
 */
function itemSql(grouping: "recipe" | "grinder" | "basket", link: Prisma.Sql, table: string, name: "name" | "model", located = false): GroupingSql {
  // Each name is one of this file's, written into the statement as it is.
  const key = Prisma.raw(`g.${grouping}_id`);
  const item = Prisma.raw(`by_${grouping}`);
  const location = `by_${grouping}_location`;
  const field = Prisma.raw(`'${name}'`);
  const named = Prisma.sql`${item}.content ->> ${field}`;
  return {
    keys: { [`${grouping}_id`]: link },
    joins: located
      ? Prisma.sql`LEFT JOIN ${Prisma.raw(table)} ${item} ON ${item}.id = ${key} LEFT JOIN locations ${Prisma.raw(location)} ON ${Prisma.raw(location)}.id = ${item}.location_id`
      : Prisma.sql`LEFT JOIN ${Prisma.raw(table)} ${item} ON ${item}.id = ${key}`,
    by: {
      [grouping]: located
        ? Prisma.sql`CASE WHEN ${key} IS NOT NULL THEN json_build_object('id', ${key}, ${field}, ${named}, 'location', ${locationSql(location)}) END`
        : Prisma.sql`CASE WHEN ${key} IS NOT NULL THEN json_build_object('id', ${key}, ${field}, ${named}) END`,
    },
    order: Prisma.sql`${key} IS NULL, lower(${named}), ${key}`,
  };
}

/**
 * Each grouping in the summary's statement, over `shots` aliased `s` joined
 * to its Location as `l`. `listed` is the rest of a query of every listed
 * Shot, whatever the filters, from its `FROM` on, which names the Baristas.
 */
function groupingSql(grouping: Grouping, listed: Prisma.Sql): GroupingSql {
  switch (grouping) {
    case "location":
      return {
        keys: { location_id: Prisma.sql`s.location_id` },
        joins: Prisma.sql`LEFT JOIN locations by_location ON by_location.id = g.location_id`,
        by: { location: locationSql("by_location") },
        order: Prisma.sql`g.location_id IS NULL, lower(by_location.name), g.location_id`,
      };
    // A listed Shot is credited to a Machine, or held by a Pending Machine, never both (credit.ts). Machines come
    // first, by name, and then the Pending Machines, which have none, by their hardware.
    case "machine":
      return {
        keys: { machine_id: Prisma.sql`s.machine_id`, pending_machine_id: Prisma.sql`s.pending_machine_id` },
        joins: Prisma.sql`LEFT JOIN machines by_machine ON by_machine.id = g.machine_id LEFT JOIN pending_machines by_pending ON by_pending.id = g.pending_machine_id`,
        by: {
          machine: Prisma.sql`CASE WHEN g.machine_id IS NOT NULL THEN json_build_object('id', g.machine_id, 'name', by_machine.name) END`,
          pendingMachine: Prisma.sql`CASE WHEN g.machine_id IS NULL THEN json_build_object('id', g.pending_machine_id, 'model', by_pending.model, 'serial', by_pending.serial) END`,
        },
        order: Prisma.sql`g.machine_id IS NULL, lower(by_machine.name), g.machine_id, lower(by_pending.model), lower(by_pending.serial), g.pending_machine_id`,
      };
    // Resolved through its Machine's Loaded Recipes for each Shot, as the list's filter reads it.
    case "recipe":
      return { ...itemSql("recipe", shotRecipeSql("s"), "recipes", "name", true), referenceShotId: Prisma.sql`by_recipe.reference_shot_id` };
    // As the list's filter takes a Bean: by roaster and name together, an empty one as none, in its choices' order.
    case "bean":
      return {
        keys: { coffee_roaster: Prisma.sql`nullif(s.coffee_roaster, '')`, coffee_name: Prisma.sql`nullif(s.coffee_name, '')` },
        by: { bean: Prisma.sql`CASE WHEN g.coffee_roaster IS NOT NULL OR g.coffee_name IS NOT NULL THEN json_build_object('roaster', g.coffee_roaster, 'name', g.coffee_name) END` },
        order: Prisma.sql`g.coffee_roaster IS NULL AND g.coffee_name IS NULL, lower(g.coffee_roaster), lower(g.coffee_name), g.coffee_roaster, g.coffee_name`,
      };
    // Named by its Bean and roast date, and ordered as the Bean Batches list is: by its Bean's name, then roaster, then
    // the latest roast date first.
    case "beanBatch":
      return {
        keys: { batch_id: Prisma.sql`s.library_batch_id` },
        joins: Prisma.sql`LEFT JOIN bean_batches by_batch ON by_batch.id = g.batch_id LEFT JOIN beans by_bean ON by_bean.id = by_batch.bean_id`,
        by: {
          beanBatch: Prisma.sql`CASE WHEN g.batch_id IS NOT NULL THEN json_build_object(
            'id', g.batch_id,
            'bean', json_build_object('id', by_bean.id, 'roaster', by_bean.content ->> 'roaster', 'name', by_bean.content ->> 'name'),
            'roastDate', by_batch.content ->> 'roastDate') END`,
        },
        order: Prisma.sql`g.batch_id IS NULL, lower(by_bean.content ->> 'name'), lower(by_bean.content ->> 'roaster'), by_batch.content ->> 'roastDate' DESC NULLS LAST, g.batch_id`,
      };
    // By the title recorded, as the list's filter takes it: a Shot's Library Profile is matched as it is read
    // (`shotProfileSql`), which took 2 s for 10,000 Shots (#465). Two Profiles with one title are one group.
    case "profile":
      return {
        keys: { profile_title: Prisma.sql`nullif(s.profile_title, '')` },
        by: { profile: Prisma.sql`g.profile_title` },
        order: Prisma.sql`g.profile_title IS NULL, lower(g.profile_title), g.profile_title`,
      };
    case "grinder":
      return itemSql("grinder", Prisma.sql`s.library_grinder_id`, "grinders", "model", true);
    case "basket":
      return itemSql("basket", Prisma.sql`s.library_basket_id`, "baskets", "name");
    // One Barista whatever the name's case and the blanks around it, by one name wherever it is given: its most recent
    // spelling among every listed Shot, which the filter's choices give too. Its key is that name, ignoring case.
    case "barista":
      return {
        keys: { barista: baristaKeySql(Prisma.raw("s.barista")) },
        named: Prisma.sql`by_barista AS (${baristaNamesSql(listed)})`,
        joins: Prisma.sql`LEFT JOIN by_barista ON by_barista.key = g.barista`,
        by: { barista: Prisma.sql`by_barista.name` },
        order: Prisma.sql`g.barista`,
      };
  }
}

/** The parts joined, or nothing where there are none, which `Prisma.join` refuses. */
function joined(parts: Prisma.Sql[], separator: string): Prisma.Sql {
  return parts.length > 0 ? Prisma.join(parts, separator) : Prisma.empty;
}

/**
 * The summary of the Shots `listed` and `filters` find together: `listed`
 * the rest of a query of every listed Shot from its `FROM` on, over `shots`
 * aliased `s` joined to its Location as `l`, and `filters` the conditions
 * that narrow them, as the Shots list's own, so the two count the same
 * Shots. They are grouped by `groupBy`, a group for each value the Shots
 * found have, or, without a grouping, as one group; the groups are ordered
 * by the first grouping, then the second, each by name, ignoring case, then
 * by id, with its group of Shots with none last, and `page` takes that many
 * groups of them. Each group gives its counts and the `numbers` asked for,
 * only those being read. Grouped by Recipe, each group on the page gives its
 * Recipe's Reference Shot too, where it has one the Shots list lists
 * (`shotListedSql`), with that Shot's own value of each of those numbers,
 * read as each Shot's are, in the same statement, so the two are of one
 * moment.
 *
 * With a `bucket`, a group gives in their place its buckets (`BucketedGroup`):
 * its counts and numbers for each day or week it has Shots of (`bucketSql`),
 * oldest first, a day or week with none having no bucket. The Shots are put
 * together by group and bucket at once, and a page is still a number of
 * groups, each with every one of its buckets, so none is split between two
 * pages; the buckets of the groups on the page are read as one value each,
 * found by the group's key.
 *
 * Each Shot's numbers are worked out in decimal, as its columns print, so
 * 35.9 less 36 is -0.1, and its duration to the millisecond, as the list
 * shows it. They are worked out once for each Shot, with what it is grouped
 * by (`MATERIALIZED`), before they are put together: left to itself,
 * PostgreSQL writes what is read from a Shot's record into each place that
 * uses it, and reads the record again for each, which took four times as
 * long. What names a group is joined to the groups, never to each Shot.
 *
 * A stop reason of blanks alone (`BLANK`) is none. Decaid writes one of its
 * stop reasons' names or nothing, so this follows the Shots list's reading
 * of one (`recordedText`) no further: not into Unicode's other spaces, nor
 * a value that is no text, which counts as recorded by its text.
 */
export async function summarise(
  db: Prisma.TransactionClient,
  listed: Prisma.Sql,
  filters: Prisma.Sql,
  groupBy: readonly Grouping[],
  page: { limit: number; offset: number },
  numbers: readonly NumberName[] = DEFAULT_NUMBERS,
  bucket?: Bucket,
): Promise<ShotSummary<SummaryGroup | BucketedGroup>> {
  const groupings = groupBy.map((grouping) => groupingSql(grouping, listed));
  const keys = groupings.flatMap((grouping) => Object.entries(grouping.keys));
  const named = groupings.flatMap((grouping) => (grouping.named ? [Prisma.sql`${grouping.named},`] : []));
  const joins = groupings.flatMap((grouping) => (grouping.joins ? [grouping.joins] : []));
  const by = groupings.flatMap((grouping) => Object.entries(grouping.by).map(([name, value]) => Prisma.sql`${Prisma.raw(`'${name}'`)}, ${value}`));
  const order = groupings.map((grouping) => grouping.order);
  const ofShot = (name: Prisma.Sql) => Prisma.sql`shot.${name}`;
  const keyNames = keys.map(([name]) => ofShot(Prisma.raw(name)));
  // What the Shots are put together by: their group, or, with a bucket, each day or week of it.
  const cellNames = bucket ? [...keyNames, Prisma.sql`shot.bucket`] : keyNames;
  const asked = NUMBERS.filter((name) => numbers.includes(name)).map((name) => [name, numberSql(name)] as const);
  // A Shot's numbers cover it unless it is left out as cleaning or calibration, or is unfinished.
  const covered = Prisma.sql`NOT shot.left_out AND NOT shot.unfinished`;
  // The steps the Shots ended in: counted for every group, or bucket of one, at once, those most of them did kept, and
  // joined to those on the page by their keys as one value, so each one's are found by hash rather than by reading every
  // Shot again for each, as a join on each key would (`IS NOT DISTINCT FROM`, for a group of none, can't be hashed). A
  // group's buckets are found by its keys as one value likewise.
  const steps = asked.some(([name]) => name === "lastStep");
  const referenceShotId = groupings.find((grouping) => grouping.referenceShotId)?.referenceShotId;
  const groupKey = Prisma.sql`jsonb_build_array(${joined(keyNames, ", ")})`;
  const cellKey = Prisma.sql`jsonb_build_array(${joined(cellNames, ", ")})`;
  const groupedBy = (names: Prisma.Sql[]) => (names.length > 0 ? Prisma.sql`GROUP BY ${Prisma.join(names, ", ")}` : Prisma.empty);
  const rows = await db.$queryRaw<Record<string, unknown>[]>`
    WITH ${joined(named, " ")} shot AS MATERIALIZED (
      SELECT ${Prisma.join(
        [
          ...keys.map(([name, value]) => Prisma.sql`${value} AS ${Prisma.raw(name)}`),
          ...(bucket ? [Prisma.sql`${bucketSql(bucket)} AS bucket`] : []),
          Prisma.sql`${LEFT_OUT} AS left_out`,
          Prisma.sql`${UNFINISHED} AS unfinished`,
          Prisma.sql`${AWAITING} AS awaiting`,
          ...asked.flatMap(([, number]) => number.columns),
        ],
        ", ",
      )}
      ${listed} AND ${filters}
    ),
    grouped AS (
      SELECT ${Prisma.join(
        [
          ...cellNames,
          Prisma.sql`count(*) FILTER (WHERE ${covered})::int AS shots`,
          Prisma.sql`count(*) FILTER (WHERE NOT shot.left_out AND shot.unfinished)::int AS unfinished`,
          Prisma.sql`count(*) FILTER (WHERE shot.left_out)::int AS "leftOut"`,
          Prisma.sql`count(*) FILTER (WHERE ${covered} AND shot.awaiting)::int AS awaiting`,
          ...asked.flatMap(([, number]) => number.aggregates(covered)),
          ...(steps ? [Prisma.sql`${cellKey} AS cell_key`] : []),
          ...(bucket ? [Prisma.sql`${groupKey} AS group_key`] : []),
        ],
        ", ",
      )}
      FROM shot ${groupedBy(cellNames)}
    ),
    ${
      // The groups themselves, which the page counts: one even where no Shot is found, without a grouping, as an
      // aggregate without one gives.
      bucket ? Prisma.sql`groups AS (SELECT ${Prisma.join([...keyNames, Prisma.sql`${groupKey} AS group_key`, Prisma.sql`count(*) AS found`], ", ")} FROM shot ${groupedBy(keyNames)}),` : Prisma.empty
    }
    ${
      steps
        ? Prisma.sql`ended AS (
      SELECT ${cellKey} AS cell_key, shot."stepFrame" AS frame, shot."stepName" AS name, count(*)::int AS shots,
        row_number() OVER (PARTITION BY ${cellKey} ORDER BY count(*) DESC, shot."stepFrame", shot."stepName") AS rank
      FROM shot WHERE ${covered} AND shot."stepFrame" IS NOT NULL
      GROUP BY 1, 2, 3
    ),
    steps AS (
      SELECT ended.cell_key, json_agg(json_build_object('frame', ended.frame, 'name', ended.name, 'shots', ended.shots) ORDER BY ended.rank) AS "lastSteps"
      FROM ended WHERE ended.rank <= ${LAST_STEPS} GROUP BY ended.cell_key
    ),`
        : Prisma.empty
    }
    page AS (
      SELECT g.*, json_build_object(${joined(by, ", ")}) AS by, row_number() OVER (${order.length > 0 ? Prisma.sql`ORDER BY ${Prisma.join(order, ", ")}` : Prisma.empty}) AS position
        ${referenceShotId ? Prisma.sql`, ${referenceShotId} AS reference_shot_id` : Prisma.empty}
      FROM ${bucket ? Prisma.sql`groups` : Prisma.sql`grouped`} g ${joined(joins, " ")}
      ORDER BY position LIMIT ${page.limit} OFFSET ${page.offset}
    )${
      // Each group on the page's buckets, oldest first, that of the Shots whose time is unknown last: each as its row.
      bucket
        ? Prisma.sql`,
    bucketed AS (
      SELECT cell.group_key, json_agg(${steps ? Prisma.sql`to_jsonb(cell) || jsonb_build_object('lastSteps', steps."lastSteps")` : Prisma.sql`to_jsonb(cell)`} ORDER BY cell.bucket NULLS LAST) AS buckets
      FROM grouped cell ${steps ? Prisma.sql`LEFT JOIN steps ON steps.cell_key = cell.cell_key` : Prisma.empty}
      WHERE cell.group_key IN (SELECT page.group_key FROM page)
      GROUP BY cell.group_key
    )`
        : Prisma.empty
    }
    SELECT (SELECT count(*)::int FROM ${bucket ? Prisma.sql`groups` : Prisma.sql`grouped`}) AS total, page.*
      ${bucket ? Prisma.sql`, bucketed.buckets` : steps ? Prisma.sql`, steps."lastSteps"` : Prisma.empty}
      ${referenceShotId ? Prisma.sql`, CASE WHEN reference_shot.id IS NOT NULL THEN to_json(reference_shot) END AS reference` : Prisma.empty}
    FROM (SELECT 1) AS whole LEFT JOIN page ON TRUE
    ${bucket ? Prisma.sql`LEFT JOIN bucketed ON bucketed.group_key = page.group_key` : steps ? Prisma.sql`LEFT JOIN steps ON steps.cell_key = page.cell_key` : Prisma.empty}
    ${
      // Read for the groups on the page alone, each by its id.
      referenceShotId
        ? Prisma.sql`LEFT JOIN LATERAL (
      SELECT ${Prisma.join([Prisma.sql`s.id`, ...asked.flatMap(([, number]) => number.columns)], ", ")}
      FROM shots s WHERE s.id = page.reference_shot_id AND ${shotListedSql("s")}
    ) AS reference_shot ON TRUE`
        : Prisma.empty
    }
    ORDER BY page.position`;
  /** What the Shots of a row have in common: a group's, or a bucket's, which is a group's row as JSON. */
  const figuresOf = (row: Record<string, unknown>): SummaryFigures => {
    const shots = row.shots as number;
    return {
      counts: { shots, unfinished: row.unfinished as number, cleaningAndCalibration: row.leftOut as number, awaitingValues: row.awaiting as number },
      numbers: Object.fromEntries(asked.map(([name, number]) => [name, number.read(row, shots)])) as Partial<SummaryNumbers>,
    };
  };
  return {
    groups: rows.flatMap((row): (SummaryGroup | BucketedGroup)[] => {
      if (row.by === null) return [];
      const by = row.by as GroupedBy;
      const own = (row.reference ?? null) as Record<string, unknown> | null;
      const reference = own && { reference: { id: own.id as string, numbers: Object.fromEntries(asked.map(([name, number]) => [name, number.own(own)])) as Partial<ShotNumbers> } };
      if (!bucket) return [{ by, ...figuresOf(row), ...reference }];
      // A group with no Shots, the one group of no grouping, has no bucket.
      const cells = (row.buckets ?? []) as Record<string, unknown>[];
      // The reference before the buckets, which may be many.
      return [{ by, ...reference, buckets: cells.map((cell) => ({ start: cell.bucket as string | null, ...figuresOf(cell) })) }];
    }),
    total: rows[0]!.total as number,
    limit: page.limit,
    offset: page.offset,
  };
}
