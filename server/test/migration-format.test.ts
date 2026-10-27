import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Every migration after the latest at v1.2.0 is written in one of two forms,
// so that it waits a few seconds at most for a lock the running release holds
// and then gives up whole (ADR-0025; docs/AI_STORAGE_NOTES.md, Writing a
// migration). Prisma 7.4 and later run a file's statements one at a time when
// they can parse it, so a file is atomic only as an explicit transaction.

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../prisma/migrations");
const LATEST_AT_1_2_0 = "20261025200000_wake_schedule_edits";

/**
 * Comments, strings, quoted identifiers and dollar-quoted bodies, matched from
 * the left, so that each hides what looks like another inside it.
 */
const LEXEMES = /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|\$(\w*)\$[\s\S]*?\$\1\$/g;

/** The form a migration's SQL is written in, or undefined if neither. */
function migrationForm(sql: string): "transaction" | "concurrent index" | undefined {
  const code = sql.replace(LEXEMES, (lexeme) => (/^(--|\/\*)/.test(lexeme) ? " " : lexeme)).replace(/\s+/g, " ").trim();
  const transaction = /^BEGIN; SET LOCAL lock_timeout = '5s'; (.+) COMMIT;$/.exec(code);
  if (transaction) {
    // Nothing in between ends the transaction, builds an index concurrently, which a transaction refuses, or changes the timeout.
    const statements = transaction[1]!.replace(LEXEMES, "''");
    return /(^|;)\s*(BEGIN|START|COMMIT|END|ROLLBACK|ABORT)\b/i.test(statements) || /\b(CONCURRENTLY|lock_timeout|RESET ALL)\b/i.test(statements)
      ? undefined
      : "transaction";
  }
  const index = /^SET lock_timeout = '5s'; DROP INDEX IF EXISTS ("[^"]+"); CREATE (?:UNIQUE )?INDEX CONCURRENTLY ("[^"]+") ON [^;]+;$/.exec(code);
  return index && index[1] === index[2] ? "concurrent index" : undefined;
}

describe("migrations", () => {
  it("after the latest at v1.2.0 are each one transaction setting lock_timeout, or a concurrent index build", () => {
    const names = fs.readdirSync(migrationsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    expect(names).toContain(LATEST_AT_1_2_0);
    const later = names.filter((name) => name > LATEST_AT_1_2_0);
    expect(later.length).toBeGreaterThan(0);
    for (const name of later) {
      expect(migrationForm(fs.readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8")), name).toBeDefined();
    }
  });

  it("are recognised in either form, with comments", () => {
    expect(migrationForm(`-- Why.\n\nBEGIN;\nSET LOCAL lock_timeout = '5s';\n\nALTER TABLE "shots" ADD COLUMN "a" TEXT DEFAULT 'x;';\nCREATE INDEX "b" ON "shots" ("a");\n\nCOMMIT;\n`)).toBe("transaction");
    expect(migrationForm(`-- Why.\nSET lock_timeout = '5s';\nDROP INDEX IF EXISTS "shots_a_idx";\nCREATE INDEX CONCURRENTLY "shots_a_idx" ON "shots" ("a");\n`)).toBe("concurrent index");
    expect(migrationForm(`SET lock_timeout = '5s';\nDROP INDEX IF EXISTS "shots_a_key";\nCREATE UNIQUE INDEX CONCURRENTLY "shots_a_key" ON "shots" ("a") WHERE "a" IS NOT NULL;\n`)).toBe("concurrent index");
    // A function's body may hold its own BEGIN and END, and a string or comment anything.
    expect(migrationForm(`BEGIN;\nSET LOCAL lock_timeout = '5s';\nCREATE FUNCTION f() RETURNS void AS $$\nBEGIN\n  RETURN;\nEND;\n$$ LANGUAGE plpgsql;\nCOMMIT;\n`)).toBe("transaction");
    expect(migrationForm(`BEGIN;\nSET LOCAL lock_timeout = '5s';\nALTER TABLE "shots" ADD COLUMN "a" TEXT DEFAULT '--; COMMIT;'; /* COMMIT; */\nCOMMIT;\n`)).toBe("transaction");
  });

  it("are refused in any other form", () => {
    const refused = [
      // No transaction: Prisma runs each statement on its own.
      `ALTER TABLE "shots" ADD COLUMN "a" TEXT;\nALTER TABLE "shots" ADD COLUMN "b" TEXT;\n`,
      // No lock_timeout, or one for the session rather than the transaction.
      `BEGIN;\nALTER TABLE "shots" ADD COLUMN "a" TEXT;\nCOMMIT;\n`,
      `BEGIN;\nSET lock_timeout = '5s';\nALTER TABLE "shots" ADD COLUMN "a" TEXT;\nCOMMIT;\n`,
      `BEGIN;\nSET LOCAL lock_timeout = '1min';\nALTER TABLE "shots" ADD COLUMN "a" TEXT;\nCOMMIT;\n`,
      // Not ending with the commit, or committing partway.
      `BEGIN;\nSET LOCAL lock_timeout = '5s';\nALTER TABLE "shots" ADD COLUMN "a" TEXT;\n`,
      `BEGIN;\nSET LOCAL lock_timeout = '5s';\nALTER TABLE "shots" ADD COLUMN "a" TEXT;\nCOMMIT;\nALTER TABLE "shots" ADD COLUMN "b" TEXT;\n`,
      `BEGIN;\nSET LOCAL lock_timeout = '5s';\nALTER TABLE "shots" ADD COLUMN "a" TEXT;\nCOMMIT;\nBEGIN;\nSET LOCAL lock_timeout = '5s';\nALTER TABLE "shots" ADD COLUMN "b" TEXT;\nCOMMIT;\n`,
      `BEGIN;\nSET LOCAL lock_timeout = '5s';\nALTER TABLE "shots" ADD COLUMN "a" TEXT;\n/* done */ COMMIT;\nALTER TABLE "shots" ADD COLUMN "b" TEXT;\nCOMMIT;\n`,
      // A string hiding the code after it from a comment's dash.
      `BEGIN;\nSET LOCAL lock_timeout = '5s';\nALTER TABLE "shots" ADD COLUMN "a" TEXT DEFAULT '--'; COMMIT; ALTER TABLE "shots" ADD COLUMN "b" TEXT;\nCOMMIT;\n`,
      // The timeout changed or reset after it is set.
      `BEGIN;\nSET LOCAL lock_timeout = '5s';\nSET LOCAL lock_timeout = '0';\nALTER TABLE "shots" ADD COLUMN "a" TEXT;\nCOMMIT;\n`,
      `BEGIN;\nSET LOCAL lock_timeout = '5s';\nRESET lock_timeout;\nALTER TABLE "shots" ADD COLUMN "a" TEXT;\nCOMMIT;\n`,
      `BEGIN;\nSET LOCAL lock_timeout = '5s';\nRESET ALL;\nALTER TABLE "shots" ADD COLUMN "a" TEXT;\nCOMMIT;\n`,
      // A concurrent build in a transaction, which refuses it.
      `BEGIN;\nSET LOCAL lock_timeout = '5s';\nCREATE INDEX CONCURRENTLY "shots_a_idx" ON "shots" ("a");\nCOMMIT;\n`,
      // A concurrent drop, which Prisma can't split out, so runs the file in one transaction; no drop; another index dropped; no lock_timeout.
      `SET lock_timeout = '5s';\nDROP INDEX CONCURRENTLY IF EXISTS "shots_a_idx";\nCREATE INDEX CONCURRENTLY "shots_a_idx" ON "shots" ("a");\n`,
      `SET lock_timeout = '5s';\nCREATE INDEX CONCURRENTLY "shots_a_idx" ON "shots" ("a");\n`,
      `SET lock_timeout = '5s';\nDROP INDEX IF EXISTS "shots_b_idx";\nCREATE INDEX CONCURRENTLY "shots_a_idx" ON "shots" ("a");\n`,
      `DROP INDEX IF EXISTS "shots_a_idx";\nCREATE INDEX CONCURRENTLY "shots_a_idx" ON "shots" ("a");\n`,
      // Keeping an invalid index a failed build left.
      `SET lock_timeout = '5s';\nDROP INDEX IF EXISTS "shots_a_idx";\nCREATE INDEX CONCURRENTLY IF NOT EXISTS "shots_a_idx" ON "shots" ("a");\n`,
      // Anything after the build.
      `SET lock_timeout = '5s';\nDROP INDEX IF EXISTS "shots_a_idx";\nCREATE INDEX CONCURRENTLY "shots_a_idx" ON "shots" ("a");\nALTER TABLE "shots" ADD COLUMN "b" TEXT;\n`,
    ];
    for (const sql of refused) expect(migrationForm(sql), sql).toBeUndefined();
  });
});
