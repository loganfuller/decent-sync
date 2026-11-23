import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi } from "./support/admin-api.js";
import { syncingTablet } from "./support/loaded-tablets.js";
import { dye2List, dye2NeverUsed } from "./support/simulated-dye2.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #550: from DYE2 v0.1.37 a recipe holding a dose, grind
// setting or RPM of 0 is applied as naming none, while DYE2's editor saves an
// RPM left blank as 0, so a Recipe holds each above 0 or none (ADR-0022). The
// release reads a stored 0, as 1.10.0 may take one in while both run, as
// none: the REST API shows none, and a tablet's record holding the 0 is left
// as it is, neither an edit nor a reason to write it again. Its migration
// (`20261115000003_recipe_zero_is_none`) makes every Recipe holding 0 for one
// hold none, one version from the server that each field's latest edit then
// names, and dismisses an open Conflict offering 0. The migration's SQL is
// run again on a migrated database holding what 1.10.0 left, through the
// database, the REST API and a simulated tablet. Serials are made up, from
// 55001.
//
// From #617 a grind setting of 0 is a dial position, as DYE2 v0.1.42 applies
// one: this release takes, shows and writes one, while the migration, as
// 1.10.1 shipped it, still clears a grind setting of 0 with the dose and RPM,
// as it did then.

type Record_ = Record<string, unknown>;

interface RecipeView {
  id: string;
  content: Record_;
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

const MIGRATION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../prisma/migrations/20261115000003_recipe_zero_is_none/migration.sql");
const DISMISSED_DELETED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../prisma/migrations/20261123000001_dismissed_lost_edits_deleted/migration.sql");

describe("A Recipe's dose, grind setting or RPM of 0, from 1.10.0's data", { timeout: 90_000 }, () => {
  let server: TestServer;
  let api: AdminApi;

  beforeAll(async () => {
    // From template0, migrated by this release, since later releases' CI runs this suite on a schema of theirs (AI_BUILD_NOTES.md).
    server = await startTestServer({ env, emptyDatabase: true });
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => {
    await server?.stop();
  });

  const create = (locationId: string, slot: number, content: Record_) => api.send<{ recipe: RecipeView }>("POST", "/recipes", { locationId, slot, content }, 201).then((created) => created.recipe);
  const recipe = (id: string) => api.get<{ recipe: RecipeView }>(`/recipes/${id}`).then((read) => read.recipe);

  it("is refused in an edit, read as none, and made none by the migration, one version from the server that each field's latest edit names, its open Conflicts offering 0 dismissed, a yield of 0 kept", async () => {
    const location = await api.createLocation("Zero is none lab", "America/Chicago");
    const machine = await api.createMachine("Zero is none lab 1", location.id);
    const tablet = syncingTablet(machine, server, { api: dye2NeverUsed("55001") });
    await api.waitForOnline(machine);
    const zero = await create(location.id, 1, { name: "Zero Espresso", dose: 18, yield: 36, grindSetting: 2.5, rpm: 900 });
    const kept = await create(location.id, 2, { name: "Kept Espresso", dose: 18, yield: 0, grindSetting: 2.5, rpm: 900 });
    const record = (id: string) => (dye2List(tablet, "recipes") as Record_[] | null)?.find((entry) => entry.decentSyncId === id);
    const dial = (id: string) => {
      const variables = (record(id)?.dashboardVariables ?? {}) as Record_;
      return [variables.dose ?? null, variables.drink ?? null, variables.grind ?? null, variables.rpm ?? null];
    };
    await expect.poll(() => [zero, kept].map(({ id }) => dial(id)), { timeout: 15_000 }).toEqual([[18, 36, 2.5, 900], [18, 0, 2.5, 900]]);

    // No edit sets one of 0: clearing the field says none. A yield of 0 is stop-at-weight off, which a Recipe may hold.
    for (const [field, problem] of [["dose", "dose must be a number above 0"], ["rpm", "rpm must be a number above 0"]] as const) {
      const refused = await api.call("PATCH", `/recipes/${zero.id}`, { content: { [field]: 0 } });
      expect(refused.status, field).toBe(400);
      expect(await refused.text()).toContain(problem);
    }
    expect((await api.call("POST", "/recipes", { locationId: location.id, slot: 3, content: { name: "Refused", rpm: 0 } })).status).toBe(400);
    expect((await api.call("PATCH", `/recipes/${zero.id}`, { content: { yield: 0 } })).status).toBe(200);
    expect((await api.call("PATCH", `/recipes/${zero.id}`, { content: { yield: 36 } })).status).toBe(200);
    await expect.poll(() => dial(zero.id), { timeout: 15_000 }).toEqual([18, 36, 2.5, 900]);

    // As 1.10.0 leaves them: one Recipe holding 0 for each, as DYE2's editor saves an RPM left blank, its tablet's record
    // holding the same, with an open Conflict offering an RPM of 0, an open one offering 1100 and a used one offering 0.
    const database = await server.connectDatabase();
    let conflicts: { zero: string; other: string; used: string };
    const fieldEdits = async (id: string) =>
      (await database.query<{ edits: Record<string, Record_ | undefined> }>(`SELECT field_edits AS edits FROM recipes WHERE id = $1`, [id])).rows[0]!.edits;
    const lostEdits = async (id: string) => (await api.get<{ lostEdits: { id: string }[] }>(`/recipes/${id}/history`)).lostEdits.map((lost) => lost.id).sort();
    try {
      await database.query(`UPDATE recipes SET content = content || '{"dose": 0, "grindSetting": 0, "rpm": 0}'::jsonb WHERE id = $1`, [zero.id]);
      const conflict = (value: number, state: string) =>
        database
          .query<{ id: string }>(
            `INSERT INTO conflicts (id, kind, item_id, location_id, field, value, edited_at, state)
             VALUES (gen_random_uuid(), 'recipe', $1, NULL, 'rpm', $2::jsonb, now(), $3::conflict_state) RETURNING id::text AS id`,
            [zero.id, JSON.stringify(value), state],
          )
          .then(({ rows }) => rows[0]!.id);
      conflicts = { zero: await conflict(0, "OPEN"), other: await conflict(1100, "OPEN"), used: await conflict(0, "USED") };

      // Read as none before the migration, by the REST API and in what its tablets are written as they connect again; the
      // grind setting of 0 as the dial position it is from #617.
      const read = (await recipe(zero.id)).content;
      for (const field of ["dose", "rpm"]) expect(read, field).not.toHaveProperty(field);
      expect(read).toMatchObject({ yield: 36, grindSetting: 0 });
      tablet.loseNetwork();
      tablet.restoreNetwork();
      await expect.poll(() => dial(zero.id), { timeout: 15_000 }).toEqual([null, 36, 0, null]);
      expect(dial(kept.id)).toEqual([18, 0, 2.5, 900]);
      const before = await fieldEdits(zero.id);

      await database.query(fs.readFileSync(MIGRATION, "utf8"));

      const { rows } = await database.query<{ id: string; content: Record_ }>(`SELECT id::text AS id, content FROM recipes WHERE id = ANY($1::uuid[])`, [[zero.id, kept.id]]);
      const stored = Object.fromEntries(rows.map((row) => [row.id, row.content]));
      for (const field of ["dose", "grindSetting", "rpm"]) expect(stored[zero.id], field).not.toHaveProperty(field);
      expect(stored[zero.id]).toMatchObject({ name: "Zero Espresso", yield: 36 });
      // One holding none of them at 0 is left whole, its yield of 0 with it.
      expect(stored[kept.id]).toMatchObject({ dose: 18, yield: 0, grindSetting: 2.5, rpm: 900 });
      const states = await database.query<{ id: string; state: string }>(`SELECT id::text AS id, state::text AS state FROM conflicts WHERE item_id = $1`, [zero.id]);
      expect(Object.fromEntries(states.rows.map((row) => [row.id, row.state]))).toEqual({ [conflicts.zero]: "DISMISSED", [conflicts.other]: "OPEN", [conflicts.used]: "USED" });
      // Each field's latest edit names the migration's one version, from no tablet, decided after the ones before it.
      const after = await fieldEdits(zero.id);
      const [version] = (await api.get<{ versions: { id: string; fields: Record_; source: unknown }[] }>(`/recipes/${zero.id}/history`)).versions;
      expect(version).toMatchObject({ fields: { dose: null, grindSetting: null, rpm: null }, source: { machine: null, tabletId: null, account: null } });
      for (const field of ["dose", "grindSetting", "rpm"]) {
        expect(after[field], field).toMatchObject({ versionId: version!.id, tabletId: null });
        expect(new Date(String(after[field]!.decidedAt)).getTime(), field).toBeGreaterThan(new Date(String(before[field]!.decidedAt)).getTime());
      }
      expect(after.yield).toEqual(before.yield);
      expect(Object.values(await fieldEdits(kept.id)).some((edit) => edit?.versionId === version!.id)).toBe(false);

      // The one it dismissed is deleted by a later migration (#642), so it is no Lost Edit in the Recipe's history (ADR-0033);
      // the others are.
      await database.query(fs.readFileSync(DISMISSED_DELETED, "utf8"));
      expect(await lostEdits(zero.id)).toEqual([conflicts.other, conflicts.used].sort());

      // Run again, it changes nothing.
      await database.query(fs.readFileSync(MIGRATION, "utf8"));
      expect(await fieldEdits(zero.id)).toEqual(after);
    } finally {
      await database.end();
    }

    for (const field of ["dose", "grindSetting", "rpm"]) expect((await recipe(zero.id)).content, field).not.toHaveProperty(field);
    expect((await recipe(kept.id)).content).toMatchObject({ dose: 18, yield: 0, rpm: 900 });
    // An RPM above 0 is an edit as before, written to the tablet.
    expect((await api.call("PATCH", `/recipes/${zero.id}`, { content: { rpm: 1100 } })).status).toBe(200);
    expect((await recipe(zero.id)).content).toMatchObject({ rpm: 1100 });
    await expect.poll(() => dial(zero.id), { timeout: 15_000 }).toEqual([null, 36, null, 1100]);
  });
});
