import { randomUUID } from "node:crypto";
import { COLLECTION_NAMES, SETTINGS_HISTORY_COLLECTIONS } from "@decent-sync/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { LoadedTablets, emptyLibrary } from "./support/loaded-tablets.js";
import { waitForLockWaits } from "./support/lock-waits.js";
import { RawConnection, type SimulatedTablet, helloWith, sensorCalibration } from "./support/simulated-tablet.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1 for ticket #432: each Machine's Settings History, recorded from the
// collections its tablet reports, through the built plugin in a simulated
// tablet, which carries out Settings Edits as Decaid v0.9.1 takes them
// (decaid-settings.ts), and through raw frames, for an edit's read-back
// holding a change made outside it, against real servers sharing one
// PostgreSQL database. The history is read from the database here, as
// recorded; settings-history-reads.test.ts reads it through the REST API.
// Values are made up, shaped as Decaid reports them (COLLECTIONS.md); serials
// are made up.

interface Row {
  name: string;
  value: unknown;
  tabletId: string | null;
  receivedAt: string;
  settingsEditId: string | null;
  editedFields: string[];
}
interface Collection { value: unknown; available: boolean; receivedAt: string | null }
interface SettingsEditView { id: string; outcome: string | null; schedule: { action: string; id: string | null } | null }
interface Frame { type: string; id?: string; tabletId?: string }

/** A value of each collection a Settings History keeps, as a tablet reports it. */
const VALUES = {
  appSettings: { scalePowerMode: "disconnect", keepAwake: true, weightFlowMultiplier: 0.87, chargingState: { mode: "longevity", batteryPercent: 50, usbChargerOn: true } },
  presenceSettings: { userPresenceEnabled: true, sleepTimeoutMinutes: 30, schedules: [{ id: "sched-morning", time: "06:30", daysOfWeek: [1, 2, 3, 4, 5], enabled: true }] },
  machineSettings: { fan: 50, steamPurgeMode: 0, steamFlow: 1.5, hotWaterFlow: 6, flushFlow: 6, flushTemp: 90, flushTimeout: 3, tankTemp: 0, usb: true },
  advancedSettings: { heaterPh1Flow: 2, heaterPh2Flow: 4, heaterIdleTemp: 99, heaterPh2Timeout: 1, heaterVoltage: 120, refillKitSetting: 2 },
  machineCalibration: { flowMultiplier: 1.1 },
  sensorCalibration: calibrationOf(sensorCalibration()),
  plugins: [{ id: "decent-sync.reaplugin", version: "1.7.1", loaded: true, source: { kind: "github_release", releaseTag: "v1.7.1", lastChecked: "2026-11-07T07:10:46.408380" } }],
  skins: { skins: [{ id: "streamline.js", version: "0.2.23" }], default: { id: "streamline.js" }, server: { serving: true, path: "/web-ui/streamline.js" } },
  pairedDevices: [{ name: "Mock Scale", id: "MockScale", state: "connected", type: "scale", available: true, connectionRole: "primary" }],
  scaleInfo: { firmwareVersion: "1.4.2", batteryLevel: 80 },
  sensors: [{ id: "mockSensorBasket", info: { name: "SensorBasket", vendor: "DecentEspresso" } }],
} satisfies Record<(typeof SETTINGS_HISTORY_COLLECTIONS)[number], unknown>;
type Name = keyof typeof VALUES;

/** The sensor calibration Decaid answers in `served`, by target, as the plugin reports it. */
function calibrationOf(served: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(["flow", "pressure", "temperature"].map((target) => [target, served[`/machine/calibration/${target}`]]));
}

describe("Settings History", () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  const tablets = new LoadedTablets();
  let serial = 43_200;
  const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
  });
  afterEach(async () => {
    await tablets.unloadAll();
  });
  afterAll(async () => {
    await server?.stop();
  });

  /** The history held for a Machine, or a Pending Machine, in the order it was written, which a report is compared in, read from the database. */
  async function history(holder: { machineId: string } | { pendingMachineId: string }, name?: string): Promise<Row[]> {
    const database = await server.connectDatabase();
    try {
      const [column, id] = "machineId" in holder ? ["machine_id", holder.machineId] : ["pending_machine_id", holder.pendingMachineId];
      const { rows } = await database.query<Row>(
        `SELECT name, value, tablet_id AS "tabletId", to_json(received_at) #>> '{}' AS "receivedAt",
           settings_edit_id AS "settingsEditId", edited_fields AS "editedFields"
         FROM settings_history WHERE ${column} = $1 AND ($2::text IS NULL OR name = $2) ORDER BY id`,
        [id, name ?? null],
      );
      return rows.map((row) => ({ ...row, receivedAt: new Date(row.receivedAt).toISOString() }));
    } finally {
      await database.end();
    }
  }
  const of = (machine: CreatedMachine) => ({ machineId: machine.machine.id });
  /** Runs a statement on the database, as something the server is not told of. */
  async function execute(sql: string, values: unknown[]): Promise<void> {
    const database = await server.connectDatabase();
    try {
      await database.query(sql, values);
    } finally {
      await database.end();
    }
  }
  const collection = async (machine: CreatedMachine, name: string) =>
    (await api.get<{ collection: Collection | null }>(`/machines/${machine.machine.id}/collections/${name}`)).collection;

  /** A raw connection of the Machine's token, welcomed, from the tablet given, reporting the hardware given or none. */
  async function connect(machine: CreatedMachine, url: string, tabletId: string, hardware?: { model: string; serial: string }): Promise<RawConnection> {
    return RawConnection.welcomed(url, helloWith(machine.token, { tabletId, ...(hardware ? { machine: hardware } : {}) }));
  }
  const report = (name: string, value: unknown, extra: Record<string, unknown> = {}) => ({ type: "collection", id: randomUUID(), name, available: true, value, ...extra });

  /** A Machine whose tablet runs the built plugin, its Library empty, and the id of that tablet. */
  async function connected(name: string): Promise<{ machine: CreatedMachine; tablet: SimulatedTablet; tabletId: string }> {
    const machine = await api.createMachine(name);
    const tablet = tablets.syncing(machine, server, { api: emptyLibrary(serial++) });
    await api.waitForOnline(machine);
    const hello = tablet.sent.find((frame) => (frame as Frame).type === "hello") as Frame;
    return { machine, tablet, tabletId: hello.tabletId! };
  }
  const editsPath = (machine: CreatedMachine) => `/machines/${machine.machine.id}/settings-edits`;
  const make = async (machine: CreatedMachine, body: unknown) => (await api.send<{ settingsEdit: SettingsEditView }>("POST", editsPath(machine), body, 201)).settingsEdit;
  async function answered(machine: CreatedMachine, id: string): Promise<SettingsEditView> {
    const read = async () => (await api.get<{ settingsEdit: SettingsEditView }>(`${editsPath(machine)}/${id}`)).settingsEdit;
    await expect.poll(async () => (await read()).outcome, { timeout: 15_000 }).not.toBeNull();
    return read();
  }

  it("takes each collection's baseline from its first report, as the Tablet sent it and when it was received, and keeps none of the Library's lists", async () => {
    const { machine, tabletId } = await connected("History baseline");
    await expect.poll(async () => (await api.get<{ collections: unknown[] }>(`/machines/${machine.machine.id}/collections`)).collections.length).toBe(COLLECTION_NAMES.length);
    const reported = await Promise.all(SETTINGS_HISTORY_COLLECTIONS.map(async (name) => [name, (await collection(machine, name))!] as const));
    // Every collection kept but the scale's, which no scale connected leaves unavailable.
    expect(reported.filter(([, found]) => !found.available).map(([name]) => name)).toEqual(["scaleInfo"]);
    const rows = await history(of(machine));
    expect(rows.map((row) => row.name).sort()).toEqual(SETTINGS_HISTORY_COLLECTIONS.filter((name) => name !== "scaleInfo").sort());
    for (const [name, found] of reported.filter(([, found]) => found.available)) {
      expect(rows.filter((row) => row.name === name), name).toEqual([{ name, value: found.value, tabletId, receivedAt: found.receivedAt, settingsEditId: null, editedFields: [] }]);
    }
  });

  it("records a changed report of each collection once, whole, with its Tablet and when it was received, from outside Decent Sync, and nothing for one unchanged or changed only in what is left out", async () => {
    const machine = await api.createMachine("History of changes");
    const tabletId = randomUUID();
    const first = await connect(machine, server.url, tabletId);
    for (const [name, value] of Object.entries(VALUES)) await first.deliver(report(name, value));
    await first.close();
    expect((await history(of(machine))).map((row) => row.name)).toEqual(Object.keys(VALUES));

    // Through the other instance, each sent again on a reconnect, then changed only in what other things set.
    const second = await connect(machine, other.url, tabletId);
    for (const [name, value] of Object.entries(VALUES)) await second.deliver(report(name, value));
    const leftOut: Record<Name, unknown> = {
      ...VALUES,
      appSettings: { ...VALUES.appSettings, chargingState: { ...VALUES.appSettings.chargingState, batteryPercent: 49, usbChargerOn: false } },
      presenceSettings: { ...VALUES.presenceSettings, keepAwakeUntil: "2026-11-09T08:30:00.000" },
      machineSettings: { ...VALUES.machineSettings, steamFlow: 0.8, hotWaterFlow: 4, flushFlow: 3, flushTemp: 85, flushTimeout: 5, tankTemp: 20, usb: false },
      plugins: [{ ...VALUES.plugins[0]!, source: { ...VALUES.plugins[0]!.source, lastChecked: "2026-11-08T07:10:46.408380" } }],
      pairedDevices: [{ name: "Mock Scale", id: "MockScale", state: "disconnected", type: "scale", available: false }],
      scaleInfo: { ...VALUES.scaleInfo, batteryLevel: 79 },
    };
    for (const [name, value] of Object.entries(leftOut)) await second.deliver(report(name, value));
    // A daylight saving change alone changes no setting.
    await second.deliver(report("appSettings", leftOut.appSettings, { utcOffsetMinutes: -300 }));
    expect(await history(of(machine))).toHaveLength(Object.keys(VALUES).length);

    // A change of each.
    const changed: Record<Name, unknown> = {
      appSettings: { ...VALUES.appSettings, weightFlowMultiplier: 0.9 },
      presenceSettings: { ...VALUES.presenceSettings, sleepTimeoutMinutes: 45 },
      machineSettings: { ...VALUES.machineSettings, fan: 45 },
      advancedSettings: { ...VALUES.advancedSettings, refillKitSetting: 0 },
      machineCalibration: { flowMultiplier: 0.6 },
      sensorCalibration: calibrationOf(sensorCalibration({ temperature: -0.5 })),
      plugins: [{ ...VALUES.plugins[0]!, version: "1.8.0" }],
      skins: { ...VALUES.skins, default: { id: "insight" } },
      pairedDevices: [...VALUES.pairedDevices, { name: "Other Scale", id: "OtherScale", state: "disconnected", type: "scale", available: false }],
      scaleInfo: { ...VALUES.scaleInfo, firmwareVersion: "1.4.3" },
      sensors: [],
    };
    for (const [name, value] of Object.entries(changed)) {
      await second.deliver(report(name, value, name === "appSettings" || name === "presenceSettings" ? { utcOffsetMinutes: -300 } : {}));
    }
    await second.close();
    const rows = await history(of(machine));
    expect(rows).toHaveLength(2 * Object.keys(VALUES).length);
    for (const [name, value] of Object.entries(changed)) {
      const latest = rows.filter((row) => row.name === name);
      expect(latest, name).toHaveLength(2);
      expect(latest[1], name).toEqual({ name, value, tabletId, receivedAt: (await collection(machine, name))!.receivedAt, settingsEditId: null, editedFields: [] });
    }
    // An unavailable report records nothing.
    const third = await connect(machine, server.url, tabletId);
    await third.deliver({ type: "collection", id: randomUUID(), name: "scaleInfo", available: false });
    await third.close();
    expect(await history(of(machine))).toHaveLength(rows.length);
  });

  it("labels the changes an edit's read-back makes to the fields the edit set with that edit, whatever came of it, and every other change as from outside", async () => {
    const machine = await api.createMachine("History of an edit");
    const raw = await connect(machine, server.url, randomUUID());
    await raw.deliver(report("advancedSettings", VALUES.advancedSettings));
    await api.waitForOnline(machine);
    const edit = await make(machine, {
      collection: "advancedSettings",
      fields: { heaterPh1Flow: 3, heaterPh2Flow: 5, refillKitSetting: 0 },
      expected: { heaterPh1Flow: 2, heaterPh2Flow: 4, refillKitSetting: 2 },
    });
    await expect.poll(() => raw.messages.some((message) => (message as Frame).type === "settingsEdit" && (message as Frame).id === edit.id)).toBe(true);
    // Decaid took the heater flows, the second at another value, and refused the refill kit; meanwhile the idle
    // temperature was changed on the Tablet.
    const readBack = { ...VALUES.advancedSettings, heaterPh1Flow: 3, heaterPh2Flow: 4.9, heaterIdleTemp: 97 };
    await raw.deliver(report("advancedSettings", readBack, { settingsEditId: edit.id }));
    await raw.deliver({
      type: "settingsEdited",
      id: edit.id,
      outcome: "refused",
      reason: "decaid",
      status: 500,
      message: "TimeoutException: the machine did not answer",
      values: { heaterPh1Flow: 3, heaterPh2Flow: 4.9, refillKitSetting: 2 },
    });
    let rows = await history(of(machine), "advancedSettings");
    expect(rows.slice(1)).toEqual([expect.objectContaining({ value: readBack, settingsEditId: edit.id, editedFields: ["heaterPh1Flow", "heaterPh2Flow"] })]);

    // A change in a report naming no edit, an edit of another collection or of another Machine, or an edit whose
    // fields it doesn't change, is from outside.
    const elsewhere = await api.createMachine("Elsewhere");
    const otherRaw = await connect(elsewhere, server.url, randomUUID());
    await api.waitForOnline(elsewhere);
    const otherEdit = await make(elsewhere, { collection: "machineCalibration", fields: { flowMultiplier: 1.2 }, expected: { flowMultiplier: 1.1 } });
    await otherRaw.close();
    const outside = [
      report("advancedSettings", { ...readBack, refillKitSetting: 0 }),
      report("advancedSettings", { ...readBack, refillKitSetting: 1 }, { settingsEditId: otherEdit.id }),
      report("advancedSettings", { ...readBack, refillKitSetting: 2 }, { settingsEditId: randomUUID() }),
      report("advancedSettings", { ...readBack, heaterIdleTemp: 99, refillKitSetting: 2 }, { settingsEditId: edit.id }),
    ];
    for (const delivery of outside) await raw.deliver(delivery);
    await raw.close();
    rows = await history(of(machine), "advancedSettings");
    expect(rows.slice(2)).toEqual(outside.map((delivery) => expect.objectContaining({ value: delivery.value, settingsEditId: null, editedFields: [] })));
  });

  it("labels an edit applied, and one the Machine stored otherwise, through the built plugin, with the edit", async () => {
    const { machine } = await connected("History of applied edits");
    await expect.poll(async () => (await history(of(machine), "machineCalibration")).length).toBe(1);
    const applied = await make(machine, { collection: "machineSettings", fields: { fan: 40 }, expected: { fan: 50 } });
    expect((await answered(machine, applied.id)).outcome).toBe("applied");
    // 1.001 times 1000 is 1000.9999999999999 in floating point, which Decaid truncates to 1000.
    const adjusted = await make(machine, { collection: "machineCalibration", fields: { flowMultiplier: 1.001 }, expected: { flowMultiplier: 1.1 } });
    expect((await answered(machine, adjusted.id)).outcome).toBe("adjusted");
    expect((await history(of(machine), "machineSettings")).slice(1)).toEqual([
      expect.objectContaining({ value: expect.objectContaining({ fan: 40 }), settingsEditId: applied.id, editedFields: ["fan"] }),
    ]);
    expect((await history(of(machine), "machineCalibration")).slice(1)).toEqual([
      expect.objectContaining({ value: { flowMultiplier: 1 }, settingsEditId: adjusted.id, editedFields: ["flowMultiplier"] }),
    ]);
  });

  it("compares the wake schedules by their ids and the sensor calibration by target, labelling the schedule an edit added, changed or deleted, and the target it set", async () => {
    const { machine, tablet } = await connected("History of schedules and calibration");
    await expect.poll(async () => (await history(of(machine), "sensorCalibration")).length).toBe(1);
    const add = await make(machine, {
      collection: "presenceSettings",
      schedule: { action: "add" },
      fields: { time: "06:30", daysOfWeek: [1, 2, 3, 4, 5], enabled: true, keepAwakeFor: null },
      expected: {},
    });
    const added = await answered(machine, add.id);
    const id = added.schedule!.id!;
    const key = `schedules/${id}`;
    const schedule = { id, time: "06:30", daysOfWeek: [1, 2, 3, 4, 5], enabled: true };
    const change = await make(machine, { collection: "presenceSettings", schedule: { action: "change", id }, fields: { time: "07:00" }, expected: schedule });
    await answered(machine, change.id);
    const remove = await make(machine, { collection: "presenceSettings", schedule: { action: "delete", id }, fields: {}, expected: { ...schedule, time: "07:00" } });
    await answered(machine, remove.id);
    const presence = await history(of(machine), "presenceSettings");
    expect(presence.slice(1).map((row) => [row.settingsEditId, row.editedFields])).toEqual([
      [add.id, [key]],
      [change.id, [key]],
      [remove.id, [key]],
    ]);

    const sensors = (await collection(machine, "sensorCalibration"))!.value as Record<string, { measuredValue: number }>;
    const set = await make(machine, { collection: "sensorCalibration", fields: { pressure: 1.02 }, expected: { pressure: sensors.pressure!.measuredValue } });
    await answered(machine, set.id);
    expect((await history(of(machine), "sensorCalibration")).slice(1)).toEqual([expect.objectContaining({ settingsEditId: set.id, editedFields: ["pressure"] })]);

    // A schedule added on the Tablet itself is from outside.
    const { status } = await tablet.callApi("POST", "/presence/schedules", { time: "12:00", daysOfWeek: [], enabled: true });
    expect(status).toBe(201);
    tablet.dropConnections();
    await expect.poll(async () => (await history(of(machine), "presenceSettings")).length).toBe(presence.length + 1);
    expect((await history(of(machine), "presenceSettings")).at(-1)).toMatchObject({ settingsEditId: null, editedFields: [] });
  });

  it("takes a baseline from the latest value stored before the history was kept: as a report finds none, and for every other collection as an instance starts", async () => {
    const machine = await api.createMachine("History from before");
    const tabletId = randomUUID();
    const raw = await connect(machine, server.url, tabletId);
    for (const name of ["advancedSettings", "machineCalibration"] as const) await raw.deliver(report(name, VALUES[name]));
    // As if stored by a release that kept no history.
    await execute("DELETE FROM settings_history WHERE machine_id = $1", [machine.machine.id]);
    const stored = (await collection(machine, "advancedSettings"))!;

    const changed = { ...VALUES.advancedSettings, refillKitSetting: 0 };
    await raw.deliver(report("advancedSettings", changed));
    await raw.close();
    expect(await history(of(machine))).toEqual([
      { name: "advancedSettings", value: VALUES.advancedSettings, tabletId: null, receivedAt: stored.receivedAt, settingsEditId: null, editedFields: [] },
      expect.objectContaining({ name: "advancedSettings", value: changed, tabletId }),
    ]);

    // An instance starting takes the baseline of what nothing reported since.
    const calibration = (await collection(machine, "machineCalibration"))!;
    const starting = await startTestServer({ env, sharing: server });
    try {
      await expect.poll(() => history(of(machine), "machineCalibration")).toEqual([
        { name: "machineCalibration", value: VALUES.machineCalibration, tabletId: null, receivedAt: calibration.receivedAt, settingsEditId: null, editedFields: [] },
      ]);
    } finally {
      await starting.stop();
    }
    expect(await history(of(machine), "advancedSettings")).toHaveLength(2);
  });

  it("holds a mismatched connection's history for hardware without a Machine, takes its baselines too, and hands it to the Machine that takes the hardware over", async () => {
    const machine = await api.createMachine("Binds its hardware later");
    const visitor = await api.createMachine("Visiting tablet");
    const hardware = { model: "DE1Pro", serial: "43901" };
    const ownTablet = randomUUID();
    const visitingTablet = randomUUID();
    // The Machine's own tablet reports before its machine is on.
    const early = await connect(machine, server.url, ownTablet);
    await early.deliver(report("machineSettings", VALUES.machineSettings));
    await early.close();
    // The visitor's tablet, moved onto the machine, reports a change and another collection, which its Pending Machine holds.
    await (await connect(visitor, other.url, visitingTablet, { model: "DE1Pro", serial: "43902" })).close();
    const mismatched = await connect(visitor, other.url, visitingTablet, hardware);
    await mismatched.deliver(report("machineSettings", { ...VALUES.machineSettings, fan: 45 }));
    await mismatched.deliver(report("advancedSettings", VALUES.advancedSettings));
    await mismatched.deliver(report("machineCalibration", VALUES.machineCalibration));
    await mismatched.close();
    const pending = (await api.pendingMachines()).find((candidate) => candidate.serial === hardware.serial)!;
    expect((await history({ pendingMachineId: pending.id })).map((row) => [row.name, row.tabletId])).toEqual([
      ["machineSettings", visitingTablet],
      ["advancedSettings", visitingTablet],
      ["machineCalibration", visitingTablet],
    ]);
    // A baseline the Pending Machine lacks is taken as an instance starts.
    await execute("DELETE FROM settings_history WHERE pending_machine_id = $1 AND name = 'machineCalibration'", [pending.id]);
    const starting = await startTestServer({ env, sharing: server });
    try {
      await expect.poll(async () => (await history({ pendingMachineId: pending.id }, "machineCalibration")).length).toBe(1);
    } finally {
      await starting.stop();
    }

    // The Machine's tablet reports the hardware: its token binds it, and the Machine takes over the history held.
    await (await connect(machine, server.url, ownTablet, hardware)).close();
    expect(await history({ pendingMachineId: pending.id })).toEqual([]);
    expect((await history(of(machine))).map((row) => [row.name, row.value, row.tabletId])).toEqual([
      ["machineSettings", VALUES.machineSettings, ownTablet],
      ["machineSettings", { ...VALUES.machineSettings, fan: 45 }, visitingTablet],
      ["advancedSettings", VALUES.advancedSettings, visitingTablet],
      ["machineCalibration", VALUES.machineCalibration, null],
    ]);
    expect(await history(of(visitor))).toEqual([]);
  });

  it("records each change once, whether a delivery arrives again through another instance or two tablets report it at once through two", async () => {
    const machine = await api.createMachine("History once");
    const visitor = await api.createMachine("History once, visiting");
    const hardware = { model: "DE1Pro", serial: "44001" };
    const own = await connect(machine, server.url, randomUUID(), hardware);
    await own.deliver(report("machineSettings", VALUES.machineSettings));
    // Delivered through one instance, then again through the other, as after a lost acknowledgment.
    const change = report("machineSettings", { ...VALUES.machineSettings, fan: 45 });
    await own.deliver(change);
    const again = await connect(machine, other.url, randomUUID(), hardware);
    await again.deliver(change);
    await again.close();
    expect((await history(of(machine))).map((row) => (row.value as { fan: number }).fan)).toEqual([50, 45]);

    // The Machine's own tablet and a visitor's moved onto its hardware report the same change at once, through each instance.
    const visiting = await connect(visitor, other.url, randomUUID(), hardware);
    const own2 = await connect(machine, server.url, randomUUID(), hardware);
    const value = { ...VALUES.machineSettings, fan: 40 };
    const database = await server.connectDatabase();
    const deliveries: Promise<void>[] = [];
    try {
      await database.query("BEGIN");
      await database.query("LOCK TABLE settings_history IN SHARE MODE");
      deliveries.push(own2.deliver(report("machineSettings", value)), visiting.deliver(report("machineSettings", value)));
      // One waits for the history, holding the Machine, which the other waits for.
      await waitForLockWaits(server, { count: 2 });
      await database.query("COMMIT");
    } finally {
      await database.end();
    }
    await Promise.all(deliveries);
    await Promise.all([own2.close(), visiting.close()]);
    expect((await history(of(machine))).map((row) => (row.value as { fan: number }).fan)).toEqual([50, 45, 40]);
    expect(await history(of(visitor))).toEqual([]);
  });
});
