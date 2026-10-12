import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { STREAMLINE_NAMESPACE, type SimulatedStreamline, type StreamlineKey, startStreamline } from "./support/simulated-streamline.js";
import { SimulatedTablet, derivedDe1Pro, settingsFor, workflowFixture } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for tickets #130 and #137: Streamline remembers what the barista
// last set for some of the steam, hot water and rinse settings in Decaid's
// store, and pushes it back over the Workflow whenever the Workflow holds
// another. So when the plugin writes a Location's settings to a tablet, it
// first sets the values Streamline remembers of them to match, and Streamline
// keeps the Location's (ADR-0021). The Location's settings are steam and
// rinse alone, so its hot water keys are left as they are (ADR-0014).
// Through the built plugin in simulated tablets running the simulated
// Streamline, with assertions through the REST API and what each simulated
// tablet's Decaid holds. Serials are made up, from 23001.

type Record_ = Record<string, unknown>;
type Parts = Record<string, Record_>;

interface SettingsView {
  id: string | null;
  values: Record<string, number | null>;
}

interface VersionView {
  fields: Record_;
  source: { machine: { id: string } | null; account: { id: string } | null };
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** The settings of the tablets' Workflows, and what Streamline remembers of them where it runs. */
const SETTINGS: Parts = {
  steamSettings: { targetTemperature: 160, duration: 120, flow: 2.5, stopAtTemperature: 60 },
  hotWaterData: { targetTemperature: 65, volume: 100 },
  rinseData: { duration: 5 },
};
const REMEMBERED: Partial<Record<StreamlineKey, number>> = {
  "last-steam-temp": 160,
  "last-steam-duration": 120,
  "last-steam-flow": 2.5,
  "last-milk-stop": 60,
  "last-hot-water-volume": 100,
  "last-hot-water-temp": 65,
  "last-flush-duration": 5,
};

describe("Streamline's remembered steam and rinse values", { timeout: 60_000 }, () => {
  let server: TestServer;
  let api: AdminApi;
  const tablets: SimulatedTablet[] = [];
  const skins: SimulatedStreamline[] = [];

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
  }, 60_000);
  afterAll(async () => {
    for (const skin of skins) skin.stop();
    await Promise.all(tablets.map((tablet) => tablet.unload()));
    await server?.stop();
  });

  /** The built plugin on a tablet of the Machine, its Workflow holding SETTINGS, with an empty Library. */
  function load(machine: CreatedMachine, serial: number): SimulatedTablet {
    const workflow = workflowFixture();
    for (const [part, values] of Object.entries(SETTINGS)) workflow[part] = { ...(workflow[part] as Record_), ...values };
    const tablet = SimulatedTablet.load({
      settings: { ...settingsFor({ token: machine.token, serverUrl: server.url }), PollSeconds: 5 },
      api: { ...derivedDe1Pro({ serial: String(serial) }), "/beans": [], "/bean-batches": [], "/profiles": [], "/grinders": [], "/workflow": workflow },
      timeScale: 50,
    });
    tablets.push(tablet);
    return tablet;
  }

  /** Streamline on the tablet, remembering the values given, REMEMBERED by default. */
  async function streamlineOn(tablet: SimulatedTablet, remembered = REMEMBERED): Promise<SimulatedStreamline> {
    const skin = await startStreamline(tablet, remembered);
    skins.push(skin);
    return skin;
  }

  /** A Location with a Machine for each serial, online, each tablet loaded, once the first has set the Location's settings. */
  async function cafe(name: string, ...serials: number[]) {
    const location = await api.createLocation(name, "America/Chicago");
    const machines: CreatedMachine[] = [];
    const loaded: SimulatedTablet[] = [];
    for (const [index, serial] of serials.entries()) {
      const machine = await api.createMachine(`${name} ${index + 1}`, location.id);
      machines.push(machine);
      loaded.push(load(machine, serial));
      await api.waitForMachine(machine.machine.name, (viewed) => viewed.online);
    }
    const settings = await settingsOf(location);
    return { location, machines, tablets: loaded, settings };
  }

  const settingsAt = async (location: LocationView) =>
    ((await (await api.call("GET", `/locations/${location.id}/settings`)).json()) as { settings: SettingsView }).settings;
  async function settingsOf(location: LocationView): Promise<SettingsView> {
    await expect.poll(async () => (await settingsAt(location)).id, { timeout: 10_000 }).not.toBeNull();
    return settingsAt(location);
  }
  const versions = async (settings: SettingsView) =>
    ((await (await api.call("GET", `/location-settings/${settings.id}/history`)).json()) as { versions: VersionView[] }).versions;
  const change = (settings: SettingsView, values: Record<string, number>) => api.call("PATCH", `/location-settings/${settings.id}`, { values });
  function setting(tablet: SimulatedTablet, field: string): unknown {
    const [part, name] = field.split(".") as [string, string];
    return (tablet.workflow()[part] as Record_)[name];
  }
  async function holds(tablet: SimulatedTablet, values: Record<string, number>): Promise<void> {
    await expect.poll(() => Object.fromEntries(Object.keys(values).map((field) => [field, setting(tablet, field)])), { timeout: 10_000 }).toEqual(values);
  }
  /** The versions of the settings a Machine made. */
  const versionsBy = async (settings: SettingsView, { machine }: CreatedMachine) =>
    (await versions(settings)).filter((version) => version.source.machine?.id === machine.id);
  /** The latest Workflow the server stored for the Machine. */
  const latestWorkflow = async ({ machine }: CreatedMachine) => {
    const { events } = (await (await api.call("GET", `/machines/${machine.id}/workflow-events?limit=1`)).json()) as { events: { workflow: Parts }[] };
    return events[0]?.workflow;
  };
  /** The answers to settings writes the tablet's plugin sent. */
  const settingsAnswers = (tablet: SimulatedTablet) => tablet.sent.filter((frame) => (frame as Record_).kind === "settings") as Record_[];

  it("keeps a steam time changed in the management interface, as Streamline remembers it on the tablet the Location's change is written to", async () => {
    const { location, machines, tablets, settings } = await cafe("Steam time", 23001);
    const [tablet] = tablets as [SimulatedTablet];
    const streamline = await streamlineOn(tablet);
    expect((await change(settings, { "steamSettings.duration": 90 })).status).toBe(200);
    await holds(tablet, { "steamSettings.duration": 90 });
    // The machine echoes the new value, and Streamline, finding it remembers the same, pushes nothing.
    await streamline.settled();
    expect(streamline.pushes).toEqual([]);
    expect(streamline.remembered("last-steam-duration")).toBe(90);
    expect(tablet.storeWrites).toEqual([{ namespace: STREAMLINE_NAMESPACE, key: "last-steam-duration", value: 90 }]);
    expect(setting(tablet, "steamSettings.duration")).toBe(90);
    expect((await settingsAt(location)).values["steamSettings.duration"]).toBe(90);
    // Joining set the settings, and the only edit since is the management interface's.
    const history = await versions(settings);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ fields: { "steamSettings.duration": 90 }, source: { machine: null } });
    expect(await versionsBy(settings, machines[0]!)).toHaveLength(1);
  });

  it("lets Streamline push its remembered value back over the Location's when Decaid refuses to set it, as it did before, the settings write still answered", async () => {
    const { location, machines, tablets, settings } = await cafe("Refused", 23011);
    const [tablet] = tablets as [SimulatedTablet];
    const streamline = await streamlineOn(tablet);
    tablet.refuseWrites = ({ method, route }) =>
      method === "POST" && route.startsWith(`/store/${STREAMLINE_NAMESPACE}/`) ? { status: 500, body: { error: "Internal server error" } } : undefined;
    expect((await change(settings, { "steamSettings.duration": 90 })).status).toBe(200);
    await tablet.waitForLog(/Could not set Streamline's last-steam-duration: Decaid answered 500/);
    // The Workflow was still written, and the write answered as written.
    await expect
      .poll(() => settingsAnswers(tablet).filter((answer) => answer.type === "written").map((answer) => answer.writtenFields), { timeout: 10_000 })
      .toContainEqual(["steamSettings.duration"]);
    expect(tablet.storeWrites).toEqual([]);
    // Streamline, still remembering 120, pushes it back, which becomes the Location's value as the Machine's edit.
    await expect.poll(() => streamline.pushes, { timeout: 10_000 }).toEqual([{ key: "last-steam-duration", value: 120 }]);
    await expect.poll(async () => (await settingsAt(location)).values["steamSettings.duration"], { timeout: 10_000 }).toBe(120);
    expect((await versionsBy(settings, machines[0]!))[0]).toMatchObject({ fields: { "steamSettings.duration": 120 } });
  });

  it("sets Streamline's value back when Decaid refuses the Workflow, so it does not push a value the Location has since dropped", async () => {
    const { location, machines, tablets, settings } = await cafe("Refused Workflow", 23061);
    const [tablet] = tablets as [SimulatedTablet];
    const streamline = await streamlineOn(tablet);
    // The machine switched off, as for the night, while the tablet stays connected: Decaid refuses the Workflow.
    tablet.machineConnected = false;
    expect((await change(settings, { "steamSettings.duration": 90 })).status).toBe(200);
    await expect.poll(() => settingsAnswers(tablet).some((answer) => answer.type === "writeRefused"), { timeout: 10_000 }).toBe(true);
    expect(tablet.storeWrites.map(({ value }) => value)).toEqual([90, 120]);
    expect(streamline.remembered("last-steam-duration")).toBe(120);
    // Set back before the machine returns, the Location's value is what the tablet holds, so nothing is written to it.
    expect((await change(settings, { "steamSettings.duration": 120 })).status).toBe(200);
    tablet.connectMachine();
    await tablet.waitForLog(/The machine is connected again/);
    await streamline.reload();
    await streamline.settled();
    expect(streamline.pushes).toEqual([]);
    expect(setting(tablet, "steamSettings.duration")).toBe(120);
    expect((await settingsAt(location)).values["steamSettings.duration"]).toBe(120);
    expect(await versionsBy(settings, machines[0]!)).toHaveLength(1);
  });

  it("sets back only the keys still holding what it set when Decaid refuses the Workflow for another reason, keeping a barista's change made meanwhile", async () => {
    const { tablets, settings } = await cafe("Busy", 23071);
    const [tablet] = tablets as [SimulatedTablet];
    const streamline = await streamlineOn(tablet);
    // Decaid's request queue times out the Workflow write, while a barista sets the steam time in Streamline.
    tablet.refuseWrites = ({ method, route }) => {
      if (method !== "PUT" || route !== "/workflow") return undefined;
      tablet.refuseWrites = undefined;
      void streamline.keep("last-steam-duration", 130);
      return { status: 503, body: { error: "Request timed out" } };
    };
    expect((await change(settings, { "steamSettings.duration": 90, "rinseData.duration": 8 })).status).toBe(200);
    await expect.poll(() => settingsAnswers(tablet).some((answer) => answer.type === "writeRefused"), { timeout: 10_000 }).toBe(true);
    expect(tablet.storeWrites.filter(({ key }) => key === "last-flush-duration").map(({ value }) => value)).toEqual([8, 5]);
    expect(streamline.remembered("last-flush-duration")).toBe(5);
    expect(streamline.remembered("last-steam-duration")).toBe(130);
    expect([setting(tablet, "steamSettings.duration"), setting(tablet, "rinseData.duration")]).toEqual([120, 5]);
  });

  it("keeps a steam flow changed in the management interface once Streamline loads its data again", async () => {
    const { location, machines, tablets, settings } = await cafe("Flow", 23021);
    const [tablet] = tablets as [SimulatedTablet];
    const streamline = await streamlineOn(tablet);
    expect((await change(settings, { "steamSettings.flow": 2, "steamSettings.targetTemperature": 150 })).status).toBe(200);
    await holds(tablet, { "steamSettings.flow": 2, "steamSettings.targetTemperature": 150 });
    expect(streamline.remembered("last-steam-flow")).toBe(2);
    expect(streamline.remembered("last-steam-temp")).toBe(150);
    // As when the machine connects again: Streamline compares every value it remembers with the Workflow.
    await streamline.reload();
    await streamline.settled();
    expect(streamline.pushes).toEqual([]);
    expect(setting(tablet, "steamSettings.flow")).toBe(2);
    expect((await settingsAt(location)).values["steamSettings.flow"]).toBe(2);
    expect(await versionsBy(settings, machines[0]!)).toHaveLength(1);
  });

  it("writes nothing to Decaid's store on a tablet where Streamline keeps nothing, nor to a key holding anything but a number", async () => {
    const { tablets, settings } = await cafe("Plain", 23031);
    const [tablet] = tablets as [SimulatedTablet];
    expect((await tablet.callApi("POST", `/store/${STREAMLINE_NAMESPACE}/last-flush-duration`, "5 s")).status).toBe(200);
    expect((await change(settings, { "steamSettings.duration": 100, "steamSettings.flow": 1.8, "rinseData.duration": 9 })).status).toBe(200);
    await holds(tablet, { "steamSettings.duration": 100, "steamSettings.flow": 1.8, "rinseData.duration": 9 });
    expect(tablet.writes.filter((write) => write.startsWith("POST /store/"))).toEqual([]);
    expect(tablet.storeWrites).toEqual([]);
    expect(tablet.storeValue(STREAMLINE_NAMESPACE, "last-steam-duration")).toBeNull();
    expect(tablet.storeValue(STREAMLINE_NAMESPACE, "last-flush-duration")).toBe("5 s");
    await tablet.waitForLog(/Streamline's last-flush-duration holds something other than a number/);
  });

  it("leaves Streamline's milk stop as it is for a stop turned off, and its steam values while the Machine's steam is off", async () => {
    const { machines, tablets, settings } = await cafe("Steam off", 23041);
    const [tablet] = tablets as [SimulatedTablet];
    const streamline = await streamlineOn(tablet);
    expect((await change(settings, { "steamSettings.stopAtTemperature": 0, "rinseData.duration": 8 })).status).toBe(200);
    await holds(tablet, { "steamSettings.stopAtTemperature": 0, "rinseData.duration": 8 });
    expect(streamline.remembered("last-milk-stop")).toBe(60);
    expect(streamline.remembered("last-flush-duration")).toBe(8);

    // Steam turned off on the tablet, which the server has once it has the Workflow.
    await tablet.changeSettings({ steamSettings: { targetTemperature: 0 } });
    await expect.poll(async () => {
      const { events } = (await (await api.call("GET", `/machines/${machines[0]!.machine.id}/workflow-events?limit=10`)).json()) as { events: { workflow: Parts }[] };
      return events[0]?.workflow.steamSettings?.targetTemperature;
    }, { timeout: 10_000 }).toBe(0);
    expect((await change(settings, { "steamSettings.flow": 1.2, "steamSettings.duration": 90, "rinseData.duration": 6 })).status).toBe(200);
    await holds(tablet, { "rinseData.duration": 6 });
    expect(setting(tablet, "steamSettings.flow")).toBe(2.5);
    expect(streamline.remembered("last-steam-flow")).toBe(2.5);
    expect(streamline.remembered("last-steam-duration")).toBe(120);
    expect(streamline.remembered("last-flush-duration")).toBe(6);
    expect(tablet.storeWrites.map(({ key }) => key)).toEqual(["last-flush-duration", "last-flush-duration"]);
  });

  it("takes a change a barista makes in Streamline to the Location, and to another tablet running Streamline, which keeps it", async () => {
    const { location, machines, tablets, settings } = await cafe("Barista", 23051, 23052);
    const [first, second] = tablets as [SimulatedTablet, SimulatedTablet];
    const [mine, theirs] = [await streamlineOn(first), await streamlineOn(second)];
    await mine.set("last-steam-duration", 100);
    await holds(second, { "steamSettings.duration": 100 });
    await Promise.all([mine.settled(), theirs.settled()]);
    expect(theirs.remembered("last-steam-duration")).toBe(100);
    expect([mine.pushes, theirs.pushes]).toEqual([[], []]);
    expect((await settingsAt(location)).values["steamSettings.duration"]).toBe(100);
    expect((await versions(settings))[0]).toMatchObject({ fields: { "steamSettings.duration": 100 }, source: { machine: { id: machines[0]!.machine.id } } });
    expect(await versionsBy(settings, machines[1]!)).toEqual([]);
  });

  it("keeps a hot water change a barista makes in Streamline to that Machine, and sets only the steam and flush keys of the settings the Location writes", async () => {
    const { location, machines, tablets, settings } = await cafe("Hot water", 23081, 23082);
    const [first, second] = tablets as [SimulatedTablet, SimulatedTablet];
    const [mine, theirs] = [await streamlineOn(first), await streamlineOn(second)];
    await mine.set("last-hot-water-volume", 150);
    await mine.settled();
    await mine.set("last-hot-water-temp", 80);
    await expect.poll(async () => (await latestWorkflow(machines[0]!))?.hotWaterData, { timeout: 10_000 }).toMatchObject({ volume: 150, targetTemperature: 80 });
    // A change of the Location's settings after it reaches both tablets, each keeping its own hot water.
    expect((await change(settings, { "steamSettings.duration": 100, "steamSettings.flow": 1.8, "rinseData.duration": 7 })).status).toBe(200);
    for (const tablet of tablets) await holds(tablet, { "steamSettings.duration": 100, "steamSettings.flow": 1.8, "rinseData.duration": 7 });
    await Promise.all([mine.settled(), theirs.settled()]);
    expect([mine.pushes, theirs.pushes]).toEqual([[], []]);
    expect([setting(first, "hotWaterData.volume"), setting(first, "hotWaterData.targetTemperature")]).toEqual([150, 80]);
    expect([setting(second, "hotWaterData.volume"), setting(second, "hotWaterData.targetTemperature")]).toEqual([100, 65]);
    expect([mine.remembered("last-hot-water-volume"), mine.remembered("last-hot-water-temp")]).toEqual([150, 80]);
    expect([theirs.remembered("last-hot-water-volume"), theirs.remembered("last-hot-water-temp")]).toEqual([100, 65]);
    // The plugin set only the keys of the steam and rinse settings it wrote, on each tablet.
    for (const tablet of tablets) {
      expect(tablet.storeWrites.map(({ key }) => key).sort()).toEqual(["last-flush-duration", "last-steam-duration", "last-steam-flow"]);
    }
    // The hot water change is no edit of the Location's settings: the first tablet's only version is its joining.
    expect(Object.keys((await settingsAt(location)).values).some((field) => field.startsWith("hotWaterData."))).toBe(false);
    expect(await versionsBy(settings, machines[0]!)).toHaveLength(1);
  });
});
