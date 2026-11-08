import { describe, expect, it } from "vitest";
import {
  BRIEF_CHANGE_MS,
  COLLECTION_NAMES,
  type HistoryValue,
  LIBRARY_LISTS,
  SETTINGS_HISTORY_COLLECTIONS,
  changedSettingsHistoryFields,
  editedSettingsHistoryFields,
  settingsHistoryChanges,
  settingsHistoryFields,
} from "../src/index.js";

// The Settings History's projection (#432): what counts as a change of each
// collection, field by field. Values are shaped as Decaid v0.9.1 reports
// them (COLLECTIONS.md), with made-up ids.

describe("SETTINGS_HISTORY_COLLECTIONS", () => {
  it("is every collection but the Library's lists, in COLLECTION_NAMES order", () => {
    expect(SETTINGS_HISTORY_COLLECTIONS).toEqual(COLLECTION_NAMES.filter((name) => !(LIBRARY_LISTS as readonly string[]).includes(name)));
  });
});

describe("changedSettingsHistoryFields", () => {
  const machineSettings = { fan: 50, steamPurgeMode: 0, steamFlow: 1.5, hotWaterFlow: 6, flushFlow: 6, flushTemp: 90, flushTimeout: 3, tankTemp: 0, usb: true };

  it("names each top-level field that changed, and none for a value the same in any key order", () => {
    expect(changedSettingsHistoryFields("machineSettings", machineSettings, { ...machineSettings, fan: 40 })).toEqual(["fan"]);
    expect(changedSettingsHistoryFields("machineSettings", machineSettings, { ...machineSettings, fan: 40, steamPurgeMode: 1 })).toEqual(["fan", "steamPurgeMode"]);
    const reordered = Object.fromEntries(Object.entries(machineSettings).reverse());
    expect(changedSettingsHistoryFields("machineSettings", machineSettings, reordered)).toEqual([]);
    expect(changedSettingsHistoryFields("advancedSettings", { refillKitSetting: 2, heaterVoltage: 120 }, { refillKitSetting: 0, heaterVoltage: 120 })).toEqual(["refillKitSetting"]);
    expect(changedSettingsHistoryFields("machineCalibration", { flowMultiplier: 1.1 }, { flowMultiplier: 0.6 })).toEqual(["flowMultiplier"]);
  });

  it("names a field added or gone, an absent field counting as null", () => {
    expect(changedSettingsHistoryFields("appSettings", { keepAwake: true }, { keepAwake: true, themeMode: "dark" })).toEqual(["themeMode"]);
    expect(changedSettingsHistoryFields("appSettings", { keepAwake: true, themeMode: "dark" }, { keepAwake: true })).toEqual(["themeMode"]);
    expect(changedSettingsHistoryFields("appSettings", { keepAwake: true, preferredGrinderDeviceId: null }, { keepAwake: true })).toEqual([]);
  });

  it("leaves out the machine settings the Workflow, each profile and the charging mode set", () => {
    const changed = { ...machineSettings, steamFlow: 0.8, hotWaterFlow: 4, flushFlow: 3, flushTemp: 85, flushTimeout: 5, tankTemp: 20, usb: false };
    expect(changedSettingsHistoryFields("machineSettings", machineSettings, changed)).toEqual([]);
    expect(settingsHistoryFields("machineSettings", changed)).toEqual({ fan: 50, steamPurgeMode: 0 });
  });

  it("leaves out the Tablet's charging state, the presence settings' keep-awake end and the scale's battery", () => {
    const app = { scalePowerMode: "disconnect", chargingState: { mode: "longevity", batteryPercent: 50, usbChargerOn: true } };
    expect(changedSettingsHistoryFields("appSettings", app, { ...app, chargingState: { ...app.chargingState, batteryPercent: 49, usbChargerOn: false } })).toEqual([]);
    const presence = { userPresenceEnabled: true, sleepTimeoutMinutes: 30, schedules: [], keepAwakeUntil: "2026-11-08T08:30:00.000" };
    expect(changedSettingsHistoryFields("presenceSettings", presence, { ...presence, keepAwakeUntil: null })).toEqual([]);
    const scale = { firmwareVersion: "1.4.2", batteryLevel: 80 };
    expect(changedSettingsHistoryFields("scaleInfo", scale, { ...scale, batteryLevel: 79 })).toEqual([]);
    expect(changedSettingsHistoryFields("scaleInfo", scale, { ...scale, firmwareVersion: "1.4.3" })).toEqual(["firmwareVersion"]);
  });

  it("compares the wake schedules by their ids, each as an edit names its fields", () => {
    const morning = { id: "sched-morning", time: "06:30", daysOfWeek: [1, 2, 3, 4, 5], enabled: true };
    const noon = { id: "sched-noon", time: "12:00", daysOfWeek: [], enabled: true, keepAwakeFor: 60 };
    const presence = { userPresenceEnabled: true, sleepTimeoutMinutes: 30, schedules: [morning, noon] };
    expect(settingsHistoryFields("presenceSettings", presence)).toEqual({
      userPresenceEnabled: true,
      sleepTimeoutMinutes: 30,
      "schedules/sched-morning": { time: "06:30", daysOfWeek: [1, 2, 3, 4, 5], enabled: true, keepAwakeFor: null },
      "schedules/sched-noon": { time: "12:00", daysOfWeek: [], enabled: true, keepAwakeFor: 60 },
    });
    // Listed in another order, nothing changed.
    expect(changedSettingsHistoryFields("presenceSettings", presence, { ...presence, schedules: [noon, morning] })).toEqual([]);
    expect(changedSettingsHistoryFields("presenceSettings", presence, { ...presence, schedules: [{ ...morning, time: "07:00" }, noon] })).toEqual(["schedules/sched-morning"]);
    expect(changedSettingsHistoryFields("presenceSettings", presence, { ...presence, schedules: [morning] })).toEqual(["schedules/sched-noon"]);
    expect(changedSettingsHistoryFields("presenceSettings", presence, { ...presence, schedules: [morning, noon, { ...noon, id: "sched-added" }] })).toEqual(["schedules/sched-added"]);
    // A keep-awake time of none, which Decaid leaves out, is the same as null.
    expect(changedSettingsHistoryFields("presenceSettings", presence, { ...presence, schedules: [{ ...morning, keepAwakeFor: null }, noon] })).toEqual([]);
  });

  it("compares the sensor calibration by target, each its measured value", () => {
    const read = (target: string, measuredValue: number) => ({ target, source: "current", de1ReportedValue: target === "temperature" ? 0 : 1, measuredValue });
    const calibration = { flow: read("flow", 1.100006103515625), pressure: read("pressure", 1.293609619140625), temperature: read("temperature", -2.899993896484375) };
    expect(settingsHistoryFields("sensorCalibration", calibration)).toEqual({ flow: 1.100006103515625, pressure: 1.293609619140625, temperature: -2.899993896484375 });
    expect(changedSettingsHistoryFields("sensorCalibration", calibration, { ...calibration, pressure: read("pressure", 1.0199966430664062) })).toEqual(["pressure"]);
  });

  it("compares the plugins by id, leaving out what Decaid's update checks write", () => {
    const source = { kind: "github_release", repo: "loganfuller/decent-sync", releaseTag: "v1.7.1", lastChecked: "2026-11-07T07:10:46.408380", lastError: null };
    const plugins = [
      { id: "visualizer.reaplugin", version: "1.5.11", loaded: true, source: null },
      { id: "decent-sync.reaplugin", version: "1.7.1", loaded: true, source },
    ];
    const checked = [plugins[0], { ...plugins[1], source: { ...source, lastChecked: "2026-11-08T07:10:46.408380" } }];
    // A check that failed while the Tablet was offline, then the next.
    const failed = [plugins[0], { ...plugins[1], source: { ...source, lastError: "Couldn't reach GitHub" } }];
    expect(changedSettingsHistoryFields("plugins", plugins, failed)).toEqual([]);
    // An update waiting for its new permissions, found again by each check, is a change once.
    const pendingUpdate = { version: "1.8.0", releaseTag: "v1.8.0", addedPermissions: ["network"], detectedAt: "2026-11-08T07:10:46.408380" };
    const waiting = [plugins[0], { ...plugins[1], pendingUpdate }];
    expect(changedSettingsHistoryFields("plugins", plugins, waiting)).toEqual(["decent-sync.reaplugin"]);
    const foundAgain = [plugins[0], { ...plugins[1], pendingUpdate: { ...pendingUpdate, detectedAt: "2026-11-08T19:10:46.408380" } }];
    expect(changedSettingsHistoryFields("plugins", waiting, foundAgain)).toEqual([]);
    expect(changedSettingsHistoryFields("plugins", plugins, checked)).toEqual([]);
    expect(changedSettingsHistoryFields("plugins", plugins, [plugins[1], plugins[0]])).toEqual([]);
    const updated = [plugins[0], { ...plugins[1], version: "1.8.0", source: { ...source, releaseTag: "v1.8.0" } }];
    expect(changedSettingsHistoryFields("plugins", plugins, updated)).toEqual(["decent-sync.reaplugin"]);
    expect(changedSettingsHistoryFields("plugins", plugins, [{ ...plugins[0], loaded: false }, plugins[1]])).toEqual(["visualizer.reaplugin"]);
  });

  it("compares the paired devices by id, leaving out how each is connected now", () => {
    const scale = { name: "Mock Scale", id: "MockScale", state: "connected", type: "scale", available: true, connectionRole: "primary" };
    const machine = { name: "MockDe1", id: "MockDe1", state: "connected", type: "machine", available: true };
    const devices = [scale, machine];
    const { connectionRole: _role, ...disconnected } = { ...scale, state: "disconnected", available: false };
    expect(changedSettingsHistoryFields("pairedDevices", devices, [machine, disconnected])).toEqual([]);
    const other = { name: "Other Scale", id: "OtherScale", state: "connected", type: "scale", available: true, connectionRole: "primary" };
    expect(changedSettingsHistoryFields("pairedDevices", devices, [other, machine])).toEqual(["OtherScale", "MockScale"]);
  });

  it("compares the sensors by id, and the Skins by their list, default and server", () => {
    const basket = { id: "mockSensorBasket", info: { name: "SensorBasket", vendor: "DecentEspresso" } };
    const probe = { id: "milkProbe", info: { name: "Milk probe", vendor: "DecentEspresso" } };
    expect(changedSettingsHistoryFields("sensors", [basket], [basket, probe])).toEqual(["milkProbe"]);
    const skins = { skins: [{ id: "streamline.js", version: "0.2.23" }], default: { id: "streamline.js" }, server: { serving: true, path: "/web-ui/streamline.js" } };
    expect(changedSettingsHistoryFields("skins", skins, { ...skins, skins: [{ id: "streamline.js", version: "0.2.24" }] })).toEqual(["skins"]);
  });

  it("compares a value of another shape than Decaid's as one field", () => {
    expect(changedSettingsHistoryFields("plugins", [{ name: "no id" }], [{ name: "no id" }])).toEqual([]);
    expect(changedSettingsHistoryFields("plugins", [{ name: "no id" }], [{ name: "still no id" }])).toEqual([""]);
    expect(changedSettingsHistoryFields("machineSettings", "unexpected", { fan: 50 })).toEqual(["fan", ""]);
  });
});

describe("editedSettingsHistoryFields", () => {
  const labelled = (name: Parameters<typeof editedSettingsHistoryFields>[0], edit: Parameters<typeof editedSettingsHistoryFields>[1], before: unknown, after: unknown) =>
    editedSettingsHistoryFields(name, edit, before, after, changedSettingsHistoryFields(name, before, after));

  it("labels the fields an edit set that changed, whatever came of them, and no other", () => {
    const before = { heaterPh1Flow: 2, heaterPh2Flow: 4, heaterIdleTemp: 99, refillKitSetting: 2 };
    // Applied, stored otherwise, refused (unchanged), and a field the edit did not set.
    const after = { heaterPh1Flow: 3, heaterPh2Flow: 4.9, heaterIdleTemp: 97, refillKitSetting: 2 };
    const edit = { fields: { heaterPh1Flow: 3, heaterPh2Flow: 5, refillKitSetting: 0 } };
    expect(labelled("advancedSettings", edit, before, after)).toEqual(["heaterPh1Flow", "heaterPh2Flow"]);
    expect(labelled("sensorCalibration", { fields: { pressure: 1.02 } }, { flow: { measuredValue: 1 }, pressure: { measuredValue: 1 } }, { flow: { measuredValue: 1.1 }, pressure: { measuredValue: 1.02 } })).toEqual(["pressure"]);
  });

  const morning = { id: "sched-morning", time: "06:30", daysOfWeek: [1, 2, 3, 4, 5], enabled: true };
  const presence = { userPresenceEnabled: true, schedules: [morning] };

  it("labels the schedule a change or delete names, and not another changed beside it", () => {
    const noon = { id: "sched-noon", time: "12:00", daysOfWeek: [], enabled: true };
    const before = { ...presence, schedules: [morning, noon] };
    const after = { ...presence, schedules: [{ ...morning, time: "07:00" }, { ...noon, enabled: false }] };
    expect(labelled("presenceSettings", { fields: { time: "07:00" }, schedule: { action: "change", id: "sched-morning" } }, before, after)).toEqual(["schedules/sched-morning"]);
    expect(labelled("presenceSettings", { fields: {}, schedule: { action: "delete", id: "sched-noon" } }, before, presence)).toEqual(["schedules/sched-noon"]);
  });

  it("labels the schedule new in the read-back that holds each field an add set, before its id is known", () => {
    const fields = { time: "12:00", daysOfWeek: [], enabled: true, keepAwakeFor: null };
    const add = { fields, schedule: { action: "add" as const, id: null } };
    // Decaid leaves out a keep-awake time of none, and may hold fields an edit doesn't set.
    const added = { id: "sched-added", time: "12:00", daysOfWeek: [], enabled: true, createdBy: "api" };
    // Another app added a schedule at the same moment, and changed the presence settings.
    const other = { id: "sched-other", time: "18:00", daysOfWeek: [6, 7], enabled: true };
    const after = { ...presence, userPresenceEnabled: false, schedules: [morning, added, other] };
    expect(labelled("presenceSettings", add, presence, after)).toEqual(["schedules/sched-added"]);
    // A schedule changed to the fields added is no add.
    expect(labelled("presenceSettings", add, presence, { ...presence, schedules: [{ ...morning, ...fields }] })).toEqual([]);
  });
});

describe("settingsHistoryChanges", () => {
  const at = (seconds: number) => Date.UTC(2026, 10, 8, 9) + seconds * 1000;
  const outside = (value: unknown, seconds: number): HistoryValue => ({ value, receivedAt: at(seconds), settingsEditId: null, editedFields: [] });
  const advanced = { heaterPh1Flow: 2, heaterIdleTemp: 99, refillKitSetting: 0 };

  it("gives each value's changes from the one before, field by field, and none for the baseline or a value unchanged as compared", () => {
    const changes = settingsHistoryChanges("machineSettings", [
      outside({ fan: 50, steamPurgeMode: 0, steamFlow: 1.5 }, 0),
      outside({ fan: 45, steamPurgeMode: 0, steamFlow: 1.5 }, 600),
      // The Workflow's steam flow alone, which a Settings History leaves out.
      outside({ fan: 45, steamPurgeMode: 0, steamFlow: 0.8 }, 1200),
      outside({ fan: 45, steamPurgeMode: 0, steamFlow: 0.8, newField: true }, 1800),
      outside({ fan: 45, steamFlow: 0.8, newField: true }, 2400),
    ]);
    expect(changes).toEqual([
      { index: 1, settingsEditId: null, fields: [{ field: "fan", change: "changed", before: 50, after: 45, backAt: null }] },
      { index: 3, settingsEditId: null, fields: [{ field: "newField", change: "added", before: null, after: true, backAt: null }] },
      { index: 4, settingsEditId: null, fields: [{ field: "steamPurgeMode", change: "removed", before: 0, after: null, backAt: null }] },
    ]);
  });

  it("gives a wake schedule added, changed or removed by its id, a sensor calibration by target, and a plugin by its id", () => {
    const morning = { id: "sched-morning", time: "06:30", daysOfWeek: [1, 2, 3, 4, 5], enabled: true };
    const presence = (schedules: unknown[]) => ({ userPresenceEnabled: true, schedules });
    expect(
      settingsHistoryChanges("presenceSettings", [outside(presence([]), 0), outside(presence([morning]), 600), outside(presence([{ ...morning, time: "07:00" }]), 1200), outside(presence([]), 1800)]).map(
        ({ fields }) => fields.map(({ field, change }) => [field, change]),
      ),
    ).toEqual([[["schedules/sched-morning", "added"]], [["schedules/sched-morning", "changed"]], [["schedules/sched-morning", "removed"]]]);
    const calibration = (pressure: number) => ({ flow: { measuredValue: 1 }, pressure: { target: "pressure", measuredValue: pressure } });
    expect(settingsHistoryChanges("sensorCalibration", [outside(calibration(1), 0), outside(calibration(1.02), 600)])[0]!.fields).toEqual([
      { field: "pressure", change: "changed", before: 1, after: 1.02, backAt: null },
    ]);
    const plugin = { id: "decent-sync.reaplugin", version: "1.7.1", loaded: true };
    expect(settingsHistoryChanges("plugins", [outside([plugin], 0), outside([{ ...plugin, version: "1.8.0" }], 600)])[0]!.fields).toEqual([
      { field: "decent-sync.reaplugin", change: "changed", before: plugin, after: { ...plugin, version: "1.8.0" }, backAt: null },
    ]);
  });

  it("splits a read-back's changes into those its Settings Edit made and those made outside Decent Sync", () => {
    const changes = settingsHistoryChanges("advancedSettings", [
      outside(advanced, 0),
      { value: { ...advanced, heaterPh1Flow: 3, refillKitSetting: 2 }, receivedAt: at(60), settingsEditId: "edit", editedFields: ["heaterPh1Flow"] },
    ]);
    expect(changes).toEqual([
      { index: 1, settingsEditId: "edit", fields: [{ field: "heaterPh1Flow", change: "changed", before: 2, after: 3, backAt: null }] },
      { index: 1, settingsEditId: null, fields: [{ field: "refillKitSetting", change: "changed", before: 0, after: 2, backAt: null }] },
    ]);
  });

  it("folds a field changed from outside and changed back within about 2 minutes into one brief change, beside the others", () => {
    // The refill kit Decaid shows on automatic after the machine reconnects, then the kept value, with a change kept between.
    const changes = settingsHistoryChanges("advancedSettings", [
      outside(advanced, 0),
      outside({ ...advanced, refillKitSetting: 2 }, 600),
      outside({ ...advanced, refillKitSetting: 2, heaterIdleTemp: 97 }, 630),
      outside({ ...advanced, refillKitSetting: 0, heaterIdleTemp: 97 }, 600 + BRIEF_CHANGE_MS / 1000),
    ]);
    expect(changes).toEqual([
      { index: 1, settingsEditId: null, fields: [{ field: "refillKitSetting", change: "changed", before: 0, after: 2, backAt: at(600) + BRIEF_CHANGE_MS }] },
      { index: 2, settingsEditId: null, fields: [{ field: "heaterIdleTemp", change: "changed", before: 99, after: 97, backAt: null }] },
    ]);
  });

  it("folds a remembered scale left out of the paired devices for a moment as briefly removed, however it is connected when back", () => {
    const scale = { name: "Mock Scale", id: "MockScale", state: "connected", type: "scale", available: true, connectionRole: "primary" };
    const changes = settingsHistoryChanges("pairedDevices", [outside([scale], 0), outside([], 600), outside([{ ...scale, state: "connecting", available: false }], 610)]);
    expect(changes).toEqual([{ index: 1, settingsEditId: null, fields: [{ field: "MockScale", change: "removed", before: settingsHistoryFields("pairedDevices", [scale]).MockScale, after: null, backAt: at(610) }] }]);
  });

  it("folds no change back later than about 2 minutes, to another value, or made or undone through a Settings Edit, and pairs each change back once", () => {
    const later = settingsHistoryChanges("advancedSettings", [outside(advanced, 0), outside({ ...advanced, refillKitSetting: 2 }, 600), outside(advanced, 601 + BRIEF_CHANGE_MS / 1000)]);
    expect(later.map(({ fields }) => fields[0]!.backAt)).toEqual([null, null]);
    const elsewhere = settingsHistoryChanges("advancedSettings", [outside(advanced, 0), outside({ ...advanced, refillKitSetting: 2 }, 600), outside({ ...advanced, refillKitSetting: 1 }, 610)]);
    expect(elsewhere.map(({ fields }) => fields[0]!.backAt)).toEqual([null, null]);
    const edited = (value: unknown, seconds: number): HistoryValue => ({ value, receivedAt: at(seconds), settingsEditId: `edit-${seconds}`, editedFields: ["refillKitSetting"] });
    expect(settingsHistoryChanges("advancedSettings", [outside(advanced, 0), edited({ ...advanced, refillKitSetting: 2 }, 600), outside(advanced, 610)])).toHaveLength(2);
    expect(settingsHistoryChanges("advancedSettings", [outside(advanced, 0), outside({ ...advanced, refillKitSetting: 2 }, 600), edited(advanced, 610)])).toHaveLength(2);
    // Off, on, off and on again within moments: the first two fold, then the next two.
    const flapping = settingsHistoryChanges("advancedSettings", [0, 2, 0, 2, 0].map((refillKitSetting, n) => outside({ ...advanced, refillKitSetting }, 600 + n * 10)));
    expect(flapping.map(({ index, fields }) => [index, fields[0]!.backAt])).toEqual([
      [1, at(620)],
      [3, at(640)],
    ]);
  });
});
