import { randomUUID } from "node:crypto";
import { GLOBAL_ID_KEY, globalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { waitForLockWaits } from "./support/lock-waits.js";
import { PluginStorage, RawConnection, SimulatedTablet, derivedDe1Pro, helloWith, settingsFor } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #80: a Bean created on one tablet joins the Library and is
// written to the other tablets at that tablet's Location, through the built
// plugin in simulated tablets, raw frames, and two server instances on one
// database. Assertions go through the REST API and what each simulated
// tablet's Decaid holds. Serials are made up, from 14001.

interface BeanSummary {
  id: string;
  roaster: string | null;
  name: string | null;
  archived: boolean;
  offeredAt: LocationView[];
  createdAt: string;
  createdLocation: LocationView | null;
  likelyDuplicates: { id: string; roaster: string | null; name: string | null }[];
}

interface BeanView extends BeanSummary {
  content: Record<string, unknown>;
}

type Record_ = Record<string, unknown>;

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

describe("Beans in the Library", { timeout: 30_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  const tablets: SimulatedTablet[] = [];
  const raws: RawConnection[] = [];

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
  }, 60_000);
  afterAll(async () => {
    await Promise.all(tablets.map((tablet) => tablet.unload()));
    await Promise.all(raws.map((raw) => raw.terminate()));
    await other?.stop();
    await server?.stop();
  });

  /**
   * The built plugin on a tablet of the Machine, connected to an instance,
   * polling every 5 s (0.1 s here), its Decaid holding the beans given, none
   * by default, as on a fresh install.
   */
  function load(
    machine: CreatedMachine,
    serial: string,
    options: { instance?: TestServer; storage?: PluginStorage; beans?: Record_[] } = {},
  ): SimulatedTablet {
    const tablet = SimulatedTablet.load({
      settings: { ...settingsFor({ token: machine.token, serverUrl: (options.instance ?? server).url }), PollSeconds: 5 },
      api: { ...derivedDe1Pro({ serial }), "/beans": options.beans ?? [] },
      storage: options.storage,
      timeScale: 50,
    });
    tablets.push(tablet);
    return tablet;
  }

  async function online(...machines: CreatedMachine[]): Promise<void> {
    for (const { machine } of machines) await api.waitForMachine(machine.name, (viewed) => viewed.online);
  }

  const libraryBeans = async () => ((await (await api.call("GET", "/beans")).json()) as { beans: BeanSummary[] }).beans;
  const beansNamed = async (name: string) => (await libraryBeans()).filter((bean) => bean.name === name);
  /** Resolves with the Library's one Bean of that name, once there is one. */
  async function libraryBean(name: string): Promise<BeanSummary> {
    await expect.poll(async () => (await beansNamed(name)).length, { timeout: 10_000 }).toBe(1);
    return (await beansNamed(name))[0]!;
  }
  /** The tablet's beans of that name, each by the global id it carries. */
  const heldAs = (tablet: SimulatedTablet, name: string) => tablet.beans().filter((bean) => bean.name === name).map(globalIdOf);
  /** Resolves once the tablet holds the Bean, once, carrying its global id. */
  const holds = (tablet: SimulatedTablet, name: string, id: string) =>
    expect.poll(() => heldAs(tablet, name), { timeout: 10_000 }).toEqual([id]);
  const locations = (bean: BeanSummary) => bean.offeredAt.map((location) => location.name);

  it("writes a Bean created on one tablet to its Location's other tablet, through another instance, with the same global id, and lists it once", async () => {
    const lab = await api.createLocation("Roastery lab", "America/Chicago");
    const first = await api.createMachine("Lab group 1", lab.id);
    const second = await api.createMachine("Lab group 2", lab.id);
    const one = load(first, "14001");
    const two = load(second, "14002", { instance: other });
    await online(first, second);

    const created = await one.addBean({ roaster: "Roux", name: "Guji Hambela", country: "Ethiopia", processing: "washed" });
    const bean = await libraryBean("Guji Hambela");
    expect(bean).toMatchObject({ roaster: "Roux", archived: false, createdLocation: lab, likelyDuplicates: [] });
    expect(locations(bean)).toEqual(["Roastery lab"]);
    // The tablet that created it is written its global id, and the other is written the Bean.
    await holds(one, "Guji Hambela", bean.id);
    await holds(two, "Guji Hambela", bean.id);
    const written = two.beans().find((record) => record.name === "Guji Hambela")!;
    expect(written).toMatchObject({ roaster: "Roux", country: "Ethiopia", processing: "washed", extras: { [GLOBAL_ID_KEY]: bean.id } });
    expect(written.id).not.toBe(created.id);
    expect(one.beans().find((record) => record.name === "Guji Hambela")!.id).toBe(created.id);

    const viewed = ((await (await api.call("GET", `/beans/${bean.id}`)).json()) as { bean: BeanView }).bean;
    expect(viewed.content).toEqual({ roaster: "Roux", name: "Guji Hambela", decaf: false, country: "Ethiopia", processing: "washed" });
    expect(await beansNamed("Guji Hambela")).toHaveLength(1);
  });

  it("changes nothing when a tablet reports back the plugin's own write", async () => {
    const lab = await api.createLocation("Echo lab", "UTC");
    const first = await api.createMachine("Echo 1", lab.id);
    const second = await api.createMachine("Echo 2", lab.id);
    const one = load(first, "14011");
    const two = load(second, "14012");
    await online(first, second);
    await one.addBean({ roaster: "Roux", name: "Echo Natural" });
    const bean = await libraryBean("Echo Natural");
    await holds(two, "Echo Natural", bean.id);
    const writes = [one.writes.length, two.writes.length];
    const record = two.beans().find((candidate) => candidate.name === "Echo Natural");

    // Both tablets report their beans again, now holding the Bean as written, and are written nothing more.
    const reportsBefore = beanReports(two);
    await expect.poll(() => beanReports(two), { timeout: 10_000 }).toBeGreaterThan(reportsBefore);
    await one.addBean({ roaster: "Roux", name: "Echo Washed" });
    await holds(two, "Echo Washed", (await libraryBean("Echo Washed")).id);
    expect(two.beans().find((candidate) => candidate.name === "Echo Natural")).toEqual(record);
    // Each tablet was written only the second Bean: its global id to the one, the Bean itself to the other.
    expect([one.writes.length, two.writes.length]).toEqual([writes[0]! + 1, writes[1]! + 1]);
    expect(await beansNamed("Echo Natural")).toEqual([bean]);
  });

  it("keeps the other keys a tablet's record holds in its extras when it writes the global id", async () => {
    const cafe = await api.createLocation("Extras cafe", "UTC");
    const machine = await api.createMachine("Extras group", cafe.id);
    const tablet = load(machine, "14021");
    await online(machine);
    // Another plugin's key, as DYE2 keeps a Beanconqueror id there.
    await tablet.addBean({ roaster: "Roux", name: "Keeps Extras", extras: { bcUuid: "fixture-bc-1" } });
    const bean = await libraryBean("Keeps Extras");
    await holds(tablet, "Keeps Extras", bean.id);
    expect(tablet.beans().find((record) => record.name === "Keeps Extras")!.extras).toEqual({ bcUuid: "fixture-bc-1", [GLOBAL_ID_KEY]: bean.id });
  });

  it("links a Bean whose roaster and name match a Library Bean's, ignoring case and spaces at either end, and offers it where it was linked", async () => {
    const lab = await api.createLocation("Matching lab", "UTC");
    const uptown = await api.createLocation("Matching Uptown", "UTC");
    const labMachine = await api.createMachine("Matching lab group", lab.id);
    const uptownMachine = await api.createMachine("Matching Uptown group", uptown.id);
    const labTablet = load(labMachine, "14031");
    const uptownTablet = load(uptownMachine, "14032", { instance: other });
    await online(labMachine, uptownMachine);
    await labTablet.addBean({ roaster: "Roux Bakehouse", name: "Launch Day Blend", country: "Brazil" });
    const bean = await libraryBean("Launch Day Blend");
    expect(heldAs(uptownTablet, "Launch Day Blend")).toEqual([]);

    await uptownTablet.addBean({ roaster: "  roux bakehouse ", name: "LAUNCH DAY BLEND  ", notes: "Entered at Uptown" });
    await expect.poll(async () => locations((await beansNamed("Launch Day Blend"))[0]!), { timeout: 10_000 }).toEqual(["Matching lab", "Matching Uptown"]);
    expect(await libraryBeans()).not.toContainEqual(expect.objectContaining({ name: "LAUNCH DAY BLEND  " }));
    // Uptown's record carries the Bean's global id, and keeps what was entered there.
    await expect.poll(() => uptownTablet.beans().map(globalIdOf), { timeout: 10_000 }).toEqual([bean.id]);
    expect(uptownTablet.beans()[0]).toMatchObject({ name: "LAUNCH DAY BLEND  ", notes: "Entered at Uptown" });
    expect((await libraryBean("Launch Day Blend")).id).toBe(bean.id);
  });

  it("makes one Bean of a coffee two tablets enter at once, through either instance", async () => {
    const uptown = await api.createLocation("Race Uptown", "UTC");
    const belmont = await api.createLocation("Race Belmont", "UTC");
    const first = await api.createMachine("Race Uptown group", uptown.id);
    const second = await api.createMachine("Race Belmont group", belmont.id);
    const one = await RawConnection.welcomed(server.url, helloWith(first.token, { machine: { model: "DE1Pro", serial: "14101" } }));
    const two = await RawConnection.welcomed(other.url, helloWith(second.token, { machine: { model: "DE1Pro", serial: "14102" } }));
    raws.push(one, two);
    const report = (name: string) => ({
      type: "collection",
      id: randomUUID(),
      name: "beans",
      available: true,
      value: [{ ...mismatchedBean, id: randomUUID(), name }],
      updatedAt: ["2026-10-07T15:00:00.000Z"],
    });
    const database = await server.connectDatabase();
    try {
      // The test holds the lock new beans are matched under, so both reports wait for it, Uptown's first, then go in turn.
      await database.query("BEGIN");
      await database.query("SELECT pg_advisory_xact_lock(4000006)");
      const uptownDelivered = one.deliver(report("Opening Day"));
      await waitForLockWaits(server, { advisory: true });
      const belmontDelivered = two.deliver(report("  opening day"));
      await waitForLockWaits(server, { advisory: true, count: 2 });
      await database.query("COMMIT");
      await Promise.all([uptownDelivered, belmontDelivered]);
    } finally {
      await database.end();
    }
    const beans = await beansNamed("Opening Day");
    expect(beans).toHaveLength(1);
    expect(beans[0]!.createdLocation).toEqual(uptown);
    expect(locations(beans[0]!)).toEqual(["Race Belmont", "Race Uptown"]);
    expect(await beansNamed("  opening day")).toEqual([]);
  });

  it("writes a Bean only to the tablets at the Location that offers it", async () => {
    const lab = await api.createLocation("Separate lab", "UTC");
    const belmont = await api.createLocation("Separate Belmont", "UTC");
    const first = await api.createMachine("Separate lab 1", lab.id);
    const second = await api.createMachine("Separate lab 2", lab.id);
    const cafe = await api.createMachine("Separate Belmont group", belmont.id);
    const one = load(first, "14041");
    const two = load(second, "14042", { instance: other });
    const belmontTablet = load(cafe, "14043");
    await online(first, second, cafe);

    await belmontTablet.addBean({ roaster: "Roux", name: "Belmont Only" });
    const belmontBean = await libraryBean("Belmont Only");
    expect(locations(belmontBean)).toEqual(["Separate Belmont"]);
    await holds(belmontTablet, "Belmont Only", belmontBean.id);
    // A Bean the lab creates later reaches the lab's tablets after any write they were due before it.
    await one.addBean({ roaster: "Roux", name: "Lab Only" });
    const labBean = await libraryBean("Lab Only");
    await holds(two, "Lab Only", labBean.id);
    expect(heldAs(one, "Belmont Only")).toEqual([]);
    expect(heldAs(two, "Belmont Only")).toEqual([]);
    expect(heldAs(belmontTablet, "Lab Only")).toEqual([]);
  });

  it("neither writes to a Machine with no Location nor takes its Beans into the Library, which still captures them", async () => {
    const lab = await api.createLocation("Capture lab", "UTC");
    const labMachine = await api.createMachine("Capture lab group", lab.id);
    const home = await api.createMachine("Home machine");
    const labTablet = load(labMachine, "14051");
    await labTablet.addBean({ roaster: "Roux", name: "Capture Lab Bean" });
    const homeTablet = load(home, "14052", { beans: [] });
    await online(labMachine, home);
    await homeTablet.addBean({ roaster: "Roux", name: "Home Bean" });
    await expect
      .poll(async () => {
        const reported = (await (await api.call("GET", `/machines/${home.machine.id}/collections/beans`)).json()) as { collection: { value: Record_[] } | null };
        return reported.collection?.value.map((record) => record.name);
      }, { timeout: 10_000 })
      .toEqual(["Home Bean"]);

    await holds(labTablet, "Capture Lab Bean", (await libraryBean("Capture Lab Bean")).id);
    expect(await beansNamed("Home Bean")).toEqual([]);
    expect(homeTablet.beans().map((record) => record.name)).toEqual(["Home Bean"]);
    expect(homeTablet.writes).toEqual([]);
  });

  it("writes a tablet that was offline while a Bean was created once it reconnects", async () => {
    const cafe = await api.createLocation("Offline cafe", "UTC");
    const first = await api.createMachine("Offline 1", cafe.id);
    const second = await api.createMachine("Offline 2", cafe.id);
    const one = load(first, "14061");
    const storage = new PluginStorage();
    const away = load(second, "14062", { storage });
    await online(first, second);
    await away.unload();
    await api.waitForMachine(second.machine.name, (viewed) => !viewed.online);

    await one.addBean({ roaster: "Roux", name: "Made While Offline" });
    const bean = await libraryBean("Made While Offline");
    await holds(one, "Made While Offline", bean.id);
    expect(heldAs(away, "Made While Offline")).toEqual([]);
    // The same tablet, its Decaid data kept, loads the plugin again.
    const back = load(second, "14062", { storage, beans: away.beans() });
    await holds(back, "Made While Offline", bean.id);
  });

  it("writes to an Unidentified Machine's tablet, but nothing to a mismatched connection, whose Beans stay out of the Library", async () => {
    const cafe = await api.createLocation("Identity cafe", "UTC");
    const known = await api.createMachine("Identity known", cafe.id);
    const unidentified = await api.createMachine("Identity unidentified", cafe.id);
    const knownTablet = load(known, "14071");
    await online(known);
    await knownTablet.addBean({ roaster: "Roux", name: "Identity Bean" });
    const bean = await libraryBean("Identity Bean");

    // An older DE1 reports serial 0.
    const unidentifiedTablet = load(unidentified, "0");
    await holds(unidentifiedTablet, "Identity Bean", bean.id);

    // A Machine's token, bound to its hardware, used on other hardware is a mismatch.
    const mismatched = await api.createMachine("Identity mismatched", cafe.id);
    const binding = await RawConnection.welcomed(server.url, helloWith(mismatched.token, { machine: { model: "DE1Pro", serial: "14073" } }));
    await binding.close();
    const raw = await RawConnection.welcomed(server.url, helloWith(mismatched.token, { machine: { model: "DE1Pro", serial: "14074" } }));
    raws.push(raw);
    await raw.deliver({
      type: "collection",
      id: randomUUID(),
      name: "beans",
      available: true,
      value: [mismatchedBean],
      updatedAt: ["2026-10-07T15:00:00.000Z"],
    });
    // A Bean added after the mismatched report reaches the Location's tablets, so their writers have looked again since.
    await knownTablet.addBean({ roaster: "Roux", name: "Identity Later" });
    await holds(unidentifiedTablet, "Identity Later", (await libraryBean("Identity Later")).id);
    expect(await beansNamed("Mismatched Bean")).toEqual([]);
    expect(raw.messages.filter((message) => (message as { type?: unknown }).type === "write")).toEqual([]);
  });

  it("writes a Bean too large for one frame in chunks", async () => {
    const lab = await api.createLocation("Chunked lab", "UTC");
    const first = await api.createMachine("Chunked 1", lab.id);
    const second = await api.createMachine("Chunked 2", lab.id);
    const one = load(first, "14081");
    const two = load(second, "14082");
    await online(first, second);
    // Derived: tasting notes far longer than a barista writes, past one frame.
    const notes = "Stone fruit, jasmine and black tea. ".repeat(10_000);
    await one.addBean({ roaster: "Roux", name: "Long Notes", notes });
    const bean = await libraryBean("Long Notes");
    await holds(two, "Long Notes", bean.id);
    expect(two.beans().find((record) => record.name === "Long Notes")!.notes).toBe(notes);
    expect(two.received.some((frame) => (frame as { type?: unknown }).type === "chunk")).toBe(true);
  });

  it("writes a Bean once to a tablet whose answer to the write was lost, and restores a global id another plugin wiped", async () => {
    const lab = await api.createLocation("Recovery lab", "UTC");
    const first = await api.createMachine("Recovery 1", lab.id);
    const second = await api.createMachine("Recovery 2", lab.id);
    const one = load(first, "14091");
    const two = load(second, "14092");
    await online(first, second);
    // The connection drops as soon as the write reaches the tablet, so its answer never reaches the server.
    two.cutConnectionAfter((frame) => (frame as { type?: unknown }).type === "write");
    await one.addBean({ roaster: "Roux", name: "Lost Answer" });
    const bean = await libraryBean("Lost Answer");
    await holds(two, "Lost Answer", bean.id);
    await expect.poll(() => two.logs.some((log) => log.startsWith("Disconnected")), { timeout: 10_000 }).toBe(true);
    await online(second);
    await one.addBean({ roaster: "Roux", name: "After Recovery" });
    await holds(two, "After Recovery", (await libraryBean("After Recovery")).id);
    expect(heldAs(two, "Lost Answer")).toEqual([bean.id]);
    expect(two.writes.filter((write) => write === "POST /beans")).toHaveLength(2);

    // Another plugin replaces the record's extras, wiping the global id; the plugin writes it back.
    const record = two.beans().find((candidate) => candidate.name === "Lost Answer")!;
    expect((await two.callApi("PUT", `/beans/${String(record.id)}`, { extras: { otherPlugin: true } })).status).toBe(200);
    await expect.poll(() => two.beans().find((candidate) => candidate.id === record.id)!.extras, { timeout: 10_000 }).toEqual({
      otherPlugin: true,
      [GLOBAL_ID_KEY]: bean.id,
    });
    expect(await beansNamed("Lost Answer")).toHaveLength(1);
  });
});

/** A bean as Decaid v0.8.7 serves one, from the simulated devices' fixture, renamed. */
const mismatchedBean = {
  id: "79699013-0984-4a1a-842a-5b84f36e612e",
  roaster: "Fixture Roaster",
  name: "Mismatched Bean",
  decaf: false,
  archived: false,
  createdAt: "2026-10-05T14:03:13.044376",
  updatedAt: "2026-10-05T14:03:13.044376",
};

/** How many reports of its beans the plugin has sent. */
function beanReports(tablet: SimulatedTablet): number {
  return tablet.sent.filter((frame) => (frame as { type?: unknown; name?: unknown }).type === "collection" && (frame as { name?: unknown }).name === "beans").length;
}
