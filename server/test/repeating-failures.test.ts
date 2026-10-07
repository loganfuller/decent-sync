import { describe, expect, it } from "vitest";
import { Prisma } from "../src/generated/prisma/client.js";
import { repeatingFailure } from "../src/set-aside-deliveries/repeating-failures.js";

// Which storage failures set a delivery aside (ticket #60), from errors shaped
// as Prisma 7's client and its pg driver adapter throw them: a known request
// error whose meta holds the adapter's error, whose cause holds PostgreSQL's
// SQLSTATE and message for a database error. set-aside-deliveries.test.ts
// sees the real ones through Seam 1.

/** A known request error for a database error with this SQLSTATE, or with none, as for a lost connection. */
function knownRequestError(code: string, cause: Record<string, unknown>): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Database error", {
    code,
    clientVersion: Prisma.prismaVersion.client,
    meta: { driverAdapterError: Object.assign(new Error("DriverAdapterError"), { name: "DriverAdapterError", cause }) },
  });
}
const databaseError = (sqlState: string, message = "PostgreSQL's message") =>
  knownRequestError("P2010", { originalCode: sqlState, originalMessage: message, kind: "postgres" });

describe("repeatingFailure", () => {
  it("is PostgreSQL's SQLSTATE and message for a data exception, a check violation or a limit exceeded", () => {
    for (const sqlState of ["22P05", "22021", "22P02", "22001", "22003", "22008", "22000", "23514", "54000"]) {
      expect(repeatingFailure(databaseError(sqlState, `message ${sqlState}`))).toEqual({ sqlState, message: `message ${sqlState}` });
    }
  });

  it("is read whatever Prisma code wraps the database error", () => {
    for (const code of ["P2010", "P2039", "P2007"]) {
      const error = knownRequestError(code, { originalCode: "22P05", originalMessage: "unsupported Unicode escape sequence", kind: "postgres" });
      expect(repeatingFailure(error)).toEqual({ sqlState: "22P05", message: "unsupported Unicode escape sequence" });
    }
  });

  it("falls back to Prisma's message when PostgreSQL's is missing", () => {
    const error = knownRequestError("P2039", { originalCode: "54000", kind: "postgres" });
    expect(repeatingFailure(error)).toEqual({ sqlState: "54000", message: "Database error" });
  });

  it("is null for database errors storing again may not meet", () => {
    // Deadlocks and serialization failures, lock and statement timeouts, lost and refused connections,
    // too many connections, an idle transaction ended, and other constraint and limit errors.
    for (const sqlState of ["40P01", "40001", "55P03", "57014", "57P01", "08006", "08003", "53300", "25P03", "23505", "23503", "54001", "XX000"]) {
      expect(repeatingFailure(databaseError(sqlState)), sqlState).toBeNull();
    }
  });

  it("is null for errors with no SQLSTATE: a socket error, a transaction timeout, or one that is not the database's", () => {
    expect(repeatingFailure(knownRequestError("P1017", { kind: "ConnectionClosed" }))).toBeNull();
    expect(repeatingFailure(new Prisma.PrismaClientKnownRequestError("Transaction already closed", { code: "P2028", clientVersion: Prisma.prismaVersion.client }))).toBeNull();
    expect(repeatingFailure(new Prisma.PrismaClientUnknownRequestError("Unknown", { clientVersion: Prisma.prismaVersion.client }))).toBeNull();
    // As extraction code would throw.
    expect(repeatingFailure(new TypeError("Cannot read properties of undefined"))).toBeNull();
    // The adapter's own error, not wrapped by Prisma.
    expect(repeatingFailure(Object.assign(new Error("DriverAdapterError"), { cause: { originalCode: "22P05" } }))).toBeNull();
    expect(repeatingFailure("22P05")).toBeNull();
  });
});
