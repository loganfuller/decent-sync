import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi } from "./support/admin-api.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #642: a release before Lost Edits (ADR-0033) kept a
// Conflict someone dismissed in the table Lost Edits are kept in, in state
// `DISMISSED`, which 1.12.2 leaves out of its item's history. Its migration
// (`20261123000001_dismissed_lost_edits_deleted`) deletes those rows, so that
// no release reads `state`, and keeps the open and used ones, which are Lost
// Edits. The migration's SQL is run again on a migrated database holding what
// such a release left, through the database and the REST API.

const MIGRATION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../prisma/migrations/20261123000001_dismissed_lost_edits_deleted/migration.sql");

describe("Conflicts dismissed through a release before Lost Edits", { timeout: 60_000 }, () => {
  let server: TestServer;
  let api: AdminApi;

  beforeAll(async () => {
    server = await startTestServer();
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => {
    await server?.stop();
  });

  const basket = async (locationId: string, name: string) =>
    (await api.send<{ basket: { id: string } }>("POST", "/baskets", { locationId, content: { name, size: "double" } }, 201)).basket.id;
  const lostEdits = async (id: string) => (await api.get<{ lostEdits: { id: string }[] }>(`/baskets/${id}/history`)).lostEdits.map((lost) => lost.id).sort();

  it("are deleted by the migration, of every item, while the open and used ones stay Lost Edits, and running it again changes nothing", async () => {
    const location = await api.createLocation("Dismissed lab", "America/Chicago");
    const ids = [await basket(location.id, "Dismissed 18g"), await basket(location.id, "Dismissed 20g")] as const;
    const database = await server.connectDatabase();
    try {
      // As such a release left them: with no edit each lost to, open, used or dismissed there.
      const conflictOf = async (id: string, value: string, state: string) =>
        (
          await database.query<{ id: string }>(
            `INSERT INTO conflicts (id, kind, item_id, location_id, field, value, edited_at, state)
             VALUES (gen_random_uuid(), 'basket', $1, NULL, 'name', to_jsonb($2::text), now(), $3::conflict_state) RETURNING id::text AS id`,
            [id, value, state],
          )
        ).rows[0]!.id;
      const kept = { open: await conflictOf(ids[0], "Open 18g", "OPEN"), used: await conflictOf(ids[0], "Used 18g", "USED") };
      const dismissed = [await conflictOf(ids[0], "Dismissed once", "DISMISSED"), await conflictOf(ids[1], "Dismissed twice", "DISMISSED")];

      await database.query(fs.readFileSync(MIGRATION, "utf8"));

      const states = async () =>
        Object.fromEntries(
          (await database.query<{ id: string; state: string }>(`SELECT id::text AS id, state::text AS state FROM conflicts WHERE item_id = ANY($1::text[])`, [ids])).rows.map(
            (row) => [row.id, row.state],
          ),
        );
      expect(await states()).toEqual({ [kept.open]: "OPEN", [kept.used]: "USED" });
      expect((await database.query(`SELECT 1 FROM conflicts WHERE id = ANY($1::uuid[])`, [dismissed])).rowCount).toBe(0);
      expect((await database.query(`SELECT 1 FROM conflicts WHERE state = 'DISMISSED'`)).rowCount).toBe(0);
      // The open and used ones are shown, and nothing else.
      expect(await lostEdits(ids[0])).toEqual([kept.open, kept.used].sort());
      expect(await lostEdits(ids[1])).toEqual([]);

      // Run again, it changes nothing.
      await database.query(fs.readFileSync(MIGRATION, "utf8"));
      expect(await states()).toEqual({ [kept.open]: "OPEN", [kept.used]: "USED" });
    } finally {
      await database.end();
    }
  });
});
