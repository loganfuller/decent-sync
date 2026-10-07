import { Prisma } from "../generated/prisma/client.js";

/** Why storing a delivery failed, as PostgreSQL reported it. */
export interface StorageFailure {
  /** PostgreSQL's error code (SQLSTATE), such as 22P05. */
  sqlState: string;
  message: string;
}

/** Class 22 (data exception), 23514 (check violation) and 54000 (program limit exceeded). */
const REPEATING = /^(?:22[0-9A-Z]{3}|23514|54000)$/;

/**
 * The failure, if storing a delivery failed in a way that would repeat
 * whenever the same delivery was stored again: PostgreSQL refused a value in
 * it as data it cannot hold (class 22, such as a NUL or a lone surrogate in a
 * string), as breaking a check constraint (23514), or as past one of its
 * limits (54000, such as an index entry too large). Null for any other
 * failure, which storing it again may not meet: a lost connection, a lock or
 * transaction timeout, a deadlock or serialization failure, a socket error,
 * an error with no SQLSTATE, or one that is not the database's. The SQLSTATE
 * is read from the cause Prisma's driver adapter gives a known request error.
 */
export function repeatingFailure(error: unknown): StorageFailure | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  const adapterError = error.meta?.driverAdapterError as { cause?: { originalCode?: unknown; originalMessage?: unknown } } | undefined;
  const sqlState = adapterError?.cause?.originalCode;
  if (typeof sqlState !== "string" || !REPEATING.test(sqlState)) return null;
  const message = adapterError?.cause?.originalMessage;
  return { sqlState, message: typeof message === "string" ? message : error.message };
}
