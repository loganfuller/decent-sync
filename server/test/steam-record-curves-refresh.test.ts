import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi } from "./support/admin-api.js";
import { syncingTablet } from "./support/loaded-tablets.js";
import { derivedDe1Pro } from "./support/simulated-tablet.js";
import { liveSteamFixture, withSteams } from "./support/steam-fixtures.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1: a Steam Record's duration counts only its steaming (ticket #308),
// while `duration` keeps the whole recording, as 1.4.0 stores and shows it.
// Those stored before, at curves revision 0, are computed again from their
// measurements by the server. Each is the test tablet's record of steaming
// stopped by a tap in Normal: 16.915 s of steaming in 25.2 s of recording.

interface Listed { id: string; duration: number | null }

describe("A Steam Record's duration", () => {
  let server: TestServer;
  let api: AdminApi;
  const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => { await server?.stop(); });

  const shown = async (id: string) => (await api.get<{ steamRecord: Listed }>(`/steam-records/${id}`)).steamRecord.duration;
  const listed = async (id: string) =>
    (await api.get<{ steamRecords: Listed[] }>("/steam-records?limit=100")).steamRecords.find((steamRecord) => steamRecord.id === id)?.duration;

  it("is its steaming time, stored beside the whole recording, and computed again for one stored before", async () => {
    const machine = await api.createMachine("Steamer");
    const steams = ["steam-refresh-old", "steam-refresh-current"].map((id) => ({ ...liveSteamFixture("steam-record"), id }));
    syncingTablet(machine, server, { api: withSteams(derivedDe1Pro({ serial: "10001" }), steams) });
    await expect.poll(async () => (await api.get<{ total: number }>("/steam-records")).total).toBe(2);
    expect(await shown("steam-refresh-old")).toBe(16.915);
    expect(await listed("steam-refresh-old")).toBe(16.915);

    const database = await server.connectDatabase();
    try {
      const { rows } = await database.query("SELECT id, duration, steaming, curves_revision FROM steam_records ORDER BY id");
      expect(rows).toEqual([
        { id: "steam-refresh-current", duration: 25.2, steaming: 16.915, curves_revision: 1 },
        { id: "steam-refresh-old", duration: 25.2, steaming: 16.915, curves_revision: 1 },
      ]);
      // As 1.4.0 stores it: the whole recording, as this release stores it too, and no steaming time.
      await database.query("UPDATE steam_records SET steaming = NULL, curves_revision = 0 WHERE id = 'steam-refresh-old'");
      // Stored at the current revision, with a steaming time no revision computes, so a change shows.
      await database.query("UPDATE steam_records SET steaming = 99 WHERE id = 'steam-refresh-current'");
    } finally {
      await database.end();
    }
    // Until then it shows what 1.4.0 shows.
    expect(await shown("steam-refresh-old")).toBe(25.2);
    expect(await listed("steam-refresh-old")).toBe(25.2);

    const other = await startTestServer({ env, sharing: server });
    try {
      await expect.poll(() => shown("steam-refresh-old")).toBe(16.915);
      expect(await listed("steam-refresh-old")).toBe(16.915);
      expect(other.output()).toMatch(/Computed the steaming time of 1 stored Steam Record again/);
      expect(await shown("steam-refresh-current")).toBe(99);
    } finally {
      await other.stop();
    }
    // The whole recording is kept as 1.4.0 stores and shows it.
    const after = await server.connectDatabase();
    try {
      const { rows } = await after.query("SELECT duration, steaming, curves_revision FROM steam_records WHERE id = 'steam-refresh-old'");
      expect(rows).toEqual([{ duration: 25.2, steaming: 16.915, curves_revision: 1 }]);
    } finally {
      await after.end();
    }
  });
});
