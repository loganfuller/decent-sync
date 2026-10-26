import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi } from "./support/admin-api.js";
import { syncingTablet } from "./support/loaded-tablets.js";
import { preheatShotFixture, withShots } from "./support/shot-fixtures.js";
import { derivedDe1Pro } from "./support/simulated-tablet.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1: the Shots stored before Preheat was left out of their duration and
// peaks (ticket #287), at curves revision 0, as 1.2.0 stores them, are
// computed again from their measurements by the server. Each Shot is the
// real one with a long Preheat, under another id.

interface Curves { duration: number | null; peakPressure: number | null; peakFlow: number | null }

describe("Shots stored with an earlier curves revision", () => {
  let server: TestServer;
  let api: AdminApi;
  const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => { await server?.stop(); });

  const curves = async (id: string) => (await api.get<{ shot: Curves }>(`/shots/${id}`)).shot;

  it("are computed again as an instance starts, and those at the current revision are left as they are", async () => {
    const machine = await api.createMachine("Refreshed");
    const shots = ["refresh-old", "refresh-current"].map((id) => ({ ...preheatShotFixture(), id }));
    syncingTablet(machine, server, { api: withShots(derivedDe1Pro({ serial: "10001" }), shots) });
    await expect.poll(async () => (await api.get<{ total: number }>("/shots")).total).toBe(2);
    expect(await curves("refresh-old")).toMatchObject({ peakFlow: 8.045166015625, peakPressure: 8.01220703125 });

    const database = await server.connectDatabase();
    try {
      // As 1.2.0 stored it: Preheat counted in its duration and peaks, and not kept.
      await database.query(
        "UPDATE shots SET duration = 33.196, peak_flow = 8.053466796875, preheat = NULL, curves_revision = 0 WHERE id = 'refresh-old'",
      );
      // Stored at the current revision, with a duration no revision computes, so a change shows.
      await database.query("UPDATE shots SET duration = 99 WHERE id = 'refresh-current'");
    } finally {
      await database.end();
    }
    expect(await curves("refresh-old")).toMatchObject({ duration: 33.196, peakFlow: 8.053466796875 });

    const other = await startTestServer({ env, sharing: server });
    try {
      await expect.poll(async () => (await curves("refresh-old")).duration).toBeCloseTo(25.833, 3);
      expect(await curves("refresh-old")).toMatchObject({ peakFlow: 8.045166015625, peakPressure: 8.01220703125 });
      expect(other.output()).toMatch(/Computed the Preheat, duration and peaks of 1 stored Shot again/);
      expect((await curves("refresh-current")).duration).toBe(99);
    } finally {
      await other.stop();
    }
  });
});
