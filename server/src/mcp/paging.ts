import * as z from "zod";

// How a tool's list pages (#405): as the REST API's lists do, by `limit` and
// `offset`, with at most 50 entries a page, saying how many match and whether
// more follow this page.

/** At most this many entries a page, as #405 sets for every list through the endpoint. */
export const MAX_PAGE = 50;

/** A list's paging inputs, to spread into its input schema. */
export const page = {
  limit: z.number().int().min(1).max(MAX_PAGE).default(20).describe(`How many to list, from 1 to ${MAX_PAGE}.`),
  offset: z.number().int().min(0).max(1 << 30).default(0).describe("How many to skip, newest first: the previous page's offset plus its length."),
};

/** What a list's page says of the rest, to spread into its output schema. */
export const pageOutput = {
  total: z.number().int().describe("How many match."),
  offset: z.number().int(),
  more: z.boolean().describe("Whether more match after this page."),
};

/** What a page of `length` entries at `offset` of `total` says of the rest. */
export function pageOf(total: number, offset: number, length: number): { total: number; offset: number; more: boolean } {
  return { total, offset, more: offset + length < total };
}
