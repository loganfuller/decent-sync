import { setTimeout as delay } from "node:timers/promises";
import { globalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite } from "./support/admin-api.js";
import { syncingTablet, emptyLibrary, localTime } from "./support/loaded-tablets.js";
import { type SimulatedTablet, derivedProfile } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 and the REST API for ticket #632 (ADR-0033): an edit to a field of
// a Library item that loses, on time or to an edit made without seeing it,
// is kept as a Lost Edit in the item's history, with its value, who or which
// Machine made it, when, and the edit it lost to, for its content and for
// each field of a Location's state. None is kept for a value the editing
// tablet's last known record held, though holding a value never changes who
// wins. Nothing lists, uses or dismisses one. Lost Edits are made through the
// built plugin in simulated tablets, on two server instances sharing
// PostgreSQL. Serials are made up, from 20001.

type Record_ = Record<string, unknown>;

interface Source {
  machine: { id: string; name: string } | null;
  tabletId: string | null;
  account: { id: string; name: string | null } | null;
}

interface LostEditView {
  id: string;
  field: string;
  value: unknown;
  location: LocationView | null;
  source: Source;
  editedAt: string;
  lostAt: string;
  lostTo: { versionId: string; value: unknown; source: Source; editedAt: string } | null;
}

interface VersionView {
  id: string;
  fields: Record_;
  location: LocationView | null;
  source: Source;
  editedAt: string;
  receivedAt: string;
}

interface HistoryView {
  versions: VersionView[];
  lostEdits: LostEditView[];
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

describe("Lost Edits", () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => {
    await server?.stop();
  });

  /** The built plugin on a tablet of the Machine, polling every 5 s (0.1 s here), its Decaid's Library empty. */
  function load(machine: CreatedMachine, serial: string, instance: TestServer = server): SimulatedTablet {
    return syncingTablet(machine, instance, { api: emptyLibrary(serial) });
  }

  /** The id of the Library's one Bean of that name, once there is one. */
  async function libraryBean(name: string): Promise<string> {
    const named = async () => (await api.get<{ beans: { id: string; name: string | null }[] }>("/beans")).beans.filter((bean) => bean.name === name);
    await expect.poll(async () => (await named()).length).toBe(1);
    return (await named())[0]!.id;
  }
  const heldBean = (tablet: SimulatedTablet, id: string) => tablet.beans().find((record) => globalIdOf(record) === id);
  async function holds(tablet: SimulatedTablet, id: string, fields: Record_): Promise<void> {
    await expect.poll(() => heldBean(tablet, id)).toMatchObject(fields);
  }
  /** An item's history, by its page's path, such as `/beans/<id>`. */
  const historyOf = (path: string, as: AdminApi = api) => as.get<HistoryView>(`${path}/history`);
  const lostEditsOf = async (path: string) => (await historyOf(path)).lostEdits;
  /** The item's one Lost Edit, once it has one. */
  async function theLostEdit(path: string): Promise<LostEditView> {
    await expect.poll(async () => (await lostEditsOf(path)).length).toBe(1);
    return (await lostEditsOf(path))[0]!;
  }
  const beanContent = async (id: string) => (await api.get<{ bean: { content: Record_ } }>(`/beans/${id}`)).bean.content;

  /**
   * Two tablets at a lab hold a Bean, also entered at a cafe. Both lab
   * tablets, offline, edit its notes, the first earlier than the second.
   * They come back in the order given, by which is taken in `first`.
   */
  async function notesEdited(name: string, serials: number, first: "earlier" | "later") {
    const labLocation = await api.createLocation(`${name} lab`, "America/Chicago");
    const cafeLocation = await api.createLocation(`${name} cafe`, "America/Chicago");
    const labMachine = await api.createMachine(`${name} lab 1`, labLocation.id);
    const secondMachine = await api.createMachine(`${name} lab 2`, labLocation.id);
    const cafeMachine = await api.createMachine(`${name} cafe 1`, cafeLocation.id);
    const one = load(labMachine, String(serials + 1));
    const two = load(secondMachine, String(serials + 2), other);
    const cafe = load(cafeMachine, String(serials + 3));
    await api.waitForOnline(labMachine, secondMachine, cafeMachine);
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
    if (first === "earlier") {
      one.restoreNetwork();
      await holds(cafe, id, { notes: "Earlier notes" });
      two.restoreNetwork();
    } else {
      two.restoreNetwork();
      await holds(cafe, id, { notes: "Later notes" });
      one.restoreNetwork();
    }
    for (const tablet of [one, two, cafe]) await holds(tablet, id, { notes: "Later notes" });
    const lost = await theLostEdit(`/beans/${id}`);
    return { labLocation, cafeLocation, labMachine, secondMachine, one, two, cafe, id, earlier, later, lost };
  }

  it("keeps a value that an edit made without seeing it replaced in the item's history, with who made it, when and the edit it lost to, for Staff and Viewers to read as Admins do, and nothing to list, use or dismiss", async () => {
    const { id, lost, labMachine, secondMachine, earlier, later, one, two, cafe } = await notesEdited("Replaced", 20010, "earlier");
    expect(lost).toMatchObject({
      field: "notes",
      value: "Earlier notes",
      location: null,
      source: { machine: { id: labMachine.machine.id, name: "Replaced lab 1" }, account: null },
      lostTo: { value: "Later notes", source: { machine: { id: secondMachine.machine.id, name: "Replaced lab 2" }, account: null } },
    });
    expect(Date.parse(lost.editedAt)).toBe(localTime(earlier.updatedAt));
    expect(Date.parse(lost.lostTo!.editedAt)).toBe(localTime(later.updatedAt));
    // The edit it lost to is one of the item's versions, the latest; the value that lost is the one before it, kept as it applied.
    const { versions, lostEdits } = await historyOf(`/beans/${id}`);
    expect(lostEdits).toEqual([lost]);
    expect(versions[0]).toMatchObject({ id: lost.lostTo!.versionId, fields: { notes: "Later notes" } });
    expect(versions[1]).toMatchObject({ fields: { notes: "Earlier notes" } });
    // A history of one field has the Lost Edits of that field only.
    expect((await api.get<HistoryView>(`/beans/${id}/history?field=notes`)).lostEdits).toEqual([lost]);
    expect((await api.get<HistoryView>(`/beans/${id}/history?field=country`)).lostEdits).toEqual([]);
    expect((await api.call("GET", "/beans/00000000-0000-4000-8000-000000000000/history")).status).toBe(404);

    // Staff anywhere and a Viewer read it as an Admin does.
    const staff = await api.staffAt("reading-lost@example.com", await api.createLocation("Replaced elsewhere", "America/Chicago"));
    expect((await historyOf(`/beans/${id}`, staff)).lostEdits).toEqual([lost]);
    const { link } = await api.invite("viewing-lost@example.com", "viewer");
    const viewer = AdminApi.signedInAs(server.url, await acceptInvite(server.url, link, { name: "Viewer", password: "viewer password 1" }));
    expect((await historyOf(`/beans/${id}`, viewer)).lostEdits).toEqual([lost]);

    // Nothing lists, uses or dismisses it: what a page of the release before this one still asks for is empty or refused (#642).
    expect(await api.get("/conflicts")).toEqual({ conflicts: [] });
    expect(await api.get(`/beans/${id}/conflicts`)).toEqual({ conflicts: [] });
    for (const action of ["use", "dismiss"]) expect((await api.call("POST", `/conflicts/${lost.id}/${action}`, { seen: lost.lostTo!.versionId })).status).toBe(410);
    expect(await beanContent(id)).toMatchObject({ notes: "Later notes" });
    expect(await lostEditsOf(`/beans/${id}`)).toEqual([lost]);
    for (const tablet of [one, two, cafe]) expect(heldBean(tablet, id)).toMatchObject({ notes: "Later notes" });

    // Editing the item brings a value back, as any edit: the Lost Edit stays as it was.
    await api.call("PATCH", `/beans/${id}`, { content: { notes: "Earlier notes" } });
    for (const tablet of [one, two, cafe]) await holds(tablet, id, { notes: "Earlier notes" });
    expect(await lostEditsOf(`/beans/${id}`)).toEqual([lost]);
  });

  it("keeps an edit that loses on time, arriving after a later one it had not seen, the same way", async () => {
    const { id, lost, labMachine, secondMachine, earlier, later } = await notesEdited("On time", 20020, "later");
    expect(lost).toMatchObject({
      field: "notes",
      value: "Earlier notes",
      location: null,
      source: { machine: { id: labMachine.machine.id } },
      lostTo: { value: "Later notes", source: { machine: { id: secondMachine.machine.id } } },
    });
    expect(Date.parse(lost.editedAt)).toBe(localTime(earlier.updatedAt));
    expect(Date.parse(lost.lostTo!.editedAt)).toBe(localTime(later.updatedAt));
    // It never applied, so it is no version of the item.
    const { versions } = await historyOf(`/beans/${id}`);
    expect(versions[0]).toMatchObject({ id: lost.lostTo!.versionId, fields: { notes: "Later notes" } });
    expect(versions.some((version) => version.fields.notes === "Earlier notes")).toBe(false);
  });

  /** Two tablets at a lab, each on its own instance, both online. */
  async function lab(name: string, serials: number) {
    const location = await api.createLocation(`${name} lab`, "America/Chicago");
    const first = await api.createMachine(`${name} lab 1`, location.id);
    const second = await api.createMachine(`${name} lab 2`, location.id);
    const one = load(first, String(serials + 1));
    const two = load(second, String(serials + 2), other);
    await api.waitForOnline(first, second);
    return { location, first, second, one, two };
  }

  /** A batch both lab tablets hold, weighing 250 g, with how each holds it. */
  async function sharedBatch(one: SimulatedTablet, two: SimulatedTablet, name: string, roastDate: string) {
    const bean = await one.addBean({ roaster: "Roux", name });
    const added = await one.addBatch(bean.id, { roastDate, weight: 250 });
    const heldBatch = (tablet: SimulatedTablet) => tablet.batches().find((record) => record.roastDate === added.roastDate);
    await expect.poll(() => heldBatch(two)).toMatchObject({ weightRemaining: 250 });
    await expect.poll(() => globalIdOf(heldBatch(one) ?? {})).toBeTruthy();
    return { batchId: globalIdOf(heldBatch(one)!)!, heldBatch };
  }

  it.each([
    { first: "earlier", what: "a remaining weight replaced by one entered later without seeing it" },
    { first: "later", what: "a remaining weight that loses on time" },
  ] as const)("keeps $what at its Location, where Staff read it though the account names are not theirs to see", async ({ first: taken }) => {
    const serials = taken === "earlier" ? 20030 : 20035;
    const { location, first, second, one, two } = await lab(`Weight ${taken}`, serials);
    const { batchId, heldBatch } = await sharedBatch(one, two, `Weight ${taken} Guji`, "2026-10-01");

    // Both groups weigh what is left while offline, the first group earlier.
    one.loseNetwork();
    two.loseNetwork();
    await one.editBatch(heldBatch(one)!.id, { weightRemaining: 200 });
    await delay(20);
    await two.editBatch(heldBatch(two)!.id, { weightRemaining: 150 });
    const [before, after] = taken === "earlier" ? [one, two] : [two, one];
    before.restoreNetwork();
    await expect.poll(() => weightAt(batchId)).toBe(taken === "earlier" ? 200 : 150);
    after.restoreNetwork();
    await expect.poll(() => heldBatch(one)?.weightRemaining).toBe(150);
    const lost = await theLostEdit(`/bean-batches/${batchId}`);
    expect(lost).toMatchObject({
      field: "remainingWeight",
      value: 200,
      location: { id: location.id },
      source: { machine: { id: first.machine.id } },
      lostTo: { value: 150, source: { machine: { id: second.machine.id } } },
    });
    expect(await weightAt(batchId)).toBe(150);

    // A group that had the figure weighs again: its entry replaces one it had, so nothing more is lost.
    await two.editBatch(heldBatch(two)!.id, { weightRemaining: 120 });
    await expect.poll(() => weightAt(batchId)).toBe(120);
    expect(await lostEditsOf(`/bean-batches/${batchId}`)).toEqual([lost]);
    // Staff elsewhere read it too.
    const staff = await api.staffAt(`weight-${taken}@example.com`, await api.createLocation(`Weight ${taken} cafe`, "America/Chicago"));
    expect((await historyOf(`/bean-batches/${batchId}`, staff)).lostEdits).toEqual([lost]);
  });

  it("keeps a value of a Grinder's content that an edit made without seeing it replaced", async () => {
    const { first, second, one, two } = await lab("Grinder", 20040);
    await one.addGrinder({ model: "Lost EK43", burrs: "98mm" });
    const heldGrinder = (tablet: SimulatedTablet) => tablet.grinders().find((record) => record.model === "Lost EK43");
    await expect.poll(() => globalIdOf(heldGrinder(two) ?? {})).toBeTruthy();
    await expect.poll(() => globalIdOf(heldGrinder(one) ?? {})).toBeTruthy();
    const grinderId = globalIdOf(heldGrinder(one)!)!;

    one.loseNetwork();
    two.loseNetwork();
    await one.editGrinder(heldGrinder(one)!.id, { burrs: "98mm Turkish" });
    await delay(20);
    await two.editGrinder(heldGrinder(two)!.id, { burrs: "98mm Coffee" });
    one.restoreNetwork();
    await expect.poll(async () => (await api.get<{ grinder: { content: Record_ } }>(`/grinders/${grinderId}`)).grinder.content.burrs).toBe(
      "98mm Turkish",
    );
    two.restoreNetwork();
    expect(await theLostEdit(`/grinders/${grinderId}`)).toMatchObject({
      field: "burrs",
      value: "98mm Turkish",
      location: null,
      source: { machine: { id: first.machine.id } },
      lostTo: { value: "98mm Coffee", source: { machine: { id: second.machine.id } } },
    });
    for (const tablet of [one, two]) await expect.poll(() => heldGrinder(tablet)?.burrs).toBe("98mm Coffee");
  });

  it("keeps an edit of whether a Profile is shown at a Location that loses on time, and none for a decision its tablet's record held", async () => {
    const { location, first, second, one, two } = await lab("Visibility", 20050);
    const saved = await one.addProfile(derivedProfile("Lost Bloom", 8.5));
    const id = String(saved.id);
    const path = `/profiles/${encodeURIComponent(id)}`;
    const visibility = (tablet: SimulatedTablet) => tablet.profiles().find((record) => record.id === id)?.visibility;
    const shownAt = async () => (await api.get<{ profile: { shownAt: unknown[] } }>(path)).profile.shownAt.length;
    await expect.poll(() => visibility(two)).toBe("visible");

    // The first group hides it offline; the second hides it and shows it again, later, which the first had not seen.
    one.loseNetwork();
    await one.setProfileVisibility(id, "hidden");
    await delay(20);
    await two.setProfileVisibility(id, "hidden");
    await expect.poll(shownAt).toBe(0);
    await two.setProfileVisibility(id, "visible");
    await expect.poll(shownAt).toBe(1);
    one.restoreNetwork();
    const lost = await theLostEdit(path);
    expect(lost).toMatchObject({
      field: "shown",
      value: false,
      location: { id: location.id },
      source: { machine: { id: first.machine.id } },
      lostTo: { value: true, source: { machine: { id: second.machine.id } } },
    });
    for (const tablet of [one, two]) await expect.poll(() => visibility(tablet)).toBe("visible");

    // The second group hides it, then the first, later, offline, and so without having seen that: its record held it
    // shown, as the Location had it, so nothing is lost, and its hiding it again changes nothing.
    one.loseNetwork();
    await two.setProfileVisibility(id, "hidden");
    await expect.poll(shownAt).toBe(0);
    await two.setProfileVisibility(id, "visible");
    await expect.poll(shownAt).toBe(1);
    await delay(20);
    await one.setProfileVisibility(id, "hidden");
    one.restoreNetwork();
    await expect.poll(shownAt).toBe(0);
    await expect.poll(() => visibility(two)).toBe("hidden");
    // The second group's showing it was replaced by the first, whose record held it shown: no Lost Edit.
    expect(await lostEditsOf(path)).toEqual([lost]);
  });

  it("keeps an edit of whether a batch is at a Location that loses on time, and none for a decision its tablet's record held", async () => {
    const { location, first, second, one, two } = await lab("Presence", 20060);
    const { batchId, heldBatch } = await sharedBatch(one, two, "Presence Guji", "2026-10-02");
    const atLab = async () => (await api.get<{ batch: { locations: unknown[] } }>(`/bean-batches/${batchId}`)).batch.locations.length;

    // The first group finishes it offline; the second finishes it and adds it back, later.
    one.loseNetwork();
    await one.editBatch(heldBatch(one)!.id, { archived: true });
    await delay(20);
    await two.editBatch(heldBatch(two)!.id, { archived: true });
    await expect.poll(atLab).toBe(0);
    await two.editBatch(heldBatch(two)!.id, { archived: false });
    await expect.poll(atLab).toBe(1);
    one.restoreNetwork();
    expect(await theLostEdit(`/bean-batches/${batchId}`)).toMatchObject({
      field: "atLocation",
      value: false,
      location: { id: location.id },
      source: { machine: { id: first.machine.id } },
      lostTo: { value: true, source: { machine: { id: second.machine.id } } },
    });
    for (const tablet of [one, two]) await expect.poll(() => heldBatch(tablet)?.archived).toBe(false);
    expect(await atLab()).toBe(1);
    const [lost] = await lostEditsOf(`/bean-batches/${batchId}`);

    // The second group finishes it and adds it back, then the first, later, offline, and so without having seen that,
    // finishes it: its record held it at the Location, as the Location had it, so nothing is lost.
    one.loseNetwork();
    await two.editBatch(heldBatch(two)!.id, { archived: true });
    await expect.poll(atLab).toBe(0);
    await two.editBatch(heldBatch(two)!.id, { archived: false });
    await expect.poll(atLab).toBe(1);
    await delay(20);
    await one.editBatch(heldBatch(one)!.id, { archived: true });
    one.restoreNetwork();
    await expect.poll(atLab).toBe(0);
    await expect.poll(() => heldBatch(two)?.archived).toBe(true);
    expect(await lostEditsOf(`/bean-batches/${batchId}`)).toEqual([lost]);
  });

  it("keeps an edit of whether a Grinder is Archived that loses on time", async () => {
    const { first, second, one, two } = await lab("Archived", 20070);
    await one.addGrinder({ model: "Archived EK43" });
    const heldGrinder = (tablet: SimulatedTablet) => tablet.grinders().find((record) => record.model === "Archived EK43");
    await expect.poll(() => globalIdOf(heldGrinder(two) ?? {})).toBeTruthy();
    await expect.poll(() => globalIdOf(heldGrinder(one) ?? {})).toBeTruthy();
    const grinderId = globalIdOf(heldGrinder(one)!)!;
    const archived = async () => (await api.get<{ grinder: { archived: boolean } }>(`/grinders/${grinderId}`)).grinder.archived;

    // The first group archives it offline; the second archives it and restores it, later.
    one.loseNetwork();
    await one.editGrinder(heldGrinder(one)!.id, { archived: true });
    await delay(20);
    await two.editGrinder(heldGrinder(two)!.id, { archived: true });
    await expect.poll(archived).toBe(true);
    await two.editGrinder(heldGrinder(two)!.id, { archived: false });
    await expect.poll(archived).toBe(false);
    one.restoreNetwork();
    expect(await theLostEdit(`/grinders/${grinderId}`)).toMatchObject({
      field: "archived",
      value: true,
      location: null,
      source: { machine: { id: first.machine.id } },
      lostTo: { value: false, source: { machine: { id: second.machine.id } } },
    });
    expect(await archived()).toBe(false);
    for (const tablet of [one, two]) await expect.poll(() => heldGrinder(tablet)?.archived).toBe(false);
  });

  it("keeps no Lost Edit for a value the editing tablet's last known record held, though the server cannot show it saw the edit that set it", async () => {
    const { one, two } = await lab("Held", 20080);
    await one.addBean({ roaster: "Roux", name: "Held Guji", notes: "Peach" });
    const id = await libraryBean("Held Guji");
    await holds(two, id, { notes: "Peach" });
    // The first group's record carries the Bean's global id, by a write of its own, before it is edited there.
    await holds(one, id, { notes: "Peach" });

    // Both groups set the same notes, the first offline and earlier, with a region. Its edit, taken in second, loses
    // the notes on time, to the same value, so nothing is lost and nothing is written to it: its record holds the
    // second group's notes, which nothing shows it saw. Its region shows its record was taken in.
    one.loseNetwork();
    await one.editBean(heldBean(one, id)!.id, { notes: "Apricot", region: "Guji" });
    await delay(20);
    await two.editBean(heldBean(two, id)!.id, { notes: "Apricot" });
    await expect.poll(async () => (await beanContent(id)).notes).toBe("Apricot");
    one.restoreNetwork();
    await expect.poll(async () => (await beanContent(id)).region).toBe("Guji");
    expect(await lostEditsOf(`/beans/${id}`)).toEqual([]);
    // The first group's next edit is made later, so it wins over the second group's unseen, and replaces a value its
    // own record held, which is kept as no Lost Edit.
    await one.editBean(heldBean(one, id)!.id, { notes: "Jasmine" });
    await holds(two, id, { notes: "Jasmine" });
    expect(await lostEditsOf(`/beans/${id}`)).toEqual([]);
  });

  it("lets an earlier offline edit lose to a later one it did not see though its tablet's record held the value now, and keeps it as a Lost Edit", async () => {
    const { first, second, one, two } = await lab("Reverted", 20090);
    await one.addBean({ roaster: "Roux", name: "Reverted Guji", notes: "Peach" });
    const id = await libraryBean("Reverted Guji");
    await holds(two, id, { notes: "Peach" });
    // The first group's record carries the Bean's global id, by a write of its own, before it is edited there.
    await holds(one, id, { notes: "Peach" });

    // The first group changes the notes offline. Later, the second changes them and sets them back, to what the first
    // group's record held before its edit.
    one.loseNetwork();
    await one.editBean(heldBean(one, id)!.id, { notes: "Jasmine" });
    await delay(20);
    await two.editBean(heldBean(two, id)!.id, { notes: "Plum" });
    await expect.poll(async () => (await beanContent(id)).notes).toBe("Plum");
    await two.editBean(heldBean(two, id)!.id, { notes: "Peach" });
    await expect.poll(async () => (await beanContent(id)).notes).toBe("Peach");
    one.restoreNetwork();
    // Holding a value is not having seen the edit that set it: the earlier edit loses, and is kept.
    expect(await theLostEdit(`/beans/${id}`)).toMatchObject({
      field: "notes",
      value: "Jasmine",
      source: { machine: { id: first.machine.id } },
      lostTo: { value: "Peach", source: { machine: { id: second.machine.id } } },
    });
    expect(await beanContent(id)).toMatchObject({ notes: "Peach" });
    await holds(one, id, { notes: "Peach" });
  });

  it("shows what the release before this one kept as a Conflict as a Lost Edit, with nothing it lost to, but one that release dismissed, and nothing for one naming another item's version", async () => {
    const { first, one } = await lab("Previous", 20100);
    await one.addBean({ roaster: "Roux", name: "Previous Guji", notes: "Peach" });
    const id = await libraryBean("Previous Guji");
    await one.addBean({ roaster: "Roux", name: "Other Guji", notes: "Plum" });
    const other = await libraryBean("Other Guji");
    const database = await server.connectDatabase();
    try {
      // As that release writes them: with no edit it lost to, open, and then used or dismissed there.
      for (const [value, state] of [["Open notes", "OPEN"], ["Used notes", "USED"], ["Dismissed notes", "DISMISSED"]] as const) {
        await database.query(
          `INSERT INTO conflicts (id, kind, item_id, field, value, machine_id, edited_at, state)
           VALUES (gen_random_uuid(), 'bean', $1, 'notes', to_jsonb($2::text), $3, now(), $4::conflict_state)`,
          [id, value, first.machine.id, state],
        );
      }
      // One naming a version of another item, which the column's lack of a foreign key allows: it lost to nothing of this one's.
      const {
        rows: [elsewhere],
      } = await database.query<{ id: string }>(`SELECT id FROM item_versions WHERE kind = 'bean' AND item_id = $1 LIMIT 1`, [other]);
      await database.query(
        `INSERT INTO conflicts (id, kind, item_id, field, value, machine_id, edited_at, state, lost_to_version_id)
         VALUES (gen_random_uuid(), 'bean', $1, 'notes', to_jsonb('Elsewhere notes'::text), $2, now(), 'OPEN', $3)`,
        [id, first.machine.id, elsewhere!.id],
      );
    } finally {
      await database.end();
    }
    const lost = await lostEditsOf(`/beans/${id}`);
    expect(lost.map((edit) => edit.value).sort()).toEqual(["Elsewhere notes", "Open notes", "Used notes"]);
    for (const edit of lost) expect(edit).toMatchObject({ field: "notes", lostTo: null, source: { machine: { id: first.machine.id } } });
  });

  /** The batch's remaining weight at its one Location, through the REST API. */
  async function weightAt(batchId: string): Promise<number | null | undefined> {
    return (await api.get<{ batch: { locations: { remainingWeight: number | null }[] } }>(`/bean-batches/${batchId}`)).batch.locations[0]?.remainingWeight;
  }
});
