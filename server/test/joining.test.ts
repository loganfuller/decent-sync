import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { globalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, type MachineView } from "./support/admin-api.js";
import { RawConnection, SimulatedTablet, derivedDe1Pro, derivedProfile, helloWith, settingsFor, workflowFixture } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #89: a Machine joining a Location, as it is adopted
// there or moved there, takes on the Location's state (ADR-0008). Its tablet
// is written the Location's shown Profiles, its batches and their Beans, its
// Grinders and its steam, hot water and rinse settings; what only its old
// Location offered is archived or hidden on it; its Workflow's grinder and
// batch are cleared when the new Location does not offer them. What its
// tablet held of its own stays out of the Library, archived or hidden on it,
// but for a Bean matching one the Library has, which is linked to it, and
// for a kind of item the Location offers none of yet, which it brings
// (ADR-0018). A Machine moved to no Location is written nothing more.
// Through the built plugin in simulated tablets, on two server instances
// sharing one database, with assertions through the REST API and what each
// simulated tablet's Decaid holds. Serials are made up, from 23001.

type Record_ = Record<string, unknown>;
type Parts = Record<string, Record_>;

interface SettingsView {
  id: string | null;
  values: Record<string, number | null>;
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** The fields of a Workflow's `context` that name its grinder and its batch, which joining a Location may clear. */
const GRINDER_AND_BATCH = ["grinderId", "grinderModel", "beanBatchId", "coffeeName", "coffeeRoaster"];

/** The test tablet's Workflow with its settings changed as given, and its context as given in place of the test tablet's. */
function workflowWith(parts: Parts, context?: Record_): Record_ {
  const workflow = workflowFixture();
  for (const [part, values] of Object.entries(parts)) workflow[part] = { ...(workflow[part] as Record_), ...values };
  return context === undefined ? workflow : { ...workflow, context };
}

/**
 * Derived from the test tablet's beans: the same records with their names
 * begun with `prefix`, so a test's coffees match no other test's by roaster
 * and name (ADR-0018).
 */
function beansNamed(prefix: string): Record_[] {
  return (derivedDe1Pro({})["/beans"] as Record_[]).map((bean) => ({ ...bean, name: `${prefix} ${String(bean.name)}` }));
}

/** Decaid's bundled Profiles from the test tablet, as a fresh install holds them. */
function bundledProfiles(): Record_[] {
  return (derivedDe1Pro({})["/profiles"] as Record_[]).filter((profile) => profile.isDefault === true);
}

describe("Joining a Location", { timeout: 60_000 }, () => {
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
   * polling every 5 s (0.1 s here). Its Decaid holds the test tablet's
   * Library, its beans' names begun with the Machine's, and its Workflow,
   * which names one of its grinders and batches; or, `fresh`, only Decaid's
   * bundled Profiles, as on a fresh install, and a Workflow naming no
   * grinder or batch. Its settings are changed as given. The test tablet's
   * user Profiles are the same Profiles on every tablet holding them, in
   * every test.
   */
  function load(
    machine: CreatedMachine,
    serial: string,
    options: { instance?: TestServer; fresh?: boolean; parts?: Parts } = {},
  ): SimulatedTablet {
    const library = options.fresh
      ? { "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": bundledProfiles() }
      : { "/beans": beansNamed(machine.machine.name) };
    const context = options.fresh ? { targetDoseWeight: 18, targetYield: 36 } : undefined;
    const tablet = SimulatedTablet.load({
      settings: { ...settingsFor({ token: machine.token, serverUrl: (options.instance ?? server).url }), PollSeconds: 5 },
      api: { ...derivedDe1Pro({ serial }), ...library, "/workflow": workflowWith(options.parts ?? {}, context) },
      timeScale: 50,
    });
    tablets.push(tablet);
    return tablet;
  }

  async function online(...machines: CreatedMachine[]): Promise<void> {
    for (const { machine } of machines) await api.waitForMachine(machine.name, (viewed) => viewed.online);
  }

  const read = async <T>(path: string): Promise<T> => (await (await api.call("GET", path)).json()) as T;
  const settingsAt = async (location: LocationView) => (await read<{ settings: SettingsView }>(`/locations/${location.id}/settings`)).settings;
  /** Resolves with the Location's settings once they are set. */
  async function settingsOf(location: LocationView): Promise<Record<string, number | null>> {
    await expect.poll(async () => (await settingsAt(location)).id, { timeout: 10_000 }).not.toBeNull();
    return (await settingsAt(location)).values;
  }
  /** The steam, hot water and rinse settings of the tablet's Workflow, as Decaid holds them, by their names. */
  function tabletSettings(tablet: SimulatedTablet): Record<string, unknown> {
    const workflow = tablet.workflow();
    return Object.fromEntries(
      ["steamSettings", "hotWaterData", "rinseData"].flatMap((part) => Object.entries(workflow[part] as Record_).map(([name, value]) => [`${part}.${name}`, value])),
    );
  }
  const context = (tablet: SimulatedTablet) => tablet.workflow().context as Record_;
  /** The names of the Library's Beans begun with `prefix`, sorted. */
  const libraryBeans = async (prefix: string) =>
    (await read<{ beans: { name: string }[] }>("/beans")).beans.map((bean) => bean.name).filter((name) => name.startsWith(prefix)).sort();
  const machineView = async ({ machine }: CreatedMachine) => (await read<{ machine: MachineView }>(`/machines/${machine.id}`)).machine;
  const move = (created: CreatedMachine, location: LocationView) =>
    api.call("POST", `/machines/${created.machine.id}/location-history`, { locationId: location.id });

  /** The global ids the tablet's records of a list carry, unarchived or archived, sorted. */
  function heldIds(records: Record_[], archived: boolean): string[] {
    return records
      .filter((record) => (record.archived === true) === archived)
      .map((record) => globalIdOf(record))
      .filter((id) => id !== null)
      .sort();
  }
  /** The ids of the tablet's user Profiles, visible or not, sorted. */
  function userProfiles(tablet: SimulatedTablet, visible: boolean): string[] {
    return tablet
      .profiles()
      .filter((profile) => profile.isDefault !== true && (profile.visibility === "visible") === visible)
      .map((profile) => String(profile.id))
      .sort();
  }
  /** Resolves once every bean, batch and grinder record on the tablet carries a global id: the Library has taken them all in. */
  async function mapped(tablet: SimulatedTablet): Promise<void> {
    await expect
      .poll(() => [...tablet.beans(), ...tablet.batches(), ...tablet.grinders()].filter((record) => globalIdOf(record) === null).length, { timeout: 15_000 })
      .toBe(0);
  }
  /**
   * Resolves once both tablets hold the same, as `held` reads it. Both are
   * read again on each attempt, as either may still be written to while it
   * waits.
   */
  async function alike(held: (tablet: SimulatedTablet) => unknown, one: SimulatedTablet, another: SimulatedTablet): Promise<void> {
    await expect.poll(() => [held(one), held(another)], { timeout: 15_000 }).toSatisfy(([mine, theirs]) => isDeepStrictEqual(mine, theirs), "the same on both tablets");
  }
  /** What the server last took in of the tablet's list, as it reported it. */
  const captured = async ({ machine }: CreatedMachine, name: string) =>
    (await read<{ collection: { value: Record_[] } | null }>(`/machines/${machine.id}/collections/${name}`)).collection?.value ?? [];
  /** What the tablet holds that a Location offers it: its unarchived Beans, batches and Grinders, and its visible user Profiles. */
  const offered = (tablet: SimulatedTablet) => ({
    beans: heldIds(tablet.beans(), false),
    batches: heldIds(tablet.batches(), false),
    grinders: heldIds(tablet.grinders(), false),
    profiles: userProfiles(tablet, true),
  });

  it("writes a Machine adopted at Uptown Uptown's shown Profiles, its batches and their Beans, its Grinders, and its settings", async () => {
    const uptown = await api.createLocation("Adopting Uptown", "America/Chicago");
    const first = await api.createMachine("Adopting Uptown 1", uptown.id);
    const one = load(first, "23001", { parts: { steamSettings: { flow: 1.6 }, hotWaterData: { volume: 120 } } });
    await online(first);
    await mapped(one);
    const values = await settingsOf(uptown);
    const uptownOffers = offered(one);
    expect(uptownOffers.beans).toHaveLength(9);
    expect(uptownOffers.batches).toHaveLength(7);
    expect(uptownOffers.grinders).toHaveLength(2);
    expect(uptownOffers.profiles).toHaveLength(2);

    // A new Machine is adopted at Uptown, its tablet as fresh as a new install, its settings its own.
    const second = await api.createMachine("Adopting Uptown 2", uptown.id);
    const two = load(second, "23002", { instance: other, fresh: true, parts: { steamSettings: { flow: 0.7 }, rinseData: { duration: 9 } } });
    await online(second);
    await expect.poll(() => offered(two), { timeout: 15_000 }).toEqual(uptownOffers);
    await expect.poll(() => tabletSettings(two), { timeout: 10_000 }).toEqual(values);
    // Each batch with Uptown's remaining weight, under the tablet's record of its Bean.
    const beanOf = new Map(two.beans().map((bean) => [bean.id, globalIdOf(bean)]));
    const uptownBeanOf = new Map(one.beans().map((bean) => [bean.id, globalIdOf(bean)]));
    for (const batch of two.batches()) {
      const same = one.batches().find((record) => globalIdOf(record) === globalIdOf(batch))!;
      expect(beanOf.get(batch.beanId)).toBe(uptownBeanOf.get(same.beanId));
      expect(batch.weightRemaining).toBe(same.weightRemaining);
    }
    // Uptown's settings are as they were.
    expect((await settingsAt(uptown)).values).toEqual(values);
  });

  it("writes the lab's Machine moved to Belmont Belmont's state, archives or hides what only the lab offered, and clears its Workflow's grinder and batch", async () => {
    const lab = await api.createLocation("Moving lab", "America/Chicago");
    const belmont = await api.createLocation("Moving Belmont", "America/Chicago");
    const labMachine = await api.createMachine("Moving lab 1", lab.id);
    const belmontMachine = await api.createMachine("Moving Belmont 1", belmont.id);
    const labTablet = load(labMachine, "23011");
    const belmontTablet = load(belmontMachine, "23012", { instance: other, fresh: true, parts: { steamSettings: { flow: 0.9 }, hotWaterData: { volume: 140 } } });
    await online(labMachine, belmontMachine);
    // Belmont's own coffee, batch, grinder and Profile, entered on its tablet.
    const bean = await belmontTablet.addBean({ roaster: "Roux", name: "Belmont House" });
    await belmontTablet.addBatch(bean.id, { roastDate: "2026-10-05", weight: 1000 });
    await belmontTablet.addGrinder({ model: "Belmont EK43" });
    const profile = await belmontTablet.addProfile(derivedProfile("Belmont Espresso", 8.8));
    await mapped(labTablet);
    await mapped(belmontTablet);
    const belmontOffers = offered(belmontTablet);
    expect(belmontOffers.profiles).toEqual([String(profile.id)]);
    const labOffers = offered(labTablet);
    const belmontValues = await settingsOf(belmont);
    const labWorkflow = labTablet.workflow();
    expect(context(labTablet)).toMatchObject({ grinderModel: "DF64 v2", coffeeName: "Ethiopia Generic 100g Sample" });

    expect((await move(labMachine, belmont)).status).toBe(201);
    await expect.poll(() => offered(labTablet), { timeout: 15_000 }).toEqual(belmontOffers);
    // What only the lab offered is archived or hidden on it, never deleted.
    expect(heldIds(labTablet.beans(), true)).toEqual(labOffers.beans);
    expect(heldIds(labTablet.batches(), true)).toEqual(labOffers.batches);
    expect(heldIds(labTablet.grinders(), true)).toEqual(labOffers.grinders);
    expect(userProfiles(labTablet, false)).toEqual(labOffers.profiles);
    // It takes Belmont's settings, which it does not change.
    await expect.poll(() => tabletSettings(labTablet), { timeout: 10_000 }).toEqual(belmontValues);
    expect((await settingsAt(belmont)).values).toEqual(belmontValues);
    // Belmont offers neither its grinder nor its batch, which are cleared; its profile, dose, yield, grinder setting and barista stay.
    await expect.poll(() => GRINDER_AND_BATCH.filter((field) => field in context(labTablet)), { timeout: 10_000 }).toEqual([]);
    const { context: before, ...rest } = labWorkflow;
    const kept = Object.fromEntries(Object.entries(before as Record_).filter(([field]) => !GRINDER_AND_BATCH.includes(field)));
    expect(context(labTablet)).toEqual(kept);
    const { context: _after, steamSettings: _steam, hotWaterData: _water, rinseData: _rinse, ...restNow } = labTablet.workflow();
    const { steamSettings: _s, hotWaterData: _w, rinseData: _r, ...restBefore } = rest;
    expect(restNow).toEqual(restBefore);
    // The lab's items are still offered at the lab only.
    const labBean = await read<{ bean: { offeredAt: LocationView[] } }>(`/beans/${labOffers.beans[0]}`);
    expect(labBean.bean.offeredAt).toEqual([lab]);
  });

  it("keeps the Workflow's grinder and batch when the new Location offers them", async () => {
    const lab = await api.createLocation("Keeping lab", "UTC");
    const cafe = await api.createLocation("Keeping cafe", "UTC");
    const labMachine = await api.createMachine("Keeping lab 1", lab.id);
    const cafeMachine = await api.createMachine("Keeping cafe 1", cafe.id);
    const labTablet = load(labMachine, "23021");
    const cafeTablet = load(cafeMachine, "23022", { fresh: true });
    await online(labMachine, cafeMachine);
    await mapped(labTablet);
    // The cafe takes the lab's batch its Workflow names, but none of its Grinders.
    const batchId = globalIdOf(labTablet.batches().find((batch) => batch.id === context(labTablet).beanBatchId))!;
    expect((await api.call("PUT", `/bean-batches/${batchId}/locations/${cafe.id}`, { atLocation: true })).status).toBe(200);
    await expect.poll(() => heldIds(cafeTablet.batches(), false), { timeout: 10_000 }).toEqual([batchId]);

    expect((await move(labMachine, cafe)).status).toBe(201);
    await expect.poll(() => heldIds(labTablet.grinders(), false), { timeout: 15_000 }).toEqual([]);
    await expect.poll(() => GRINDER_AND_BATCH.filter((field) => field in context(labTablet)), { timeout: 10_000 }).toEqual([
      "beanBatchId",
      "coffeeName",
      "coffeeRoaster",
    ]);
    expect(context(labTablet).beanBatchId).toBe(labTablet.batches().find((batch) => globalIdOf(batch) === batchId)!.id);
  });

  it("changes nothing on the tablet when the time of a past move is corrected", async () => {
    const lab = await api.createLocation("Correcting lab", "UTC");
    const belmont = await api.createLocation("Correcting Belmont", "UTC");
    const traveller = await api.createMachine("Correcting traveller", lab.id);
    const belmontMachine = await api.createMachine("Correcting Belmont 1", belmont.id);
    const tablet = load(traveller, "23031");
    const belmontTablet = load(belmontMachine, "23032", { instance: other, fresh: true });
    await online(traveller, belmontMachine);
    await mapped(tablet);
    expect((await move(traveller, belmont)).status).toBe(201);
    // Profiles are written last: once the lab's are hidden, the move is written whole.
    await expect.poll(() => userProfiles(tablet, true), { timeout: 15_000 }).toEqual([]);
    expect(heldIds(tablet.grinders(), false)).toEqual([]);
    expect(GRINDER_AND_BATCH.filter((field) => field in context(tablet))).toEqual([]);
    const requests = () => tablet.received.filter((frame) => (frame as { type?: unknown }).type === "requestCollections").length;
    const asked = requests();
    const writes = tablet.writes.length;
    const workflow = tablet.workflow();
    const records = { beans: tablet.beans(), batches: tablet.batches(), grinders: tablet.grinders(), profiles: tablet.profiles() };

    // Its move to Belmont is corrected to have happened earlier, and its arrival at the lab earlier still.
    const [arrived, moved] = (await machineView(traveller)).locationHistory;
    const earlier = new Date((Date.parse(arrived!.effectiveFrom) + Date.parse(moved!.effectiveFrom)) / 2).toISOString();
    expect((await api.call("PATCH", `/machines/${traveller.machine.id}/location-history/${moved!.id}`, { effectiveFrom: earlier })).status).toBe(200);
    expect((await api.call("PATCH", `/machines/${traveller.machine.id}/location-history/${arrived!.id}`, { effectiveFrom: "2026-01-01T00:00:00Z" })).status).toBe(200);
    // A Bean Belmont enters after reaches the tablet, with nothing before it.
    await belmontTablet.addBean({ roaster: "Roux", name: "Correcting Sentinel" });
    await expect.poll(() => tablet.beans().filter((bean) => bean.name === "Correcting Sentinel").length, { timeout: 10_000 }).toBe(1);
    expect(tablet.writes.slice(writes)).toEqual(["POST /beans"]);
    expect(requests()).toBe(asked);
    expect(tablet.workflow()).toEqual(workflow);
    expect({ beans: tablet.beans().filter((bean) => bean.name !== "Correcting Sentinel"), batches: tablet.batches(), grinders: tablet.grinders(), profiles: tablet.profiles() }).toEqual(
      records,
    );
  });

  it("leaves a joining Machine's own Beans, batches, Grinders and Profiles out of the Library, archived or hidden on it, but links a Bean matching one the Library has", async () => {
    const uptown = await api.createLocation("Left out Uptown", "America/Chicago");
    const uptownMachine = await api.createMachine("Left out Uptown 1", uptown.id);
    const uptownTablet = load(uptownMachine, "23041", { fresh: true });
    await online(uptownMachine);
    // Uptown offers a coffee the joining tablet holds too, a batch of it, a Grinder and a Profile of its own.
    const coffee = await uptownTablet.addBean({ roaster: "roux bakehouse ", name: "Left out traveller Roest #24 Eth", notes: "Uptown's notes" });
    await uptownTablet.addBatch(coffee.id, { roastDate: "2026-10-05", weight: 1000 });
    await uptownTablet.addGrinder({ model: "Uptown EK43" });
    await uptownTablet.addProfile(derivedProfile("Left out Espresso", 8.6));
    await mapped(uptownTablet);
    const [uptownBean] = heldIds(uptownTablet.beans(), false);
    const uptownOffers = offered(uptownTablet);

    // A Machine with no Location connects, its tablet holding its own Library, which is captured but not taken in.
    const traveller = await api.createMachine("Left out traveller");
    const tablet = load(traveller, "23042", { instance: other });
    await online(traveller);
    await expect
      .poll(async () => (await read<{ collection: { value: unknown[] } | null }>(`/machines/${traveller.machine.id}/collections/grinders`)).collection?.value.length, {
        timeout: 10_000,
      })
      .toBe(2);
    expect(tablet.writes).toEqual([]);
    const ownBeans = tablet.beans().length;
    const ownProfiles = userProfiles(tablet, true);

    expect((await move(traveller, uptown)).status).toBe(201);
    // It is written what Uptown offers, and its coffee of the same roaster and name is Uptown's Bean, with Uptown's notes.
    await expect.poll(() => offered(tablet), { timeout: 15_000 }).toEqual(uptownOffers);
    const roest24 = tablet.beans().find((bean) => bean.name === "Left out traveller Roest #24 Eth")!;
    expect(globalIdOf(roest24)).toBe(uptownBean);
    expect(roest24.notes).toBe("Uptown's notes");
    expect((await read<{ conflicts: unknown[] }>(`/beans/${uptownBean}/conflicts`)).conflicts).toEqual([]);
    // Everything else it held stays out of the Library, archived or hidden on it, never deleted.
    const own = (records: Record_[]) => records.filter((record) => globalIdOf(record) === null);
    await expect.poll(() => own(tablet.beans()).filter((bean) => bean.archived !== true).length, { timeout: 15_000 }).toBe(0);
    await expect.poll(() => own(tablet.batches()).filter((batch) => batch.archived !== true).length, { timeout: 15_000 }).toBe(0);
    await expect.poll(() => own(tablet.grinders()).filter((grinder) => grinder.archived !== true).length, { timeout: 15_000 }).toBe(0);
    expect(own(tablet.beans())).toHaveLength(ownBeans - 1);
    expect(own(tablet.grinders())).toHaveLength(2);
    expect(userProfiles(tablet, false)).toEqual(expect.arrayContaining(ownProfiles));
    expect(await libraryBeans("Left out traveller")).toEqual(["Left out traveller Roest #24 Eth"]);
    expect(offered(uptownTablet)).toEqual(uptownOffers);
    // Uptown offers neither its grinder nor its batch, which are cleared.
    await expect.poll(() => GRINDER_AND_BATCH.filter((field) => field in context(tablet)), { timeout: 10_000 }).toEqual([]);

    // Its barista takes up one of its grinders again: un-archived there, it joins the Library at Uptown, as one entered then.
    const grinder = own(tablet.grinders())[0]!;
    await tablet.editGrinder(grinder.id, { archived: false });
    await expect.poll(() => heldIds(uptownTablet.grinders(), false).length, { timeout: 15_000 }).toBe(uptownOffers.grinders.length + 1);
    // Its tablet is written the Grinder's global id by a write of its own, apart from Uptown's tablet's.
    await alike((held) => heldIds(held.grinders(), false), tablet, uptownTablet);
  });

  it("brings a joining Machine's own items of each kind its Location offers none of yet", async () => {
    const cafe = await api.createLocation("Bringing cafe", "UTC");
    const cafeMachine = await api.createMachine("Bringing cafe 1", cafe.id);
    const cafeTablet = load(cafeMachine, "23043", { fresh: true });
    await online(cafeMachine);
    // The cafe offers a coffee the joining tablet holds too, but no batch, Grinder or user's Profile.
    await cafeTablet.addBean({ roaster: "Roux Bakehouse", name: "Bringing traveller Roest #24 Eth" });
    await mapped(cafeTablet);

    const traveller = await api.createMachine("Bringing traveller");
    const tablet = load(traveller, "23044", { instance: other });
    await online(traveller);
    const ownProfiles = userProfiles(tablet, true);
    // One of its grinders, not the one its Workflow names, is archived there before it joins: the server has taken in its
    // report of the grinder archived, not only one read before.
    const archived = tablet.grinders().find((grinder) => grinder.id !== context(tablet).grinderId)!;
    const kept = tablet.grinders().find((grinder) => grinder.id === context(tablet).grinderId)!;
    expect(archived.model).not.toBe(kept.model);
    await tablet.editGrinder(archived.id, { archived: true });
    await expect.poll(async () => (await captured(traveller, "grinders")).find((grinder) => grinder.id === archived.id)?.archived, { timeout: 10_000 }).toBe(true);
    expect((await move(traveller, cafe)).status).toBe(201);
    // Its Grinder and Profiles join the Library at the cafe, and reach the cafe's tablet; the grinder it archived stays out.
    await expect.poll(() => cafeTablet.grinders().filter((grinder) => grinder.archived !== true).map((grinder) => grinder.model), { timeout: 15_000 }).toEqual([kept.model]);
    await alike((held) => heldIds(held.grinders(), false), tablet, cafeTablet);
    const archivedNow = tablet.grinders().find((grinder) => grinder.id === archived.id)!;
    expect(archivedNow.archived).toBe(true);
    expect(globalIdOf(archivedNow)).toBeNull();
    const atCafe = (await read<{ grinders: { model: string | null; location: LocationView | null }[] }>("/grinders")).grinders.filter((grinder) => grinder.location?.id === cafe.id);
    expect(atCafe.map((grinder) => grinder.model)).toEqual([kept.model]);
    await expect.poll(() => userProfiles(cafeTablet, true), { timeout: 15_000 }).toEqual(ownProfiles);
    // Its coffees are left out, as the cafe offers one, and so are their batches, though the cafe offers none; but the batch
    // of the coffee linked to the cafe's joins the Library there, and reaches the cafe's tablet.
    await expect.poll(() => tablet.beans().filter((bean) => globalIdOf(bean) === null && bean.archived !== true).length, { timeout: 15_000 }).toBe(0);
    const roest24 = tablet.beans().find((bean) => bean.name === "Bringing traveller Roest #24 Eth")!;
    await expect.poll(() => heldIds(cafeTablet.batches(), false).length, { timeout: 15_000 }).toBe(1);
    await alike((held) => heldIds(held.batches(), false), tablet, cafeTablet);
    expect(tablet.batches().filter((batch) => batch.archived !== true).map((batch) => batch.beanId)).toEqual([roest24.id]);
    expect(await libraryBeans("Bringing traveller")).toEqual(["Bringing traveller Roest #24 Eth"]);
    // Its grinder joined the cafe, so its Workflow keeps it; its batch, whose coffee is left out, is cleared.
    await expect.poll(() => GRINDER_AND_BATCH.filter((field) => field in context(tablet)), { timeout: 10_000 }).toEqual(["grinderId", "grinderModel"]);
  });

  it("links a record left out at one join to the Library's item at a later join", async () => {
    const uptown = await api.createLocation("Relinking Uptown", "UTC");
    const belmont = await api.createLocation("Relinking Belmont", "UTC");
    const uptownMachine = await api.createMachine("Relinking Uptown 1", uptown.id);
    const uptownTablet = load(uptownMachine, "23045", { fresh: true });
    await online(uptownMachine);
    await uptownTablet.addBean({ roaster: "Roux", name: "Relinking Uptown House" });
    await mapped(uptownTablet);
    const traveller = await api.createMachine("Relinking traveller");
    const tablet = load(traveller, "23046", { instance: other });
    await online(traveller);
    const record = () => tablet.beans().filter((bean) => bean.name === "Relinking traveller Roest #24 Eth");
    const [roest24] = record();

    // At Uptown, which has no such coffee, it is left out, archived on the tablet.
    expect((await move(traveller, uptown)).status).toBe(201);
    await expect.poll(() => record()[0]!.archived, { timeout: 15_000 }).toBe(true);
    expect(globalIdOf(record()[0]!)).toBeNull();
    // Belmont gets that coffee, and the Machine moves there: its record is Belmont's Bean, written as Belmont offers it.
    const created = (await (await api.call("POST", "/beans", { content: { roaster: "Roux Bakehouse", name: "Relinking traveller Roest #24 Eth" } })).json()) as {
      bean: { id: string };
    };
    expect((await api.call("POST", "/bean-batches", { beanId: created.bean.id, content: { roastDate: "2026-10-05" }, locations: [{ locationId: belmont.id }] })).status).toBe(
      201,
    );
    expect((await move(traveller, belmont)).status).toBe(201);
    await expect.poll(() => globalIdOf(record()[0]!), { timeout: 15_000 }).toBe(created.bean.id);
    await expect.poll(() => record()[0]!.archived, { timeout: 15_000 }).toBe(false);
    expect(record().map((bean) => bean.id)).toEqual([roest24!.id]);
  });

  it("lets a Machine joining a Location that has no settings yet set them", async () => {
    const cafe = await api.createLocation("Settling cafe", "UTC");
    const traveller = await api.createMachine("Settling traveller");
    const tablet = load(traveller, "23051", { fresh: true, parts: { steamSettings: { flow: 1.1 }, hotWaterData: { volume: 90 }, rinseData: { duration: 6 } } });
    await online(traveller);
    const own = tabletSettings(tablet);
    expect((await settingsAt(cafe)).id).toBeNull();

    expect((await move(traveller, cafe)).status).toBe(201);
    expect(await settingsOf(cafe)).toEqual(own);
    expect(tabletSettings(tablet)).toEqual(own);
  });

  it("writes nothing more to a Machine moved to no Location, whose tablet keeps what it has", async () => {
    const lab = await api.createLocation("Leaving lab", "UTC");
    const leaving = await api.createMachine("Leaving lab 1", lab.id);
    const staying = await api.createMachine("Leaving lab 2", lab.id);
    const tablet = load(leaving, "23061", { fresh: true });
    const stayingTablet = load(staying, "23062", { instance: other, fresh: true });
    await online(leaving, staying);
    await stayingTablet.addBean({ roaster: "Roux", name: "Leaving Before" });
    await expect.poll(() => tablet.beans().filter((bean) => globalIdOf(bean) !== null).map((bean) => bean.name), { timeout: 10_000 }).toEqual(["Leaving Before"]);

    // Its only Location History entry is removed: it is at no Location.
    const [entry] = (await machineView(leaving)).locationHistory;
    expect((await api.call("DELETE", `/machines/${leaving.machine.id}/location-history/${entry!.id}`)).status).toBe(200);
    await expect.poll(async () => (await machineView(leaving)).location, { timeout: 10_000 }).toBeNull();
    const writes = tablet.writes.length;
    const held = tablet.beans();
    // The lab enters another coffee, and the leaving tablet one of its own, which is captured but not taken in.
    const after = await stayingTablet.addBean({ roaster: "Roux", name: "Leaving After" });
    await expect.poll(() => globalIdOf(stayingTablet.beans().find((bean) => bean.id === after.id)), { timeout: 10_000 }).not.toBeNull();
    await tablet.addBean({ roaster: "Roux", name: "Leaving Own" });
    await expect
      .poll(async () => (await read<{ collection: { value: Record_[] } | null }>(`/machines/${leaving.machine.id}/collections/beans`)).collection?.value.map((bean) => bean.name), {
        timeout: 10_000,
      })
      .toEqual(expect.arrayContaining(["Leaving Before", "Leaving Own"]));
    expect(tablet.writes.length).toBe(writes);
    expect(tablet.beans().filter((bean) => bean.name !== "Leaving Own")).toEqual(held);
    const { beans } = await read<{ beans: { name: string }[] }>("/beans");
    expect(beans.map((bean) => bean.name).filter((name) => name.startsWith("Leaving"))).toEqual(["Leaving After", "Leaving Before"]);
  });

  it("clears a grinder a skin relabelled between the join and the write, but keeps a batch a barista picked meanwhile", async () => {
    const lab = await api.createLocation("Picking lab", "UTC");
    const belmont = await api.createLocation("Picking Belmont", "UTC");
    const labMachine = await api.createMachine("Picking lab 1", lab.id);
    const belmontMachine = await api.createMachine("Picking Belmont 1", belmont.id);
    const tablet = load(labMachine, "23071");
    load(belmontMachine, "23072", { instance: other, fresh: true });
    await online(labMachine, belmontMachine);
    await mapped(tablet);
    const picked = tablet.batches().find((batch) => batch.id !== context(tablet).beanBatchId)!;

    // Decaid is slow to answer the plugin's read of the Workflow, so the barista acts while the plugin reads it to clear them.
    const release = tablet.holdWorkflowReads();
    expect((await move(labMachine, belmont)).status).toBe(201);
    await expect.poll(() => tablet.received.some((frame) => (frame as { kind?: unknown }).kind === "workflow"), { timeout: 15_000 }).toBe(true);
    const relabelled: Record_ = { ...context(tablet), grinderModel: "DF64 v2 (bar)", beanBatchId: picked.id, coffeeName: "Picked" };
    tablet.setWorkflow({ ...tablet.workflow(), context: relabelled });
    release();
    await expect.poll(() => "grinderId" in context(tablet), { timeout: 15_000 }).toBe(false);
    expect(context(tablet)).toMatchObject({ beanBatchId: picked.id, coffeeName: "Picked", coffeeRoaster: relabelled.coffeeRoaster });
    expect("grinderModel" in context(tablet)).toBe(false);
    // Once the lab's Profiles are hidden on it, the move is written whole, and its grinder and batch are not due again.
    await expect.poll(() => userProfiles(tablet, true), { timeout: 15_000 }).toEqual([]);
    expect(tablet.received.filter((frame) => (frame as { type?: unknown; kind?: unknown }).type === "write" && (frame as { kind?: unknown }).kind === "workflow")).toHaveLength(1);
  });

  it("changes nothing on the tablet when a move away and back made by mistake is removed", async () => {
    const lab = await api.createLocation("Mistaken lab", "UTC");
    const belmont = await api.createLocation("Mistaken Belmont", "UTC");
    const labMachine = await api.createMachine("Mistaken lab 1", lab.id);
    const traveller = await api.createMachine("Mistaken traveller", lab.id);
    const belmontMachine = await api.createMachine("Mistaken Belmont 1", belmont.id);
    const labTablet = load(labMachine, "23081", { fresh: true, parts: { steamSettings: { flow: 1.4 } } });
    const belmontTablet = load(belmontMachine, "23083", { fresh: true });
    await online(labMachine, belmontMachine);
    await settingsOf(lab);
    await belmontTablet.addBean({ roaster: "Roux", name: "Mistaken Belmont Bean" });
    const tablet = load(traveller, "23082", { instance: other, fresh: true, parts: { steamSettings: { flow: 1.4 } } });
    await online(traveller);
    const requests = () => tablet.received.filter((frame) => (frame as { type?: unknown }).type === "requestCollections").length;
    const held = (archived: boolean) => tablet.beans().filter((bean) => globalIdOf(bean) !== null && (bean.archived === true) === archived).map((bean) => bean.name);
    // Its reports are taken in at Belmont, which writes it Belmont's coffee, before it moves back.
    expect((await move(traveller, belmont)).status).toBe(201);
    await expect.poll(() => held(false), { timeout: 10_000 }).toEqual(["Mistaken Belmont Bean"]);
    expect((await move(traveller, lab)).status).toBe(201);
    await expect.poll(() => held(true), { timeout: 10_000 }).toEqual(["Mistaken Belmont Bean"]);
    const asked = requests();

    // The move to Belmont was a mistake: removing it removes the move back too, as the Machine never left the lab.
    const [, toBelmont] = (await machineView(traveller)).locationHistory;
    expect(toBelmont!.location.id).toBe(belmont.id);
    expect((await api.call("DELETE", `/machines/${traveller.machine.id}/location-history/${toBelmont!.id}`)).status).toBe(200);
    expect((await machineView(traveller)).locationHistory.map((entry) => entry.location.id)).toEqual([lab.id]);
    // A change its barista makes then is an edit at the lab, not given way to the lab's settings, and a coffee entered joins the Library.
    await tablet.changeSettings({ steamSettings: { flow: 2.1 } });
    await expect.poll(async () => (await settingsAt(lab)).values["steamSettings.flow"], { timeout: 10_000 }).toBe(2.1);
    await tablet.addBean({ roaster: "Roux", name: "Mistaken Later" });
    await expect.poll(() => held(false), { timeout: 10_000 }).toEqual(["Mistaken Later"]);
    expect(requests()).toBe(asked);
    expect(tabletSettings(tablet)["steamSettings.flow"]).toBe(2.1);
  });

  it("asks a joining tablet again for its Workflow taken in before it joined, though its lists came after, and writes nothing until it is judged there", async () => {
    const cafe = await api.createLocation("Asking cafe", "UTC");
    const created = (await (await api.call("POST", "/beans", { content: { roaster: "Roux", name: "Asking House" } })).json()) as { bean: { id: string } };
    expect((await api.call("POST", "/bean-batches", { beanId: created.bean.id, content: { roastDate: "2026-10-05" }, locations: [{ locationId: cafe.id }] })).status).toBe(201);
    const machine = await api.createMachine("Asking traveller");
    const raw = await RawConnection.welcomed(server.url, helloWith(machine.token, { tabletId: randomUUID(), machine: { model: "DE1Pro", serial: "23093" } }));
    raws.push(raw);
    const workflow = () => ({ type: "workflow", id: randomUUID(), observedAt: new Date().toISOString(), workflow: workflowFixture() });
    const report = (name: string) => ({ type: "collection", id: randomUUID(), name, available: true, value: [], updatedAt: [] });
    const sent = (type: string) => raw.messages.filter((message) => (message as { type?: unknown }).type === type);
    // Its Workflow is taken in while it is capture-only; it is then adopted at the cafe before its lists arrive.
    await raw.deliver(workflow());
    expect((await move(machine, cafe)).status).toBe(201);
    for (const name of ["beans", "beanBatches", "grinders", "profiles"]) await raw.deliver(report(name));
    await expect.poll(() => sent("requestCollections").length, { timeout: 10_000 }).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sent("write")).toEqual([]);
    // Once its Workflow is taken in at the cafe, it is judged as joining: the batch it names, its own, is cleared first.
    await raw.deliver(workflow());
    await expect.poll(() => sent("write").map((write) => (write as { kind?: unknown }).kind), { timeout: 10_000 }).toEqual(["workflow"]);
  });

  it("writes to a joining tablet once a Workflow it sends again is set aside, as it cannot be stored, rather than waiting for it", async () => {
    const cafe = await api.createLocation("Setting aside cafe", "UTC");
    const created = (await (await api.call("POST", "/beans", { content: { roaster: "Roux", name: "Setting aside House" } })).json()) as { bean: { id: string } };
    expect((await api.call("POST", "/bean-batches", { beanId: created.bean.id, content: { roastDate: "2026-10-05" }, locations: [{ locationId: cafe.id }] })).status).toBe(201);
    const machine = await api.createMachine("Setting aside traveller");
    const raw = await RawConnection.welcomed(server.url, helloWith(machine.token, { tabletId: randomUUID(), machine: { model: "DE1Pro", serial: "23094" } }));
    raws.push(raw);
    const workflow = (context: Record_) => ({ type: "workflow", id: randomUUID(), observedAt: new Date().toISOString(), workflow: { ...workflowFixture(), context } });
    const report = (name: string) => ({ type: "collection", id: randomUUID(), name, available: true, value: [], updatedAt: [] });
    const sent = (type: string) => raw.messages.filter((message) => (message as { type?: unknown }).type === type);
    await raw.deliver(workflow({ targetDoseWeight: 18 }));
    expect((await move(machine, cafe)).status).toBe(201);
    for (const name of ["beans", "beanBatches", "grinders", "profiles"]) await raw.deliver(report(name));
    await expect.poll(() => sent("requestCollections").length, { timeout: 10_000 }).toBe(1);
    // The Workflow it sends again holds what PostgreSQL refuses to store, so it is set aside, and the cafe's Bean is written.
    await raw.deliver(workflow({ targetDoseWeight: 18, notes: "Bright\u0000, sweet" }));
    await expect.poll(() => sent("write").some((write) => (write as { kind?: unknown }).kind === "bean"), { timeout: 10_000 }).toBe(true);
  });

  it("judges the batches a joining tablet holds as joining though its report of them came before its beans'", async () => {
    const uptown = await api.createLocation("Ordering Uptown", "UTC");
    const first = await api.createMachine("Ordering Uptown 1", uptown.id);
    const second = await api.createMachine("Ordering Uptown 2", uptown.id);
    const batches = derivedDe1Pro({})["/bean-batches"] as Record_[];
    const report = (name: string, value: Record_[]) => ({ type: "collection", id: randomUUID(), name, available: true, value, updatedAt: value.map(() => "2026-10-07T15:00:00.000Z") });
    const atUptown = async () =>
      (await read<{ batches: { locations: { location: LocationView }[] }[] }>("/bean-batches")).batches.filter((batch) =>
        batch.locations.some((here) => here.location.id === uptown.id),
      ).length;
    /** A tablet of the Machine reporting its batches first, as when its read of the beans failed: none can join before its bean is known. */
    async function joinWith(machine: CreatedMachine, serial: string, prefix: string): Promise<void> {
      const raw = await RawConnection.welcomed(server.url, helloWith(machine.token, { tabletId: randomUUID(), machine: { model: "DE1Pro", serial } }));
      raws.push(raw);
      await raw.deliver(report("beanBatches", batches));
      await raw.deliver(report("beans", beansNamed(prefix)));
      await raw.deliver(report("beanBatches", batches));
    }
    // The first brings its batches to Uptown, which offered none.
    await joinWith(first, "23091", "Ordering first");
    const brought = await atUptown();
    expect(brought).toBeGreaterThan(0);
    // The second holds the same coffees, which are linked to Uptown's, but its batches are left out, as Uptown offers batches now.
    await joinWith(second, "23092", "Ordering first");
    expect(await atUptown()).toBe(brought);
  });
});
