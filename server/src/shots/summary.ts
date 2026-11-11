import { BadRequestException } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { queryValue } from "../record-filters.js";
import { BLANK, baristaKeySql, baristaNamesSql } from "./filters.js";
import { shotRecipeSql } from "./links.js";

// A Shot Summary (#466, #468; #465, The numbers, Groupings): what the Shots
// a list's filters find have in common, by group, worked out as it is read,
// in one statement, from each Shot's columns and its record. Nothing is
// stored for it, so a Shot edit shows in the next one.

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

/** What a set of Shots have in common. */
export interface SummaryGroup {
  by: GroupedBy;
  counts: {
    /** The Shots its numbers cover. */
    shots: number;
    /** The Shots left out of them, as cleaning or calibration (`LEFT_OUT`). With `shots`, the Shots list's total for the same filters and the group's. */
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

/**
 * A Shot Summary: a page of its groups, in their order, with how many
 * groups there are, as a list gives its page. Without a grouping it is one
 * group, every Shot the filters find, there even where they find none; with
 * one, a group is there only for Shots found.
 */
export interface ShotSummary {
  groups: SummaryGroup[];
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
 * The most a yield or target may be, in grams, to have a yield against
 * target: a record may hold any number, and the difference of two beyond
 * this fits no float8, which would fail the whole summary.
 */
const MAX_GRAMS = 1e307;

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
      return itemSql("recipe", shotRecipeSql("s"), "recipes", "name", true);
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

interface SummaryRow {
  total: number;
  /** Null where the page holds no group. */
  by: GroupedBy | null;
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
 * The summary of the Shots `listed` and `filters` find together: `listed`
 * the rest of a query of every listed Shot from its `FROM` on, over `shots`
 * aliased `s` joined to its Location as `l`, and `filters` the conditions
 * that narrow them, as the Shots list's own, so the two count the same
 * Shots. They are grouped by `groupBy`, a group for each value the Shots
 * found have, or, without a grouping, as one group; the groups are ordered
 * by the first grouping, then the second, each by name, ignoring case, then
 * by id, with its group of Shots with none last, and `page` takes that many
 * groups of them.
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
): Promise<ShotSummary> {
  const groupings = groupBy.map((grouping) => groupingSql(grouping, listed));
  const keys = groupings.flatMap((grouping) => Object.entries(grouping.keys));
  const named = groupings.flatMap((grouping) => (grouping.named ? [Prisma.sql`${grouping.named},`] : []));
  const joins = groupings.flatMap((grouping) => (grouping.joins ? [grouping.joins] : []));
  const by = groupings.flatMap((grouping) => Object.entries(grouping.by).map(([name, value]) => Prisma.sql`${Prisma.raw(`'${name}'`)}, ${value}`));
  const order = groupings.map((grouping) => grouping.order);
  const keyNames = keys.map(([name]) => Prisma.raw(`shot.${name}`));
  const covered = Prisma.sql`FILTER (WHERE NOT shot.left_out)`;
  const quartiles = (number: string) => Prisma.sql`percentile_cont(ARRAY[0.25, 0.5, 0.75]) WITHIN GROUP (ORDER BY shot.${Prisma.raw(number)}) ${covered}`;
  const rows = await db.$queryRaw<SummaryRow[]>`
    WITH ${joined(named, " ")} shot AS MATERIALIZED (
      SELECT ${Prisma.join([...keys.map(([name, value]) => Prisma.sql`${value} AS ${Prisma.raw(name)}`), Prisma.sql`${LEFT_OUT} AS left_out`], ", ")},
        CASE WHEN s.target_yield <> 0 AND greatest(abs(s.actual_yield), abs(s.target_yield)) < ${MAX_GRAMS}::float8
          THEN (s.actual_yield::numeric - s.target_yield::numeric)::float8 END AS yield_against_target,
        round((s.duration - coalesce(s.preheat, 0))::numeric, 3)::float8 AS duration,
        nullif(btrim(s.record ->> 'stopReason', ${BLANK}), '') AS stop_reason
      ${listed} AND ${filters}
    ),
    grouped AS (
      SELECT ${Prisma.join([...keyNames, Prisma.sql`count(*) ${covered}::int AS shots`], ", ")},
        count(*) FILTER (WHERE shot.left_out)::int AS "leftOut",
        count(shot.yield_against_target) ${covered}::int AS "yieldShots",
        ${quartiles("yield_against_target")} AS "yieldQuartiles",
        count(shot.duration) ${covered}::int AS "durationShots",
        ${quartiles("duration")} AS "durationQuartiles",
        count(shot.stop_reason) ${covered}::int AS "stopShots",
        count(*) FILTER (WHERE NOT shot.left_out AND shot.stop_reason = 'targetWeight')::int AS "stoppedOnWeight"
      FROM shot ${keyNames.length > 0 ? Prisma.sql`GROUP BY ${Prisma.join(keyNames, ", ")}` : Prisma.empty}
    ),
    page AS (
      SELECT g.*, json_build_object(${joined(by, ", ")}) AS by, row_number() OVER (${order.length > 0 ? Prisma.sql`ORDER BY ${Prisma.join(order, ", ")}` : Prisma.empty}) AS position
      FROM grouped g ${joined(joins, " ")}
      ORDER BY position LIMIT ${page.limit} OFFSET ${page.offset}
    )
    SELECT (SELECT count(*)::int FROM grouped) AS total, page.*
    FROM (SELECT 1) AS whole LEFT JOIN page ON TRUE
    ORDER BY page.position`;
  const number = (shots: number, quartiles: number[] | null): SummaryNumber => ({
    shots,
    median: quartiles?.[1] ?? null,
    p25: quartiles?.[0] ?? null,
    p75: quartiles?.[2] ?? null,
  });
  return {
    groups: rows.flatMap((row) =>
      row.by === null
        ? []
        : [
            {
              by: row.by,
              counts: { shots: row.shots, cleaningAndCalibration: row.leftOut },
              numbers: {
                yieldAgainstTarget: number(row.yieldShots, row.yieldQuartiles),
                duration: number(row.durationShots, row.durationQuartiles),
                stoppedOnWeight: { shots: row.stopShots, share: row.stopShots === 0 ? null : row.stoppedOnWeight / row.stopShots },
              },
            },
          ],
    ),
    total: rows[0]!.total,
    limit: page.limit,
    offset: page.offset,
  };
}
