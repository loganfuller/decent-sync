import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type StagedMigrations, migrationRecords, stageMigrations } from "../support/staged-migrations.js";
import { type TestServer, startTestServer } from "../support/test-server.js";

// A migration of the next release, staged after the change's own, failing on
// its lock_timeout while the latest release serves (ADR-0025). Left as
// Prisma leaves it, unfinished, every later `migrate deploy` would refuse to
// run (P3009), the latest release's included, so its instances couldn't
// restart.

const COLUMN = "99990101000000_staged_column";

describe("a migration that fails on its lock_timeout beside the latest release", () => {
  let staged: StagedMigrations;
  let release: TestServer;
  let holder: pg.Client;

  beforeAll(async () => {
    staged = stageMigrations({
      [COLUMN]: `BEGIN;\nSET LOCAL lock_timeout = '5s';\n\nALTER TABLE "machines" ADD COLUMN "staged" INTEGER;\nALTER TABLE "shots" ADD COLUMN "staged" INTEGER;\n\nCOMMIT;\n`,
    });
    release = await startTestServer({ latestRelease: true });
    holder = await release.connectDatabase();
  });
  afterAll(async () => {
    await holder?.end();
    await release?.stop();
    staged?.remove();
  });

  it("gives up whole and is recorded as rolled back, so the latest release restarts, and the next deploy applies it", async () => {
    // A transaction of the running release's that holds shots, more than the migration's 5 s.
    await holder.query("BEGIN; LOCK TABLE shots IN ACCESS SHARE MODE");
    const failure = await startTestServer({ sharing: release, buildDir: staged.buildDir }).then(() => "started", (error: Error) => error.message);
    expect(failure).toContain(`Database migrations failed (prisma migrate deploy exited with 1). Recorded ${COLUMN} as rolled back, so the next start applies it again`);
    // Tried once, it can't have been applied by an instance killed before Prisma recorded it.
    expect(failure).not.toContain("migrate resolve --applied");
    expect(await migrationRecords(release, COLUMN)).toEqual([{ finished: false, rolledBack: true }]);
    // Its first statement, on machines, went with it.
    const machines = await holder.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'machines' AND column_name = 'staged'");
    expect(machines.rowCount).toBe(0);

    // The latest release's instances restart meanwhile, while shots is still held.
    await startTestServer({ sharing: release, latestRelease: true });
    await holder.query("COMMIT");
    await startTestServer({ sharing: release, buildDir: staged.buildDir });
    expect(await migrationRecords(release, COLUMN)).toEqual([{ finished: false, rolledBack: true }, { finished: true, rolledBack: false }]);
  });
});
