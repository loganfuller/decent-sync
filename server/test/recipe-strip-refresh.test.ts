import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi } from "./support/admin-api.js";
import { syncingTablet } from "./support/loaded-tablets.js";
import { dye2List, dye2NeverUsed } from "./support/simulated-dye2.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #371: a Recipe is on Streamline's strip exactly while it
// is in a Recipe Slot (DYE2 v0.1.32), and keeps `showOnDashboard` in its
// content set from its slot, which the previous release writes its records
// from (ADR-0025). One the previous release left in a slot and hidden, as
// its switch or a tablet's hide did, is taken out of its slot by the server
// as an instance starts (`RecipeStripRefresh`), as DYE2 takes one it saves
// hidden out of its slot, so the strip shows what it showed; and any other
// Recipe's `showOnDashboard` is set from its slot. Through the REST API, the
// database and a simulated tablet, on two server instances sharing one
// database. Serials are made up, from 46001.

type Record_ = Record<string, unknown>;

interface RecipeView {
  id: string;
  slot: number | null;
  content: Record_;
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

describe("A Recipe hidden from the strip in a slot, as the previous release leaves one", { timeout: 90_000 }, () => {
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

  it("is taken out of its slot as an instance starts, a version from the server, and every Recipe's showOnDashboard set from its slot", async () => {
    const location = await api.createLocation("Strip refresh lab", "America/Chicago");
    const machine = await api.createMachine("Strip refresh lab 1", location.id);
    const tablet = syncingTablet(machine, server, { api: dye2NeverUsed("46001") });
    await api.waitForOnline(machine);
    const hidden = await create(location.id, 2, "Hidden Espresso");
    const shown = await create(location.id, 3, "Shown Espresso");
    const kept = await create(location.id, null, "Kept Espresso");
    const recordOf = (id: string) => (dye2List(tablet, "recipes") as Record_[] | null)?.find((record) => record.decentSyncId === id);
    await expect.poll(() => [hidden, shown, kept].map(({ id }) => recordOf(id)?.showOnStreamlineDashboard), { timeout: 15_000 }).toEqual([true, true, false]);

    // As the previous release leaves them: one hidden in its slot, one in none shown.
    const database = await server.connectDatabase();
    try {
      await database.query(`UPDATE recipes SET content = content || '{"showOnDashboard": false}'::jsonb WHERE id = $1`, [hidden.id]);
      await database.query(`UPDATE recipes SET content = content || '{"showOnDashboard": true}'::jsonb WHERE id = $1`, [kept.id]);
    } finally {
      await database.end();
    }

    const other = await startTestServer({ env, sharing: server });
    try {
      await expect.poll(async () => (await recipe(hidden.id)).slot, { timeout: 15_000 }).toBeNull();
      expect(other.output()).toMatch(/Took 1 Recipe hidden from the strip out of its slot/);
      expect((await recipe(hidden.id)).content.showOnDashboard).toBe(false);
      expect((await recipe(kept.id)).content.showOnDashboard).toBe(false);
      expect(await recipe(shown.id)).toMatchObject({ slot: 3, content: { showOnDashboard: true } });
      // A version of its own, from no account or tablet.
      const versions = (await api.get<{ versions: { fields: Record_; source: unknown }[] }>(`/recipes/${hidden.id}/history`)).versions;
      expect(versions[0]).toMatchObject({ fields: { slot: null } });
      expect(versions[0]!.source).toMatchObject({ machine: null, tabletId: null, account: null });
      // Its tablets are written it in no slot, hidden; the others keep theirs.
      await expect.poll(() => recordOf(hidden.id), { timeout: 15_000 }).toMatchObject({ stripSlot: null, showOnStreamlineDashboard: false });
      expect(recordOf(shown.id)).toMatchObject({ stripSlot: 3, showOnStreamlineDashboard: true });
    } finally {
      await other.stop();
    }
  });
});
