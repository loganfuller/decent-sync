import { BadRequestException } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { readBeanBatchId } from "../library/bean-batches.service.js";
import { readBeanId } from "../library/beans.service.js";
import { readEquipmentId } from "../library/equipment.service.js";
import { readGrinderId } from "../library/grinders.service.js";
import { readProfileId } from "../library/profiles.service.js";
import { readRecipeId } from "../library/recipes.service.js";
import { type RecordFilters, queryValue, readRecordFilters, recordFilterSql } from "../record-filters.js";
import { shotPulledWithSql, shotRecipeSql } from "./links.js";

/**
 * What a Shots list is narrowed to: the filters every record list has, what
 * the Shot recorded, and the Library items it is linked to (links.ts). Each
 * text filter matches what the Shot recorded as `match` says, or, when
 * empty, matches Shots that recorded none.
 */
export interface ShotFilters extends RecordFilters {
  /**
   * How the text filters match: `exact`, the default, as the Shots page's
   * choices pass what Shots recorded; or `words`, as an assistant's
   * find_shots does, each word anywhere, ignoring case, as find_library_items
   * matches names, a filter of no words then matching Shots that recorded none.
   */
  match?: "exact" | "words";
  coffeeRoaster?: string;
  coffeeName?: string;
  barista?: string;
  profileTitle?: string;
  /** A Bean Batch's id, or null for Shots linked to none. */
  beanBatchId?: string | null;
  /** A Grinder's id, or null for Shots linked to none. */
  grinderId?: string | null;
  /** A Basket's id, or null for Shots linked to none. */
  basketId?: string | null;
  /** A Recipe's id: Shots pulled with it loaded (`shotRecipeSql`); or null for Shots linked to none. */
  recipeId?: string | null;
  /** A Bean's id: Shots linked to any of its batches. */
  beanId?: string;
  /** A Library Profile's id, which is Decaid's: Shots pulled with it (`shotProfileSql`). */
  profileId?: string;
}

const TEXT_FILTERS = ["coffeeRoaster", "coffeeName", "barista", "profileTitle"] as const;
const MAX_TEXT_LENGTH = 500;
/** The most words a text filter matched by words holds: each is a search of every Shot's text, which hundreds would make take seconds. */
export const MAX_WORDS = 20;

/** Reads a Shots list's filters from its query; `readRecordFilters` reads those every record list has. */
export function readShotFilters(query: Record<string, unknown>): ShotFilters {
  const problems: string[] = [];
  const filters: ShotFilters = readRecordFilters(query, problems);
  const match = queryValue(query, "match", problems);
  if (match === "exact" || match === "words") filters.match = match;
  else if (match !== undefined) problems.push("Enter match as exact or words");
  for (const name of TEXT_FILTERS) {
    const text = queryValue(query, name, problems);
    if (text === undefined) continue;
    if (text.length > MAX_TEXT_LENGTH) problems.push(`Use a ${name} of at most ${MAX_TEXT_LENGTH} characters`);
    // Worded alike for every text filter, as an assistant's find_shots names two of them its own way. PostgreSQL's
    // text holds no NUL, so no Shot recorded one, and a query holding one fails.
    else if (text.includes("\0")) problems.push("Use text filters without NUL characters");
    else if (filters.match === "words" && wordsOf(text).length > MAX_WORDS) problems.push(`Use at most ${MAX_WORDS} words in each text filter`);
    else filters[name] = text;
  }
  // A malformed id names nothing, as in a path.
  const beanBatchId = queryValue(query, "beanBatchId", problems);
  if (beanBatchId !== undefined) filters.beanBatchId = beanBatchId === "none" ? null : readBeanBatchId(beanBatchId);
  const grinderId = queryValue(query, "grinderId", problems);
  if (grinderId !== undefined) filters.grinderId = grinderId === "none" ? null : readGrinderId(grinderId);
  const basketId = queryValue(query, "basketId", problems);
  if (basketId !== undefined) filters.basketId = basketId === "none" ? null : readEquipmentId("basket", basketId);
  const recipeId = queryValue(query, "recipeId", problems);
  if (recipeId !== undefined) filters.recipeId = recipeId === "none" ? null : readRecipeId(recipeId);
  const beanId = queryValue(query, "beanId", problems);
  if (beanId !== undefined) filters.beanId = readBeanId(beanId);
  const profileId = queryValue(query, "profileId", problems);
  if (profileId !== undefined) filters.profileId = readProfileId(profileId);
  if (problems.length > 0) throw new BadRequestException([...new Set(problems)]);
  return filters;
}

/**
 * The conditions for the filters, on `shots` aliased `s` joined to its
 * Location as `l`. Times are read as `recordFilterSql` reads them, on the
 * Shot's pulled-at time; a Shot whose time is unknown matches no time.
 */
export function shotFilterSql(filters: ShotFilters): Prisma.Sql {
  const conditions = [recordFilterSql(filters, "s", "pulled_at")];
  for (const [name, column] of [
    ["coffeeRoaster", "coffee_roaster"],
    ["coffeeName", "coffee_name"],
    ["barista", "barista"],
    ["profileTitle", "profile_title"],
  ] as const) {
    const text = filters[name];
    if (text === undefined) continue;
    conditions.push(textSql(Prisma.raw(`s.${column}`), text, filters.match ?? "exact"));
  }
  for (const [name, column] of [
    ["beanBatchId", "library_batch_id"],
    ["grinderId", "library_grinder_id"],
    ["basketId", "library_basket_id"],
  ] as const) {
    const id = filters[name];
    if (id === undefined) continue;
    const field = Prisma.raw(`s.${column}`);
    conditions.push(id === null ? Prisma.sql`${field} IS NULL` : Prisma.sql`${field} = ${id}::uuid`);
  }
  if (filters.beanId !== undefined) {
    conditions.push(Prisma.sql`s.library_batch_id IN (SELECT id FROM bean_batches WHERE bean_id = ${filters.beanId}::uuid)`);
  }
  if (filters.profileId !== undefined) conditions.push(shotPulledWithSql("s", filters.profileId));
  if (filters.recipeId === null) conditions.push(Prisma.sql`${shotRecipeSql("s")} IS NULL`);
  else if (filters.recipeId !== undefined) conditions.push(Prisma.sql`s.recipe_id = ${filters.recipeId}::uuid AND ${shotRecipeSql("s")} IS NOT NULL`);
  return Prisma.join(conditions, " AND ");
}

/** The condition a text filter makes on what Shots recorded in `field`, matching as `match` says (`ShotFilters.match`). */
function textSql(field: Prisma.Sql, text: string, match: "exact" | "words"): Prisma.Sql {
  const words = wordsOf(text);
  if (text === "" || (match === "words" && words.length === 0)) return Prisma.sql`nullif(${field}, '') IS NULL`;
  if (match === "exact") return Prisma.sql`${field} = ${text}`;
  return Prisma.join(words.map((word) => Prisma.sql`strpos(lower(${field}), lower(${word})) > 0`), " AND ");
}

/** A text filter's words, as matching by words reads them: split at whitespace. */
function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter((word) => word !== "");
}
