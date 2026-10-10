import { BadRequestException } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { readBeanBatchId } from "../library/bean-batches.service.js";
import { readBeanId } from "../library/beans.service.js";
import { readGrinderId } from "../library/grinders.service.js";
import { readProfileId } from "../library/profiles.service.js";
import { type RecordFilters, queryValue, readRecordFilters, recordFilterSql } from "../record-filters.js";
import { shotPulledWithSql } from "./links.js";

/**
 * What a Shots list is narrowed to: the filters every record list has, what
 * the Shot recorded, and the Library items it is linked to (links.ts). Each
 * text filter is an exact match on what the Shot recorded, or, when empty,
 * matches Shots that recorded none.
 */
export interface ShotFilters extends RecordFilters {
  coffeeRoaster?: string;
  coffeeName?: string;
  barista?: string;
  profileTitle?: string;
  /** A Bean Batch's id, or null for Shots linked to none. */
  beanBatchId?: string | null;
  /** A Grinder's id, or null for Shots linked to none. */
  grinderId?: string | null;
  /** A Bean's id: Shots linked to any of its batches. */
  beanId?: string;
  /** A Library Profile's id, which is Decaid's: Shots pulled with it (`shotProfileSql`). */
  profileId?: string;
}

const TEXT_FILTERS = ["coffeeRoaster", "coffeeName", "barista", "profileTitle"] as const;
const MAX_TEXT_LENGTH = 500;

/** Reads a Shots list's filters from its query; `readRecordFilters` reads those every record list has. */
export function readShotFilters(query: Record<string, unknown>): ShotFilters {
  const problems: string[] = [];
  const filters: ShotFilters = readRecordFilters(query, problems);
  for (const name of TEXT_FILTERS) {
    const text = queryValue(query, name, problems);
    if (text === undefined) continue;
    if (text.length > MAX_TEXT_LENGTH) problems.push(`Use a ${name} of at most ${MAX_TEXT_LENGTH} characters`);
    else filters[name] = text;
  }
  // A malformed id names nothing, as in a path.
  const beanBatchId = queryValue(query, "beanBatchId", problems);
  if (beanBatchId !== undefined) filters.beanBatchId = beanBatchId === "none" ? null : readBeanBatchId(beanBatchId);
  const grinderId = queryValue(query, "grinderId", problems);
  if (grinderId !== undefined) filters.grinderId = grinderId === "none" ? null : readGrinderId(grinderId);
  const beanId = queryValue(query, "beanId", problems);
  if (beanId !== undefined) filters.beanId = readBeanId(beanId);
  const profileId = queryValue(query, "profileId", problems);
  if (profileId !== undefined) filters.profileId = readProfileId(profileId);
  if (problems.length > 0) throw new BadRequestException(problems);
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
    const field = Prisma.raw(`s.${column}`);
    conditions.push(text === "" ? Prisma.sql`nullif(${field}, '') IS NULL` : Prisma.sql`${field} = ${text}`);
  }
  for (const [name, column] of [
    ["beanBatchId", "library_batch_id"],
    ["grinderId", "library_grinder_id"],
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
  return Prisma.join(conditions, " AND ");
}
