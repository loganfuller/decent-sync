import { BadRequestException } from "@nestjs/common";

/** A list's page, from its query: `limit`, 1–100 and 20 if not given, and `offset`, from 0. */
export function readPage(limit: string | undefined, offset: string | undefined): { limit: number; offset: number } {
  return { limit: integer(limit, 20, 1, 100), offset: integer(offset, 0, 0, 1 << 30) };
}

/** A list's page from its whole query; a repeated `limit` or `offset` is no whole number, so it is refused. */
export function readQueryPage(query: Record<string, unknown>): { limit: number; offset: number } {
  return readPage(single(query.limit), single(query.offset));
}

function single(value: unknown): string | undefined {
  if (value === undefined || typeof value === "string") return value;
  return String(value);
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new BadRequestException(`Pagination must be a whole number between ${min} and ${max}`);
  }
  return parsed;
}
