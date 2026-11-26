import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

// A Lost Edit's `state`, what a release before Lost Edits (ADR-0033) made of a
// Conflict, with its enum and index, which `20261126000000_lost_edits_without_state`
// drops (#653). A test of an older data migration whose SQL, as it shipped,
// dismisses Conflicts puts them back as `20261016000000_init` made them, seeds
// what that migration's release left, runs its SQL, and takes them out again
// as the migrations after it do.

const migration = (name: string) => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../prisma/migrations", name, "migration.sql");
const DISMISSED_DELETED = migration("20261123000001_dismissed_lost_edits_deleted");
const DROPPED = migration("20261126000000_lost_edits_without_state");

/** Puts back `conflicts.state`, its enum `conflict_state` and its index, as a release before #653 had them. */
export async function restoreConflictState(database: pg.Client): Promise<void> {
  await database.query(`
    CREATE TYPE "conflict_state" AS ENUM ('OPEN', 'USED', 'DISMISSED');
    ALTER TABLE "conflicts" ADD COLUMN "state" "conflict_state" NOT NULL DEFAULT 'OPEN';
    CREATE INDEX "conflicts_state_created_at_idx" ON "conflicts"("state", "created_at");`);
}

/**
 * Takes them out again by the migrations' own SQL: each Conflict dismissed is
 * deleted (#642), and the rest stay Lost Edits as the column goes (#653).
 */
export async function dropConflictState(database: pg.Client): Promise<void> {
  await database.query(fs.readFileSync(DISMISSED_DELETED, "utf8"));
  await database.query(fs.readFileSync(DROPPED, "utf8"));
}
