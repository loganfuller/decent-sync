import { globalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite } from "./support/admin-api.js";
import { SimulatedTablet, derivedDe1Pro, derivedProfile, settingsFor } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 and the REST API for ticket #85: an open Conflict (ADR-0020) shows
// the field's value now and where and when each value came from; using its
// value makes it a new edit, from the account, written to every tablet that
// holds the item, and dismissing it closes it with nothing else changed.
// Staff resolve Conflicts about shared content anywhere, and about a
// Location's state only at their own Locations. Conflicts are made through
// the built plugin in simulated tablets, on two server instances sharing
// PostgreSQL. Serials are made up, from 20001.

type Record_ = Record<string, unknown>;

interface Source {
  machine: { id: string; name: string } | null;
  tabletId: string | null;
  account: { id: string; name: string | null } | null;
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
  state: "open" | "used" | "dismissed";
  current: { value: unknown; source: Source | null; editedAt: string | null; versionId: string | null };
  resolvable: boolean;
}

interface VersionView {
  fields: Record_;
  location: LocationView | null;
  source: Source;
  editedAt: string;
  receivedAt: string;
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

describe("Resolving Conflicts", { timeout: 60_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  let adminId: string;
  const tablets: SimulatedTablet[] = [];

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
    adminId = ((await (await api.call("GET", "/session")).json()) as { account: { id: string } }).account.id;
  }, 60_000);
  afterAll(async () => {
    await Promise.all(tablets.map((tablet) => tablet.unload()));
    await other?.stop();
    await server?.stop();
  });

  /** The built plugin on a tablet of the Machine, polling every 5 s (0.1 s here), its Decaid's Library empty. */
  function load(machine: CreatedMachine, serial: string, instance: TestServer = server): SimulatedTablet {
    const tablet = SimulatedTablet.load({
      settings: { ...settingsFor({ token: machine.token, serverUrl: instance.url }), PollSeconds: 5 },
      api: { ...derivedDe1Pro({ serial }), "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [] },
      timeScale: 50,
    });
    tablets.push(tablet);
    return tablet;
  }

  async function get<T>(path: string, as: AdminApi = api): Promise<T> {
    const response = await as.call("GET", path);
    expect(response.status).toBe(200);
    return (await response.json()) as T;
  }

  /** Staff at the Locations, signed in. */
  async function staffAt(email: string, ...locations: LocationView[]): Promise<AdminApi> {
    const { link } = await api.invite(email, "staff", locations.map((location) => location.id));
    return AdminApi.signedInAs(server.url, await acceptInvite(server.url, link, { name: "Staff", password: "staff password 1" }));
  }

  /** The id of the Library's one Bean of that name, once there is one. */
  async function libraryBean(name: string): Promise<string> {
    const named = async () => (await get<{ beans: { id: string; name: string | null }[] }>("/beans")).beans.filter((bean) => bean.name === name);
    await expect.poll(async () => (await named()).length, { timeout: 10_000 }).toBe(1);
    return (await named())[0]!.id;
  }
  const heldBean = (tablet: SimulatedTablet, id: string) => tablet.beans().find((record) => globalIdOf(record) === id);
  async function holds(tablet: SimulatedTablet, id: string, fields: Record_): Promise<void> {
    await expect.poll(() => heldBean(tablet, id), { timeout: 10_000 }).toMatchObject(fields);
  }
  /** Uses the Conflict's value over the value now the account was shown with it. */
  const use = (as: AdminApi, conflict: ConflictView) => as.call("POST", `/conflicts/${conflict.id}/use`, { seen: conflict.current.versionId });
  const openConflicts = async (as: AdminApi = api) => (await get<{ conflicts: ConflictView[] }>("/conflicts", as)).conflicts;
  const conflictsOf = async (id: string) => (await openConflicts()).filter((conflict) => conflict.item.id === id);
  const beanContent = async (id: string) => (await get<{ bean: { content: Record_ } }>(`/beans/${id}`)).bean.content;
  const beanHistory = async (id: string) => (await get<{ versions: VersionView[] }>(`/beans/${id}/history`)).versions;

  /**
   * Two tablets at a lab hold a Bean, also entered at a cafe. Both lab
   * tablets, offline, edit its notes; the earlier edit is taken in first,
   * and the later one, made without seeing it, wins: the earlier is an open
   * Conflict.
   */
  async function notesConflict(name: string, serials: number) {
    const labLocation = await api.createLocation(`${name} lab`, "America/Chicago");
    const cafeLocation = await api.createLocation(`${name} cafe`, "America/Chicago");
    const labMachine = await api.createMachine(`${name} lab 1`, labLocation.id);
    const secondMachine = await api.createMachine(`${name} lab 2`, labLocation.id);
    const cafeMachine = await api.createMachine(`${name} cafe 1`, cafeLocation.id);
    const one = load(labMachine, String(serials + 1));
    const two = load(secondMachine, String(serials + 2), other);
    const cafe = load(cafeMachine, String(serials + 3));
    for (const { machine } of [labMachine, secondMachine, cafeMachine]) await api.waitForMachine(machine.name, (viewed) => viewed.online);
    await one.addBean({ roaster: "Roux", name: `${name} Guji`, notes: "Peach" });
    const id = await libraryBean(`${name} Guji`);
    await holds(two, id, { notes: "Peach" });
    await cafe.addBean({ roaster: "Roux", name: `${name} Guji`, notes: "Peach" });
    await holds(cafe, id, { notes: "Peach" });

    one.loseNetwork();
    two.loseNetwork();
    const earlier = await one.editBean(heldBean(one, id)!.id, { notes: "Earlier notes" });
    await delay(20);
    const later = await two.editBean(heldBean(two, id)!.id, { notes: "Later notes" });
    one.restoreNetwork();
    await holds(cafe, id, { notes: "Earlier notes" });
    two.restoreNetwork();
    for (const tablet of [one, two, cafe]) await holds(tablet, id, { notes: "Later notes" });
    await expect.poll(async () => (await conflictsOf(id)).length, { timeout: 10_000 }).toBe(1);
    const [conflict] = await conflictsOf(id);
    return { labLocation, cafeLocation, labMachine, secondMachine, one, two, cafe, id, earlier, later, conflict: conflict! };
  }

  it("shows an open Conflict with the value it lost to and where and when each came from, on its item too", async () => {
    const { id, conflict, labMachine, secondMachine, earlier, later } = await notesConflict("Shown", 20000);
    expect(conflict).toMatchObject({
      item: { kind: "bean", id, name: "Roux Shown Guji" },
      field: "notes",
      value: "Earlier notes",
      location: null,
      source: { machine: { id: labMachine.machine.id }, account: null },
      state: "open",
      current: { value: "Later notes", source: { machine: { id: secondMachine.machine.id, name: "Shown lab 2" }, account: null } },
      resolvable: true,
    });
    expect(Date.parse(conflict.editedAt)).toBe(localTime(earlier.updatedAt));
    expect(Date.parse(conflict.current.editedAt!)).toBe(localTime(later.updatedAt));

    expect(await get<{ conflicts: ConflictView[] }>(`/beans/${id}/conflicts`)).toEqual({ conflicts: [conflict] });
    expect((await api.call("GET", "/beans/00000000-0000-4000-8000-000000000000/conflicts")).status).toBe(404);
    expect((await api.call("GET", "/profiles/profile%3A00000000000000000000/conflicts")).status).toBe(404);
  });

  it("makes a used value current on every tablet that holds the item, as an edit from the account, and closes the Conflict", async () => {
    const { id, conflict, one, two, cafe } = await notesConflict("Used", 20010);
    const before = await beanHistory(id);

    // It names the value it replaces: a body that does not is refused.
    expect((await api.call("POST", `/conflicts/${conflict.id}/use`)).status).toBe(400);
    expect((await api.call("POST", `/conflicts/${conflict.id}/use`, { seen: "later" })).status).toBe(400);

    // A tablet that had seen the value now edits the field after the Conflict was shown: using its value is refused, as
    // the account was not shown that edit, which would otherwise be replaced unseen.
    await cafe.editBean(heldBean(cafe, id)!.id, { notes: "Cafe notes" });
    await expect.poll(async () => (await beanContent(id)).notes, { timeout: 10_000 }).toBe("Cafe notes");
    const stale = await use(api, conflict);
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { message: string }).message).toMatch(/changed since/);
    expect(await conflictsOf(id)).toHaveLength(1);
    const [shown] = await conflictsOf(id);
    expect(shown).toMatchObject({ current: { value: "Cafe notes", source: { machine: { name: "Used cafe 1" } } } });
    for (const tablet of [one, two]) await holds(tablet, id, { notes: "Cafe notes" });

    // A version's id is read in any case.
    const response = await api.call("POST", `/conflicts/${conflict.id}/use`, { seen: shown!.current.versionId!.toUpperCase() });
    expect(response.status).toBe(200);
    const { conflict: used } = (await response.json()) as { conflict: ConflictView };
    expect(used).toMatchObject({
      id: conflict.id,
      state: "used",
      value: "Earlier notes",
      current: { value: "Earlier notes", source: { machine: null, account: { id: adminId, name: "Ada Admin" } } },
    });

    // Written to every tablet that holds the Bean, at both Locations, through both instances.
    for (const tablet of [one, two, cafe]) await holds(tablet, id, { notes: "Earlier notes" });
    expect(await beanContent(id)).toMatchObject({ notes: "Earlier notes" });
    expect(await conflictsOf(id)).toEqual([]);
    expect(await get<{ conflicts: ConflictView[] }>(`/beans/${id}/conflicts`)).toEqual({ conflicts: [] });
    // A new version, made in the management interface, timed by PostgreSQL's clock.
    const versions = await beanHistory(id);
    expect(versions).toHaveLength(before.length + 2);
    expect(versions[0]).toMatchObject({ fields: { notes: "Earlier notes" }, location: null, source: { machine: null, tabletId: null, account: { id: adminId } } });
    expect(versions[0]!.editedAt).toBe(versions[0]!.receivedAt);

    // It is resolved once.
    expect((await use(api, used)).status).toBe(409);
    expect((await api.call("POST", `/conflicts/${conflict.id}/dismiss`)).status).toBe(409);
    expect((await api.call("POST", "/conflicts/00000000-0000-4000-8000-000000000000/use", { seen: null })).status).toBe(404);
    expect((await api.call("POST", "/conflicts/not-a-conflict/dismiss")).status).toBe(404);

    // A later edit on a tablet decides the field as any other would.
    await cafe.editBean(heldBean(cafe, id)!.id, { notes: "Cafe again" });
    for (const tablet of [one, two]) await holds(tablet, id, { notes: "Cafe again" });
    expect(await conflictsOf(id)).toEqual([]);
  });

  it("closes a dismissed Conflict and changes nothing else, and lets Staff resolve one about shared content anywhere", async () => {
    const { id, conflict, one, two, cafe } = await notesConflict("Dismissed", 20020);
    const before = await beanHistory(id);
    const elsewhere = await api.createLocation("Dismissed elsewhere", "America/Chicago");
    const staff = await staffAt("dismissing@example.com", elsewhere);
    expect((await openConflicts(staff)).find((open) => open.id === conflict.id)).toMatchObject({ resolvable: true });

    const response = await staff.call("POST", `/conflicts/${conflict.id}/dismiss`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { conflict: ConflictView }).conflict).toMatchObject({ state: "dismissed", value: "Earlier notes", current: { value: "Later notes" } });

    expect(await conflictsOf(id)).toEqual([]);
    expect(await beanContent(id)).toMatchObject({ notes: "Later notes" });
    expect(await beanHistory(id)).toEqual(before);
    await delay(500);
    for (const tablet of [one, two, cafe]) expect(heldBean(tablet, id)).toMatchObject({ notes: "Later notes" });
  });

  it("lets Staff resolve a Conflict about a Location's state only at their own Locations", async () => {
    const lab = await api.createLocation("Weight lab", "America/Chicago");
    const cafe = await api.createLocation("Weight cafe", "America/Chicago");
    const first = await api.createMachine("Weight lab 1", lab.id);
    const second = await api.createMachine("Weight lab 2", lab.id);
    const one = load(first, "20031");
    const two = load(second, "20032", other);
    for (const { machine } of [first, second]) await api.waitForMachine(machine.name, (viewed) => viewed.online);
    const bean = await one.addBean({ roaster: "Roux", name: "Weight Guji" });
    const added = await one.addBatch(bean.id, { roastDate: "2026-10-01", weight: 250 });
    const heldBatch = (tablet: SimulatedTablet) => tablet.batches().find((record) => record.roastDate === added.roastDate);
    await expect.poll(() => heldBatch(two), { timeout: 10_000 }).toMatchObject({ weightRemaining: 250 });
    await expect.poll(() => globalIdOf(heldBatch(one) ?? {}), { timeout: 10_000 }).toBeTruthy();
    const batchId = globalIdOf(heldBatch(one)!)!;

    // Both groups weigh what is left while offline: the earlier figure is taken in first, then replaced by the later.
    one.loseNetwork();
    two.loseNetwork();
    await one.editBatch(heldBatch(one)!.id, { weightRemaining: 200 });
    await delay(20);
    await two.editBatch(heldBatch(two)!.id, { weightRemaining: 150 });
    one.restoreNetwork();
    await expect.poll(() => weightAt(batchId), { timeout: 10_000 }).toBe(200);
    two.restoreNetwork();
    await expect.poll(() => heldBatch(one)?.weightRemaining, { timeout: 10_000 }).toBe(150);
    await expect.poll(async () => (await conflictsOf(batchId)).length, { timeout: 10_000 }).toBe(1);
    const [conflict] = await conflictsOf(batchId);
    expect(conflict).toMatchObject({
      item: { kind: "beanBatch", id: batchId, name: "Weight Guji, roasted 2026-10-01" },
      field: "remainingWeight",
      value: 200,
      location: { id: lab.id },
      source: { machine: { id: first.machine.id } },
      current: { value: 150, source: { machine: { id: second.machine.id } } },
    });

    const cafeStaff = await staffAt("weight-cafe@example.com", cafe);
    expect((await openConflicts(cafeStaff)).find((open) => open.id === conflict!.id)).toMatchObject({ resolvable: false });
    for (const action of ["use", "dismiss"]) {
      const refused = await cafeStaff.call("POST", `/conflicts/${conflict!.id}/${action}`, { seen: conflict!.current.versionId });
      expect(refused.status).toBe(403);
    }
    expect(await conflictsOf(batchId)).toHaveLength(1);

    // A group that had seen the figure now weighs again after the Conflict was shown: its value is not used over that
    // unseen entry, which made no Conflict.
    const labStaff = await staffAt("weight-lab@example.com", lab, cafe);
    await two.editBatch(heldBatch(two)!.id, { weightRemaining: 120 });
    await expect.poll(() => weightAt(batchId), { timeout: 10_000 }).toBe(120);
    expect((await use(labStaff, conflict!)).status).toBe(409);
    expect(await weightAt(batchId)).toBe(120);
    const [shown] = await conflictsOf(batchId);
    expect(shown).toMatchObject({ id: conflict!.id, current: { value: 120, source: { machine: { id: second.machine.id } } } });

    // Staff at the lab use it over the figure now: the lab's figure, on both its tablets.
    const used = await use(labStaff, shown!);
    expect(used.status).toBe(200);
    expect(((await used.json()) as { conflict: ConflictView }).conflict).toMatchObject({ state: "used", current: { value: 200, source: { machine: null } } });
    expect(await weightAt(batchId)).toBe(200);
    for (const tablet of [one, two]) await expect.poll(() => heldBatch(tablet)?.weightRemaining, { timeout: 10_000 }).toBe(200);
    expect(await conflictsOf(batchId)).toEqual([]);
    const { versions } = await get<{ versions: VersionView[] }>(`/bean-batches/${batchId}/history`);
    // Admins see which account it was; Staff see only its id, as other accounts' names are personal information.
    expect(versions[0]).toMatchObject({ fields: { remainingWeight: 200 }, location: { id: lab.id }, source: { machine: null, tabletId: null, account: { name: "Staff" } } });
    const asStaff = await get<{ versions: VersionView[] }>(`/bean-batches/${batchId}/history`, cafeStaff);
    expect(asStaff.versions[0]!.source.account).toEqual({ id: versions[0]!.source.account!.id, name: null });
  });

  it("lets Staff resolve a Conflict about a Grinder's content only at its Location", async () => {
    const lab = await api.createLocation("Grinder lab", "America/Chicago");
    const cafe = await api.createLocation("Grinder cafe", "America/Chicago");
    const first = await api.createMachine("Grinder lab 1", lab.id);
    const second = await api.createMachine("Grinder lab 2", lab.id);
    const one = load(first, "20041");
    const two = load(second, "20042", other);
    for (const { machine } of [first, second]) await api.waitForMachine(machine.name, (viewed) => viewed.online);
    await one.addGrinder({ model: "Conflict EK43", burrs: "98mm" });
    const heldGrinder = (tablet: SimulatedTablet) => tablet.grinders().find((record) => record.model === "Conflict EK43");
    await expect.poll(() => globalIdOf(heldGrinder(two) ?? {}), { timeout: 10_000 }).toBeTruthy();
    await expect.poll(() => globalIdOf(heldGrinder(one) ?? {}), { timeout: 10_000 }).toBeTruthy();
    const grinderId = globalIdOf(heldGrinder(one)!)!;

    one.loseNetwork();
    two.loseNetwork();
    await one.editGrinder(heldGrinder(one)!.id, { burrs: "98mm Turkish" });
    await delay(20);
    await two.editGrinder(heldGrinder(two)!.id, { burrs: "98mm Coffee" });
    one.restoreNetwork();
    await expect.poll(() => heldGrinder(two)?.burrs, { timeout: 10_000 }).toBe("98mm Coffee");
    await expect.poll(async () => (await get<{ grinder: { content: Record_ } }>(`/grinders/${grinderId}`)).grinder.content.burrs, { timeout: 10_000 }).toBe(
      "98mm Turkish",
    );
    two.restoreNetwork();
    await expect.poll(async () => (await conflictsOf(grinderId)).length, { timeout: 10_000 }).toBe(1);
    const [conflict] = await conflictsOf(grinderId);
    expect(conflict).toMatchObject({ item: { kind: "grinder", name: "Conflict EK43" }, field: "burrs", value: "98mm Turkish", location: null, current: { value: "98mm Coffee" } });

    const cafeStaff = await staffAt("grinder-cafe@example.com", cafe);
    expect((await openConflicts(cafeStaff)).find((open) => open.id === conflict!.id)).toMatchObject({ resolvable: false });
    expect((await use(cafeStaff, conflict!)).status).toBe(403);
    const labStaff = await staffAt("grinder-lab@example.com", lab);
    expect((await use(labStaff, conflict!)).status).toBe(200);
    for (const tablet of [one, two]) await expect.poll(() => heldGrinder(tablet)?.burrs, { timeout: 10_000 }).toBe("98mm Turkish");
  });

  /** Two tablets at a lab, each on its own instance, both online. */
  async function lab(name: string, serials: number) {
    const location = await api.createLocation(`${name} lab`, "America/Chicago");
    const first = await api.createMachine(`${name} lab 1`, location.id);
    const second = await api.createMachine(`${name} lab 2`, location.id);
    const one = load(first, String(serials + 1));
    const two = load(second, String(serials + 2), other);
    for (const { machine } of [first, second]) await api.waitForMachine(machine.name, (viewed) => viewed.online);
    return { location, one, two };
  }

  /** The item's one open Conflict, once there is one. */
  async function theConflict(id: string): Promise<ConflictView> {
    await expect.poll(async () => (await conflictsOf(id)).length, { timeout: 10_000 }).toBe(1);
    return (await conflictsOf(id))[0]!;
  }

  it("uses a value of whether a Profile is shown at a Location, hiding it there on every tablet", async () => {
    const { location, one, two } = await lab("Visibility", 20050);
    const saved = await one.addProfile(derivedProfile("Conflict Bloom", 8.5));
    const id = String(saved.id);
    const visibility = (tablet: SimulatedTablet) => tablet.profiles().find((record) => record.id === id)?.visibility;
    await expect.poll(() => visibility(two), { timeout: 10_000 }).toBe("visible");

    // The first group hides it offline; the second hides it and shows it again, later, which the first had not seen.
    one.loseNetwork();
    await one.setProfileVisibility(id, "hidden");
    await delay(20);
    await two.setProfileVisibility(id, "hidden");
    await expect.poll(async () => (await get<{ profile: { shownAt: unknown[] } }>(`/profiles/${encodeURIComponent(id)}`)).profile.shownAt, { timeout: 10_000 }).toEqual([]);
    await two.setProfileVisibility(id, "visible");
    await expect.poll(async () => (await get<{ profile: { shownAt: unknown[] } }>(`/profiles/${encodeURIComponent(id)}`)).profile.shownAt.length, { timeout: 10_000 }).toBe(1);
    one.restoreNetwork();
    const conflict = await theConflict(id);
    expect(conflict).toMatchObject({ item: { kind: "profile", name: "Conflict Bloom" }, field: "shown", value: false, location: { id: location.id }, current: { value: true } });
    for (const tablet of [one, two]) await expect.poll(() => visibility(tablet), { timeout: 10_000 }).toBe("visible");

    expect((await use(api, conflict)).status).toBe(200);
    for (const tablet of [one, two]) await expect.poll(() => visibility(tablet), { timeout: 10_000 }).toBe("hidden");
    expect((await get<{ profile: { shownAt: unknown[] } }>(`/profiles/${encodeURIComponent(id)}`)).profile.shownAt).toEqual([]);
    const { versions } = await get<{ versions: VersionView[] }>(`/profiles/${encodeURIComponent(id)}/history`);
    expect(versions[0]).toMatchObject({ fields: { shown: false }, location: { id: location.id }, source: { account: { id: adminId } } });
  });

  it("uses a value of whether a batch is at a Location, finishing it there on every tablet", async () => {
    const { location, one, two } = await lab("Presence", 20060);
    const bean = await one.addBean({ roaster: "Roux", name: "Presence Guji" });
    const added = await one.addBatch(bean.id, { roastDate: "2026-10-02", weight: 250 });
    const heldBatch = (tablet: SimulatedTablet) => tablet.batches().find((record) => record.roastDate === added.roastDate);
    await expect.poll(() => globalIdOf(heldBatch(two) ?? {}), { timeout: 10_000 }).toBeTruthy();
    await expect.poll(() => globalIdOf(heldBatch(one) ?? {}), { timeout: 10_000 }).toBeTruthy();
    const batchId = globalIdOf(heldBatch(one)!)!;
    const atLab = async () => (await get<{ batch: { locations: unknown[] } }>(`/bean-batches/${batchId}`)).batch.locations.length;

    // The first group finishes it offline; the second finishes it and adds it back, later.
    one.loseNetwork();
    await one.editBatch(heldBatch(one)!.id, { archived: true });
    await delay(20);
    await two.editBatch(heldBatch(two)!.id, { archived: true });
    await expect.poll(atLab, { timeout: 10_000 }).toBe(0);
    await two.editBatch(heldBatch(two)!.id, { archived: false });
    await expect.poll(atLab, { timeout: 10_000 }).toBe(1);
    one.restoreNetwork();
    const conflict = await theConflict(batchId);
    expect(conflict).toMatchObject({ field: "atLocation", value: false, location: { id: location.id }, current: { value: true } });
    for (const tablet of [one, two]) await expect.poll(() => heldBatch(tablet)?.archived, { timeout: 10_000 }).toBe(false);

    expect((await use(api, conflict)).status).toBe(200);
    expect(await atLab()).toBe(0);
    for (const tablet of [one, two]) await expect.poll(() => heldBatch(tablet)?.archived, { timeout: 10_000 }).toBe(true);
  });

  it("lets Staff anywhere use a value of whether a Grinder is Archived, as they Archive and restore items anywhere", async () => {
    const { one, two } = await lab("Archived", 20070);
    await one.addGrinder({ model: "Archived EK43" });
    const heldGrinder = (tablet: SimulatedTablet) => tablet.grinders().find((record) => record.model === "Archived EK43");
    await expect.poll(() => globalIdOf(heldGrinder(two) ?? {}), { timeout: 10_000 }).toBeTruthy();
    await expect.poll(() => globalIdOf(heldGrinder(one) ?? {}), { timeout: 10_000 }).toBeTruthy();
    const grinderId = globalIdOf(heldGrinder(one)!)!;
    const archived = async () => (await get<{ grinder: { archived: boolean } }>(`/grinders/${grinderId}`)).grinder.archived;

    // The first group archives it offline; the second archives it and restores it, later.
    one.loseNetwork();
    await one.editGrinder(heldGrinder(one)!.id, { archived: true });
    await delay(20);
    await two.editGrinder(heldGrinder(two)!.id, { archived: true });
    await expect.poll(archived, { timeout: 10_000 }).toBe(true);
    await two.editGrinder(heldGrinder(two)!.id, { archived: false });
    await expect.poll(archived, { timeout: 10_000 }).toBe(false);
    one.restoreNetwork();
    const conflict = await theConflict(grinderId);
    expect(conflict).toMatchObject({ field: "archived", value: true, location: null, current: { value: false } });

    const elsewhere = await staffAt("archiving@example.com", await api.createLocation("Archived elsewhere", "America/Chicago"));
    expect((await openConflicts(elsewhere)).find((open) => open.id === conflict.id)).toMatchObject({ resolvable: true });
    expect((await use(elsewhere, conflict)).status).toBe(200);
    expect(await archived()).toBe(true);
    for (const tablet of [one, two]) await expect.poll(() => heldGrinder(tablet)?.archived, { timeout: 10_000 }).toBe(true);
  });

  it("resolves a Conflict once when it is used and dismissed at the same time through two instances", async () => {
    const { id, conflict } = await notesConflict("Raced", 20080);
    const [used, dismissed] = await Promise.all([use(api, conflict), api.at(other.url).call("POST", `/conflicts/${conflict.id}/dismiss`)]);
    expect([used.status, dismissed.status].sort()).toEqual([200, 409]);
    const winner = used.status === 200 ? "used" : "dismissed";
    expect(await conflictsOf(id)).toEqual([]);
    const { conflict: closed } = (await (used.status === 200 ? used : dismissed).json()) as { conflict: ConflictView };
    expect(closed.state).toBe(winner);
    expect((await beanContent(id)).notes).toBe(winner === "used" ? "Earlier notes" : "Later notes");
  });

  /** The batch's remaining weight at its one Location, through the REST API. */
  async function weightAt(batchId: string): Promise<number | null | undefined> {
    return (await get<{ batch: { locations: { remainingWeight: number | null }[] } }>(`/bean-batches/${batchId}`)).batch.locations[0]?.remainingWeight;
  }
});

/** A time Decaid wrote in the tablet's local time without an offset, to the millisecond the plugin reads, as a UTC instant: the simulated tablet's zone is the process's. */
function localTime(written: unknown): number {
  return new Date(String(written).slice(0, 23)).getTime();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
