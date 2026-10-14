import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { STREAMLINE_NAMESPACE, type SimulatedStreamline, type StreamlineKey, startStreamline } from "./support/simulated-streamline.js";
import { NO_DYE2_LISTS, SimulatedTablet, derivedDe1Pro, settingsFor, workflowFixture } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for tickets #130 and #137: Streamline remembers what the barista
// last set for some of the steam, hot water and rinse settings in Decaid's
// store. The builds Decent Sync supports adopt a value the Workflow holds
// that differs from the one remembered, rather than pushing theirs back
// (ADR-0021, ADR-0017), but for the steam temperature, which Streamline sends
// with every steam time and never adopts. So the plugin writes a Location's
// settings into the Workflow, then sets Streamline's steam temperature to
// match, and Streamline keeps the Location's. The Location's settings are
// steam and rinse alone, so hot water stays each Machine's own (ADR-0014).
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
      api: { ...derivedDe1Pro({ serial: String(serial) }), "/beans": [], "/bean-batches": [], "/profiles": [], "/grinders": [], "/workflow": workflow, ...NO_DYE2_LISTS },
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

  it("keeps a steam time changed in the management interface, which Streamline on the tablet the Location's change is written to adopts", async () => {
    const { location, machines, tablets, settings } = await cafe("Steam time", 23001);
    const [tablet] = tablets as [SimulatedTablet];
    const streamline = await streamlineOn(tablet);
    expect((await change(settings, { "steamSettings.duration": 90 })).status).toBe(200);
    await holds(tablet, { "steamSettings.duration": 90 });
    // The machine echoes the new value, which Streamline adopts, pushing nothing.
    await expect.poll(() => streamline.adopted, { timeout: 10_000 }).toEqual([{ key: "last-steam-duration", value: 90 }]);
    await streamline.settled();
    expect(streamline.pushes).toEqual([]);
    expect(streamline.remembered("last-steam-duration")).toBe(90);
    expect(tablet.storeWrites).toEqual([]);
    expect(setting(tablet, "steamSettings.duration")).toBe(90);
    expect((await settingsAt(location)).values["steamSettings.duration"]).toBe(90);
    // Joining set the settings, and the only edit since is the management interface's.
    const history = await versions(settings);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ fields: { "steamSettings.duration": 90 }, source: { machine: null } });
    expect(await versionsBy(settings, machines[0]!)).toHaveLength(1);
  });

  it("leaves Streamline's value as it is when Decaid refuses the Workflow, so it has nothing to push once the machine is back", async () => {
    const { location, machines, tablets, settings } = await cafe("Refused Workflow", 23061);
    const [tablet] = tablets as [SimulatedTablet];
    const streamline = await streamlineOn(tablet);
    // The machine switched off, as for the night, while the tablet stays connected: Decaid refuses the Workflow.
    tablet.machineConnected = false;
    expect((await change(settings, { "steamSettings.duration": 90, "steamSettings.targetTemperature": 150 })).status).toBe(200);
    await expect.poll(() => settingsAnswers(tablet).some((answer) => answer.type === "writeRefused"), { timeout: 10_000 }).toBe(true);
    // The steam temperature is set only once Decaid has taken the Workflow.
    expect(tablet.storeWrites).toEqual([]);
    expect([streamline.remembered("last-steam-duration"), streamline.remembered("last-steam-temp")]).toEqual([120, 160]);
    // Set back before the machine returns, the Location's value is what the tablet holds, so nothing is written to it.
    expect((await change(settings, { "steamSettings.duration": 120, "steamSettings.targetTemperature": 160 })).status).toBe(200);
    tablet.connectMachine();
    await tablet.waitForLog(/The machine is connected again/);
    await streamline.reload();
    await streamline.settled();
    expect([streamline.pushes, streamline.adopted]).toEqual([[], []]);
    expect(setting(tablet, "steamSettings.duration")).toBe(120);
    expect((await settingsAt(location)).values["steamSettings.duration"]).toBe(120);
    expect(await versionsBy(settings, machines[0]!)).toHaveLength(1);
  });

  it("keeps a steam flow changed in the management interface, which Streamline adopts once it loads its data again", async () => {
    const { location, machines, tablets, settings } = await cafe("Flow", 23021);
    const [tablet] = tablets as [SimulatedTablet];
    const streamline = await streamlineOn(tablet);
    expect((await change(settings, { "steamSettings.flow": 2, "steamSettings.targetTemperature": 150 })).status).toBe(200);
    await holds(tablet, { "steamSettings.flow": 2, "steamSettings.targetTemperature": 150 });
    // No shot-settings frame carries the flow, so Streamline still remembers its own.
    expect(streamline.remembered("last-steam-flow")).toBe(2.5);
    // As when the machine connects again: Streamline compares every value it remembers with the Workflow, and adopts the flow.
    await streamline.reload();
    await streamline.settled();
    expect(streamline.pushes).toEqual([]);
    expect(streamline.adopted).toEqual([{ key: "last-steam-flow", value: 2 }]);
    expect(streamline.remembered("last-steam-flow")).toBe(2);
    // Streamline never adopts the steam temperature, so the plugin set it.
    expect(streamline.remembered("last-steam-temp")).toBe(150);
    expect(tablet.storeWrites).toEqual([{ namespace: STREAMLINE_NAMESPACE, key: "last-steam-temp", value: 150 }]);
    expect(setting(tablet, "steamSettings.flow")).toBe(2);
    expect((await settingsAt(location)).values["steamSettings.flow"]).toBe(2);
    expect(await versionsBy(settings, machines[0]!)).toHaveLength(1);
  });

  it("keeps a steam temperature changed in the management interface when a barista then changes the steam time in Streamline, which sends its remembered temperature with it", async () => {
    const { location, machines, tablets, settings } = await cafe("Steam temperature", 23091, 23092);
    const [first, second] = tablets as [SimulatedTablet, SimulatedTablet];
    const [mine, theirs] = [await streamlineOn(first), await streamlineOn(second)];
    expect((await change(settings, { "steamSettings.targetTemperature": 150 })).status).toBe(200);
    for (const tablet of tablets) await holds(tablet, { "steamSettings.targetTemperature": 150 });
    for (const [tablet, skin] of [[first, mine], [second, theirs]] as const) {
      expect(skin.remembered("last-steam-temp")).toBe(150);
      expect(tablet.storeWrites).toEqual([{ namespace: STREAMLINE_NAMESPACE, key: "last-steam-temp", value: 150 }]);
    }
    // Streamline's steam time setter sends the steam temperature it remembers along with it (`steamHeaterFor`).
    await mine.set("last-steam-duration", 100);
    await holds(second, { "steamSettings.duration": 100 });
    await Promise.all([mine.settled(), theirs.settled()]);
    for (const tablet of tablets) expect(setting(tablet, "steamSettings.targetTemperature")).toBe(150);
    expect((await settingsAt(location)).values).toMatchObject({ "steamSettings.duration": 100, "steamSettings.targetTemperature": 150 });
    expect((await versionsBy(settings, machines[0]!))[0]).toMatchObject({ fields: { "steamSettings.duration": 100 } });
    expect((await versionsBy(settings, machines[0]!))[0]!.fields).not.toHaveProperty(["steamSettings.targetTemperature"]);
  });

  it("sets no steam temperature on a tablet where Streamline keeps none, nor over a key holding anything but a number", async () => {
    const { tablets, settings } = await cafe("Plain", 23031, 23032);
    const [kept, none] = tablets as [SimulatedTablet, SimulatedTablet];
    expect((await kept.callApi("POST", `/store/${STREAMLINE_NAMESPACE}/last-steam-temp`, "hot")).status).toBe(200);
    expect((await change(settings, { "steamSettings.targetTemperature": 150 })).status).toBe(200);
    for (const tablet of tablets) await holds(tablet, { "steamSettings.targetTemperature": 150 });
    await kept.waitForLog(/Streamline's last-steam-temp holds something other than a number/);
    for (const tablet of tablets) expect(tablet.storeWrites).toEqual([]);
    expect([kept.storeValue(STREAMLINE_NAMESPACE, "last-steam-temp"), none.storeValue(STREAMLINE_NAMESPACE, "last-steam-temp")]).toEqual(["hot", null]);
  });

  it("lets Streamline push a barista's change Decaid refused once the machine is back, over a Location change made since", async () => {
    const { location, tablets, settings } = await cafe("Pending", 23101);
    const [tablet] = tablets as [SimulatedTablet];
    const streamline = await streamlineOn(tablet);
    tablet.machineConnected = false;
    // Streamline keeps the value and marks it pending before Decaid refuses it.
    await expect(streamline.set("last-steam-duration", 100)).rejects.toThrow(/refused Streamline's change/);
    expect((await change(settings, { "steamSettings.duration": 90 })).status).toBe(200);
    await expect.poll(() => settingsAnswers(tablet).some((answer) => answer.type === "writeRefused"), { timeout: 10_000 }).toBe(true);
    tablet.connectMachine();
    // The server writes the Location's 90 again, and Streamline, on the machine's echo of it, pushes its pending 100, which becomes the Location's.
    await expect.poll(() => streamline.pushes, { timeout: 10_000 }).toEqual([{ key: "last-steam-duration", value: 100 }]);
    await expect.poll(async () => (await settingsAt(location)).values["steamSettings.duration"], { timeout: 10_000 }).toBe(100);
    await holds(tablet, { "steamSettings.duration": 100 });
  });

  it("leaves a Location change written within 10 s of a barista's change in Streamline to the Workflow, Streamline keeping the barista's value", async () => {
    const { location, tablets, settings } = await cafe("Echo", 23111);
    const [tablet] = tablets as [SimulatedTablet];
    const streamline = await streamlineOn(tablet);
    // Streamline's clock held still, so what follows is inside ECHO_WINDOW_MS of its own push.
    const now = Date.now();
    streamline.clock = () => now;
    await streamline.set("last-steam-duration", 100);
    await expect.poll(async () => (await settingsAt(location)).values["steamSettings.duration"], { timeout: 10_000 }).toBe(100);
    expect((await change(settings, { "steamSettings.duration": 90 })).status).toBe(200);
    await holds(tablet, { "steamSettings.duration": 90 });
    await streamline.settled();
    // Taken as a stale echo of its own push: neither adopted nor pushed back over.
    expect([streamline.pushes, streamline.adopted]).toEqual([[], []]);
    expect(streamline.remembered("last-steam-duration")).toBe(100);
    expect((await settingsAt(location)).values["steamSettings.duration"]).toBe(90);
    // Once the window is over, Streamline adopts the Workflow's.
    streamline.clock = () => now + 11_000;
    await streamline.reload();
    await streamline.settled();
    expect(streamline.adopted).toEqual([{ key: "last-steam-duration", value: 90 }]);
    expect(setting(tablet, "steamSettings.duration")).toBe(90);
  });

  it("leaves Streamline's milk stop as it is for a stop turned off, and the steam values while the Machine's steam is off", async () => {
    const { machines, tablets, settings } = await cafe("Steam off", 23041);
    const [tablet] = tablets as [SimulatedTablet];
    const streamline = await streamlineOn(tablet);
    expect((await change(settings, { "steamSettings.stopAtTemperature": 0, "rinseData.duration": 8 })).status).toBe(200);
    await holds(tablet, { "steamSettings.stopAtTemperature": 0, "rinseData.duration": 8 });
    // Streamline checks the milk stop only while it is on, and adopts the flush time.
    await streamline.reload();
    await streamline.settled();
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
    expect([setting(tablet, "steamSettings.flow"), setting(tablet, "steamSettings.duration")]).toEqual([2.5, 120]);
    await streamline.reload();
    await streamline.settled();
    expect(streamline.pushes).toEqual([]);
    expect(streamline.remembered("last-steam-flow")).toBe(2.5);
    expect(streamline.remembered("last-steam-duration")).toBe(120);
    expect(streamline.remembered("last-flush-duration")).toBe(6);
    expect(tablet.storeWrites).toEqual([]);
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
    expect(theirs.adopted).toEqual([{ key: "last-steam-duration", value: 100 }]);
    expect((await settingsAt(location)).values["steamSettings.duration"]).toBe(100);
    expect((await versions(settings))[0]).toMatchObject({ fields: { "steamSettings.duration": 100 }, source: { machine: { id: machines[0]!.machine.id } } });
    expect(await versionsBy(settings, machines[1]!)).toEqual([]);
  });

  it("keeps a hot water change a barista makes in Streamline to that Machine, while both tablets take the Location's steam and flush", async () => {
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
    for (const [tablet, skin] of [[first, mine], [second, theirs]] as const) {
      expect(tablet.storeWrites).toEqual([]);
      expect(skin.remembered("last-steam-duration")).toBe(100);
    }
    // The hot water change is no edit of the Location's settings: the first tablet's only version is its joining.
    expect(Object.keys((await settingsAt(location)).values).some((field) => field.startsWith("hotWaterData."))).toBe(false);
    expect(await versionsBy(settings, machines[0]!)).toHaveLength(1);
  });
});
