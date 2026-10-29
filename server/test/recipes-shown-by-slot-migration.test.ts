import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi } from "./support/admin-api.js";
import { syncingTablet } from "./support/loaded-tablets.js";
import { dye2List, dye2NeverUsed } from "./support/simulated-dye2.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for tickets #371 and #379: a Recipe is on Streamline's strip exactly
// while it is in a Recipe Slot (DYE2 v0.1.32), and keeps no
// `showOnDashboard` of its own. The release that drops it, deployed with
// every instance stopped, fixes what 1.6.0 left once, in its migration
// (`20261029000000_recipes_shown_by_slot`): a Recipe hidden in a slot leaves
// it, a version from the server, written so to its tablets as they connect
// again; the field leaves every Recipe's content and latest edits; and an
// open Conflict over it is dismissed. The migration's SQL is run again on a
// migrated database holding what 1.6.0 left, through the database, the REST
// API and a simulated tablet. Serials are made up, from 46001.

type Record_ = Record<string, unknown>;

interface RecipeView {
  id: string;
  slot: number | null;
  content: Record_;
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

const MIGRATION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../prisma/migrations/20261029000000_recipes_shown_by_slot/migration.sql");

describe("Recipes shown on the strip by their slots alone, from 1.6.0's data", { timeout: 90_000 }, () => {
  let server: TestServer;
  let api: AdminApi;

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => {
    await server?.stop();
  });

  const create = (locationId: string, slot: number | null, name: string) =>
    api.send<{ recipe: RecipeView }>("POST", "/recipes", { locationId, slot, content: { name } }, 201).then((created) => created.recipe);
  const recipe = (id: string) => api.get<{ recipe: RecipeView }>(`/recipes/${id}`).then((read) => read.recipe);

  it("take a Recipe hidden in a slot out of it, a version from the server, drop the field and its edits, and dismiss its open Conflicts", async () => {
    const location = await api.createLocation("Shown by slot lab", "America/Chicago");
    const machine = await api.createMachine("Shown by slot lab 1", location.id);
    const tablet = syncingTablet(machine, server, { api: dye2NeverUsed("46001") });
    await api.waitForOnline(machine);
    const hidden = await create(location.id, 2, "Hidden Espresso");
    const shown = await create(location.id, 3, "Shown Espresso");
    const kept = await create(location.id, null, "Kept Espresso");
    const recordOf = (id: string) => (dye2List(tablet, "recipes") as Record_[] | null)?.find((record) => record.decentSyncId === id);
    await expect.poll(() => [hidden, shown, kept].map(({ id }) => recordOf(id)?.showOnStreamlineDashboard), { timeout: 15_000 }).toEqual([true, true, false]);

    // As 1.6.0 leaves them: one hidden in its slot by its switch, an edit of the field; one in a slot shown, with an open
    // Conflict over the field and a used one; one in none shown.
    const database = await server.connectDatabase();
    let conflicts: { open: string; used: string };
    try {
      await database.query(
        `UPDATE recipes SET content = content || '{"showOnDashboard": false}'::jsonb,
           field_edits = field_edits || jsonb_build_object('showOnDashboard', field_edits -> 'name') WHERE id = $1`,
        [hidden.id],
      );
      await database.query(`UPDATE recipes SET content = content || '{"showOnDashboard": true}'::jsonb WHERE id = ANY($1::uuid[])`, [[shown.id, kept.id]]);
      const conflict = (state: string) =>
        database
          .query<{ id: string }>(
            `INSERT INTO conflicts (id, kind, item_id, location_id, field, value, edited_at, state)
             VALUES (gen_random_uuid(), 'recipe', $1, NULL, 'showOnDashboard', 'false'::jsonb, now(), $2::conflict_state) RETURNING id::text AS id`,
            [shown.id, state],
          )
          .then(({ rows }) => rows[0]!.id);
      conflicts = { open: await conflict("OPEN"), used: await conflict("USED") };

      await database.query(fs.readFileSync(MIGRATION, "utf8"));

      const { rows } = await database.query<{ id: string; fieldEdits: Record_ }>(`SELECT id::text AS id, field_edits AS "fieldEdits" FROM recipes WHERE id = ANY($1::uuid[])`, [
        [hidden.id, shown.id, kept.id],
      ]);
      for (const row of rows) expect(row.fieldEdits, row.id).not.toHaveProperty("showOnDashboard");
      expect(rows.find((row) => row.id === hidden.id)!.fieldEdits).toHaveProperty("name");
      const states = await database.query<{ id: string; state: string }>(`SELECT id::text AS id, state::text AS state FROM conflicts WHERE item_id = $1`, [shown.id]);
      expect(Object.fromEntries(states.rows.map((row) => [row.id, row.state]))).toEqual({ [conflicts.open]: "DISMISSED", [conflicts.used]: "USED" });
    } finally {
      await database.end();
    }

    expect(await recipe(hidden.id)).toMatchObject({ slot: null });
    expect(await recipe(shown.id)).toMatchObject({ slot: 3 });
    expect(await recipe(kept.id)).toMatchObject({ slot: null });
    for (const { id } of [hidden, shown, kept]) expect((await recipe(id)).content, id).not.toHaveProperty("showOnDashboard");
    // A version of its own, from no account or tablet; the others have none.
    const versions = async (id: string) => (await api.get<{ versions: { fields: Record_; source: unknown }[] }>(`/recipes/${id}/history`)).versions;
    expect((await versions(hidden.id))[0]).toMatchObject({ fields: { slot: null }, source: { machine: null, tabletId: null, account: null } });
    expect((await versions(shown.id))[0]!.fields).toEqual({ slot: 3 });

    // Its tablets are written it in no slot, hidden, as they connect again once the release has started.
    tablet.loseNetwork();
    tablet.restoreNetwork();
    await expect.poll(() => recordOf(hidden.id), { timeout: 15_000 }).toMatchObject({ stripSlot: null, showOnStreamlineDashboard: false });
    expect(recordOf(shown.id)).toMatchObject({ stripSlot: 3, showOnStreamlineDashboard: true });
    expect(recordOf(kept.id)).toMatchObject({ stripSlot: null, showOnStreamlineDashboard: false });
  });
});
