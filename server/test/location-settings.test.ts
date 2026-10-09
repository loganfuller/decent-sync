import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite } from "./support/admin-api.js";
import { SimulatedTablet, derivedDe1Pro, settingsFor, workflowFixture } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #86: steam, hot water and rinse settings are shared by a
// Location's Machines, whatever their model (ADR-0014). The first Machine at
// a Location sets them; a change on one tablet reaches the Location's other
// Machines, and a change in the management interface reaches them all. A
// Machine with sharing turned off keeps its own, and takes the Location's
// once sharing is turned back on. Turning steam off stays on that Machine, and once it is
// turned on again the Machine takes the Location's values. Through the built
// plugin in simulated tablets, on two server instances sharing one database,
// with assertions through the REST API and what each simulated tablet's
// Decaid holds. Serials are made up, from 19001.

type Record_ = Record<string, unknown>;
type Parts = Record<string, Record_>;

interface SettingsView {
  id: string | null;
  values: Record<string, number | null>;
  machines: { id: string; name: string; model: string | null; sharesSettings: boolean }[];
  editable: boolean;
}

interface VersionView {
  fields: Record_;
  source: { machine: { id: string; name: string } | null; tabletId: string | null; account: { id: string } | null };
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** The test tablet's Workflow with these settings changed. */
function workflowWith(parts: Parts = {}): Record_ {
  const workflow = workflowFixture();
  for (const [part, values] of Object.entries(parts)) workflow[part] = { ...(workflow[part] as Record_), ...values };
  return workflow;
}

describe("Steam, hot water and rinse settings shared by a Location's Machines", { timeout: 60_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  const tablets: SimulatedTablet[] = [];

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
  }, 60_000);
  afterAll(async () => {
    await Promise.all(tablets.map((tablet) => tablet.unload()));
    await other?.stop();
    await server?.stop();
  });

  /** The built plugin on a tablet of the Machine, its Workflow's settings changed as given, and an empty Library. */
  function load(
    machine: CreatedMachine,
    serial: string,
    options: { instance?: TestServer; model?: string; parts?: Parts; stallUpload?: (frame: unknown) => boolean } = {},
  ): SimulatedTablet {
    const tablet = SimulatedTablet.load({
      settings: { ...settingsFor({ token: machine.token, serverUrl: (options.instance ?? server).url }), PollSeconds: 5 },
      api: {
        ...derivedDe1Pro({ serial, model: options.model }),
        "/beans": [],
        "/bean-batches": [],
        "/profiles": [],
        "/grinders": [],
        "/workflow": workflowWith(options.parts),
      },
      timeScale: 50,
      stallUpload: options.stallUpload,
    });
    tablets.push(tablet);
    return tablet;
  }

  async function online(...machines: CreatedMachine[]): Promise<void> {
    for (const { machine } of machines) await api.waitForMachine(machine.name, (viewed) => viewed.online);
  }

  const settingsAt = async (location: LocationView, as = api) =>
    ((await (await as.call("GET", `/locations/${location.id}/settings`)).json()) as { settings: SettingsView }).settings;
  /** Resolves with the Location's settings once they are set. */
  async function settingsOf(location: LocationView): Promise<SettingsView> {
    await expect.poll(async () => (await settingsAt(location)).id, { timeout: 10_000 }).not.toBeNull();
    return settingsAt(location);
  }
  const versions = async (settings: SettingsView) =>
    ((await (await api.call("GET", `/location-settings/${settings.id}/history`)).json()) as { versions: VersionView[] }).versions;
  /** A setting of the tablet's Workflow, as Decaid holds it, by its name, such as `steamSettings.flow`. */
  function setting(tablet: SimulatedTablet, field: string): unknown {
    const [part, name] = field.split(".") as [string, string];
    return (tablet.workflow()[part] as Record_)[name];
  }
  /** Resolves once the tablet's Workflow holds those settings. */
  async function holds(tablet: SimulatedTablet, values: Record<string, number>): Promise<void> {
    await expect.poll(() => Object.fromEntries(Object.keys(values).map((field) => [field, setting(tablet, field)])), { timeout: 10_000 }).toEqual(values);
  }
  const workflowWrites = (tablet: SimulatedTablet) => tablet.writes.filter((write) => write === "PUT /workflow");
  /** Each value of a setting the Machine's Workflows the server stored held, the latest first. */
  const storedSettings = async ({ machine }: CreatedMachine, part: string, name: string) => {
    const { events } = (await (await api.call("GET", `/machines/${machine.id}/workflow-events?limit=100`)).json()) as { events: { workflow: Record<string, Record_> }[] };
    return events.map((event) => event.workflow[part]?.[name]);
  };

  /**
   * Uptown with two DE1Pros, the second on the other instance, and a Bengle;
   * Belmont with a DE1Pro. The first DE1Pro at Uptown reports its Workflow
   * first, and each Machine's steam flow differs. Resolves once each of
   * Uptown's has taken Uptown's settings.
   */
  async function cafes(name: string, serials: number, options: { stallBengle?: (frame: unknown) => boolean } = {}) {
    const uptown = await api.createLocation(`${name} Uptown`, "America/Chicago");
    const belmont = await api.createLocation(`${name} Belmont`, "America/Chicago");
    const machines = {
      first: await api.createMachine(`${name} Uptown 1`, uptown.id),
      second: await api.createMachine(`${name} Uptown 2`, uptown.id),
      bengle: await api.createMachine(`${name} Uptown Bengle`, uptown.id),
      belmont: await api.createMachine(`${name} Belmont 1`, belmont.id),
    };
    const first = load(machines.first, String(serials), { parts: { steamSettings: { flow: 1.5 } } });
    await online(machines.first);
    const uptownSettings = await settingsOf(uptown);
    const second = load(machines.second, String(serials + 1), { instance: other, parts: { steamSettings: { flow: 0.9 }, rinseData: { duration: 7 } } });
    const bengle = load(machines.bengle, String(serials + 2), { model: "Bengle", parts: { steamSettings: { flow: 1.2 } }, stallUpload: options.stallBengle });
    const belmontDe1 = load(machines.belmont, String(serials + 3), { parts: { steamSettings: { flow: 0.8 } } });
    await online(machines.second, machines.bengle, machines.belmont);
    await holds(second, { "steamSettings.flow": 1.5 });
    await holds(bengle, { "steamSettings.flow": 1.5 });
    return { uptown, belmont, machines, first, second, bengle, belmontDe1, uptownSettings };
  }

  it("lets the first Machine at a Location set its settings, and takes them to every Machine joining after, whatever its model", async () => {
    const { uptown, belmont, machines, second, bengle, belmontDe1, uptownSettings } = await cafes("First", 19001);
    expect(uptownSettings).toMatchObject({
      values: {
        "steamSettings.targetTemperature": 160,
        "steamSettings.duration": 120,
        "steamSettings.flow": 1.5,
        "hotWaterData.volume": 100,
        "rinseData.duration": 5,
      },
      editable: true,
    });
    // The second DE1Pro and the Bengle take Uptown's settings, rather than giving their own.
    await holds(second, { "rinseData.duration": 5 });
    expect((await settingsAt(uptown)).machines.map(({ name, model, sharesSettings }) => ({ name, model, sharesSettings }))).toEqual([
      { name: "First Uptown 1", model: "DE1Pro", sharesSettings: true },
      { name: "First Uptown 2", model: "DE1Pro", sharesSettings: true },
      { name: "First Uptown Bengle", model: "Bengle", sharesSettings: true },
    ]);
    expect(setting(bengle, "steamSettings.flow")).toBe(1.5);
    // Belmont's DE1Pro sets Belmont's own, and keeps it.
    expect((await settingsOf(belmont)).values["steamSettings.flow"]).toBe(0.8);
    expect(setting(belmontDe1, "steamSettings.flow")).toBe(0.8);
    expect(workflowWrites(belmontDe1)).toEqual([]);
    // Joining the settings made their first version, and writing them to the others made none.
    const history = await versions(uptownSettings);
    expect(history).toHaveLength(1);
    expect(history[0]!.source.machine?.id).toBe(machines.first.machine.id);
    expect((await settingsAt(uptown)).values["steamSettings.flow"]).toBe(1.5);
  });

  it("takes a steam flow change on one Machine to the Location's others, its Bengle included, through another instance, but not to another Location's", async () => {
    const { uptown, machines, first, second, bengle, belmontDe1, uptownSettings } = await cafes("Flow", 19011);
    await first.changeSettings({ steamSettings: { flow: 2.2 } });
    await holds(second, { "steamSettings.flow": 2.2 });
    await holds(bengle, { "steamSettings.flow": 2.2 });
    expect((await settingsAt(uptown)).values["steamSettings.flow"]).toBe(2.2);
    expect(setting(belmontDe1, "steamSettings.flow")).toBe(0.8);
    // And back the other way, from the tablet the server wrote to.
    await second.changeSettings({ hotWaterData: { volume: 180 } });
    await holds(first, { "hotWaterData.volume": 180 });
    // Each change is one version, from the tablet that made it: the plugin's own writes coming back are none.
    await expect.poll(async () => (await versions(uptownSettings)).length, { timeout: 10_000 }).toBe(3);
    const [volume, flow] = await versions(uptownSettings);
    expect(flow).toMatchObject({ fields: { "steamSettings.flow": 2.2 }, source: { machine: { id: machines.first.machine.id } } });
    expect(volume).toMatchObject({ fields: { "hotWaterData.volume": 180 }, source: { machine: { id: machines.second.machine.id } } });
    await holds(bengle, { "hotWaterData.volume": 180 });
    expect(setting(belmontDe1, "hotWaterData.volume")).toBe(100);
  });

  it("keeps steam turned off on one Machine to it, and writes the Location's current values to it once steam is turned on again", async () => {
    const { uptown, first, second } = await cafes("Steam off", 19021);
    await first.changeSettings({ steamSettings: { targetTemperature: 0 } });
    // Its hot water is still shared while its steam is off.
    await second.changeSettings({ steamSettings: { flow: 2.4, duration: 90 }, hotWaterData: { volume: 160 } });
    await holds(first, { "hotWaterData.volume": 160 });
    expect(setting(first, "steamSettings.targetTemperature")).toBe(0);
    expect(setting(first, "steamSettings.flow")).toBe(1.5);
    expect(setting(second, "steamSettings.targetTemperature")).toBe(160);
    expect((await settingsAt(uptown)).values).toMatchObject({ "steamSettings.targetTemperature": 160, "steamSettings.flow": 2.4 });

    // Turned on again as Decaid's own steam form does, at 135, it takes Uptown's steam settings.
    await first.changeSettings({ steamSettings: { targetTemperature: 135 } });
    await holds(first, { "steamSettings.targetTemperature": 160, "steamSettings.flow": 2.4, "steamSettings.duration": 90 });
    expect((await settingsAt(uptown)).values["steamSettings.targetTemperature"]).toBe(160);
  });

  it("takes a hot water or rinse change made in the management interface to every Machine at the Location, and only Staff there may make it", async () => {
    const { uptown, belmont, first, second, bengle, belmontDe1, uptownSettings } = await cafes("Managed", 19031);
    await first.changeSettings({ steamSettings: { targetTemperature: 0 } });
    const response = await api.call("PATCH", `/location-settings/${uptownSettings.id}`, { values: { "hotWaterData.targetTemperature": 85, "rinseData.flow": 4.5, "steamSettings.flow": 2 } });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { settings: SettingsView }).settings.values).toMatchObject({ "hotWaterData.targetTemperature": 85, "rinseData.flow": 4.5 });
    await holds(first, { "hotWaterData.targetTemperature": 85, "rinseData.flow": 4.5 });
    await holds(second, { "hotWaterData.targetTemperature": 85, "rinseData.flow": 4.5, "steamSettings.flow": 2 });
    await holds(bengle, { "hotWaterData.targetTemperature": 85, "rinseData.flow": 4.5, "steamSettings.flow": 2 });
    // The steam flow does not reach the Machine whose steam is off, and nothing reaches Belmont.
    expect(setting(first, "steamSettings.flow")).toBe(1.5);
    expect(setting(belmontDe1, "hotWaterData.targetTemperature")).toBe(65);
    const [edit] = await versions(uptownSettings);
    expect(edit).toMatchObject({ fields: { "hotWaterData.targetTemperature": 85, "rinseData.flow": 4.5, "steamSettings.flow": 2 }, source: { machine: null, account: {} } });

    // Turning steam off is each Machine's own, so the management interface cannot share it; nor fractions Decaid would cut.
    for (const values of [{ "steamSettings.targetTemperature": 120 }, { "hotWaterData.volume": 10.5 }, { "rinseData.colour": 1 }, {}]) {
      expect((await api.call("PATCH", `/location-settings/${uptownSettings.id}`, { values })).status).toBe(400);
    }

    const staffAt = async (email: string, location: LocationView) => {
      const { link } = await api.invite(email, "staff", [location.id]);
      return AdminApi.signedInAs(server.url, await acceptInvite(server.url, link, { name: "Staff", password: "staff password 1" }));
    };
    const elsewhere = await staffAt("settings-belmont@example.com", belmont);
    expect((await settingsAt(uptown, elsewhere)).editable).toBe(false);
    expect((await elsewhere.call("PATCH", `/location-settings/${uptownSettings.id}`, { values: { "rinseData.flow": 3 } })).status).toBe(403);
    const here = await staffAt("settings-uptown@example.com", uptown);
    expect((await here.call("PATCH", `/location-settings/${uptownSettings.id}`, { values: { "rinseData.flow": 3 } })).status).toBe(200);
    await holds(second, { "rinseData.flow": 3 });
  });

  it("keeps a Machine with sharing turned off to its own settings, and writes it the Location's once sharing is turned back on", async () => {
    const { uptown, belmont, machines, first, second, bengle, uptownSettings } = await cafes("Switched", 19061);
    const switchBengle = (sharesSettings: boolean, as = api) => as.call("PUT", `/machines/${machines.bengle.machine.id}/settings-sharing`, { sharesSettings });
    expect((await switchBengle(false)).status).toBe(200);
    expect((await settingsAt(uptown)).machines.find((machine) => machine.id === machines.bengle.machine.id)).toMatchObject({ sharesSettings: false });
    // Its own change stays on it, once the server has it, and the Location's changes do not reach it.
    const writesBefore = workflowWrites(bengle).length;
    await bengle.changeSettings({ hotWaterData: { volume: 220 } });
    await expect.poll(async () => (await storedSettings(machines.bengle, "hotWaterData", "volume"))[0], { timeout: 10_000 }).toBe(220);
    await first.changeSettings({ steamSettings: { flow: 2.6 } });
    await holds(second, { "steamSettings.flow": 2.6 });
    // A later change through the other instance has reached the others: anything due to the Bengle would have been written by now.
    await second.changeSettings({ rinseData: { flow: 4 } });
    await holds(first, { "rinseData.flow": 4 });
    expect(workflowWrites(bengle)).toHaveLength(writesBefore);
    expect(setting(first, "hotWaterData.volume")).toBe(100);
    expect(setting(bengle, "steamSettings.flow")).toBe(1.5);
    expect((await settingsAt(uptown)).values["hotWaterData.volume"]).toBe(100);
    expect((await versions(uptownSettings)).every((version) => version.source.machine?.id !== machines.bengle.machine.id)).toBe(true);

    // Staff may switch it only at their own Locations.
    const { link } = await api.invite("switching-belmont@example.com", "staff", [belmont.id]);
    const elsewhere = AdminApi.signedInAs(server.url, await acceptInvite(server.url, link, { name: "Staff", password: "staff password 1" }));
    expect((await switchBengle(true, elsewhere)).status).toBe(403);

    // With sharing turned back on, it takes Uptown's settings, and its changes are shared from then on.
    expect((await switchBengle(true)).status).toBe(200);
    await holds(bengle, { "steamSettings.flow": 2.6, "hotWaterData.volume": 100 });
    await bengle.changeSettings({ rinseData: { flow: 3.5 } });
    await holds(first, { "rinseData.flow": 3.5 });
  });

  it("keeps a change made offline on a Machine with sharing turned off to it, though it arrives once sharing is turned back on", async () => {
    const { uptown, machines, first, bengle } = await cafes("Offline switched", 19071);
    const switchBengle = (sharesSettings: boolean) => api.call("PUT", `/machines/${machines.bengle.machine.id}/settings-sharing`, { sharesSettings });
    expect((await switchBengle(false)).status).toBe(200);
    bengle.loseNetwork();
    await bengle.changeSettings({ steamSettings: { flow: 0.8 } });
    // Well after it, whatever the drift between the tablet's clock and PostgreSQL's.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect((await switchBengle(true)).status).toBe(200);
    bengle.restoreNetwork();
    // Made while it kept its own, the change is not shared: the Bengle takes Uptown's.
    await expect.poll(() => storedSettings(machines.bengle, "steamSettings", "flow"), { timeout: 10_000 }).toContain(0.8);
    await holds(bengle, { "steamSettings.flow": 1.5 });
    expect((await settingsAt(uptown)).values["steamSettings.flow"]).toBe(1.5);
    expect(setting(first, "steamSettings.flow")).toBe(1.5);
  });

  it("writes the Location's settings to a Machine with sharing turned back on whose change made while it was off arrives after, its tablet still connected", async () => {
    let holding = false;
    const stallBengle = (frame: unknown) => holding && (frame as Record_).type === "workflow";
    const { uptown, machines, bengle } = await cafes("Held", 19081, { stallBengle });
    const switchBengle = (sharesSettings: boolean) => api.call("PUT", `/machines/${machines.bengle.machine.id}/settings-sharing`, { sharesSettings });
    expect((await switchBengle(false)).status).toBe(200);
    // Its change waits on the tablet, as behind a long upload, until well after sharing is turned back on.
    holding = true;
    await bengle.changeSettings({ steamSettings: { flow: 0.8 } });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect((await switchBengle(true)).status).toBe(200);
    holding = false;
    bengle.resumeUpload();
    // Made while it kept its own, the change is not shared, and the Bengle is written Uptown's.
    await expect.poll(() => storedSettings(machines.bengle, "steamSettings", "flow"), { timeout: 10_000 }).toContain(0.8);
    await holds(bengle, { "steamSettings.flow": 1.5 });
    expect((await settingsAt(uptown)).values["steamSettings.flow"]).toBe(1.5);
  });

  it("keeps a change made offline that lost to a later one as a Conflict, whose value can be used", async () => {
    const { uptown, first, second, uptownSettings } = await cafes("Offline", 19041);
    second.loseNetwork();
    await second.changeSettings({ rinseData: { duration: 12 } });
    // Well after it, whatever the drift between the tablet's clock and PostgreSQL's.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await api.call("PATCH", `/location-settings/${uptownSettings.id}`, { values: { "rinseData.duration": 9 } });
    await holds(first, { "rinseData.duration": 9 });
    second.restoreNetwork();
    // The offline change was made before the management interface's: it loses, and the Location's is written back.
    await holds(second, { "rinseData.duration": 9 });
    const conflicts = async () =>
      ((await (await api.call("GET", `/location-settings/${uptownSettings.id}/conflicts`)).json()) as { conflicts: Record_[] }).conflicts;
    await expect.poll(async () => (await conflicts()).length, { timeout: 10_000 }).toBe(1);
    const [conflict] = (await conflicts()) as { id: string; current: { versionId: string } }[];
    expect(conflict).toMatchObject({
      item: { kind: "settings", id: uptownSettings.id, name: "Steam, hot water and rinse" },
      field: "rinseData.duration",
      value: 12,
      location: uptown,
      current: { value: 9 },
      resolvable: true,
    });
    expect((await api.call("POST", `/conflicts/${conflict!.id}/use`, { seen: conflict!.current.versionId })).status).toBe(200);
    await holds(first, { "rinseData.duration": 12 });
    await holds(second, { "rinseData.duration": 12 });
  });

  it("writes the settings to a tablet once its machine is back, as Decaid refuses them while it is away", async () => {
    const { first, second } = await cafes("Disconnected", 19051);
    second.machineConnected = false;
    await first.changeSettings({ steamSettings: { flow: 1.9 } });
    await expect.poll(() => second.sent.some((frame) => (frame as Record_).type === "writeRefused"), { timeout: 10_000 }).toBe(true);
    expect(setting(second, "steamSettings.flow")).toBe(1.5);
    // A later change is not tried while the machine is away.
    await first.changeSettings({ rinseData: { duration: 6 } });
    // The same machine back, the plugin reconnects, and the tablet is written the Location's settings.
    second.connectMachine();
    await holds(second, { "steamSettings.flow": 1.9, "rinseData.duration": 6 });
    await second.waitForLog(/The machine is connected again/);
  });
});
