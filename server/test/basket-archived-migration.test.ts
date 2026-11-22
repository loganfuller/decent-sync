import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GLOBAL_ID_KEY } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type LocationView } from "./support/admin-api.js";
import { syncingTablet } from "./support/loaded-tablets.js";
import { DYE2_NAMESPACE, dye2List, dye2NeverUsed } from "./support/simulated-dye2.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #618: releases before it took `archived` on a tablet's
// record of a Basket, which DYE2 sets from v0.1.41, in as a field of the
// Basket's content, and wrote it to every tablet holding it. From this
// release `archived` is a Location's state, never content: it reads a
// Basket's content holding one, as 1.12.1 may leave while both run, as
// holding none, so the Basket's records are unarchived wherever it is shown.
// Its migration (`20261122000000_basket_archived_not_content`) takes
// `archived` out of every Basket's content and its fields' latest edits, and
// dismisses an open Conflict over it, changing no Location's state. The
// migration's SQL is run again on a migrated database holding what 1.12.1
// left, through the database, the REST API and simulated tablets. Serials
// are made up, from 61831.

type Record_ = Record<string, unknown>;

interface BasketView {
  id: string;
  archived: boolean;
  content: Record_;
  locations: { location: LocationView; shown: boolean }[];
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

const MIGRATION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../prisma/migrations/20261122000000_basket_archived_not_content/migration.sql");

describe("A Basket's `archived` in its content, from 1.12.1's data", { timeout: 90_000 }, () => {
  let server: TestServer;
  let api: AdminApi;

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => {
    await server?.stop();
  });

  const create = (location: LocationView, content: Record_) =>
    api.send<{ basket: BasketView }>("POST", "/baskets", { locationId: location.id, content }, 201).then((created) => created.basket);
  const basket = (id: string) => api.get<{ basket: BasketView }>(`/baskets/${id}`).then((read) => read.basket);
  const recordOf = (tablet: SimulatedTablet, id: string) => (dye2List(tablet, "baskets") as Record_[] | null)?.find((record) => record[GLOBAL_ID_KEY] === id);

  it("is read as none, unarchiving the Basket's records where it is shown, and taken out by the migration, with its open Conflicts, no Location's state changed", async () => {
    const lab = await api.createLocation("Archived content lab", "America/Chicago");
    const cafe = await api.createLocation("Archived content cafe", "America/Chicago");
    const tablets = [
      syncingTablet(await api.createMachine("Archived content lab 1", lab.id), server, { api: dye2NeverUsed("61831") }),
      syncingTablet(await api.createMachine("Archived content cafe 1", cafe.id), server, { api: dye2NeverUsed("61832") }),
    ] as const;
    const spread = await create(lab, { name: "Spread 18g", size: "double", diameterMm: 58.5 });
    const untouched = await create(lab, { name: "Untouched 20g", size: "double" });
    expect((await api.call("PUT", `/baskets/${spread.id}/locations/${cafe.id}`, { shown: true })).status).toBe(200);
    for (const tablet of tablets) await expect.poll(() => recordOf(tablet, spread.id)?.name).toBe("Spread 18g");
    await expect.poll(() => recordOf(tablets[0], untouched.id)?.name).toBe("Untouched 20g");

    // As 1.12.1 leaves it: one tablet's archive merged into the Basket's content as a field of it, its latest edit kept, with
    // an open Conflict over it, and written to every tablet holding it, which the map holds as written. Set while the
    // tablets are offline, so neither reports its record between the two.
    const database = await server.connectDatabase();
    const conflictOf = async (state: string) =>
      (
        await database.query<{ id: string }>(
          `INSERT INTO conflicts (id, kind, item_id, location_id, field, value, edited_at, state)
           VALUES (gen_random_uuid(), 'basket', $1, NULL, 'archived', 'false'::jsonb, now(), $2::conflict_state) RETURNING id::text AS id`,
          [spread.id, state],
        )
      ).rows[0]!.id;
    const stored = async (id: string) =>
      (await database.query<{ content: Record_; edits: Record_ }>(`SELECT content, field_edits AS edits FROM baskets WHERE id = $1`, [id])).rows[0]!;
    const decided = async () => (await basket(spread.id)).locations.map(({ location, shown }) => [location.name, shown]);
    try {
      for (const tablet of tablets) tablet.loseNetwork();
      const edit = JSON.stringify({ archived: { at: new Date().toISOString(), decidedAt: new Date().toISOString(), tabletId: null, versionId: null } });
      await database.query(`UPDATE baskets SET content = content || '{"archived": true}'::jsonb, field_edits = field_edits || $2::jsonb WHERE id = $1`, [spread.id, edit]);
      await database.query(`UPDATE tablet_baskets SET record = record || '{"archived": true}'::jsonb WHERE basket_id = $1`, [spread.id]);
      for (const tablet of tablets) {
        const list = (dye2List(tablet, "baskets") as Record_[]).map((record) => (record[GLOBAL_ID_KEY] === spread.id ? { ...record, archived: true } : record));
        expect((await tablet.callApi("POST", `/store/${DYE2_NAMESPACE}/baskets`, list)).status).toBe(200);
      }
      const conflicts = { open: await conflictOf("OPEN"), used: await conflictOf("USED") };
      const before = await decided();
      const untouchedBefore = await stored(untouched.id);

      // Read as none: the REST API shows no `archived`, and the Basket's records are unarchived where it is shown, as the
      // tablets connect again, no Location's state changed.
      expect((await basket(spread.id)).content).toEqual({ name: "Spread 18g", size: "double", diameterMm: 58.5 });
      for (const tablet of tablets) tablet.restoreNetwork();
      for (const tablet of tablets) await expect.poll(() => recordOf(tablet, spread.id)?.archived, { timeout: 15_000 }).toBe(false);
      expect(await decided()).toEqual(before);
      expect(before).toEqual([
        ["Archived content cafe", true],
        ["Archived content lab", true],
      ]);

      await database.query(fs.readFileSync(MIGRATION, "utf8"));

      const after = await stored(spread.id);
      expect(after.content).toEqual({ name: "Spread 18g", size: "double", diameterMm: 58.5 });
      expect(after.edits).not.toHaveProperty("archived");
      expect(Object.keys(after.edits).sort()).toEqual(["diameterMm", "name", "size"]);
      expect(await stored(untouched.id)).toEqual(untouchedBefore);
      const states = await database.query<{ id: string; state: string }>(`SELECT id::text AS id, state::text AS state FROM conflicts WHERE item_id = $1`, [spread.id]);
      expect(Object.fromEntries(states.rows.map((row) => [row.id, row.state]))).toEqual({ [conflicts.open]: "DISMISSED", [conflicts.used]: "USED" });
      expect(await decided()).toEqual(before);
      expect((await basket(spread.id)).archived).toBe(false);

      // Run again, it changes nothing.
      await database.query(fs.readFileSync(MIGRATION, "utf8"));
      expect(await stored(spread.id)).toEqual(after);
    } finally {
      await database.end();
    }
  });
});
