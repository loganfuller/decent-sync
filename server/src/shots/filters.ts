import { BadRequestException } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { type RecordFilters, queryValue, readRecordFilters, recordFilterSql } from "../record-filters.js";

/**
 * What a Shots list is narrowed to: the filters every record list has, and
 * what the Shot recorded. Each text filter is an exact match on what the Shot
 * recorded, or, when empty, matches Shots that recorded none.
 */
export interface ShotFilters extends RecordFilters {
  coffeeRoaster?: string;
  coffeeName?: string;
  barista?: string;
  profileTitle?: string;
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
  return Prisma.join(conditions, " AND ");
}
