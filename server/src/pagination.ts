import { BadRequestException } from "@nestjs/common";

/** A page of a list, from a request's `limit` (1 to 100, 20 if absent) and `offset` (0 if absent). */
export interface Page {
  limit: number;
  offset: number;
}

export function readPage(limit: string | undefined, offset: string | undefined): Page {
  return { limit: integer(limit, 20, 1, 100), offset: integer(offset, 0, 0, 1 << 30) };
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new BadRequestException(`Pagination must be a whole number between ${min} and ${max}`);
  }
  return parsed;
}
