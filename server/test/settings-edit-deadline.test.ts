import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import { RawConnection, type SimulatedTablet, helloWith } from "./support/simulated-tablet.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1 for ticket #225: a Settings Edit lands within 60 s, on the
// connection it was made for, or never. The built plugin in a simulated
// tablet, whose Decaid a test slows by holding its requests
// (`holdRequests`), always for less than Decaid's 30 s fetch timeout,
// against real servers sharing one PostgreSQL database. Tablets that hold
// requests run at real time, as the 60 s and the plugin's 15 s margin are
// counted at real time on both ends. Assertions are made through the REST
// API and what the tablet's Decaid holds. Serials are made up.

interface SettingsEditView {
  id: string;
  madeAt: string;
  sentAt: string | null;
  answeredAt: string | null;
  outcome: "applied" | "adjusted" | "refused" | "notConfirmed" | null;
  late: boolean;
  refusal: { reason: string; current?: Record<string, unknown> | null } | null;
  readBack: Record<string, unknown> | null;
}
interface Frame { type: string; id?: string }

/** The fan threshold and steam purge mode the tablets' machines start with (machine-settings.json). */
const AS_REPORTED = { fan: 50, steamPurgeMode: 0 };
const FAN_TO_40 = { collection: "machineSettings", fields: { fan: 40 }, expected: { fan: 50 } };

describe("Settings Edits within 60 s", () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  let cafe: LocationView;
  let serial = 22_500;
  const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
    cafe = await api.createLocation("Deadline cafe", "America/Toronto");
  });
  afterAll(async () => {
    await other?.stop();
    await server?.stop();
  });

  /**
   * A Machine at the cafe whose tablet is connected to `instance`, at real
   * time, with a Library of its own that is empty, once the server holds its
   * machine settings as reported.
   */
  async function connected(name: string, instance: TestServer = server, tabletSerial = serial++): Promise<{ machine: CreatedMachine; tablet: SimulatedTablet }> {
    const machine = await api.createMachine(name, cafe.id);
    const tablet = syncingTablet(machine, instance, { api: emptyLibrary(tabletSerial), timeScale: 1 });
    await api.waitForOnline(machine);
    await expect.poll(() => machineSettings(machine)).toMatchObject(AS_REPORTED);
    return { machine, tablet };
  }
  const path = (machine: CreatedMachine) => `/machines/${machine.machine.id}/settings-edits`;
  const make = async (machine: CreatedMachine, body: unknown, as = api) => (await as.send<{ settingsEdit: SettingsEditView }>("POST", path(machine), body, 201)).settingsEdit;
  const read = async (machine: CreatedMachine, id: string, as = api) => (await as.get<{ settingsEdit: SettingsEditView }>(`${path(machine)}/${id}`)).settingsEdit;
  /** Resolves with the edit once the plugin's answer to it has been recorded, whatever came of it. */
  async function answered(machine: CreatedMachine, id: string, as = api): Promise<SettingsEditView> {
    await expect.poll(async () => (await read(machine, id, as)).answeredAt, { timeout: 15_000 }).not.toBeNull();
    return read(machine, id, as);
  }
  const outcomeOf = async (machine: CreatedMachine, id: string) => (await read(machine, id)).outcome;
  const machineSettings = async (machine: CreatedMachine) =>
    (await api.get<{ collection: { value: Record<string, unknown> } | null }>(`/machines/${machine.machine.id}/collections/machineSettings`)).collection?.value;
  /** The machine settings the tablet's Decaid holds, read as another app on the tablet would. */
  const held = async (tablet: SimulatedTablet) => (await tablet.callApi("GET", "/machine/settings")).body as Record<string, unknown>;
  const settingsWrites = (tablet: SimulatedTablet) => tablet.writes.filter((write) => write === "POST /machine/settings");
  const editsReceived = (tablet: SimulatedTablet) => tablet.received.filter((frame) => (frame as Frame).type === "settingsEdit") as Frame[];
  /** Resolves once `ms` have passed since `madeAt`, an edit's time made. */
  const after = (madeAt: string, ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(madeAt) + ms - Date.now())));

  it("marks edits unanswered after 60 s not confirmed, refuses one that would start its write with less than 15 s left as expired, and records a slow write's late answer", async () => {
    // One tablet's first edit starts its write in time, which Decaid answers after 60 s; its second waits behind it.
    // The other's only edit reaches its write with 12 s left.
    const { machine: slow, tablet: slowTablet } = await connected("Deadline slow write");
    const { machine: tight, tablet: tightTablet } = await connected("Deadline too late to write");
    const holds = (tablet: SimulatedTablet) => ({
      state: tablet.holdRequests("GET", "/machine/state"),
      read: tablet.holdRequests("GET", "/machine/settings"),
      write: tablet.holdRequests("POST", "/machine/settings"),
    });
    const slowHolds = holds(slowTablet);
    const tightHolds = holds(tightTablet);
    const first = await make(slow, FAN_TO_40);
    const second = await make(slow, { collection: "machineSettings", fields: { steamPurgeMode: 1 }, expected: { steamPurgeMode: 0 } });
    const alone = await make(tight, FAN_TO_40);
    // Both are sent at once, the second without waiting for the first's answer.
    await expect.poll(() => editsReceived(slowTablet).map((frame) => frame.id)).toEqual([first.id, second.id]);
    await expect.poll(() => [slowHolds.state.arrived, tightHolds.state.arrived]).toEqual([1, 1]);

    await after(first.madeAt, 25_000);
    slowHolds.state.release();
    tightHolds.state.release();
    await expect.poll(() => [slowHolds.read.arrived, tightHolds.read.arrived]).toEqual([1, 1]);
    // With 20 s left, the first edit's write starts.
    await after(first.madeAt, 40_000);
    slowHolds.read.release();
    await expect.poll(() => slowHolds.write.arrived).toBe(1);
    // With 12 s left, the other's would not finish in time: it is refused, before the 60 s, and nothing written.
    await after(alone.madeAt, 48_000);
    tightHolds.read.release();
    expect(await answered(tight, alone.id)).toMatchObject({ outcome: "refused", late: false, refusal: { reason: "expired" } });
    expect(tightHolds.write.arrived).toBe(0);
    expect(settingsWrites(tightTablet)).toEqual([]);

    // 60 s after they were made, neither of the first tablet's edits is answered.
    await expect.poll(() => outcomeOf(slow, first.id), { timeout: 20_000 }).toBe("notConfirmed");
    expect(await read(slow, second.id)).toMatchObject({ outcome: "notConfirmed", answeredAt: null, late: false, refusal: null });
    expect(Date.now() - Date.parse(first.madeAt)).toBeGreaterThanOrEqual(59_000);

    // Decaid finishes the write: its answer replaces the mark, marked late.
    slowHolds.write.release();
    expect(await answered(slow, first.id)).toMatchObject({ outcome: "applied", late: true, refusal: null, readBack: { fan: 40 } });
    // The second's turn came too late: refused as expired, it stays not confirmed, its write never started.
    expect(await answered(slow, second.id)).toMatchObject({ outcome: "notConfirmed", late: false, refusal: null });
    expect(settingsWrites(slowTablet)).toEqual(["POST /machine/settings"]);
    expect(await held(slowTablet)).toMatchObject({ fan: 40, steamPurgeMode: 0 });
    await expect.poll(() => machineSettings(slow)).toMatchObject({ fan: 40, steamPurgeMode: 0 });
  }, 120_000);

  it("sends two edits made at once at once, and carries them out in order: the second, expecting a value the first changed, is refused as changed since", async () => {
    const { machine, tablet } = await connected("Deadline two at once");
    const state = tablet.holdRequests("GET", "/machine/state");
    const first = await make(machine, FAN_TO_40);
    const second = await make(machine, { collection: "machineSettings", fields: { fan: 30 }, expected: { fan: 50 } });
    await expect.poll(() => editsReceived(tablet).map((frame) => frame.id)).toEqual([first.id, second.id]);
    state.release();

    expect(await answered(machine, first.id)).toMatchObject({ outcome: "applied", late: false, readBack: { fan: 40 } });
    expect(await answered(machine, second.id)).toMatchObject({ outcome: "refused", late: false, refusal: { reason: "changedSince", current: { fan: 40 } } });
    expect(settingsWrites(tablet)).toEqual(["POST /machine/settings"]);
    expect((await held(tablet)).fan).toBe(40);
  });

  it("leaves an edit whose connection drops before its write not confirmed, and sends the new connection nothing of it", async () => {
    const { machine, tablet } = await connected("Deadline reconnect");
    const state = tablet.holdRequests("GET", "/machine/state");
    const made = await make(machine, FAN_TO_40);
    await expect.poll(() => state.arrived).toBe(1);

    tablet.dropConnections();
    await expect.poll(() => outcomeOf(machine, made.id)).toBe("notConfirmed");
    await api.waitForOnline(machine);
    // Its write is not started: refused as expired, an answer the new connection takes, it stays not confirmed.
    state.release();
    expect(await answered(machine, made.id)).toMatchObject({ outcome: "notConfirmed", late: false, refusal: null });
    expect(editsReceived(tablet)).toHaveLength(1);
    expect(settingsWrites(tablet)).toEqual([]);
    expect((await held(tablet)).fan).toBe(50);
  });

  it("leaves an edit under way as the plugin unloads not confirmed, writes nothing of it, and sends its next load nothing of it", async () => {
    const { machine, tablet } = await connected("Deadline unload");
    const state = tablet.holdRequests("GET", "/machine/state");
    const made = await make(machine, FAN_TO_40);
    await expect.poll(() => state.arrived).toBe(1);

    await tablet.unload();
    await expect.poll(() => outcomeOf(machine, made.id)).toBe("notConfirmed");
    const reloaded = await tablet.reload();
    await api.waitForOnline(machine);
    // Decaid answers the unloaded plugin's read: it goes no further.
    state.release();
    await expect.poll(() => reloaded.received.some((frame) => (frame as Frame).type === "welcome")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await read(machine, made.id)).toMatchObject({ outcome: "notConfirmed", answeredAt: null });
    expect(editsReceived(reloaded)).toEqual([]);
    expect([...settingsWrites(tablet), ...settingsWrites(reloaded)]).toEqual([]);
    expect((await held(reloaded)).fan).toBe(50);
  });

  it("sends an edit to the Tablet whose connection now holds the Machine after a Tablet swap, leaving one made for the replaced connection not confirmed", async () => {
    const machineSerial = serial++;
    const { machine, tablet: replaced } = await connected("Deadline Tablet swap", server, machineSerial);
    const state = replaced.holdRequests("GET", "/machine/state");
    const before = await make(machine, FAN_TO_40);
    await expect.poll(() => state.arrived).toBe(1);

    // Another tablet is attached to the same machine, and takes it over.
    const attached = syncingTablet(machine, server, { api: emptyLibrary(machineSerial), timeScale: 1 });
    await expect.poll(() => outcomeOf(machine, before.id)).toBe("notConfirmed");
    await expect.poll(() => attached.received.some((frame) => (frame as Frame).type === "welcome")).toBe(true);
    const after = await make(machine, { collection: "machineSettings", fields: { fan: 35 }, expected: { fan: 50 } });
    expect(await answered(machine, after.id)).toMatchObject({ outcome: "applied", readBack: { fan: 35 } });
    expect(editsReceived(attached).map((frame) => frame.id)).toEqual([after.id]);
    expect((await held(attached)).fan).toBe(35);

    // The replaced tablet, its connection closed, writes nothing of the edit made for it.
    state.release();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(editsReceived(replaced).map((frame) => frame.id)).toEqual([before.id]);
    expect(settingsWrites(replaced)).toEqual([]);
    expect(await read(machine, before.id)).toMatchObject({ outcome: "notConfirmed" });
  });

  it("leaves an edit made before the instance holding the connection crashed not confirmed, and refuses new edits with 409 once the Machine is no longer heard from", async () => {
    const doomed = await startTestServer({ env, sharing: server });
    try {
      const { machine, tablet } = await connected("Deadline crash", doomed);
      const state = tablet.holdRequests("GET", "/machine/state");
      // Made through the instance that stays up.
      const made = await make(machine, FAN_TO_40);
      await expect.poll(() => state.arrived).toBe(1);

      await doomed.kill();
      // Nothing released the Machine; only the silence of three heartbeat intervals tells.
      await expect.poll(() => outcomeOf(machine, made.id), { timeout: 15_000 }).toBe("notConfirmed");
      const response = await api.call("POST", path(machine), FAN_TO_40);
      expect(response.status, await response.text()).toBe(409);
      state.release();
    } finally {
      await doomed.stop();
    }
  });

  it("sends a connection's unsent edits once its instance listens for them again", async () => {
    const { machine, tablet } = await connected("Deadline listening again");
    const database = await server.connectDatabase();
    const notListening = () => server.output().split("Not listening for access changes, Library changes, moves or Settings Edits").length - 1;
    try {
      const before = notListening();
      // Every instance loses its listening connection; the edit's notification reaches neither.
      await database.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND query LIKE 'LISTEN %'");
      await expect.poll(notListening).toBeGreaterThan(before);
      const made = await make(machine, FAN_TO_40, api.at(other.url));
      expect(await answered(machine, made.id)).toMatchObject({ outcome: "applied", late: false, readBack: { fan: 40 } });
      expect(editsReceived(tablet)).toHaveLength(1);
    } finally {
      await database.end();
    }
  });

  it("records an answer that reaches the other instance on the tablet's next connection, marked late", async () => {
    const machine = await api.createMachine("Deadline answered elsewhere", cafe.id);
    const tabletId = randomUUID();
    const welcomed = (instance: TestServer) => RawConnection.welcomed(instance.url, helloWith(machine.token, { tabletId, machine: null }));
    const sentEdits = (raw: RawConnection) => raw.messages.filter((message) => (message as Frame).type === "settingsEdit");
    const first = await welcomed(server);
    const made = await make(machine, FAN_TO_40);
    await expect.poll(() => sentEdits(first).map((message) => (message as Frame).id)).toEqual([made.id]);

    // The connection drops while Decaid writes; the answer goes on the next one, which reaches the other instance.
    await first.terminate();
    await expect.poll(() => outcomeOf(machine, made.id)).toBe("notConfirmed");
    const second = await welcomed(other);
    await second.deliver({ type: "settingsEdited", id: made.id, outcome: "written", values: { fan: 40 } });
    expect(await read(machine, made.id, api.at(other.url))).toMatchObject({ outcome: "applied", late: true, readBack: { fan: 40 } });
    expect(sentEdits(second)).toEqual([]);
    await second.close();
  });
});
