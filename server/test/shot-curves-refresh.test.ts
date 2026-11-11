import { stripVTControlCharacters } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi } from "./support/admin-api.js";
import { syncingTablet } from "./support/loaded-tablets.js";
import { derivedShot, preheatShotFixture, withShots } from "./support/shot-fixtures.js";
import { derivedDe1Pro } from "./support/simulated-tablet.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1: the Shots stored before Preheat was left out of their shown
// duration and peaks (ticket #287), at curves revision 0, as 1.2.0 stores
// them, are computed again from their measurements by the server. Each Shot
// is the real one with a long Preheat, under another id. So are those stored
// before a Shot kept what its samples show of how it went (ticket #467), at
// revision 1, as 1.8.2 stores them: each a real Shot under another id, of 4
// samples, whose scale first read 1 g or more, 25.8 g, 21.45 s into its
// profile, which ended in its Pressure Decline step at 3.216 g/s.

interface Curves { duration: number | null; peakPressure: number | null; peakFlow: number | null }
/** What a Shot's read and its row in the list give of what its samples show. */
interface Measured { id: string; timeToFirstDrip: number | null; lastStep: { frame: number; name: string } | null; flowAtStop?: number | null }

/** How many Shots a server's log says its refresh computed again. */
function computedAgain(instance: TestServer): number {
  const counts = stripVTControlCharacters(instance.output()).matchAll(/Computed the Preheat, peaks and measured values of (\d+) stored Shots? again/g);
  return [...counts].reduce((sum, [, count]) => sum + Number(count), 0);
}

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
      // As 1.2.0 stored it: its whole recording as its duration, as this release stores it too, Preheat counted
      // in its peaks, and none kept.
      const { rows } = await database.query<{ duration: number }>("SELECT duration FROM shots WHERE id = 'refresh-old'");
      expect(rows[0]!.duration).toBeCloseTo(33.196, 3);
      await database.query("UPDATE shots SET peak_flow = 8.053466796875, preheat = NULL, curves_revision = 0 WHERE id = 'refresh-old'");
      // Stored at the current revision, with a peak no revision computes, so a change shows.
      await database.query("UPDATE shots SET peak_flow = 99 WHERE id = 'refresh-current'");
    } finally {
      await database.end();
    }
    // Until then it shows what 1.2.0 shows.
    expect(await curves("refresh-old")).toMatchObject({ peakFlow: 8.053466796875 });
    expect((await curves("refresh-old")).duration).toBeCloseTo(33.196, 3);

    const other = await startTestServer({ env, sharing: server });
    try {
      await expect.poll(async () => (await curves("refresh-old")).duration).toBe(25.833);
      expect(await curves("refresh-old")).toMatchObject({ peakFlow: 8.045166015625, peakPressure: 8.01220703125 });
      expect(other.output()).toMatch(/Computed the Preheat, peaks and measured values of 1 stored Shot again/);
      expect((await curves("refresh-current")).peakFlow).toBe(99);
    } finally {
      await other.stop();
    }
  });

  it("have what their samples show worked out by the instances that start, each Shot by one of them", async () => {
    const machine = await api.createMachine("Measured later");
    // More than two of a run's batches of 20, and one whose samples name a frame no profile has, which its column still holds.
    const whole = derivedShot("earlier-beyond");
    const beyond = { ...whole, measurements: (whole.measurements as { machine: object }[]).map((sample) => ({ ...sample, machine: { ...sample.machine, profileFrame: 3e10 } })) };
    const shots = [...Array.from({ length: 44 }, (_, n) => derivedShot(`earlier-${n}`)), beyond];
    syncingTablet(machine, server, { api: withShots(derivedDe1Pro({ serial: "10002" }), shots) });
    const listed = async () => (await api.get<{ shots: Measured[] }>("/shots?limit=100")).shots.filter((shot) => shot.id.startsWith("earlier-"));
    await expect.poll(async () => (await listed()).length, { timeout: 60_000 }).toBe(45);
    const measured = async (id: string) => (await api.get<{ shot: Measured & { lastRecordedWeight: unknown } }>(`/shots/${id}`)).shot;
    expect(await measured("earlier-0")).toMatchObject({ timeToFirstDrip: 21.45, flowAtStop: 3.21596222288838 });

    const database = await server.connectDatabase();
    try {
      // As 1.8.2 stores them: at revision 1, with none of what their samples show.
      await database.query(
        `UPDATE shots SET curves_revision = 1, time_to_first_drip = NULL, last_step_frame = NULL, last_step_name = NULL, poured = NULL,
           last_weight = NULL, last_weight_seconds = NULL, flow_at_stop = NULL WHERE id LIKE 'earlier-%' AND id <> 'earlier-0'`,
      );
      // Stored at the current revision, with values no revision works out, so a change would show.
      await database.query("UPDATE shots SET time_to_first_drip = 91, flow_at_stop = 95 WHERE id = 'earlier-0'");
    } finally {
      await database.end();
    }
    // Until then such a Shot gives neither its time to first drip nor its flow at the stop, and its row no step it ended in;
    // its read still gives that step and the scale's last weight, from its samples.
    expect(await measured("earlier-1")).toMatchObject({
      timeToFirstDrip: null,
      flowAtStop: null,
      lastStep: { frame: 4, name: "Pressure Decline" },
      lastRecordedWeight: { weight: 32.5, seconds: 23.549 },
    });
    expect((await listed()).filter((shot) => shot.timeToFirstDrip !== null || shot.lastStep !== null).map((shot) => shot.id)).toEqual(["earlier-0"]);

    const others = await Promise.all([startTestServer({ env, sharing: server }), startTestServer({ env, sharing: server })]);
    try {
      await expect.poll(async () => (await listed()).filter((shot) => shot.timeToFirstDrip === null).length).toBe(0);
      // Each batch takes Shots no other holds, so the two instances' runs computed every Shot, and none twice.
      await expect.poll(() => others.map(computedAgain).reduce((sum, count) => sum + count)).toBe(44);
      const rows = await listed();
      expect(rows.filter((shot) => shot.id !== "earlier-0" && shot.id !== "earlier-beyond").every((shot) => shot.timeToFirstDrip === 21.45 && shot.lastStep?.name === "Pressure Decline")).toBe(true);
      expect(rows.find((shot) => shot.id === "earlier-beyond")).toMatchObject({ timeToFirstDrip: 21.45, lastStep: { frame: 3e10, name: "Step 30000000001" } });
      expect(await measured("earlier-1")).toMatchObject({ timeToFirstDrip: 21.45, flowAtStop: 3.21596222288838 });
      expect(await measured("earlier-0")).toMatchObject({ timeToFirstDrip: 91, flowAtStop: 95 });
      const again = await server.connectDatabase();
      try {
        const { rows: stored } = await again.query("SELECT DISTINCT curves_revision, poured, last_weight, last_weight_seconds FROM shots WHERE id LIKE 'earlier-%'");
        expect(stored).toEqual([{ curves_revision: 2, poured: true, last_weight: 32.5, last_weight_seconds: 23.549 }]);
      } finally {
        await again.end();
      }
    } finally {
      await Promise.all(others.map((other) => other.stop()));
    }
  });
});
