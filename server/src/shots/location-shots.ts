import { type SkinRecipe, type SkinShot, type SkinShotRow, type SkinShots, isRecordId } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { recordedText, shownDuration } from "./extraction.js";
import { shotListedSql, shotRecipeSql } from "./links.js";
import { LEFT_OUT, UNFINISHED } from "./summary.js";

// A Location's Shots as one of its tablets reads them for a Skin (ticket
// #509, ADR-0030): a page of them, newest first, and any one of them whole.
// They are the Shots the management interface's Shots list lists for that
// Location now: credited to it by Location History (`shots.location_id`),
// whichever Machine pulled them, a dismissed Pending Machine's left out
// (`shotListedSql`). So a Shot credited to another Location once its
// Machine's Location History is corrected leaves them, and a tablet reads
// whole only a Shot its list would list. Each takes the transaction of the
// request it answers (`SkinRequestsService`), so it reads what that saw.

/** The tablet asking, and the Location its Machine is at, whose Shots it reads. */
export interface AskingTablet {
  locationId: string;
  tabletId: string;
}

/** The Shots of `shots` aliased `s` that the asking tablet's list lists. */
function listedAt({ locationId }: AskingTablet): Prisma.Sql {
  return Prisma.sql`${shotListedSql("s")} AND s.location_id = ${locationId}::uuid`;
}

/**
 * Where a page ended: its last Shot's pull time, in ms, and id. A Shot
 * credited to a Location has a pull time, as its credit is by it
 * (`creditShotLocation`), and it never changes once its full record is
 * stored, so the next page starts just past it in the list's order, whatever
 * was pulled or left the list since.
 */
type Cursor = [pulledAt: number, id: string];

/** The times a cursor may hold: the years 1 to 9999, which PostgreSQL reads as `Date` writes them. */
const EARLIEST_MS = Date.parse("0001-01-01T00:00:00.000Z");
const LATEST_MS = Date.parse("9999-12-31T23:59:59.999Z");

function writeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

/** The cursor a page gave, or null for text that is none: whatever a Skin sent is read here. */
function readCursor(text: string): Cursor | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [pulledAt, id] = value as unknown[];
  if (typeof pulledAt !== "number" || !Number.isInteger(pulledAt) || pulledAt < EARLIEST_MS || pulledAt > LATEST_MS || !isRecordId(id)) return null;
  return [pulledAt, id];
}

/**
 * Whether the Shot of `shots` aliased `s` is one a Shot Summary counts as
 * unfinished: nothing poured, and it is no cleaning or calibration Shot,
 * which a summary counts as that whether it poured or not (summary.ts).
 */
const unfinished = Prisma.sql`(${UNFINISHED} AND NOT ${LEFT_OUT})`;

interface PageRow {
  id: string;
  pulledAt: Date;
  machineId: string;
  machineName: string;
  onThisTablet: boolean;
  recipeId: string | null;
  recipeName: string | null;
  recipeRecordId: string | null;
  roaster: string | null;
  name: string | null;
  dose: number | null;
  targetDose: number | null;
  yield: number | null;
  targetYield: number | null;
  duration: number | null;
  preheat: number | null;
  rating: number | null;
  barista: string | null;
  note: unknown;
  unfinished: boolean;
}

/**
 * A page of up to `limit` of the Location's Shots, newest first by when
 * they were pulled, then by id, as the Shots list orders them, after the
 * `cursor` the page before gave; or null for a cursor that is none. One
 * Shot more than the page is read, to say whether another page follows.
 */
export async function locationShots(db: Prisma.TransactionClient, asking: AskingTablet, limit: number, cursor: string | undefined): Promise<SkinShots | null> {
  const after = cursor === undefined ? undefined : readCursor(cursor);
  if (after === null) return null;
  // Bounded above, so the index on the Location and pulled_at starts at the cursor's Shot, as `previous` in shots.service.ts has it.
  const past = after
    ? Prisma.sql`AND s.pulled_at <= ${new Date(after[0])}::timestamptz AND (s.pulled_at < ${new Date(after[0])}::timestamptz OR s.id > ${after[1]})`
    : Prisma.empty;
  // The page is chosen first, so each Shot's Recipe is worked out for its Shots alone.
  const rows = await db.$queryRaw<PageRow[]>`
    WITH page AS MATERIALIZED (
      SELECT s.id, s.pulled_at, s.machine_id, s.tablet_id, ${shotRecipeSql("s")} AS linked_recipe_id,
        s.coffee_roaster, s.coffee_name, s.actual_dose, s.target_dose, s.actual_yield, s.target_yield, s.duration, s.preheat,
        s.enjoyment, s.barista, s.record #> '{annotations,espressoNotes}' AS note, ${unfinished} AS unfinished
      FROM shots AS s WHERE ${listedAt(asking)} ${past}
      ORDER BY s.pulled_at DESC NULLS LAST, s.id ASC LIMIT ${limit + 1}
    )
    SELECT page.id, page.pulled_at AS "pulledAt", m.id::text AS "machineId", m.name AS "machineName",
      coalesce(page.tablet_id = ${asking.tabletId}::uuid, false) AS "onThisTablet",
      r.id::text AS "recipeId", r.content ->> 'name' AS "recipeName", held.local_id AS "recipeRecordId",
      page.coffee_roaster AS roaster, page.coffee_name AS name, page.actual_dose AS dose, page.target_dose AS "targetDose",
      page.actual_yield AS yield, page.target_yield AS "targetYield", page.duration, page.preheat,
      page.enjoyment AS rating, page.barista, page.note, page.unfinished
    FROM page JOIN machines AS m ON m.id = page.machine_id
    LEFT JOIN recipes AS r ON r.id = page.linked_recipe_id
    LEFT JOIN tablet_recipes AS held ON held.tablet_id = ${asking.tabletId}::uuid AND held.recipe_id = r.id
    ORDER BY page.pulled_at DESC NULLS LAST, page.id ASC`;
  const page = rows.slice(0, limit);
  const referenceOf = await referencesOf(db, asking, page.map((row) => row.id));
  const last = page.at(-1);
  return {
    shots: page.map(
      (row): SkinShotRow => ({
        id: row.id,
        pulledAt: row.pulledAt.toISOString(),
        machine: { id: row.machineId, name: row.machineName },
        onThisTablet: row.onThisTablet,
        recipe: row.recipeId === null ? null : { id: row.recipeId, name: row.recipeName, recordId: row.recipeRecordId },
        bean: { roaster: row.roaster, name: row.name },
        dose: row.dose,
        targetDose: row.targetDose,
        yield: row.yield,
        targetYield: row.targetYield,
        duration: shownDuration(row.duration, row.preheat),
        rating: row.rating,
        barista: row.barista,
        hasNote: recordedText(row.note) !== null,
        unfinished: row.unfinished,
        referenceOf: referenceOf.get(row.id) ?? [],
      }),
    ),
    nextCursor: rows.length > limit && last ? writeCursor([last.pulledAt.getTime(), last.id]) : null,
  };
}

/**
 * One of the Location's Shots whole: its record with its measurements, as
 * stored, which is as Decaid sent them, so a Skin draws it as it draws its
 * tablet's own; or null for any other, whether or not the server holds it.
 */
export async function locationShot(db: Prisma.TransactionClient, asking: AskingTablet, shotId: string): Promise<SkinShot | null> {
  if (!isRecordId(shotId)) return null;
  const [found] = await db.$queryRaw<{ record: Record<string, unknown>; measurements: unknown; recipeId: string | null; recipeName: string | null; recipeRecordId: string | null }[]>`
    SELECT s.record, measured.data AS measurements, r.id::text AS "recipeId", r.content ->> 'name' AS "recipeName", held.local_id AS "recipeRecordId"
    FROM shots AS s LEFT JOIN shot_measurements AS measured ON measured.shot_id = s.id
    LEFT JOIN recipes AS r ON r.id = ${shotRecipeSql("s")}
    LEFT JOIN tablet_recipes AS held ON held.tablet_id = ${asking.tabletId}::uuid AND held.recipe_id = r.id
    WHERE s.id = ${shotId} AND ${listedAt(asking)}`;
  if (!found) return null;
  return {
    shot: { ...found.record, measurements: found.measurements },
    recipe: found.recipeId === null ? null : { id: found.recipeId, name: found.recipeName, recordId: found.recipeRecordId },
    referenceOf: (await referencesOf(db, asking, [shotId])).get(shotId) ?? [],
  };
}

/**
 * The Recipes each of the Shots is the Reference Shot of (ADR-0029), by the
 * Shot's id: those of the asking tablet's Location that are not Archived,
 * which are the ones its tablets hold, by name, ignoring case. Another
 * Location's Recipe is not named to this one's tablets.
 */
export async function referencesOf(db: Prisma.TransactionClient, asking: AskingTablet, shotIds: string[]): Promise<Map<string, SkinRecipe[]>> {
  const references = new Map<string, SkinRecipe[]>();
  if (shotIds.length === 0) return references;
  const recipes = await db.$queryRaw<(SkinRecipe & { shotId: string })[]>`
    SELECT r.reference_shot_id AS "shotId", r.id::text AS id, r.content ->> 'name' AS name, held.local_id AS "recordId"
    FROM recipes AS r LEFT JOIN tablet_recipes AS held ON held.tablet_id = ${asking.tabletId}::uuid AND held.recipe_id = r.id
    WHERE r.reference_shot_id = ANY(${shotIds}::text[]) AND r.location_id = ${asking.locationId}::uuid AND NOT r.archived
    ORDER BY lower(r.content ->> 'name') NULLS LAST, r.id`;
  for (const { shotId, ...recipe } of recipes) references.set(shotId, [...(references.get(shotId) ?? []), recipe]);
  return references;
}
