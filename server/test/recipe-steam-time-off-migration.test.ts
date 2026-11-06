import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi } from "./support/admin-api.js";
import { syncingTablet } from "./support/loaded-tablets.js";
import { dye2List, dye2NeverUsed } from "./support/simulated-dye2.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #394: from Streamline v0.2.22 a steam time of 0 is steam
// off, which stays each Machine's own, so a Recipe's steam time is 1 to
// 255 s or none (ADR-0022). The release reads a stored 0, as 1.6.2 may take
// one in while both run, as none: the REST API shows none, and its tablets'
// records are written none. Its migration
// (`20261105000000_recipe_steam_time_off`) makes every Recipe holding 0 hold
// none, a version from the server that the field's latest edit then names,
// so a Conflict shown the old value is refused, and dismisses an open
// Conflict offering 0. The migration's SQL is run again on a migrated
// database holding what 1.6.2 left, through the database, the REST API and a
// simulated tablet. Serials are made up, from 52001.

type Record_ = Record<string, unknown>;

interface RecipeView {
  id: string;
  content: Record_;
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

const MIGRATION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../prisma/migrations/20261105000000_recipe_steam_time_off/migration.sql");

describe("A Recipe's steam time of 0, from 1.6.2's data", { timeout: 90_000 }, () => {
  let server: TestServer;
  let api: AdminApi;

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => {
    await server?.stop();
  });

  const create = (locationId: string, slot: number, content: Record_) => api.send<{ recipe: RecipeView }>("POST", "/recipes", { locationId, slot, content }, 201).then((created) => created.recipe);
  const recipe = (id: string) => api.get<{ recipe: RecipeView }>(`/recipes/${id}`).then((read) => read.recipe);

  it("is refused in an edit, read as none, and made none by the migration, a version from the server that the field's latest edit names, its open Conflicts offering 0 dismissed", async () => {
    const location = await api.createLocation("Steam time off lab", "America/Chicago");
    const machine = await api.createMachine("Steam time off lab 1", location.id);
    const tablet = syncingTablet(machine, server, { api: dye2NeverUsed("52001") });
    await api.waitForOnline(machine);
    const zero = await create(location.id, 1, { name: "Zero Cappuccino", steamDuration: 30 });
    const kept = await create(location.id, 2, { name: "Kept Cappuccino", steamDuration: 45 });
    const steamTime = (id: string) => {
      const record = (dye2List(tablet, "recipes") as Record_[] | null)?.find((entry) => entry.decentSyncId === id);
      return record === undefined ? undefined : (((record.dashboardVariables ?? {}) as Record_).steamTimeS ?? null);
    };
    await expect.poll(() => [zero, kept].map(({ id }) => steamTime(id)), { timeout: 15_000 }).toEqual([30, 45]);

    // No edit sets one of 0, or above the DE1's 255 s.
    for (const steamDuration of [0, 256]) {
      const refused = await api.call("PATCH", `/recipes/${zero.id}`, { content: { steamDuration } });
      expect(refused.status, String(steamDuration)).toBe(400);
      expect(await refused.text()).toContain("steamDuration must be a whole number from 1 to 255");
    }

    // As 1.6.2 leaves them: one Recipe holding a steam time of 0, which it took in from a tablet, with an open Conflict
    // offering 0, an open one offering 20 and a used one offering 0.
    const database = await server.connectDatabase();
    let conflicts: { zero: string; twenty: string; used: string };
    const fieldEdit = async (id: string) =>
      (await database.query<{ edit: Record_ | null }>(`SELECT field_edits -> 'steamDuration' AS edit FROM recipes WHERE id = $1`, [id])).rows[0]!.edit;
    const open = async (id: string) => (await api.get<{ conflicts: { id: string; current: { value: unknown; versionId: string | null } }[] }>("/conflicts")).conflicts.find((conflict) => conflict.id === id);
    try {
      await database.query(`UPDATE recipes SET content = content || '{"steamDuration": 0}'::jsonb WHERE id = $1`, [zero.id]);
      const conflict = (value: number, state: string) =>
        database
          .query<{ id: string }>(
            `INSERT INTO conflicts (id, kind, item_id, location_id, field, value, edited_at, state)
             VALUES (gen_random_uuid(), 'recipe', $1, NULL, 'steamDuration', $2::jsonb, now(), $3::conflict_state) RETURNING id::text AS id`,
            [zero.id, JSON.stringify(value), state],
          )
          .then(({ rows }) => rows[0]!.id);
      conflicts = { zero: await conflict(0, "OPEN"), twenty: await conflict(20, "OPEN"), used: await conflict(0, "USED") };

      // Read as none before the migration, by the REST API and in what its tablets are written as they connect again.
      expect((await recipe(zero.id)).content).not.toHaveProperty("steamDuration");
      tablet.loseNetwork();
      tablet.restoreNetwork();
      await expect.poll(() => steamTime(zero.id), { timeout: 15_000 }).toBeNull();
      expect(steamTime(kept.id)).toBe(45);
      const before = await fieldEdit(zero.id);
      const shown = (await open(conflicts.twenty))!.current.versionId;
      expect(shown).toBe(before!.versionId);

      await database.query(fs.readFileSync(MIGRATION, "utf8"));

      const { rows } = await database.query<{ id: string; content: Record_ }>(`SELECT id::text AS id, content FROM recipes WHERE id = ANY($1::uuid[])`, [[zero.id, kept.id]]);
      expect(Object.fromEntries(rows.map((row) => [row.id, row.content.steamDuration ?? null]))).toEqual({ [zero.id]: null, [kept.id]: 45 });
      const states = await database.query<{ id: string; state: string }>(`SELECT id::text AS id, state::text AS state FROM conflicts WHERE item_id = $1`, [zero.id]);
      expect(Object.fromEntries(states.rows.map((row) => [row.id, row.state]))).toEqual({ [conflicts.zero]: "DISMISSED", [conflicts.twenty]: "OPEN", [conflicts.used]: "USED" });
      // The field's latest edit names the migration's version, from no tablet, decided after the one before it.
      const after = (await fieldEdit(zero.id))!;
      const [version] = (await api.get<{ versions: { id: string; fields: Record_; source: unknown }[] }>(`/recipes/${zero.id}/history`)).versions;
      expect(version).toMatchObject({ fields: { steamDuration: null }, source: { machine: null, tabletId: null, account: null } });
      expect(after).toMatchObject({ versionId: version!.id, tabletId: null });
      expect(new Date(String(after.decidedAt)).getTime()).toBeGreaterThan(new Date(String(before!.decidedAt)).getTime());
      expect((await fieldEdit(kept.id))!.versionId).not.toBe(version!.id);

      // The open Conflict offering 20 shows none as the value now, and is refused where it names the value shown before.
      expect((await open(conflicts.twenty))!.current).toMatchObject({ value: null, versionId: version!.id });
      expect((await api.call("POST", `/conflicts/${conflicts.twenty}/use`, { seen: shown })).status).toBe(409);
    } finally {
      await database.end();
    }

    expect((await recipe(zero.id)).content).not.toHaveProperty("steamDuration");
    expect((await recipe(kept.id)).content).toMatchObject({ steamDuration: 45 });
    // The other has no version of the migration's.
    const versions = async (id: string) => (await api.get<{ versions: { fields: Record_ }[] }>(`/recipes/${id}/history`)).versions;
    expect((await versions(kept.id)).filter((version) => version.fields.steamDuration === null)).toEqual([]);
    // Its value used over the one now: a steam time from 1 s is an edit as before, written to the tablet.
    expect((await api.call("POST", `/conflicts/${conflicts.twenty}/use`, { seen: (await open(conflicts.twenty))!.current.versionId })).status).toBe(200);
    expect((await recipe(zero.id)).content).toMatchObject({ steamDuration: 20 });
    await expect.poll(() => steamTime(zero.id), { timeout: 15_000 }).toBe(20);
  });
});
