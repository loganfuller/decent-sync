import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1 for ticket #231: Settings Edits of a Tablet's presence settings,
// Staff's to change: presence and the sleep timeout through `POST
// /presence/settings`, and each wake schedule added, changed or deleted on
// its own, made through the REST API and carried out by the built plugin in
// a simulated tablet, whose Decaid serves the presence routes as v0.9.0 does,
// with or without a machine (decaid-settings.ts). Assertions are made through
// the REST API and what the tablet's Decaid holds. Serials are made up, and
// the schedule ids are those the simulated Decaid gives.

interface SettingsEditView {
  id: string;
  schedule: { action: string; id: string | null } | null;
  outcome: "applied" | "adjusted" | "refused" | "notConfirmed" | null;
  adjusted: { field: string; holds?: unknown }[];
  refusal: { reason: string; current?: Record<string, unknown> | null; status?: number | null; message?: string | null } | null;
  readBack: Record<string, unknown> | null;
}

interface Presence {
  userPresenceEnabled: boolean;
  sleepTimeoutMinutes: number;
  schedules: Record<string, unknown>[];
}

/** A wake schedule as an edit adding one sets it: at 06:30 on Monday, Wednesday and Friday, on, keeping the Machine awake for two hours. */
const WEEKDAY_MORNINGS = { time: "06:30", daysOfWeek: [1, 3, 5], enabled: true, keepAwakeFor: 120 };

describe("Settings Edits of the presence settings and wake schedules", () => {
  let server: TestServer;
  let api: AdminApi;
  let cafe: LocationView;
  let staff: AdminApi;
  let serial = 23_100;

  beforeAll(async () => {
    server = await startTestServer({ env: { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" } });
    api = await AdminApi.setUp(server.url);
    cafe = await api.createLocation("Presence cafe", "America/Toronto");
    staff = await api.staffAt("presence-edits@example.com", cafe);
  });
  afterAll(async () => {
    await server?.stop();
  });

  /**
   * A Machine at the cafe whose tablet, four hours behind UTC, is connected,
   * its presence settings a new install's (presence on, a 30 minute sleep
   * timeout, no wake schedules), once they are reported.
   */
  async function connected(name: string, options: Parameters<typeof syncingTablet>[2] = {}): Promise<{ machine: CreatedMachine; tablet: SimulatedTablet }> {
    const machine = await api.createMachine(name, cafe.id);
    const tablet = syncingTablet(machine, server, { api: emptyLibrary(serial++), utcOffsetMinutes: -240, ...options });
    await api.waitForOnline(machine);
    await expect.poll(async () => (await reported(machine))?.value).toMatchObject({ userPresenceEnabled: true, sleepTimeoutMinutes: 30, schedules: [] });
    return { machine, tablet };
  }
  const path = (machine: CreatedMachine) => `/machines/${machine.machine.id}/settings-edits`;
  const make = async (machine: CreatedMachine, edit: Record<string, unknown>, as = api) =>
    (await as.send<{ settingsEdit: SettingsEditView }>("POST", path(machine), { collection: "presenceSettings", ...edit }, 201)).settingsEdit;
  async function answered(machine: CreatedMachine, id: string): Promise<SettingsEditView> {
    const read = async () => (await api.get<{ settingsEdit: SettingsEditView }>(`${path(machine)}/${id}`)).settingsEdit;
    await expect.poll(async () => (await read()).outcome, { timeout: 15_000 }).not.toBeNull();
    return read();
  }
  const reported = async (machine: CreatedMachine) =>
    (await api.get<{ collection: { value: Presence; utcOffsetMinutes: number | null } | null }>(`/machines/${machine.machine.id}/collections/presenceSettings`)).collection;
  /** The presence settings the tablet's Decaid holds, read as another app on the tablet would. */
  async function held(tablet: SimulatedTablet): Promise<Presence> {
    const { status, body } = await tablet.callApi("GET", "/presence/settings");
    expect(status).toBe(200);
    return body as Presence;
  }
  const writes = (tablet: SimulatedTablet) => tablet.writes.filter((write) => write.includes(" /presence/"));
  /** Adds a schedule on the tablet, as Streamline's settings page would, and waits until the server has its report: the schedule as reported. */
  async function addedOnTablet(machine: CreatedMachine, tablet: SimulatedTablet, schedule: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { status, body } = await tablet.callApi("POST", "/presence/schedules", schedule);
    expect(status).toBe(201);
    const id = (body as { id: string }).id;
    await expect.poll(async () => (await reported(machine))?.value.schedules.find((reported) => reported.id === id)).toBeDefined();
    return (await reported(machine))!.value.schedules.find((reported) => reported.id === id)!;
  }

  it("applies Staff's edit turning presence off and setting the sleep timeout, then turning presence on, at the Machine's Location", async () => {
    const { machine, tablet } = await connected("Presence applied");
    const off = await make(machine, { fields: { userPresenceEnabled: false, sleepTimeoutMinutes: 45 }, expected: { userPresenceEnabled: true, sleepTimeoutMinutes: 30 } }, staff);
    expect(off.schedule).toBeNull();
    expect(await answered(machine, off.id)).toMatchObject({ outcome: "applied", refusal: null, readBack: { userPresenceEnabled: false, sleepTimeoutMinutes: 45 } });
    expect(await held(tablet)).toMatchObject({ userPresenceEnabled: false, sleepTimeoutMinutes: 45 });

    const on = await make(machine, { fields: { userPresenceEnabled: true }, expected: { userPresenceEnabled: false } }, staff);
    expect(await answered(machine, on.id)).toMatchObject({ outcome: "applied", readBack: { userPresenceEnabled: true } });
    expect(await held(tablet)).toMatchObject({ userPresenceEnabled: true, sleepTimeoutMinutes: 45 });
    expect(writes(tablet)).toEqual(["POST /presence/settings", "POST /presence/settings"]);
    // The read-back is reported with the Tablet's offset.
    expect(await reported(machine)).toMatchObject({ value: { userPresenceEnabled: true, sleepTimeoutMinutes: 45 }, utcOffsetMinutes: -240 });
  });

  it("adds a wake schedule, answering with the id Decaid gave it, then changes and deletes it", async () => {
    const { machine, tablet } = await connected("Wake schedule added");
    const added = await make(machine, { schedule: { action: "add" }, fields: WEEKDAY_MORNINGS, expected: {} }, staff);
    expect(added.schedule).toEqual({ action: "add", id: null });
    const addedAnswer = await answered(machine, added.id);
    const id = addedAnswer.schedule?.id;
    expect(id).toEqual(expect.any(String));
    const schedule = { id, ...WEEKDAY_MORNINGS };
    expect(addedAnswer).toMatchObject({ outcome: "applied", adjusted: [], readBack: schedule });
    expect((await held(tablet)).schedules).toEqual([schedule]);
    // The read-back is reported before the answer.
    expect((await reported(machine))?.value.schedules).toEqual([schedule]);

    // Every day, keeping the Machine awake for no set time, which Decaid leaves out.
    const changed = await make(machine, { schedule: { action: "change", id }, fields: { daysOfWeek: [], keepAwakeFor: null }, expected: schedule }, staff);
    const everyDay = { id, time: "06:30", daysOfWeek: [], enabled: true };
    expect(await answered(machine, changed.id)).toMatchObject({ schedule: { action: "change", id }, outcome: "applied", readBack: { ...everyDay, keepAwakeFor: null } });
    expect((await held(tablet)).schedules).toEqual([everyDay]);
    await expect.poll(async () => (await reported(machine))?.value.schedules).toEqual([everyDay]);

    const deleted = await make(machine, { schedule: { action: "delete", id }, fields: {}, expected: everyDay }, staff);
    expect(await answered(machine, deleted.id)).toMatchObject({ schedule: { action: "delete", id }, outcome: "applied", readBack: {} });
    expect((await held(tablet)).schedules).toEqual([]);
    expect(writes(tablet)).toEqual(["POST /presence/schedules", `PUT /presence/schedules/${id}`, `DELETE /presence/schedules/${id}`]);
  });

  it("refuses a change of a schedule deleted on the Tablet since the report as changed since, naming none, and writes nothing", async () => {
    const { machine, tablet } = await connected("Wake schedule gone");
    const schedule = await addedOnTablet(machine, tablet, WEEKDAY_MORNINGS);
    expect((await tablet.callApi("DELETE", `/presence/schedules/${schedule.id}`)).status).toBe(200);
    const before = writes(tablet).length;

    const changed = await make(machine, { schedule: { action: "change", id: schedule.id }, fields: { enabled: false }, expected: schedule }, staff);
    expect(await answered(machine, changed.id)).toMatchObject({ outcome: "refused", refusal: { reason: "changedSince", current: {} }, readBack: {} });
    const deleted = await make(machine, { schedule: { action: "delete", id: schedule.id }, fields: {}, expected: schedule }, staff);
    expect(await answered(machine, deleted.id)).toMatchObject({ outcome: "refused", refusal: { reason: "changedSince", current: {} } });
    expect(writes(tablet).length).toBe(before);
  });

  it("refuses a change or delete of a schedule changed on the Tablet since the report, with the schedule as the Tablet holds it", async () => {
    const { machine, tablet } = await connected("Wake schedule changed since");
    const schedule = await addedOnTablet(machine, tablet, WEEKDAY_MORNINGS);
    // Changed on the Tablet after the report the edit is made over, with no report since.
    expect((await tablet.callApi("PUT", `/presence/schedules/${schedule.id}`, { time: "07:00" })).status).toBe(200);
    const before = writes(tablet).length;

    const now = { ...schedule, time: "07:00" };
    const changed = await make(machine, { schedule: { action: "change", id: schedule.id }, fields: { enabled: false }, expected: schedule }, staff);
    expect(await answered(machine, changed.id)).toMatchObject({ outcome: "refused", refusal: { reason: "changedSince", current: now }, readBack: now });
    const deleted = await make(machine, { schedule: { action: "delete", id: schedule.id }, fields: {}, expected: schedule }, staff);
    expect(await answered(machine, deleted.id)).toMatchObject({ outcome: "refused", refusal: { reason: "changedSince", current: now } });
    expect(writes(tablet).length).toBe(before);
    expect((await held(tablet)).schedules).toEqual([now]);
  });

  it("applies presence and wake schedule edits while no machine is connected to the Tablet, whose state Decaid can't read then", async () => {
    const { machine, tablet } = await connected("Presence without a machine", { machineConnected: false });
    expect((await tablet.callApi("GET", "/machine/state")).status).toBe(500);
    const timeout = await make(machine, { fields: { sleepTimeoutMinutes: 90 }, expected: { sleepTimeoutMinutes: 30 } }, staff);
    expect(await answered(machine, timeout.id)).toMatchObject({ outcome: "applied", readBack: { sleepTimeoutMinutes: 90 } });
    const added = await make(machine, { schedule: { action: "add" }, fields: WEEKDAY_MORNINGS, expected: {} }, staff);
    expect(await answered(machine, added.id)).toMatchObject({ outcome: "applied", readBack: WEEKDAY_MORNINGS });
    expect(await held(tablet)).toMatchObject({ sleepTimeoutMinutes: 90, schedules: [WEEKDAY_MORNINGS] });
  });

  it("refuses at once an add missing a field, one naming an id, a change not expecting the schedule it names, and a sleep timeout out of range", async () => {
    const { machine, tablet } = await connected("Presence edits refused");
    const refused = async (edit: Record<string, unknown>, pattern: RegExp) => {
      const response = await staff.call("POST", path(machine), { collection: "presenceSettings", ...edit });
      const text = await response.text();
      expect(response.status, text).toBe(400);
      expect(text).toMatch(pattern);
    };
    const { keepAwakeFor: _, ...withoutKeepAwake } = WEEKDAY_MORNINGS;
    await refused({ schedule: { action: "add" }, fields: withoutKeepAwake, expected: {} }, /Give a new wake schedule its time/);
    await refused({ schedule: { action: "add", id: "a" }, fields: WEEKDAY_MORNINGS, expected: {} }, /no id until the Tablet gives it one/);
    await refused({ schedule: { action: "change", id: "a" }, fields: { enabled: false }, expected: { ...WEEKDAY_MORNINGS, id: "b" } }, /its id included/);
    await refused({ schedule: { action: "delete", id: "a" }, fields: {}, expected: { id: "a" } }, /its id included/);
    await refused({ schedule: { action: "move", id: "a" }, fields: {}, expected: { id: "a" } }, /added, changed or deleted/);
    await refused({ schedule: { action: "change", id: "a" }, fields: { daysOfWeek: [5, 1] }, expected: { ...WEEKDAY_MORNINGS, id: "a" } }, /Days must be days of the week/);
    await refused({ fields: { sleepTimeoutMinutes: 121 }, expected: { sleepTimeoutMinutes: 30 } }, /Sleep timeout must be from 1 to 120/);
    await refused({ fields: { schedules: [] }, expected: { schedules: [] } }, /added, changed and deleted one at a time/);
    expect(writes(tablet)).toEqual([]);
  });
});
