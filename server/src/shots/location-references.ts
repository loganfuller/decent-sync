import { createHash } from "node:crypto";
import { MAX_REFERENCE_COPY_BYTES, type ReferenceCopy, type SkinRecipe, type SkinReference, type SkinReferenceShot, isGlobalId, utf8Length } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { recordedText } from "./extraction.js";
import { referenceProfileDiffers, shotListedSql, shotProfileSql, shotRecipeSql } from "./links.js";
import { type AskingTablet, referencesOf } from "./location-shots.js";

// The Reference Shots of a Location's Recipes as one of its tablets reads
// them for a Skin (ticket #510, ADR-0030, amending ADR-0029): the one a
// Recipe has, whole, and the copy the tablet keeps of it for each Recipe in
// a slot, so its Skin still draws it while the server can't be reached. A
// Reference Shot may be from any Machine or Location, so a tablet reads
// whole the Reference Shot of any Recipe of its Location, a Shot pulled at
// another Location included: this widens what a tablet reads of the
// Location's Shots (location-shots.ts) by exactly that. One the Shots list
// doesn't list, as a dismissed Pending Machine's, reads as none. Each takes
// the transaction of what it answers, so it reads what that saw.

/** Raised when what a copy holds changes shape, so every tablet's copies are sent again. */
const COPY_FORMAT = 1;

/**
 * What is read of a Recipe's reference before its Shot's record: enough to
 * tell whether a copy of it is the one a tablet holds (`version`), which a
 * look for copies due reads for each slot every time, without loading any
 * Shot's measurements.
 */
interface Head {
  recipe: SkinRecipe;
  slot: number | null;
  /** Its Reference Shot, where the Shots list lists it. */
  shot: { id: string; rating: number | null; note: string | null; profileDiffers: boolean; pulledWith: SkinRecipe | null; referenceOf: SkinRecipe[] } | null;
  /**
   * Names the reference as this tablet reads it: another once the Recipe's
   * name or record there changes, another Shot is chosen or none, the Shot
   * is stored anew, as when its rating or note changes (`version_at`), it is
   * hidden or shown, or its Profile comes to differ or match.
   */
  version: string;
}

interface HeadRow {
  id: string;
  name: string | null;
  recordId: string | null;
  slot: number | null;
  content: unknown;
  shotId: string | null;
  shotVersion: string | null;
  rating: number | null;
  note: unknown;
  shotProfile: string | null;
  withId: string | null;
  withName: string | null;
  withRecordId: string | null;
}

/** The references of the asking tablet's Location's Recipes that `which` holds of `recipes` aliased `r`, those in slots first, in slot order. */
async function heads(db: Prisma.TransactionClient, asking: AskingTablet, which: Prisma.Sql): Promise<Head[]> {
  const rows = await db.$queryRaw<HeadRow[]>`
    SELECT r.id::text AS id, r.content ->> 'name' AS name, held.local_id AS "recordId", r.slot, r.content,
      s.id AS "shotId", (extract(epoch FROM s.version_at) * 1000000)::bigint::text AS "shotVersion",
      s.enjoyment AS rating, s.record #> '{annotations,espressoNotes}' AS note, ${shotProfileSql("s")} AS "shotProfile",
      pulled.id::text AS "withId", pulled.content ->> 'name' AS "withName", pulled_held.local_id AS "withRecordId"
    FROM recipes AS r
    LEFT JOIN tablet_recipes AS held ON held.tablet_id = ${asking.tabletId}::uuid AND held.recipe_id = r.id
    LEFT JOIN shots AS s ON s.id = r.reference_shot_id AND ${shotListedSql("s")}
    LEFT JOIN recipes AS pulled ON pulled.id = ${shotRecipeSql("s")}
    LEFT JOIN tablet_recipes AS pulled_held ON pulled_held.tablet_id = ${asking.tabletId}::uuid AND pulled_held.recipe_id = pulled.id
    WHERE r.location_id = ${asking.locationId}::uuid AND ${which}
    ORDER BY r.slot NULLS LAST, r.id`;
  const referenceOf = await referencesOf(db, asking, rows.flatMap((row) => row.shotId ?? []));
  return rows.map((row) => {
    const recipe = { id: row.id, name: row.name, recordId: row.recordId };
    const shot =
      row.shotId === null
        ? null
        : {
            id: row.shotId,
            rating: row.rating,
            note: recordedText(row.note),
            profileDiffers: referenceProfileDiffers(row.content, row.shotProfile),
            pulledWith: row.withId === null ? null : { id: row.withId, name: row.withName, recordId: row.withRecordId },
            referenceOf: referenceOf.get(row.shotId) ?? [],
          };
    const version = createHash("sha256").update(JSON.stringify([COPY_FORMAT, recipe, shot, row.shotVersion])).digest("hex").slice(0, 32);
    return { recipe, slot: row.slot, shot, version };
  });
}

/** The reference a head names, whole: with its Shot's record and measurements, as stored, which is as Decaid sent them. */
async function whole(db: Prisma.TransactionClient, head: Head): Promise<SkinReference> {
  if (head.shot === null) return { recipe: head.recipe, reference: null };
  const { id, rating, note, profileDiffers, pulledWith, referenceOf } = head.shot;
  const [stored] = await db.$queryRaw<{ record: Record<string, unknown>; measurements: unknown }[]>`
    SELECT s.record, measured.data AS measurements FROM shots AS s LEFT JOIN shot_measurements AS measured ON measured.shot_id = s.id WHERE s.id = ${id}`;
  // Read in the snapshot that listed it.
  if (!stored) return { recipe: head.recipe, reference: null };
  const reference: SkinReferenceShot = { shot: { ...stored.record, measurements: stored.measurements }, recipe: pulledWith, referenceOf, rating, note, profileDiffers };
  return { recipe: head.recipe, reference };
}

/**
 * The Reference Shot of one of the Location's Recipes, Archived or not,
 * whole, or that it has none; or null for any other Recipe, whether or not
 * the Library holds it.
 */
export async function recipeReference(db: Prisma.TransactionClient, asking: AskingTablet, recipeId: string): Promise<SkinReference | null> {
  if (!isGlobalId(recipeId)) return null;
  const [head] = await heads(db, asking, Prisma.sql`r.id = ${recipeId}::uuid`);
  return head ? whole(db, head) : null;
}

/** What a tablet is to keep for a slot, as a `referenceCopy` carries it. */
export type DueCopy = Pick<ReferenceCopy, "slot" | "copy">;

/**
 * The copies a tablet is due, given the version it holds for each slot
 * (`held`): for each Recipe in a slot at the Location it is served at, its
 * reference where the tablet holds another version of it or none, and
 * nothing for each slot it holds a copy for that has no Recipe now; or, for
 * a tablet served nowhere (`asking` null), nothing for every slot it holds.
 * A reference whose JSON is longer than MAX_REFERENCE_COPY_BYTES is not
 * among what it keeps: its copy says so in its place. Only the references
 * that differ are read whole, one at a time.
 */
export async function referenceCopiesDue(db: Prisma.TransactionClient, asking: AskingTablet | null, held: ReadonlyMap<number, string>): Promise<DueCopy[]> {
  const slotted = asking ? await heads(db, asking, Prisma.sql`r.slot IS NOT NULL`) : [];
  const filled = new Set(slotted.map((head) => head.slot));
  const due: DueCopy[] = [...held.keys()].filter((slot) => !filled.has(slot)).map((slot) => ({ slot, copy: null }));
  for (const head of slotted) {
    if (head.slot === null || held.get(head.slot) === head.version) continue;
    const { recipe, reference } = await whole(db, head);
    const tooLarge = utf8Length(JSON.stringify({ recipe, reference })) > MAX_REFERENCE_COPY_BYTES;
    due.push({ slot: head.slot, copy: { version: head.version, recipe, ...(tooLarge ? { tooLarge } : { reference }) } });
  }
  return due;
}
