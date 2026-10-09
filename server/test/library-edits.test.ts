import { globalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { SimulatedTablet, derivedDe1Pro, derivedProfile, settingsFor } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #84: an edit of a Library item's content on any tablet
// reaches every tablet that holds the item, merged per field with the latest
// edit winning, and an edit that loses to one made without seeing it is kept
// as a Conflict (ADR-0020). Through the built plugin in simulated tablets and
// two server instances on one database; assertions go through the REST API
// and what each simulated tablet's Decaid holds. Serials are made up, from
// 19001.

type Record_ = Record<string, unknown>;

interface Source {
  machine: { id: string; name: string } | null;
  tabletId: string | null;
  account: { id: string } | null;
}

interface ConflictView {
  id: string;
  item: { kind: string; id: string; name: string | null };
  field: string;
  value: unknown;
  location: LocationView | null;
  source: Source;
  editedAt: string;
  createdAt: string;
}

interface VersionView {
  id: string;
  fields: Record_;
  location: LocationView | null;
  source: Source;
  editedAt: string;
  receivedAt: string;
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

describe("Edits of the Library", { timeout: 60_000 }, () => {
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
   * polling every 5 s (0.1 s here) unless given otherwise, its Decaid's
   * Library empty, as on a fresh install.
   */
  function load(
    machine: CreatedMachine,
    serial: string,
    options: {
      instance?: TestServer;
      pollSeconds?: number;
      decaidClockOffsetMs?: number;
      stallUpload?: (frame: unknown) => boolean;
      apiDelayMs?: (method: string, path: string) => number;
    } = {},
  ): SimulatedTablet {
    const tablet = SimulatedTablet.load({
      apiDelayMs: options.apiDelayMs,
      decaidClockOffsetMs: options.decaidClockOffsetMs,
      stallUpload: options.stallUpload,
      settings: { ...settingsFor({ token: machine.token, serverUrl: (options.instance ?? server).url }), PollSeconds: options.pollSeconds ?? 5 },
      api: { ...derivedDe1Pro({ serial }), "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [] },
      timeScale: 50,
    });
    tablets.push(tablet);
    return tablet;
  }

  async function online(...machines: CreatedMachine[]): Promise<void> {
    for (const { machine } of machines) await api.waitForMachine(machine.name, (viewed) => viewed.online);
  }

  async function get<T>(path: string): Promise<T> {
    const response = await api.call("GET", path);
    expect(response.status).toBe(200);
    return (await response.json()) as T;
  }

  /** The Library's one Bean of that name, once there is one. */
  async function libraryBean(name: string): Promise<{ id: string; content: Record_ }> {
    const named = async () => (await get<{ beans: { id: string; name: string | null }[] }>("/beans")).beans.filter((bean) => bean.name === name);
    await expect.poll(async () => (await named()).length, { timeout: 10_000 }).toBe(1);
    return (await get<{ bean: { id: string; content: Record_ } }>(`/beans/${(await named())[0]!.id}`)).bean;
  }
  const beanContent = async (id: string) => (await get<{ bean: { content: Record_ } }>(`/beans/${id}`)).bean.content;
  /** The tablet's record of the Library Bean, if it holds one. */
  const heldBean = (tablet: SimulatedTablet, id: string) => tablet.beans().find((record) => globalIdOf(record) === id);
  /** Resolves once the tablet holds the Bean with these fields. */
  async function holds(tablet: SimulatedTablet, id: string, fields: Record_): Promise<Record_> {
    await expect.poll(() => heldBean(tablet, id), { timeout: 10_000 }).toMatchObject(fields);
    return heldBean(tablet, id)!;
  }
  /** The open Conflicts about an item. */
  const conflictsOf = async (id: string) => (await get<{ conflicts: ConflictView[] }>("/conflicts")).conflicts.filter((conflict) => conflict.item.id === id);

  /** A Location with a tablet that enters a Bean, written to the Location's other tablet; and a cafe whose tablet enters the same coffee, so holds it too. */
  async function shared(name: string, serials: number, options: { instance?: TestServer } = {}) {
    const labLocation = await api.createLocation(`${name} lab`, "America/Chicago");
    const cafeLocation = await api.createLocation(`${name} cafe`, "America/Chicago");
    const labMachine = await api.createMachine(`${name} lab 1`, labLocation.id);
    const secondMachine = await api.createMachine(`${name} lab 2`, labLocation.id);
    const cafeMachine = await api.createMachine(`${name} cafe 1`, cafeLocation.id);
    const one = load(labMachine, String(serials + 1));
    const two = load(secondMachine, String(serials + 2), { instance: options.instance ?? other });
    const cafe = load(cafeMachine, String(serials + 3));
    await online(labMachine, secondMachine, cafeMachine);
    const entered = await one.addBean({ roaster: "Roux", name: `${name} Guji`, country: "Ethiopia", notes: "Peach" });
    const bean = await libraryBean(`${name} Guji`);
    await holds(two, bean.id, { notes: "Peach" });
    // Entered at the cafe as well, it is the same Bean (ADR-0018).
    await cafe.addBean({ roaster: "Roux", name: `${name} Guji`, country: "Ethiopia", notes: "Peach" });
    await holds(cafe, bean.id, { notes: "Peach" });
    await holds(one, bean.id, { notes: "Peach" });
    return { labLocation, cafeLocation, labMachine, secondMachine, cafeMachine, one, two, cafe, bean, record: entered };
  }

  it("writes a Bean's notes edited on one tablet to every tablet holding it, at every Location", async () => {
    const { one, two, cafe, bean, record } = await shared("Notes", 19000);
    await one.editBean(record.id, { notes: "Peach and jasmine" });
    await holds(two, bean.id, { notes: "Peach and jasmine" });
    await holds(cafe, bean.id, { notes: "Peach and jasmine" });
    expect(await beanContent(bean.id)).toMatchObject({ notes: "Peach and jasmine", country: "Ethiopia" });
    expect(await conflictsOf(bean.id)).toEqual([]);

    // An edit on a tablet at another Location reaches the lab the same way, and a field cleared is cleared everywhere.
    await cafe.editBean(heldBean(cafe, bean.id)!.id, { notes: null, region: "Guji" });
    await holds(one, bean.id, { region: "Guji" });
    await holds(two, bean.id, { region: "Guji" });
    expect(heldBean(one, bean.id)).not.toHaveProperty("notes");
    expect(heldBean(two, bean.id)).not.toHaveProperty("notes");
    expect(await beanContent(bean.id)).toEqual({ roaster: "Roux", name: "Notes Guji", decaf: false, country: "Ethiopia", region: "Guji" });
  });

  it("keeps both of two edits of different fields, one made on a disconnected tablet, with no Conflict", async () => {
    const { one, two, cafe, bean, record } = await shared("Fields", 19010);
    two.loseNetwork();
    await one.editBean(record.id, { country: "Kenya" });
    await holds(cafe, bean.id, { country: "Kenya" });
    await two.editBean(heldBean(two, bean.id)!.id, { notes: "Blueberry" });
    two.restoreNetwork();

    for (const tablet of [one, two, cafe]) await holds(tablet, bean.id, { country: "Kenya", notes: "Blueberry" });
    expect(await beanContent(bean.id)).toMatchObject({ country: "Kenya", notes: "Blueberry" });
    expect(await conflictsOf(bean.id)).toEqual([]);
  });

  it("keeps the later of two edits of one field made on disconnected tablets everywhere, and the other as an open Conflict", async () => {
    const { one, two, cafe, bean, record, labMachine } = await shared("Same", 19020);
    one.loseNetwork();
    two.loseNetwork();
    const earlier = await one.editBean(record.id, { notes: "Earlier notes" });
    await delay(20);
    await two.editBean(heldBean(two, bean.id)!.id, { notes: "Later notes" });

    // The earlier edit arrives first and is taken in; the later one, made without seeing it, then wins.
    one.restoreNetwork();
    await holds(cafe, bean.id, { notes: "Earlier notes" });
    two.restoreNetwork();
    for (const tablet of [one, two, cafe]) await holds(tablet, bean.id, { notes: "Later notes" });
    expect(await beanContent(bean.id)).toMatchObject({ notes: "Later notes" });
    const [conflict, ...more] = await conflictsOf(bean.id);
    expect(more).toEqual([]);
    expect(conflict).toMatchObject({
      item: { kind: "bean", id: bean.id, name: "Roux Same Guji" },
      field: "notes",
      value: "Earlier notes",
      location: null,
      source: { machine: { id: labMachine.machine.id, name: "Same lab 1" }, account: null },
    });
    // Timed by the tablet's record, which Decaid wrote in the tablet's local time, placed in UTC.
    expect(Date.parse(conflict!.editedAt)).toBe(localTime(earlier.updatedAt));
  });

  it("keeps an edit made later but arriving first, and the earlier one, arriving after it, as a Conflict", async () => {
    const { one, two, cafe, bean, record, labMachine } = await shared("Order", 19030);
    one.loseNetwork();
    two.loseNetwork();
    await one.editBean(record.id, { notes: "Made first" });
    await delay(20);
    await two.editBean(heldBean(two, bean.id)!.id, { notes: "Made second" });

    two.restoreNetwork();
    await holds(cafe, bean.id, { notes: "Made second" });
    one.restoreNetwork();
    // The earlier edit loses, and the Library's value is written back to its tablet.
    await holds(one, bean.id, { notes: "Made second" });
    await holds(cafe, bean.id, { notes: "Made second" });
    expect(await beanContent(bean.id)).toMatchObject({ notes: "Made second" });
    expect(await conflictsOf(bean.id)).toMatchObject([{ field: "notes", value: "Made first", source: { machine: { name: labMachine.machine.name } } }]);
  });

  it("decides concurrent edits taken in through both instances to one value everywhere, the other kept as one Conflict", async () => {
    // Both lab tablets connect to the other instance, the cafe's to the first.
    const { one, two, cafe, bean, record } = await shared("Instances", 19040, { instance: other });
    one.loseNetwork();
    two.loseNetwork();
    cafe.loseNetwork();
    await one.editBean(record.id, { notes: "Lab one", region: "Guji" });
    await delay(20);
    await two.editBean(heldBean(two, bean.id)!.id, { notes: "Lab two" });
    await delay(20);
    await cafe.editBean(heldBean(cafe, bean.id)!.id, { notes: "Cafe", producer: "Hambela" });
    // Their reports are taken in at once, through both instances.
    one.restoreNetwork();
    two.restoreNetwork();
    cafe.restoreNetwork();

    for (const tablet of [one, two, cafe]) await holds(tablet, bean.id, { notes: "Cafe", region: "Guji", producer: "Hambela" });
    expect(await beanContent(bean.id)).toMatchObject({ notes: "Cafe", region: "Guji", producer: "Hambela" });
    // Whatever order they were taken in, the cafe's latest notes stand and each lab edit of them is kept once.
    expect((await conflictsOf(bean.id)).map((conflict) => conflict.value).sort()).toEqual(["Lab one", "Lab two"]);
  });

  it("keeps a barista's edit the tablet had not reported when the server writes that field to it, as the later edit", async () => {
    const lab = await api.createLocation("Unreported lab", "America/Chicago");
    const first = await api.createMachine("Unreported 1", lab.id);
    const second = await api.createMachine("Unreported 2", lab.id);
    const one = load(first, "19051");
    // Polls once an hour (every 72 s here), so what is entered on it is reported only on its next welcome.
    const two = load(second, "19052", { pollSeconds: 3600 });
    await online(first, second);
    const record = await one.addBean({ roaster: "Roux", name: "Unreported Guji", notes: "Peach" });
    const bean = await libraryBean("Unreported Guji");
    await holds(two, bean.id, { notes: "Peach" });

    await two.editBean(heldBean(two, bean.id)!.id, { notes: "Edited on group 2" });
    await one.editBean(record.id, { notes: "Edited on group 1" });
    // Written group 1's notes, group 2's record holds its own, which the plugin keeps, and its answer brings in.
    await holds(one, bean.id, { notes: "Edited on group 2" });
    expect(heldBean(two, bean.id)).toMatchObject({ notes: "Edited on group 2" });
    expect(await beanContent(bean.id)).toMatchObject({ notes: "Edited on group 2" });
    expect(await conflictsOf(bean.id)).toMatchObject([{ field: "notes", value: "Edited on group 1", source: { machine: { name: "Unreported 1" } } }]);
  });

  it("writes the Library's value back, on the same connection, over a barista's unreported edit that lost", async () => {
    const lab = await api.createLocation("Losing lab", "America/Chicago");
    const first = await api.createMachine("Losing 1", lab.id);
    const second = await api.createMachine("Losing 2", lab.id);
    // Its Decaid's clock runs 10 minutes fast, so its edit is timed after the other tablet's.
    const one = load(first, "19091", { decaidClockOffsetMs: 10 * 60_000 });
    // Polls once an hour (every 72 s here), so what is entered on it is not reported within the test.
    const two = load(second, "19092", { pollSeconds: 3600 });
    await online(first, second);
    const record = await one.addBean({ roaster: "Roux", name: "Losing Guji", notes: "Peach" });
    const bean = await libraryBean("Losing Guji");
    await holds(two, bean.id, { notes: "Peach" });

    await two.editBean(heldBean(two, bean.id)!.id, { notes: "Edited on group 2" });
    await one.editBean(record.id, { notes: "Edited on group 1" });
    // The plugin keeps group 2's edit as it writes group 1's notes; its answer brings it in, and it loses.
    await expect.poll(async () => (await conflictsOf(bean.id)).map((conflict) => conflict.value), { timeout: 10_000 }).toEqual(["Edited on group 2"]);
    expect(await beanContent(bean.id)).toMatchObject({ notes: "Edited on group 1" });
    // The Library's value is then written to group 2, though the write before it named the same fields.
    await holds(two, bean.id, { notes: "Edited on group 1" });
    expect(two.received.filter((frame) => (frame as { type?: unknown }).type === "welcome")).toHaveLength(1);
  });

  it("keeps a second unreported edit that loses as a Conflict too, as its record never held the value written", async () => {
    const lab = await api.createLocation("Twice lab", "America/Chicago");
    const first = await api.createMachine("Twice 1", lab.id);
    const second = await api.createMachine("Twice 2", lab.id);
    const one = load(first, "19121");
    // Its Decaid's clock runs 10 minutes slow, so its edits are timed before the other tablet's, and it reports only on
    // welcome. While `slow`, each read of a bean takes 25 s (0.5 s here), so its barista can edit between a write's read
    // and its update.
    let slow = false;
    const two = load(second, "19122", {
      decaidClockOffsetMs: -10 * 60_000,
      pollSeconds: 3600,
      apiDelayMs: (method, path) => (slow && method === "GET" && path.startsWith("/beans/") ? 25_000 : 0),
    });
    await online(first, second);
    const record = await one.addBean({ roaster: "Roux", name: "Twice Guji", notes: "Peach" });
    const bean = await libraryBean("Twice Guji");
    await holds(two, bean.id, { notes: "Peach" });

    slow = true;
    await two.editBean(heldBean(two, bean.id)!.id, { notes: "E1 on two" });
    await one.editBean(record.id, { notes: "L on one" });
    // The plugin keeps E1 as it writes L; its answer brings E1 in, which loses, and L is written to it again.
    await expect.poll(async () => (await conflictsOf(bean.id)).map((conflict) => conflict.value), { timeout: 10_000 }).toEqual(["E1 on two"]);
    // While that write reads the record, the barista edits it again, timed before L: its record never held L.
    await two.editBean(heldBean(two, bean.id)!.id, { notes: "E2 on two" });
    slow = false;
    await expect.poll(async () => (await conflictsOf(bean.id)).map((conflict) => conflict.value).sort(), { timeout: 20_000 }).toEqual(["E1 on two", "E2 on two"]);
    expect(await beanContent(bean.id)).toMatchObject({ notes: "L on one" });
    await holds(two, bean.id, { notes: "L on one" });
  });

  it("applies an edit made over a value written to the tablet whose answer came late, whatever its time", async () => {
    const lab = await api.createLocation("Late lab", "America/Chicago");
    const first = await api.createMachine("Late 1", lab.id);
    const second = await api.createMachine("Late 2", lab.id);
    const one = load(first, "19101");
    // Its Decaid's clock runs 10 minutes slow, so its edits are timed before the other tablet's. Its answers to writes
    // wait in its outbox while held, until it reconnects: answers to no write awaited then.
    let holding = false;
    const two = load(second, "19102", {
      decaidClockOffsetMs: -10 * 60_000,
      stallUpload: (frame) => holding && (frame as { type?: unknown }).type === "written",
    });
    await online(first, second);
    const record = await one.addBean({ roaster: "Roux", name: "Late Guji", notes: "v1" });
    const bean = await libraryBean("Late Guji");
    await holds(two, bean.id, { notes: "v1" });

    holding = true;
    await one.editBean(record.id, { notes: "v2 from one" });
    await holds(two, bean.id, { notes: "v2 from one" });
    two.loseNetwork();
    holding = false;
    two.restoreNetwork();
    await expect.poll(() => two.received.filter((frame) => (frame as { type?: unknown }).type === "welcome").length, { timeout: 10_000 }).toBe(2);

    // Its barista edits what it was written: an edit made over the Library's value, so it applies though timed earlier.
    await two.editBean(heldBean(two, bean.id)!.id, { notes: "v3 from two" });
    await holds(one, bean.id, { notes: "v3 from two" });
    expect(await beanContent(bean.id)).toMatchObject({ notes: "v3 from two" });
    expect(heldBean(two, bean.id)).toMatchObject({ notes: "v3 from two" });
    expect(await conflictsOf(bean.id)).toEqual([]);
  });

  it("keeps a Profile a barista hid but the tablet had not reported when the server writes it a new title", async () => {
    const lab = await api.createLocation("Hide lab", "America/Chicago");
    const first = await api.createMachine("Hide 1", lab.id);
    const second = await api.createMachine("Hide 2", lab.id);
    const one = load(first, "19111");
    // Polls once an hour (every 72 s here), so what is changed on it is not reported within the test.
    const two = load(second, "19112", { pollSeconds: 3600 });
    await online(first, second);
    const saved = await one.addProfile(derivedProfile("Hide Bloom", 7.25));
    const on = (tablet: SimulatedTablet) => tablet.profiles().find((record) => record.id === saved.id);
    await expect.poll(() => on(two)?.visibility, { timeout: 10_000 }).toBe("visible");

    await two.setProfileVisibility(saved.id, "hidden");
    await one.editProfile(saved.id, { ...(saved.profile as Record_), title: "Hide Bloom v2" });
    // Written the new title, its answer brings the hide in: the lab hides it, on the other tablet too.
    await expect.poll(() => (on(two)?.profile as Record_ | undefined)?.title, { timeout: 10_000 }).toBe("Hide Bloom v2");
    await expect.poll(() => on(one)?.visibility, { timeout: 10_000 }).toBe("hidden");
    expect(on(two)?.visibility).toBe("hidden");
    expect((await get<{ profile: { shownAt: unknown[] } }>(`/profiles/${encodeURIComponent(String(saved.id))}`)).profile.shownAt).toEqual([]);
    expect(await conflictsOf(String(saved.id))).toEqual([]);
  });

  it("renames a Profile renamed on one tablet on every tablet that holds it", async () => {
    const lab = await api.createLocation("Rename lab", "America/Chicago");
    const cafe = await api.createLocation("Rename cafe", "America/Chicago");
    const first = await api.createMachine("Rename lab 1", lab.id);
    const second = await api.createMachine("Rename lab 2", lab.id);
    const third = await api.createMachine("Rename cafe 1", cafe.id);
    const one = load(first, "19061");
    const two = load(second, "19062", { instance: other });
    const three = load(third, "19063");
    await online(first, second, third);
    const profile = derivedProfile("House Bloom", 7.75);
    const saved = await one.addProfile(profile);
    const titleOn = (tablet: SimulatedTablet) => (tablet.profiles().find((record) => record.id === saved.id)?.profile as Record_ | undefined)?.title;
    await expect.poll(() => titleOn(two), { timeout: 10_000 }).toBe("House Bloom");
    // The cafe saves the same steps, so holds the same Profile (ADR-0006).
    await three.addProfile(profile);
    const shownAt = async () =>
      (await get<{ profile: { shownAt: { location: LocationView }[] } }>(`/profiles/${encodeURIComponent(String(saved.id))}`)).profile.shownAt
        .map((here) => here.location.name)
        .sort();
    await expect.poll(shownAt, { timeout: 10_000 }).toEqual(["Rename cafe", "Rename lab"]);

    const renamed = await one.editProfile(saved.id, { ...(saved.profile as Record_), title: "House Bloom v2", notes: "Longer bloom" });
    expect(renamed.id).toBe(saved.id);
    await expect.poll(() => titleOn(two), { timeout: 10_000 }).toBe("House Bloom v2");
    await expect.poll(() => titleOn(three), { timeout: 10_000 }).toBe("House Bloom v2");
    const notesOn = (tablet: SimulatedTablet) => (tablet.profiles().find((record) => record.id === saved.id)?.profile as Record_ | undefined)?.notes;
    expect([notesOn(two), notesOn(three)]).toEqual(["Longer bloom", "Longer bloom"]);
    // Still one Profile, under the same id, on every tablet.
    for (const tablet of [one, two, three]) expect(tablet.profiles().filter((record) => (record.profile as Record_).title === "House Bloom v2").map((record) => record.id)).toEqual([saved.id]);
    expect((await get<{ profile: { title: string } }>(`/profiles/${encodeURIComponent(String(saved.id))}`)).profile.title).toBe("House Bloom v2");
    expect(await conflictsOf(String(saved.id))).toEqual([]);
  });

  it("writes a batch's and a Grinder's edits to the tablets that hold them", async () => {
    const lab = await api.createLocation("Equipment lab", "America/Chicago");
    const first = await api.createMachine("Equipment 1", lab.id);
    const second = await api.createMachine("Equipment 2", lab.id);
    const one = load(first, "19071");
    const two = load(second, "19072", { instance: other });
    await online(first, second);
    const bean = await one.addBean({ roaster: "Roux", name: "Equipment Guji" });
    const batch = await one.addBatch(bean.id, { roastDate: "2026-10-01", roastLevel: "light", weight: 250 });
    const grinder = await one.addGrinder({ model: "Fixture Grinder", burrs: "Fixture 63mm" });
    const heldBatch = () => two.batches().find((record) => record.roastLevel !== undefined);
    const heldGrinder = () => two.grinders().find((record) => record.model === "Fixture Grinder");
    await expect.poll(heldBatch, { timeout: 10_000 }).toMatchObject({ roastLevel: "light" });
    await expect.poll(heldGrinder, { timeout: 10_000 }).toMatchObject({ burrs: "Fixture 63mm" });

    await one.editBatch(batch.id, { roastLevel: "medium", notes: "Second crack" });
    await one.editGrinder(grinder.id, { burrs: "Fixture 64mm" });
    await expect.poll(heldBatch, { timeout: 10_000 }).toMatchObject({ roastLevel: "medium", notes: "Second crack", weightRemaining: 250, archived: false });
    await expect.poll(heldGrinder, { timeout: 10_000 }).toMatchObject({ burrs: "Fixture 64mm", archived: false });
  });

  it("lists each version of an item with where it came from and when, the latest first", async () => {
    const lab = await api.createLocation("History lab", "America/Chicago");
    const first = await api.createMachine("History 1", lab.id);
    const second = await api.createMachine("History 2", lab.id);
    const one = load(first, "19081");
    const two = load(second, "19082", { instance: other });
    await online(first, second);
    const record = await one.addBean({ roaster: "Roux", name: "History Guji", notes: "Peach" });
    const bean = await libraryBean("History Guji");
    await holds(two, bean.id, { notes: "Peach" });
    const edited = await two.editBean(heldBean(two, bean.id)!.id, { notes: "Jasmine", country: "Ethiopia" });
    await holds(one, bean.id, { notes: "Jasmine" });

    const { versions } = await get<{ versions: VersionView[] }>(`/beans/${bean.id}/history`);
    expect(versions).toHaveLength(2);
    const [edit, joined] = versions;
    expect(edit).toMatchObject({ fields: { notes: "Jasmine", country: "Ethiopia" }, location: null, source: { machine: { id: second.machine.id, name: "History 2" } } });
    expect(joined).toMatchObject({
      fields: { roaster: "Roux", name: "History Guji", decaf: false, notes: "Peach" },
      location: null,
      source: { machine: { id: first.machine.id, name: "History 1" }, account: null },
    });
    expect(joined!.source.tabletId).toEqual(expect.any(String));
    expect(edit!.source.tabletId).not.toBe(joined!.source.tabletId);
    // Each edit is timed by its tablet's record, and taken in afterwards by PostgreSQL's clock.
    expect(Date.parse(edit!.editedAt)).toBe(localTime(edited.updatedAt));
    expect(Date.parse(joined!.editedAt)).toBe(localTime(record.updatedAt));
    expect(Date.parse(edit!.receivedAt)).toBeGreaterThanOrEqual(Date.parse(joined!.receivedAt));

    // A batch's history includes its state at each Location, named by that Location.
    const added = await one.addBatch(record.id, { roastDate: "2026-10-01", weight: 250 });
    const weighed = async (weight: number) =>
      (await get<{ batches: { id: string; bean: { id: string }; locations: { remainingWeight: number | null }[] }[] }>("/bean-batches")).batches.find(
        (batch) => batch.bean.id === bean.id && batch.locations[0]?.remainingWeight === weight,
      );
    await expect.poll(() => weighed(250), { timeout: 10_000 }).toBeDefined();
    await one.editBatch(added.id, { weightRemaining: 180 });
    await expect.poll(() => weighed(180), { timeout: 10_000 }).toBeDefined();
    const batchHistory = (await get<{ versions: VersionView[] }>(`/bean-batches/${(await weighed(180))!.id}/history`)).versions;
    expect(batchHistory[0]).toMatchObject({ location: { name: "History lab" }, fields: { remainingWeight: 180 } });
    // Joining the Library, at the lab with the weight Decaid gave it, are each a version, taken in together.
    expect(batchHistory.slice(1).map((version) => [version.location?.name ?? null, version.fields])).toEqual(
      expect.arrayContaining([
        ["History lab", { remainingWeight: 250 }],
        ["History lab", { atLocation: true }],
        [null, expect.objectContaining({ roastDate: "2026-10-01T00:00:00.000", weight: 250 })],
      ]),
    );
    expect(batchHistory).toHaveLength(4);

    expect((await api.call("GET", "/beans/00000000-0000-4000-8000-000000000000/history")).status).toBe(404);
    expect((await api.call("GET", "/profiles/profile%3A00000000000000000000/history")).status).toBe(404);
  });
});

/** A time Decaid wrote in the tablet's local time without an offset, to the millisecond the plugin reads, as a UTC instant: the simulated tablet's zone is the process's. */
function localTime(written: unknown): number {
  return new Date(String(written).slice(0, 23)).getTime();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
