import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite } from "./support/admin-api.js";
import { RawConnection, helloWith } from "./support/simulated-tablet.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1 for ticket #433: a Machine's Settings History read through the REST
// API, as a list of its changes and as its collections as of a time, against
// a real server. The history is recorded from raw frames, as #432 records it
// (settings-history.test.ts); when each value was received is then set in
// PostgreSQL, as something the server is not told of, where a test needs
// times further apart than it can wait. Values are made up, shaped as Decaid
// reports them (COLLECTIONS.md); serials are made up.

interface FieldChange {
  field: string;
  change: "added" | "changed" | "removed";
  before: unknown;
  after: unknown;
  backAt: string | null;
}
interface Change {
  id: string;
  receivedAt: string;
  collection: string;
  settingsEdit: { id: string; account: { id: string; name: string | null } | null; connectedApp: unknown } | null;
  fields: FieldChange[];
}
interface Page {
  changes: Change[];
  total: number;
  limit: number;
  offset: number;
}
interface Collection {
  name: string;
  available: boolean;
  reportedAt: string;
  receivedAt: string | null;
  items: number | null;
  value: unknown;
  utcOffsetMinutes: number | null;
}
interface Frame {
  type: string;
  id?: string;
}

const MACHINE = { fan: 50, steamPurgeMode: 0, steamFlow: 1.5, hotWaterFlow: 6, flushFlow: 6, flushTemp: 90, flushTimeout: 3, tankTemp: 0, usb: true };
const ADVANCED = { heaterPh1Flow: 2, heaterPh2Flow: 4, heaterIdleTemp: 99, heaterPh2Timeout: 1, heaterVoltage: 120, refillKitSetting: 0 };
const MORNING = { id: "sched-morning", time: "06:30", daysOfWeek: [1, 2, 3, 4, 5], enabled: true };
const PRESENCE = { userPresenceEnabled: true, sleepTimeoutMinutes: 30, schedules: [] as unknown[] };
const read = (target: string, measuredValue: number) => ({ target, source: "current", de1ReportedValue: target === "temperature" ? 0 : 1, measuredValue });
const CALIBRATION = { flow: read("flow", 1), pressure: read("pressure", 1.0234375), temperature: read("temperature", 0) };
const PLUGIN = { id: "decent-sync.reaplugin", version: "1.7.1", loaded: true, source: { kind: "github_release", releaseTag: "v1.7.1", lastChecked: "2026-11-07T07:10:46.408380" } };
const SCALE = { name: "Mock Scale", id: "MockScale", state: "connected", type: "scale", available: true, connectionRole: "primary" };

/** When the first value of a timeline was received: 09:00 UTC on 8 November 2026. */
const START = Date.UTC(2026, 10, 8, 9);
const minutes = (count: number) => new Date(START + count * 60_000).toISOString();

describe("a Machine's Settings History through the REST API", () => {
  let server: TestServer;
  let api: AdminApi;
  let elsewhere: LocationView;

  beforeAll(async () => {
    server = await startTestServer({ env: { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" } });
    api = await AdminApi.setUp(server.url);
    // Staff who work where none of the Machines are.
    elsewhere = await api.createLocation("Elsewhere", "America/New_York");
  });
  afterAll(async () => {
    await server?.stop();
  });

  const report = (name: string, value: unknown, extra: Record<string, unknown> = {}) => ({ type: "collection", id: randomUUID(), name, available: true, value, ...extra });
  const connect = (machine: CreatedMachine) => RawConnection.welcomed(server.url, helloWith(machine.token, { tabletId: randomUUID() }));
  const historyPath = (machine: CreatedMachine, query: Record<string, string | string[]> = {}) => {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) for (const each of [value].flat()) params.append(name, each);
    return `/machines/${machine.machine.id}/settings-history${params.size > 0 ? `?${params}` : ""}`;
  };
  const changes = (machine: CreatedMachine, query: Record<string, string | string[]> = {}, by = api) => by.get<Page>(historyPath(machine, query));
  const asOf = async (machine: CreatedMachine, name: string, at: string) =>
    (await api.get<{ collection: Collection | null }>(`/machines/${machine.machine.id}/collections/${name}?${new URLSearchParams({ at })}`)).collection;

  /**
   * Sets when each of the Machine's values was received, in the order they
   * were recorded: the first at START, and each after it the minutes given
   * after START, by PostgreSQL's clock.
   */
  async function receivedAt(machine: CreatedMachine, offsets: number[]): Promise<void> {
    const database = await server.connectDatabase();
    try {
      const { rows } = await database.query<{ id: string }>("SELECT id FROM settings_history WHERE machine_id = $1 ORDER BY id", [machine.machine.id]);
      expect(rows).toHaveLength(offsets.length);
      for (const [index, { id }] of rows.entries()) {
        await database.query("UPDATE settings_history SET received_at = $2 WHERE id = $1", [id, minutes(offsets[index]!)]);
      }
    } finally {
      await database.end();
    }
  }

  describe("a Machine whose collections changed through a morning", () => {
    let machine: CreatedMachine;

    beforeAll(async () => {
      machine = await api.createMachine("Settings through a morning");
      const raw = await connect(machine);
      // The baselines, each received at START.
      const baselines: [string, unknown][] = [
        ["machineSettings", MACHINE],
        ["presenceSettings", PRESENCE],
        ["sensorCalibration", CALIBRATION],
        ["plugins", [PLUGIN]],
        ["pairedDevices", [SCALE]],
      ];
      for (const [name, value] of baselines) await raw.deliver(report(name, value, name === "presenceSettings" ? { utcOffsetMinutes: -300 } : {}));
      // Then a change every 10 minutes from 09:10.
      const morning: [string, unknown][] = [
        // The fan, beside the Workflow's steam flow, which is no change.
        ["machineSettings", { ...MACHINE, fan: 45, steamFlow: 0.8 }],
        ["presenceSettings", { ...PRESENCE, schedules: [MORNING] }],
        ["presenceSettings", { ...PRESENCE, schedules: [{ ...MORNING, time: "07:00" }] }],
        ["sensorCalibration", { ...CALIBRATION, pressure: read("pressure", 1.02) }],
        ["plugins", [{ ...PLUGIN, version: "1.8.0", source: { ...PLUGIN.source, releaseTag: "v1.8.0", lastChecked: "2026-11-08T09:40:00.000000" } }]],
        ["pairedDevices", [SCALE, { name: "Other Scale", id: "OtherScale", state: "disconnected", type: "scale", available: false }]],
        ["presenceSettings", { ...PRESENCE, sleepTimeoutMinutes: 45, schedules: [] }],
      ];
      for (const [name, value] of morning) await raw.deliver(report(name, value, name === "presenceSettings" ? { utcOffsetMinutes: -300 } : {}));
      await raw.close();
      await receivedAt(machine, [...baselines.map(() => 0), ...morning.map((_, index) => 10 * (index + 1))]);
    });

    it("lists its changes newest first, each field before and after as compared, from outside Decent Sync, its baselines none", async () => {
      const page = await changes(machine);
      expect(page).toMatchObject({ total: 7, limit: 20, offset: 0 });
      const outside = (receivedAt: string, collection: string, fields: Omit<FieldChange, "backAt">[]) => ({
        id: expect.stringMatching(/^\d+$/),
        receivedAt,
        collection,
        settingsEdit: null,
        fields: fields.map((field) => ({ ...field, backAt: null })),
      });
      const morning = { time: "06:30", daysOfWeek: [1, 2, 3, 4, 5], enabled: true, keepAwakeFor: null };
      expect(page.changes).toEqual([
        outside(minutes(70), "presenceSettings", [
          { field: "sleepTimeoutMinutes", change: "changed", before: 30, after: 45 },
          { field: "schedules/sched-morning", change: "removed", before: { ...morning, time: "07:00" }, after: null },
        ]),
        outside(minutes(60), "pairedDevices", [{ field: "OtherScale", change: "added", before: null, after: { name: "Other Scale", id: "OtherScale", type: "scale" } }]),
        outside(minutes(50), "plugins", [
          {
            field: "decent-sync.reaplugin",
            change: "changed",
            before: { ...PLUGIN, source: { kind: "github_release", releaseTag: "v1.7.1" } },
            after: { ...PLUGIN, version: "1.8.0", source: { kind: "github_release", releaseTag: "v1.8.0" } },
          },
        ]),
        outside(minutes(40), "sensorCalibration", [{ field: "pressure", change: "changed", before: 1.0234375, after: 1.02 }]),
        outside(minutes(30), "presenceSettings", [{ field: "schedules/sched-morning", change: "changed", before: morning, after: { ...morning, time: "07:00" } }]),
        outside(minutes(20), "presenceSettings", [{ field: "schedules/sched-morning", change: "added", before: null, after: morning }]),
        outside(minutes(10), "machineSettings", [{ field: "fan", change: "changed", before: 50, after: 45 }]),
      ]);
      // Every account that reads the Machine reads its history: Staff, and a Viewer.
      const staff = await api.staffAt("history-staff@example.com", elsewhere);
      expect(await changes(machine, {}, staff)).toEqual(page);
      const { link } = await api.invite("history-viewer@example.com", "viewer");
      const viewer = AdminApi.signedInAs(server.url, await acceptInvite(server.url, link, { name: "Viewer", password: "viewer password 1" }));
      expect(await changes(machine, {}, viewer)).toEqual(page);
    });

    it("pages them, and narrows them to collections and to a range of when they were received", async () => {
      const all = (await changes(machine)).changes;
      expect(await changes(machine, { limit: "2", offset: "1" })).toEqual({ changes: all.slice(1, 3), total: 7, limit: 2, offset: 1 });
      expect(await changes(machine, { limit: "2", offset: "6" })).toEqual({ changes: all.slice(6), total: 7, limit: 2, offset: 6 });
      const named = await changes(machine, { collection: ["sensorCalibration", "machineSettings"] });
      expect(named).toMatchObject({ total: 2, changes: [{ collection: "sensorCalibration" }, { collection: "machineSettings" }] });
      expect(await changes(machine, { collection: "presenceSettings" })).toMatchObject({ total: 3 });
      // From is included and to is not, each a moment with its offset.
      const ranged = await changes(machine, { from: "2026-11-08T04:20:00-05:00", to: minutes(50) });
      expect(ranged.changes.map((change) => change.receivedAt)).toEqual([minutes(40), minutes(30), minutes(20)]);
      expect(await changes(machine, { from: minutes(71) })).toMatchObject({ total: 0, changes: [] });
    });

    it("gives each collection as last received at or before a time, the value whole as sent, and none before its first", async () => {
      expect(await asOf(machine, "presenceSettings", minutes(35))).toEqual({
        name: "presenceSettings",
        available: true,
        reportedAt: minutes(30),
        receivedAt: minutes(30),
        items: null,
        value: { ...PRESENCE, schedules: [{ ...MORNING, time: "07:00" }] },
        utcOffsetMinutes: -300,
      });
      // At the moment it was received, and given with another offset.
      expect(await asOf(machine, "machineSettings", "2026-11-08T04:10:00-05:00")).toMatchObject({ receivedAt: minutes(10), value: { ...MACHINE, fan: 45, steamFlow: 0.8 } });
      expect(await asOf(machine, "machineSettings", minutes(9))).toMatchObject({ receivedAt: minutes(0), value: MACHINE });
      expect(await asOf(machine, "plugins", minutes(60))).toMatchObject({ items: 1, value: [expect.objectContaining({ version: "1.8.0" })] });
      expect(await asOf(machine, "machineSettings", minutes(-1))).toBeNull();
      // A collection never reported.
      expect(await asOf(machine, "advancedSettings", minutes(60))).toBeNull();
    });

    it("refuses a time or filter it can't read, a Library list as of a time, and an unknown Machine or collection", async () => {
      const refused = async (path: string, status: number, message: RegExp) => {
        const response = await api.call("GET", path);
        expect(response.status, path).toBe(status);
        expect(JSON.stringify(await response.json()), path).toMatch(message);
      };
      const base = `/machines/${machine.machine.id}`;
      await refused(`${base}/collections/machineSettings?at=2026-11-08T09:00:00`, 400, /with its offset/);
      await refused(`${base}/collections/machineSettings?at=yesterday`, 400, /with its offset/);
      await refused(`${base}/collections/beans?at=${minutes(0)}`, 400, /Library's own history/);
      await refused(`${base}/collections/unknown?at=${minutes(0)}`, 404, /No such collection/);
      await refused(historyPath(machine, { collection: "beans" }), 400, /Choose each collection/);
      await refused(historyPath(machine, { from: "2026-11-08" }), 400, /with its offset/);
      await refused(historyPath(machine, { from: minutes(10), to: minutes(10) }), 400, /end after the start/);
      await refused(historyPath(machine, { includeBrief: "yes" }), 400, /true or false/);
      await refused(historyPath(machine, { limit: "101" }), 400, /between 1 and 100/);
      await refused(`/machines/${randomUUID()}/settings-history`, 404, /No such Machine/);
      await refused(`/machines/${randomUUID()}/collections/machineSettings?at=${minutes(0)}`, 404, /No such Machine/);
    });
  });

  it("names the Settings Edit a read-back's change was made by, and who made it to Admins only, and gives a change beside it as from outside", async () => {
    const machine = await api.createMachine("Settings through an edit");
    const raw = await connect(machine);
    await raw.deliver(report("advancedSettings", ADVANCED));
    await api.waitForOnline(machine);
    const { settingsEdit } = await api.send<{ settingsEdit: { id: string } }>(
      "POST",
      `/machines/${machine.machine.id}/settings-edits`,
      { collection: "advancedSettings", fields: { heaterPh1Flow: 3 }, expected: { heaterPh1Flow: 2 } },
      201,
    );
    await expect.poll(() => raw.messages.some((message) => (message as Frame).type === "settingsEdit" && (message as Frame).id === settingsEdit.id)).toBe(true);
    // The read-back holds the refill kit changed on the Tablet meanwhile.
    await raw.deliver(report("advancedSettings", { ...ADVANCED, heaterPh1Flow: 3, heaterIdleTemp: 97 }, { settingsEditId: settingsEdit.id }));
    await raw.deliver({ type: "settingsEdited", id: settingsEdit.id, outcome: "written", values: { heaterPh1Flow: 3 } });
    await raw.close();

    const { changes: [made, beside], total } = await changes(machine);
    expect(total).toBe(2);
    const adminId = (await api.get<{ account: { id: string } }>("/session")).account.id;
    expect(made).toEqual({
      id: beside!.id,
      receivedAt: beside!.receivedAt,
      collection: "advancedSettings",
      settingsEdit: { id: settingsEdit.id, account: { id: adminId, name: "Ada Admin" }, connectedApp: null },
      fields: [{ field: "heaterPh1Flow", change: "changed", before: 2, after: 3, backAt: null }],
    });
    expect(beside).toMatchObject({ settingsEdit: null, fields: [{ field: "heaterIdleTemp", before: 99, after: 97 }] });
    // Staff see who made it by id only, as in its Settings Edit.
    const staff = await api.staffAt("history-edit-staff@example.com", elsewhere);
    expect((await changes(machine, {}, staff)).changes[0]!.settingsEdit).toEqual({ id: settingsEdit.id, account: { id: adminId, name: null }, connectedApp: null });
  });

  it("folds a field changed from outside and changed back within about 2 minutes into one brief change, left out unless asked for", async () => {
    const machine = await api.createMachine("Settings briefly changed");
    const raw = await connect(machine);
    const values: [string, unknown][] = [
      ["advancedSettings", ADVANCED],
      ["pairedDevices", [SCALE]],
      // The refill kit on automatic after the machine reconnects, then the kept value, Decaid's within moments.
      ["advancedSettings", { ...ADVANCED, refillKitSetting: 2 }],
      ["advancedSettings", ADVANCED],
      // The scale left out while it connects, and back, connecting.
      ["pairedDevices", []],
      ["pairedDevices", [{ ...SCALE, state: "connecting", available: false }]],
      // Changed back 3 minutes later: two changes.
      ["advancedSettings", { ...ADVANCED, heaterIdleTemp: 97 }],
      ["advancedSettings", ADVANCED],
      // Changed at the end of a range, and back just after it.
      ["advancedSettings", { ...ADVANCED, refillKitSetting: 1 }],
      ["advancedSettings", ADVANCED],
    ];
    for (const [name, value] of values) await raw.deliver(report(name, value));
    await raw.close();
    await receivedAt(machine, [0, 0, 10, 11, 20, 20.5, 30, 33, 40, 41]);

    const shown = await changes(machine);
    expect(shown.changes.map((change) => [change.receivedAt, change.fields.map((field) => field.field)])).toEqual([
      [minutes(33), ["heaterIdleTemp"]],
      [minutes(30), ["heaterIdleTemp"]],
    ]);
    const all = await changes(machine, { includeBrief: "true" });
    expect(all.total).toBe(5);
    expect(all.changes.map((change) => [change.receivedAt, change.fields])).toEqual([
      [minutes(40), [{ field: "refillKitSetting", change: "changed", before: 0, after: 1, backAt: minutes(41) }]],
      [minutes(33), [expect.objectContaining({ field: "heaterIdleTemp", backAt: null })]],
      [minutes(30), [expect.objectContaining({ field: "heaterIdleTemp", backAt: null })]],
      [minutes(20), [{ field: "MockScale", change: "removed", before: { name: "Mock Scale", id: "MockScale", type: "scale" }, after: null, backAt: minutes(20.5) }]],
      [minutes(10), [{ field: "refillKitSetting", change: "changed", before: 0, after: 2, backAt: minutes(11) }]],
    ]);
    // A range ending before the change back still folds it.
    expect(await changes(machine, { to: minutes(40.5) })).toMatchObject({ total: 2 });
    expect(await changes(machine, { to: minutes(40.5), includeBrief: "true" })).toMatchObject({ total: 5 });
  });
});
