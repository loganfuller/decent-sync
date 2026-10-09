import { GLOBAL_ID_KEY, globalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { PluginStorage, SimulatedTablet, derivedDe1Pro, settingsFor, simulatedLibrary } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #83: Grinders belong to a Location. A Grinder created on
// a tablet joins the Library belonging to that tablet's Location, and is
// written to that Location's tablets only. Archiving or deleting one on a
// tablet there Archives it, archived, never deleted, on the Location's
// other tablets, and un-archiving it restores it (ADR-0008, ADR-0019).
// Through the built plugin in simulated tablets, on two server instances
// sharing one database, with assertions through the REST API and what each
// simulated tablet's Decaid holds. Serials are made up, from 18001.

interface GrinderSummary {
  id: string;
  model: string | null;
  burrs: string | null;
  burrType: string | null;
  archived: boolean;
  location: LocationView | null;
  createdAt: string;
}

interface GrinderView extends GrinderSummary {
  content: Record<string, unknown>;
}

type Record_ = Record<string, unknown>;

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

describe("Grinders belonging to a Location", { timeout: 60_000 }, () => {
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

  /**
   * The built plugin on a tablet of the Machine, connected to an instance,
   * polling every 5 s (0.1 s here), its Decaid holding the grinders given,
   * none by default, as on a fresh install, and no beans or profiles, so
   * only Grinders are written to it.
   */
  function load(
    machine: CreatedMachine,
    serial: string,
    options: { instance?: TestServer; storage?: PluginStorage; grinders?: Record_[]; apiDelayMs?: (method: string, path: string) => number } = {},
  ): SimulatedTablet {
    const tablet = SimulatedTablet.load({
      settings: { ...settingsFor({ token: machine.token, serverUrl: (options.instance ?? server).url }), PollSeconds: 5 },
      api: { ...derivedDe1Pro({ serial }), "/beans": [], "/bean-batches": [], "/profiles": [], "/grinders": options.grinders ?? [] },
      storage: options.storage,
      apiDelayMs: options.apiDelayMs,
      timeScale: 50,
    });
    tablets.push(tablet);
    return tablet;
  }

  async function online(...machines: CreatedMachine[]): Promise<void> {
    for (const { machine } of machines) await api.waitForMachine(machine.name, (viewed) => viewed.online);
  }

  const libraryGrinders = async () => ((await (await api.call("GET", "/grinders")).json()) as { grinders: GrinderSummary[] }).grinders;
  const viewGrinder = async (id: string) => ((await (await api.call("GET", `/grinders/${id}`)).json()) as { grinder: GrinderView }).grinder;
  const grindersOf = async (model: string) => (await libraryGrinders()).filter((grinder) => grinder.model === model);
  /** Resolves with the Library's one Grinder of that model, once there is one. */
  async function libraryGrinder(model: string): Promise<GrinderSummary> {
    await expect.poll(async () => (await grindersOf(model)).length, { timeout: 10_000 }).toBe(1);
    return (await grindersOf(model))[0]!;
  }
  /** The tablet's records of the Grinder, by the global id they carry. */
  const heldGrinder = (tablet: SimulatedTablet, id: string) => tablet.grinders().filter((record) => globalIdOf(record) === id);
  /** Resolves with the tablet's one record of the Grinder once it holds it so. */
  async function holds(tablet: SimulatedTablet, id: string, fields: Record_): Promise<Record_> {
    await expect.poll(() => heldGrinder(tablet, id), { timeout: 10_000 }).toEqual([expect.objectContaining(fields)]);
    return heldGrinder(tablet, id)[0]!;
  }
  const grinderWrites = (tablet: SimulatedTablet) => tablet.writes.filter((write) => write.includes("/grinders"));
  /** The grinders the Machine's tablet last reported. */
  const reportedGrinders = async ({ machine }: CreatedMachine) =>
    ((await (await api.call("GET", `/machines/${machine.id}/collections/grinders`)).json()) as { collection: { value: unknown } }).collection.value;

  /** A lab with two tablets, the second on the other instance, and a cafe with one. */
  async function lab(name: string, serials: number) {
    const labLocation = await api.createLocation(`${name} lab`, "America/Chicago");
    const cafeLocation = await api.createLocation(`${name} cafe`, "America/Chicago");
    const machines = [
      await api.createMachine(`${name} lab 1`, labLocation.id),
      await api.createMachine(`${name} lab 2`, labLocation.id),
      await api.createMachine(`${name} cafe 1`, cafeLocation.id),
    ] as const;
    const one = load(machines[0], String(serials));
    const two = load(machines[1], String(serials + 1), { instance: other });
    const cafe = load(machines[2], String(serials + 2));
    await online(...machines);
    return { labLocation, cafeLocation, machines, one, two, cafe };
  }

  /** Adds a grinder on the tablet, as a barista does, and resolves with its record and its Library Grinder, once both tablets of the lab hold it. */
  async function enterGrinder(one: SimulatedTablet, two: SimulatedTablet, model: string) {
    const record = await one.addGrinder({ model, burrs: "SSP MP", burrSize: 64, burrType: "flat", notes: "Fixture" });
    const grinder = await libraryGrinder(model);
    await holds(one, grinder.id, { id: record.id, archived: false });
    await holds(two, grinder.id, { archived: false });
    return { record, grinder };
  }

  it("writes a Grinder created on a lab tablet to the lab's other tablet, through another instance, and to no cafe tablet", async () => {
    const { labLocation, one, two, cafe } = await lab("Created", 18001);
    const { record, grinder } = await enterGrinder(one, two, "Created DF64");
    expect(grinder).toMatchObject({ burrs: "SSP MP", burrType: "flat", archived: false, location: labLocation });
    expect((await viewGrinder(grinder.id)).content).toEqual({ model: "Created DF64", burrs: "SSP MP", burrSize: 64, burrType: "flat", notes: "Fixture", settingType: "numeric" });

    const written = heldGrinder(two, grinder.id)[0]!;
    expect(written).toMatchObject({ model: "Created DF64", burrs: "SSP MP", burrSize: 64, extras: { [GLOBAL_ID_KEY]: grinder.id } });
    expect(written.id).not.toBe(record.id);
    expect(grinderWrites(two)).toEqual(["POST /grinders"]);
    // The tablet that created it is written only its global id.
    expect(grinderWrites(one)).toEqual([`PUT /grinders/${String(record.id)}`]);
    // No cafe tablet holds it.
    expect(cafe.grinders()).toEqual([]);
    expect(grinderWrites(cafe)).toEqual([]);
  });

  it("Archives a Grinder deleted on one lab tablet, archiving it on the lab's other tablet, never deleting it, and restores it when un-archived there", async () => {
    const { one, two } = await lab("Deleted", 18011);
    const { record, grinder } = await enterGrinder(one, two, "Deleted Niche");

    await one.deleteGrinder(record.id);
    await expect.poll(async () => (await libraryGrinder("Deleted Niche")).archived, { timeout: 10_000 }).toBe(true);
    const archived = await holds(two, grinder.id, { archived: true });
    expect(two.writes.some((write) => write.startsWith("DELETE"))).toBe(false);
    // The tablet that deleted it holds it no more, and is not written it again.
    expect(heldGrinder(one, grinder.id)).toEqual([]);
    expect(grinderWrites(one).filter((write) => write.startsWith("POST "))).toEqual([]);

    // Un-archived on the other tablet, it is restored: offered at the lab again, it is written again to the tablet that deleted it.
    await two.editGrinder(archived.id, { archived: false });
    await expect.poll(async () => (await libraryGrinder("Deleted Niche")).archived, { timeout: 10_000 }).toBe(false);
    await holds(one, grinder.id, { archived: false });
  });

  it("Archives a Grinder archived on a tablet, archived on the Location's other tablets, and restores it when un-archived", async () => {
    const { one, two } = await lab("Archived", 18021);
    const { record, grinder } = await enterGrinder(one, two, "Archived EK43");

    await one.editGrinder(record.id, { archived: true });
    await expect.poll(async () => (await libraryGrinder("Archived EK43")).archived, { timeout: 10_000 }).toBe(true);
    await holds(two, grinder.id, { archived: true });
    await one.editGrinder(record.id, { archived: false });
    await expect.poll(async () => (await libraryGrinder("Archived EK43")).archived, { timeout: 10_000 }).toBe(false);
    await holds(two, grinder.id, { archived: false });
  });

  it("Archives a Grinder archived on a tablet just before the server wrote its global id, which kept it archived, rather than undoing it", async () => {
    const labLocation = await api.createLocation("Kept lab", "America/Chicago");
    const first = await api.createMachine("Kept lab 1", labLocation.id);
    const second = await api.createMachine("Kept lab 2", labLocation.id);
    let archived = false;
    // A barista archives the grinder on the tablet just as the plugin reads it to write its global id.
    const one: SimulatedTablet = load(first, "18071", {
      apiDelayMs: (method, path) => {
        if (!archived && method === "GET" && /^\/grinders\/[^/?]+$/.test(path)) {
          archived = true;
          void one.callApi("PUT", path, { archived: true });
        }
        return 0;
      },
    });
    const two = load(second, "18072", { instance: other });
    await online(first, second);
    const record = await one.addGrinder({ model: "Kept Mythos", burrs: "Mythos 75mm" });
    const grinder = await libraryGrinder("Kept Mythos");

    // The answer showed it archived, which the write did not set: the Grinder is Archived, and archived on the other tablet.
    await expect.poll(async () => (await libraryGrinder("Kept Mythos")).archived, { timeout: 10_000 }).toBe(true);
    expect(archived).toBe(true);
    await holds(one, grinder.id, { id: record.id, archived: true, extras: { [GLOBAL_ID_KEY]: grinder.id } });
    await holds(two, grinder.id, { archived: true });
    expect(grinderWrites(one)).toEqual([`PUT /grinders/${String(record.id)}`]);
    expect((await libraryGrinder("Kept Mythos")).archived).toBe(true);
  });

  it("keeps two Grinders of the same model at two Locations two Grinders, each written only at its own", async () => {
    const { labLocation, cafeLocation, one, two, cafe } = await lab("Same", 18031);
    await one.addGrinder({ model: "Same ZP6", burrType: "conical" });
    await cafe.addGrinder({ model: "Same ZP6", burrType: "conical" });
    await expect.poll(async () => (await grindersOf("Same ZP6")).map((grinder) => grinder.location?.name), { timeout: 10_000 }).toEqual([cafeLocation.name, labLocation.name]);
    const [atCafe, atLab] = await grindersOf("Same ZP6");
    expect(atCafe!.id).not.toBe(atLab!.id);
    await holds(one, atLab!.id, { archived: false });
    await holds(two, atLab!.id, { archived: false });
    await holds(cafe, atCafe!.id, { archived: false });
    // Each tablet holds its own Location's only.
    expect(heldGrinder(cafe, atLab!.id)).toEqual([]);
    expect(heldGrinder(two, atCafe!.id)).toEqual([]);
    expect(two.grinders()).toHaveLength(1);
  });

  it("adds the grinders a tablet held before its Machine had a Location, belonging to the Location it joins, Archived if archived there, and writes it the others", async () => {
    const location = await api.createLocation("Joined lab", "UTC");
    const first = await api.createMachine("Joined lab 1", location.id);
    const second = await api.createMachine("Joined lab 2", location.id);
    const own = derivedDe1Pro({ serial: "18041" })["/grinders"] as Record_[];
    const [archived] = simulatedLibrary()["/grinders"] as Record_[];
    const one = load(first, "18041", { grinders: [...own, archived!] });
    const two = load(second, "18042", { instance: other });
    await online(first, second);
    for (const record of own) {
      const grinder = await libraryGrinder(String(record.model));
      expect(grinder.location).toEqual(location);
      await holds(two, grinder.id, { model: record.model, archived: false });
    }
    const retired = await libraryGrinder(String(archived!.model));
    expect(retired).toMatchObject({ archived: true, location });
    // It keeps its global id on the tablet that brought it, and no other tablet is written it.
    await holds(one, retired.id, { id: archived!.id, archived: true });
    expect(heldGrinder(two, retired.id)).toEqual([]);
    expect(grinderWrites(two)).toEqual(["POST /grinders", "POST /grinders"]);
  });

  it("Archives nothing for a tablet whose Decaid data was reset, and writes it its Location's Grinders", async () => {
    const location = await api.createLocation("Reset grinder lab", "UTC");
    const first = await api.createMachine("Reset grinder lab 1", location.id);
    const second = await api.createMachine("Reset grinder lab 2", location.id);
    const one = load(first, "18051");
    const storage = new PluginStorage();
    const two = load(second, "18052", { storage });
    await online(first, second);
    const { grinder } = await enterGrinder(one, two, "Reset Mazzer");

    // Its Decaid data reset, the tablet has a new tablet id, and no grinders: none was deleted there.
    await two.unload();
    await api.waitForMachine(second.machine.name, (viewed) => !viewed.online);
    storage.clear();
    const reset = load(second, "18052", { storage });
    await holds(reset, grinder.id, { archived: false });
    expect((await libraryGrinder("Reset Mazzer")).archived).toBe(false);
    expect(grinderWrites(reset)).toEqual(["POST /grinders"]);
  });

  it("changes nothing at another Location for a moved tablet un-archiving or deleting its old Location's Grinder, which stays archived on it", async () => {
    const { one, two, cafeLocation, machines } = await lab("Moved", 18061);
    const { record, grinder } = await enterGrinder(one, two, "Moved Kafatek");

    // Moved to the cafe, the second lab tablet has the lab's Grinder archived, as the cafe does not offer it.
    expect((await api.call("POST", `/machines/${machines[1].machine.id}/location-history`, { locationId: cafeLocation.id })).status).toBe(201);
    const moved = await holds(two, grinder.id, { archived: true });
    expect((await libraryGrinder("Moved Kafatek")).archived).toBe(false);
    await one.editGrinder(record.id, { archived: true });
    await expect.poll(async () => (await libraryGrinder("Moved Kafatek")).archived, { timeout: 10_000 }).toBe(true);

    // Un-archived at the cafe, it is not restored: it belongs to the lab, so the tablet is written it archived again.
    const writes = grinderWrites(two).length;
    await two.editGrinder(moved.id, { archived: false });
    await expect.poll(() => grinderWrites(two).length, { timeout: 10_000 }).toBeGreaterThan(writes);
    await holds(two, grinder.id, { archived: true });
    expect((await libraryGrinder("Moved Kafatek")).archived).toBe(true);

    // Restored at the lab, it stays archived at the cafe, and deleting it there, where it was held archived, Archives nothing.
    await one.editGrinder(record.id, { archived: false });
    await expect.poll(async () => (await libraryGrinder("Moved Kafatek")).archived, { timeout: 10_000 }).toBe(false);
    await two.deleteGrinder(moved.id);
    // Its report without it is taken in as it is stored.
    await expect.poll(async () => reportedGrinders(machines[1]), { timeout: 10_000 }).toEqual([]);
    expect(await libraryGrinder("Moved Kafatek")).toMatchObject({ archived: false, location: { name: "Moved lab" } });
    expect(heldGrinder(one, grinder.id)).toEqual([expect.objectContaining({ archived: false })]);
    expect(two.grinders()).toEqual([]);
  });
});
