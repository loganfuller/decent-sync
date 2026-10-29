import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import { quiesced } from "./support/quiet.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1 for ticket #224: the first Settings Edit, of a Machine's fan
// threshold and steam purge mode, made through the REST API, sent to the
// built plugin in a simulated tablet, which takes Decaid v0.9.1's settings
// writes as Decaid does (decaid-settings.ts), and answered, against real
// servers sharing one PostgreSQL database. Assertions are made through the
// REST API and what the tablet's Decaid holds. Serials are made up.

interface SettingsEditView {
  id: string;
  collection: string;
  fields: Record<string, unknown>;
  expected: Record<string, unknown>;
  account: { id: string; name: string | null } | null;
  madeAt: string;
  sentAt: string | null;
  answeredAt: string | null;
  outcome: "applied" | "adjusted" | "refused" | null;
  adjusted: { field: string; holds?: unknown }[];
  refusal:
    | { reason: "machineBusy"; state: string | null }
    | { reason: "changedSince"; current: Record<string, unknown> | null }
    | { reason: "expired" }
    | { reason: "decaid"; status: number | null; message: string | null; changed: string[] }
    | null;
  readBack: Record<string, unknown> | null;
}
interface Frame { type: string; id?: string; name?: string; value?: unknown }

/** The fan threshold and steam purge mode the tablets' machines start with (machine-settings.json). */
const AS_REPORTED = { fan: 50, steamPurgeMode: 0 };

describe("Settings Edits", () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  let cafe: LocationView;
  let elsewhere: LocationView;
  let serial = 22_400;
  const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
    cafe = await api.createLocation("Settings cafe", "America/Toronto");
    elsewhere = await api.createLocation("Settings elsewhere", "America/Toronto");
  });
  afterAll(async () => {
    await server?.stop();
  });

  /** A Machine whose tablet is connected to `server`, with a Library of its own that is empty, at the Location given or none. */
  async function connected(name: string, location?: LocationView, options: Parameters<typeof syncingTablet>[2] = {}): Promise<{ machine: CreatedMachine; tablet: SimulatedTablet }> {
    const machine = await api.createMachine(name, location?.id);
    const tablet = syncingTablet(machine, server, { api: emptyLibrary(serial++), ...options });
    await api.waitForOnline(machine);
    return { machine, tablet };
  }
  const path = (machine: CreatedMachine) => `/machines/${machine.machine.id}/settings-edits`;
  const make = async (machine: CreatedMachine, body: unknown, as = api) => (await as.send<{ settingsEdit: SettingsEditView }>("POST", path(machine), body, 201)).settingsEdit;
  /** Asks for an edit expecting a refusal at once, and resolves with the problems it names. */
  async function refused(machine: CreatedMachine, body: unknown, status: number, as = api): Promise<string> {
    const response = await as.call("POST", path(machine), body);
    const text = await response.text();
    expect(response.status, text).toBe(status);
    return text;
  }
  const read = async (machine: CreatedMachine, id: string, as = api) => (await as.get<{ settingsEdit: SettingsEditView }>(`${path(machine)}/${id}`)).settingsEdit;
  /** Resolves with the edit once it has an outcome, read as the page reads it. */
  async function answered(machine: CreatedMachine, id: string, as = api): Promise<SettingsEditView> {
    await expect.poll(async () => (await read(machine, id, as)).outcome, { timeout: 15_000 }).not.toBeNull();
    return read(machine, id, as);
  }
  const machineSettings = async (machine: CreatedMachine, as = api) =>
    (await as.get<{ collection: { value: Record<string, unknown> } | null }>(`/machines/${machine.machine.id}/collections/machineSettings`)).collection?.value;
  /** The machine settings the tablet's Decaid holds, read as another app on the tablet would. */
  async function readHeld(tablet: SimulatedTablet): Promise<Record<string, unknown>> {
    const { status, body } = await tablet.callApi("GET", "/machine/settings");
    expect(status).toBe(200);
    return body as Record<string, unknown>;
  }
  const settingsWrites = (tablet: SimulatedTablet) => tablet.writes.filter((write) => write === "POST /machine/settings");
  /** How many of the plugin's requests to the machine's settings the tablet has taken, its writes among them. */
  const settingsRequests = (tablet: SimulatedTablet) => tablet.requests.filter((request) => request === "/machine/settings").length;
  const editsReceived = (tablet: SimulatedTablet) => tablet.received.filter((frame) => (frame as Frame).type === "settingsEdit");

  it("applies an Admin's edit of the fan threshold, reporting the read-back before the answer", async () => {
    const { machine, tablet } = await connected("Settings applied", cafe);
    await expect.poll(() => machineSettings(machine)).toMatchObject(AS_REPORTED);

    const made = await make(machine, { collection: "machineSettings", fields: { fan: 40 }, expected: { fan: 50 } });
    expect(made).toMatchObject({ collection: "machineSettings", fields: { fan: 40 }, expected: { fan: 50 }, outcome: null, answeredAt: null, refusal: null });
    expect(made.account).toEqual({ id: expect.any(String), name: "Ada Admin" });

    const edit = await answered(machine, made.id);
    expect(edit).toMatchObject({ outcome: "applied", adjusted: [], refusal: null, readBack: { fan: 40 } });
    expect(Date.parse(edit.sentAt!)).toBeGreaterThanOrEqual(Date.parse(edit.madeAt));
    expect(Date.parse(edit.answeredAt!)).toBeGreaterThanOrEqual(Date.parse(edit.sentAt!));
    expect((await readHeld(tablet)).fan).toBe(40);
    expect(settingsWrites(tablet)).toEqual(["POST /machine/settings"]);
    // The Machine's settings read back after the write were sent before the answer, and so were taken in first.
    const sent = tablet.sent as Frame[];
    const answer = sent.findIndex((frame) => frame.type === "settingsEdited" && frame.id === made.id);
    const readBack = sent.slice(0, answer).filter((frame) => frame.type === "collection" && frame.name === "machineSettings").at(-1);
    expect((readBack?.value as Record<string, unknown> | undefined)?.fan).toBe(40);
    expect(await machineSettings(machine)).toMatchObject({ fan: 40, steamPurgeMode: 0 });
  });

  it("keeps an applied edit of the fan threshold as the Machine reconnects, which Decaid writes again, and reports it so", async () => {
    const { machine, tablet } = await connected("Settings reconnect", cafe);
    await expect.poll(() => machineSettings(machine)).toMatchObject(AS_REPORTED);
    const made = await make(machine, { collection: "machineSettings", fields: { fan: 40 }, expected: { fan: 50 } });
    expect(await answered(machine, made.id)).toMatchObject({ outcome: "applied", readBack: { fan: 40 } });

    // The Machine goes and comes back: Decaid v0.9.1 writes the fan threshold it keeps for it as it connects, where v0.9.0 wrote 55, held as 50.
    tablet.machineConnected = false;
    tablet.connectMachine();
    expect((await readHeld(tablet)).fan).toBe(40);
    // Once the plugin has read the Machine's settings again and the server has taken in whatever it sent.
    const reads = settingsRequests(tablet);
    await expect.poll(() => settingsRequests(tablet)).toBeGreaterThan(reads);
    await quiesced(api, { tablets: { tablet } });
    expect(await machineSettings(machine)).toMatchObject({ fan: 40 });
  });

  it("refuses an edit at once, keeping nothing, while the Machine is offline or for a field the definitions refuse", async () => {
    const offline = await api.createMachine("Settings offline", cafe.id);
    expect(await refused(offline, { collection: "machineSettings", fields: { fan: 40 }, expected: { fan: 50 } }, 409)).toMatch(/offline/);

    const { machine, tablet } = await connected("Settings refused", cafe);
    const refusals: [fields: Record<string, unknown>, problem: RegExp][] = [
      [{ fanSpeed: 3 }, /no setting named fanSpeed/],
      [{ steamFlow: 1.5 }, /Steam flow can't be changed here: set by the Workflow/],
      [{ fan: 51 }, /Fan threshold must be from 0 to 50/],
      [{ fan: 40.5 }, /Fan threshold must be a whole number/],
      [{ steamPurgeMode: 2 }, /Steam purge mode must be Normal or Two Tap Stop/],
    ];
    for (const [fields, problem] of refusals) {
      const expected = Object.fromEntries(Object.keys(fields).map((field) => [field, null]));
      expect(await refused(machine, { collection: "machineSettings", fields, expected }, 400)).toMatch(problem);
    }
    // Off its step: a heater flow, in tenths.
    expect(await refused(machine, { collection: "advancedSettings", fields: { heaterPh1Flow: 2.05 }, expected: { heaterPh1Flow: 2 } }, 400)).toMatch(/Heater warmup flow must be a multiple of 0.1/);
    // What the page showed of every field changed, and of nothing else.
    expect(await refused(machine, { collection: "machineSettings", fields: { fan: 40 }, expected: {} }, 400)).toMatch(/value shown of fan/);
    expect(await refused(machine, { collection: "machineSettings", fields: { fan: 40 }, expected: { fan: 50, steamPurgeMode: 0 } }, 400)).toMatch(/not of steamPurgeMode/);
    expect(await refused(machine, { collection: "machineSettings", fields: {}, expected: {} }, 400)).toMatch(/at least one/);

    // Nothing was kept: neither tablet is sent an edit, the one offline then once it connects.
    const late = syncingTablet(offline, server, { api: emptyLibrary(serial++) });
    await api.waitForOnline(offline);
    await expect.poll(() => machineSettings(offline)).toMatchObject(AS_REPORTED);
    expect(editsReceived(late)).toEqual([]);
    expect(editsReceived(tablet)).toEqual([]);
    expect(settingsWrites(tablet)).toEqual([]);
  });

  it("lets Staff at the Machine's Location change its fan threshold and steam purge mode, and refuses Staff elsewhere and on a Machine at no Location", async () => {
    const staff = await api.staffAt("settings-cafe@example.com", cafe);
    const { machine, tablet } = await connected("Settings by Staff", cafe);
    const made = await make(machine, { collection: "machineSettings", fields: { fan: 35, steamPurgeMode: 1 }, expected: AS_REPORTED }, staff);
    // Its own edit names the account by its id only, as Staff see every account's.
    expect(made.account).toEqual({ id: expect.any(String), name: null });
    expect(await answered(machine, made.id, staff)).toMatchObject({ outcome: "applied", readBack: { fan: 35, steamPurgeMode: 1 } });
    expect(await readHeld(tablet)).toMatchObject({ fan: 35, steamPurgeMode: 1 });
    // Admins see who made it.
    expect((await read(machine, made.id)).account).toEqual({ id: made.account!.id, name: "Staff" });

    const away = await api.staffAt("settings-away@example.com", elsewhere);
    expect(await refused(machine, { collection: "machineSettings", fields: { fan: 30 }, expected: { fan: 35 } }, 403, away)).toMatch(/Location you work at/);
    const { machine: unplaced } = await connected("Settings at no Location");
    expect(await refused(unplaced, { collection: "machineSettings", fields: { fan: 30 }, expected: { fan: 50 } }, 403, staff)).toMatch(/Location you work at/);
    // A field only an Admin may change, at their own Location.
    expect(await refused(machine, { collection: "advancedSettings", fields: { heaterIdleTemp: 97 }, expected: { heaterIdleTemp: 98 } }, 403, staff)).toMatch(/Only an Admin can change Idle temperature/);
    expect(settingsWrites(tablet)).toEqual(["POST /machine/settings"]);
  });

  it("lets an Admin edit a Capture-only Machine and a Machine at no Location", async () => {
    const { machine: captureOnly, tablet: captured } = await connected("Settings capture-only", cafe);
    await api.send("PUT", `/machines/${captureOnly.machine.id}/sharing`, { sharing: false });
    const { machine: unplaced, tablet: unplacedTablet } = await connected("Settings unplaced by an Admin");
    for (const [machine, tablet] of [[captureOnly, captured], [unplaced, unplacedTablet]] as const) {
      const made = await make(machine, { collection: "machineSettings", fields: { steamPurgeMode: 1 }, expected: { steamPurgeMode: 0 } });
      expect(await answered(machine, made.id)).toMatchObject({ outcome: "applied", readBack: { steamPurgeMode: 1 } });
      expect((await readHeld(tablet)).steamPurgeMode).toBe(1);
    }
  });

  it("refuses an edit as changed since where the Tablet changed the setting after the report the edit was made over, and leaves a later change on the Tablet standing", async () => {
    const { machine, tablet } = await connected("Settings changed since", cafe);
    await expect.poll(() => machineSettings(machine)).toMatchObject(AS_REPORTED);
    // A barista lowers the fan threshold on the Tablet before the page's report shows it.
    expect((await tablet.callApi("POST", "/machine/settings", { fan: 30 })).status).toBe(202);
    const stale = await make(machine, { collection: "machineSettings", fields: { fan: 40 }, expected: { fan: 50 } });
    expect(await answered(machine, stale.id)).toMatchObject({ outcome: "refused", refusal: { reason: "changedSince", current: { fan: 30 } }, readBack: { fan: 30 } });
    expect(settingsWrites(tablet)).toEqual([]);
    expect((await readHeld(tablet)).fan).toBe(30);
    await expect.poll(() => machineSettings(machine)).toMatchObject({ fan: 30 });

    const applied = await make(machine, { collection: "machineSettings", fields: { fan: 40 }, expected: { fan: 30 } });
    expect(await answered(machine, applied.id)).toMatchObject({ outcome: "applied" });
    // Then the barista changes it again: it stands, and is reported, with nothing written back.
    expect((await tablet.callApi("POST", "/machine/settings", { fan: 25 })).status).toBe(202);
    await expect.poll(() => machineSettings(machine), { timeout: 15_000 }).toMatchObject({ fan: 25 });
    expect(settingsWrites(tablet)).toEqual(["POST /machine/settings"]);
    expect((await readHeld(tablet)).fan).toBe(25);
  });

  it("refuses an edit while the Machine pulls a Shot, naming its state, and writes nothing", async () => {
    const { machine, tablet } = await connected("Settings during a Shot", cafe);
    tablet.reportState("espresso", "pouring");
    const made = await make(machine, { collection: "machineSettings", fields: { fan: 40 }, expected: { fan: 50 } });
    expect(await answered(machine, made.id)).toMatchObject({ outcome: "refused", refusal: { reason: "machineBusy", state: "espresso" }, readBack: null });
    expect(settingsWrites(tablet)).toEqual([]);
    expect((await readHeld(tablet)).fan).toBe(50);
  });

  it("records Decaid's refusal, as while no machine is connected to the Tablet, with its status and message", async () => {
    const { machine, tablet } = await connected("Settings without a machine", cafe, { machineConnected: false });
    const made = await make(machine, { collection: "machineSettings", fields: { fan: 40 }, expected: { fan: 50 } });
    expect(await answered(machine, made.id)).toMatchObject({
      outcome: "refused",
      refusal: { reason: "decaid", status: 500, message: "DeviceNotConnectedException: machine not connected", changed: [] },
    });
    expect(settingsWrites(tablet)).toEqual([]);
  });

  it("records Decaid's refusal of the write part-way, with the fields it changed before refusing", async () => {
    const { machine, tablet } = await connected("Settings refused part-way", cafe);
    // The machine does not take the steam purge mode's register write in time, after the fan threshold's (Decaid's order).
    tablet.failSettingWrites = ({ field }) => (field === "steamPurgeMode" ? { status: 500, body: { error: "TimeoutException: the machine did not answer" } } : undefined);
    const made = await make(machine, { collection: "machineSettings", fields: { fan: 45, steamPurgeMode: 1 }, expected: AS_REPORTED });
    expect(await answered(machine, made.id)).toMatchObject({
      outcome: "refused",
      refusal: { reason: "decaid", status: 500, message: "TimeoutException: the machine did not answer", changed: ["fan"] },
      readBack: { fan: 45, steamPurgeMode: 0 },
    });
    await expect.poll(() => machineSettings(machine)).toMatchObject({ fan: 45, steamPurgeMode: 0 });
  });

  it("sends an edit's read-back before its answer, though the machine's settings are read again while both wait to be sent", async () => {
    let stalled = false;
    const { machine, tablet } = await connected("Settings read-back held", cafe, {
      stallUpload: (frame) => stalled && (frame as Frame).type === "collection" && (frame as Frame).name === "appSettings",
    });
    await expect.poll(() => machineSettings(machine)).toMatchObject(AS_REPORTED);
    // A report of the Tablet Settings waits on the network, and the outbox sends nothing else until it is acknowledged.
    stalled = true;
    expect((await tablet.callApi("POST", "/settings", { themeMode: "dark" })).status).toBe(200);
    await expect.poll(() => (tablet.sent as Frame[]).some((frame) => frame.type === "collection" && frame.name === "appSettings" && (frame.value as { themeMode?: string }).themeMode === "dark")).toBe(true);

    // Where the edit's write falls among the plugin's requests, marked as the tablet takes it, refusing nothing. (Held with
    // `holdRequests` instead, it would fail as Decaid's fetch times out, 30 s by this tablet's clock, 600 ms at 50x.) Its
    // read-back is the next request to the machine's settings after it: `SettingsAccess` runs the edit and every other read
    // of them one at a time, and the tablet answers that read from what Decaid holds as it lists it, with no await between.
    let written: number | undefined;
    tablet.refuseWrites = ({ method, route }) => {
      if (method === "POST" && route === "/machine/settings") written ??= tablet.requests.length;
      return undefined;
    };
    const made = await make(machine, { collection: "machineSettings", fields: { fan: 40 }, expected: { fan: 50 } });
    // The edit has read back the fan threshold it wrote, not just written it, before anything else changes it.
    await expect.poll(() => written !== undefined && tablet.requests.slice(written).includes("/machine/settings")).toBe(true);
    tablet.refuseWrites = undefined;
    expect((await readHeld(tablet)).fan).toBe(40);
    // A barista lowers it again, and the machine's settings are read on their interval, while the edit's read-back and answer wait.
    expect((await tablet.callApi("POST", "/machine/settings", { fan: 30 })).status).toBe(202);
    const reads = settingsRequests(tablet);
    await expect.poll(() => settingsRequests(tablet)).toBeGreaterThan(reads);
    stalled = false;
    tablet.resumeUpload();

    expect(await answered(machine, made.id)).toMatchObject({ outcome: "applied", readBack: { fan: 40 } });
    await expect.poll(() => machineSettings(machine)).toMatchObject({ fan: 30 });
    // The read-back is sent before the answer, and the later read after it.
    const sent = (tablet.sent as Frame[]).flatMap((frame) => {
      if (frame.type === "settingsEdited") return ["answer"];
      return frame.type === "collection" && frame.name === "machineSettings" ? [`fan ${(frame.value as { fan: number }).fan}`] : [];
    });
    expect(sent.slice(sent.indexOf("fan 50") + 1)).toEqual(["fan 40", "answer", "fan 30"]);
  });

  it("sends an edit made through the instance not holding the connection, which that instance sends and either records the answer of", async () => {
    const { machine, tablet } = await connected("Settings across instances", cafe);
    const elsewhereApi = api.at(other.url);
    const made = await make(machine, { collection: "machineSettings", fields: { fan: 42 }, expected: { fan: 50 } }, elsewhereApi);
    expect(await answered(machine, made.id, elsewhereApi)).toMatchObject({ outcome: "applied", readBack: { fan: 42 } });
    expect((await readHeld(tablet)).fan).toBe(42);
    expect(editsReceived(tablet)).toHaveLength(1);
  });
});
