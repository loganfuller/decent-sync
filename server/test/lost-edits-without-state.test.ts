import { setTimeout as delay } from "node:timers/promises";
import { globalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi } from "./support/admin-api.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #653: the migration `20261126000000_lost_edits_without_state`
// drops the `state` of the table Lost Edits are kept in, with its enum and
// its index, which no release since 1.13.0 names in a query (#642). Once
// migrated, none of them is left, and an edit that loses is still kept and
// read in its item's history. Made through the built plugin in simulated
// tablets. Serials are made up, from 20201.

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

describe("Lost Edits without their `state`", { timeout: 90_000 }, () => {
  let server: TestServer;
  let api: AdminApi;

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => {
    await server?.stop();
  });

  it("has no `state` column, `conflict_state` type or index on `state` once migrated", async () => {
    const database = await server.connectDatabase();
    try {
      const column = await database.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'conflicts' AND column_name = 'state'`);
      expect(column.rowCount).toBe(0);
      expect((await database.query(`SELECT 1 FROM pg_type WHERE typname = 'conflict_state'`)).rowCount).toBe(0);
      const indexes = await database.query<{ name: string; definition: string }>(
        `SELECT indexname AS name, indexdef AS definition FROM pg_indexes WHERE tablename = 'conflicts'`,
      );
      expect(indexes.rows.map((index) => index.name)).not.toContain("conflicts_state_created_at_idx");
      for (const index of indexes.rows) expect(index.definition, index.name).not.toMatch(/\bstate\b/);
      expect(indexes.rows.length).toBeGreaterThan(0);
    } finally {
      await database.end();
    }
  });

  it("keeps an edit that loses, and reads it in the item's history", async () => {
    const location = await api.createLocation("Stateless lab", "America/Chicago");
    const first = await api.createMachine("Stateless lab 1", location.id);
    const second = await api.createMachine("Stateless lab 2", location.id);
    const one = syncingTablet(first, server, { api: emptyLibrary("20201") });
    const two = syncingTablet(second, server, { api: emptyLibrary("20202") });
    await api.waitForOnline(first, second);
    await one.addGrinder({ model: "Stateless EK43", burrs: "98mm" });
    const heldGrinder = (tablet: SimulatedTablet) => tablet.grinders().find((record) => record.model === "Stateless EK43");
    await expect.poll(() => globalIdOf(heldGrinder(two) ?? {})).toBeTruthy();
    await expect.poll(() => globalIdOf(heldGrinder(one) ?? {})).toBeTruthy();
    const grinderId = globalIdOf(heldGrinder(one)!)!;

    // Both edit it offline; the earlier comes back first, and loses to the later, which it had not seen.
    one.loseNetwork();
    two.loseNetwork();
    await one.editGrinder(heldGrinder(one)!.id, { burrs: "98mm Turkish" });
    await delay(20);
    await two.editGrinder(heldGrinder(two)!.id, { burrs: "98mm Coffee" });
    one.restoreNetwork();
    const content = async () => (await api.get<{ grinder: { content: Record<string, unknown> } }>(`/grinders/${grinderId}`)).grinder.content;
    await expect.poll(async () => (await content()).burrs).toBe("98mm Turkish");
    two.restoreNetwork();
    await expect.poll(async () => (await content()).burrs).toBe("98mm Coffee");

    const lostEdits = async () => (await api.get<{ lostEdits: Record<string, unknown>[] }>(`/grinders/${grinderId}/history`)).lostEdits;
    await expect.poll(async () => (await lostEdits()).length).toBe(1);
    expect((await lostEdits())[0]).toMatchObject({
      field: "burrs",
      value: "98mm Turkish",
      source: { machine: { id: first.machine.id } },
      lostTo: { value: "98mm Coffee", source: { machine: { id: second.machine.id } } },
    });
    expect((await api.get<{ lostEdits: unknown[] }>(`/grinders/${grinderId}/history?field=burrs`)).lostEdits).toHaveLength(1);
  });
});
