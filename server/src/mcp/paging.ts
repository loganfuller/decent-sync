import * as z from "zod";

// How a tool's list pages (#405): as the REST API's lists do, by `limit` and
// `offset`, with at most 50 entries a page, saying whether more follow.

/** The largest page a tool gives. */
export const MOST_A_PAGE = 50;

/** A tool's paging inputs, to spread into its input schema. */
export const pageInput = {
  limit: z.number().int().min(1).max(MOST_A_PAGE).optional().describe(`How many to give, 1 to ${MOST_A_PAGE}; 20 if none.`),
  offset: z
    .number()
    .int()
    .min(0)
    .max(2 ** 30)
    .optional()
    .describe("How many to skip, from the first; none if none."),
};

/** The page a tool's inputs ask for. */
export function pageOf(input: { limit?: number; offset?: number }): { limit: number; offset: number } {
  return { limit: input.limit ?? 20, offset: input.offset ?? 0 };
}
