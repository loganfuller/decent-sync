import { globalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite } from "./support/admin-api.js";
import { shotFixture } from "./support/shot-fixtures.js";
import { SimulatedTablet, derivedDe1Pro, settingsFor } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 and the REST API for ticket #87: Beans, Bean Batches and Grinders
// created and edited in the management interface, Archived and restored,
// added and finished at Locations, and hard-deleted by an Admin, reach the
// tablets that should hold them, through the built plugin in simulated
// tablets, on two server instances sharing PostgreSQL. Serials are made up,
// from 21001.

type Record_ = Record<string, unknown>;

interface BeanView {
  id: string;
  roaster: string | null;
  name: string | null;
  archived: boolean;
  offeredAt: LocationView[];
  content: Record_;
}

interface BatchView {
  id: string;
  archived: boolean;
  locations: { location: LocationView; remainingWeight: number | null }[];
  finished: { location: LocationView }[];
  content: Record_;
}

interface GrinderView {
  id: string;
  archived: boolean;
  location: LocationView | null;
  content: Record_;
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

describe("Editing the Library in the management interface", { timeout: 60_000 }, () => {
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

  /** A Location with a Machine, each tablet on one of the two instances in turn, every one online. */
  async function locationWith(name: string, serials: number[]): Promise<{ location: LocationView; tablets: SimulatedTablet[] }> {
    const location = await api.createLocation(name, "America/Chicago");
    const loaded: SimulatedTablet[] = [];
    for (const [index, serial] of serials.entries()) {
      const machine = await api.createMachine(`${name} ${index + 1}`, location.id);
      loaded.push(load(machine, String(serial), index % 2 === 0 ? server : other));
      await api.waitForMachine(machine.machine.name, (viewed) => viewed.online);
    }
    return { location, tablets: loaded };
  }

  async function send<T>(method: string, path: string, body?: unknown, as: AdminApi = api, status = 200): Promise<T> {
    const response = await as.call(method, path, body);
    expect(response.status, await response.clone().text()).toBe(status);
    return (status === 204 ? undefined : await response.json()) as T;
  }
  const createBean = async (content: Record_, as: AdminApi = api) => (await send<{ bean: BeanView }>("POST", "/beans", { content }, as, 201)).bean;
  const createBatch = async (beanId: string, locations: { locationId: string; remainingWeight?: number }[], content: Record_ = {}) =>
    (await send<{ batch: BatchView }>("POST", "/bean-batches", { beanId, content, locations }, api, 201)).batch;
  const place = (batchId: string, location: LocationView, body: Record_, as: AdminApi = api) => as.call("PUT", `/bean-batches/${batchId}/locations/${location.id}`, body);

  const held = (records: Record_[], id: string) => records.find((record) => globalIdOf(record) === id);
  const heldBean = (tablet: SimulatedTablet, id: string) => held(tablet.beans(), id);
  const heldBatch = (tablet: SimulatedTablet, id: string) => held(tablet.batches(), id);
  const heldGrinder = (tablet: SimulatedTablet, id: string) => held(tablet.grinders(), id);
  const poll = <T>(read: () => T) => expect.poll(read, { timeout: 10_000 });

  /** Staff at the Locations, signed in. */
  async function staffAt(email: string, ...locations: LocationView[]): Promise<AdminApi> {
    const { link } = await api.invite(email, "staff", locations.map((location) => location.id));
    return AdminApi.signedInAs(server.url, await acceptInvite(server.url, link, { name: "Staff", password: "staff password 1" }));
  }

  it("writes a batch created at a Location, with its Bean, to that Location's tablets and no others", async () => {
    const uptown = await locationWith("Uptown", [21001, 21002]);
    const downtown = await locationWith("Downtown", [21003]);
    const bean = await createBean({ roaster: "Roux", name: "Uptown Guji", country: "Ethiopia", altitude: [1900, 2100] });
    expect(bean).toMatchObject({ offeredAt: [], content: { roaster: "Roux", name: "Uptown Guji", decaf: false, altitude: [1900, 2100] } });
    const batch = await createBatch(bean.id, [{ locationId: uptown.location.id, remainingWeight: 900 }], { roastDate: "2026-10-01", weight: 1000 });
    expect(batch).toMatchObject({ content: { roastDate: "2026-10-01T00:00:00.000", weight: 1000 }, locations: [{ location: { id: uptown.location.id }, remainingWeight: 900 }] });

    for (const tablet of uptown.tablets) {
      await poll(() => heldBean(tablet, bean.id)).toMatchObject({ roaster: "Roux", name: "Uptown Guji", country: "Ethiopia", archived: false });
      await poll(() => heldBatch(tablet, batch.id)).toMatchObject({ roastDate: "2026-10-01T00:00:00.000", weight: 1000, weightRemaining: 900, archived: false });
      expect(heldBatch(tablet, batch.id)!.beanId).toBe(heldBean(tablet, bean.id)!.id);
    }
    // Nothing is written to them again: what the tablets hold is the Library's.
    const written = uptown.tablets[0]!.writes.length;
    await send("PUT", `/bean-batches/${batch.id}/locations/${uptown.location.id}`, { remainingWeight: 750 });
    for (const tablet of uptown.tablets) await poll(() => heldBatch(tablet, batch.id)?.weightRemaining).toBe(750);
    expect(uptown.tablets[0]!.writes.length).toBe(written + 1);
    expect(downtown.tablets[0]!.beans()).toEqual([]);
    expect(downtown.tablets[0]!.batches()).toEqual([]);
    expect((await send<{ bean: BeanView }>("GET", `/beans/${bean.id}`)).bean.offeredAt.map((location) => location.name)).toEqual(["Uptown"]);
  });

  it("writes a lab batch added at a cafe, with its Bean, to the cafe's tablets, and archives it on them once finished there", async () => {
    const lab = await locationWith("Lab", [21011]);
    const belmont = await locationWith("Belmont", [21012, 21013]);
    const labBean = await lab.tablets[0]!.addBean({ roaster: "Roux", name: "Lab Sidamo" });
    const labBatch = await lab.tablets[0]!.addBatch(labBean.id, { roastDate: "2026-10-02", weight: 500 });
    // The lab's tablet is written the global ids its bean and batch joined the Library with.
    await poll(() => globalIdOf(lab.tablets[0]!.batches().find((record) => record.id === labBatch.id))).toBeTruthy();
    await poll(() => globalIdOf(lab.tablets[0]!.beans().find((record) => record.id === labBean.id))).toBeTruthy();
    const batch = { id: globalIdOf(lab.tablets[0]!.batches().find((record) => record.id === labBatch.id))! };
    const beanId = globalIdOf(lab.tablets[0]!.beans().find((record) => record.id === labBean.id))!;

    const added = await place(batch!.id, belmont.location, { atLocation: true, remainingWeight: 450 });
    expect(added.status).toBe(200);
    for (const tablet of belmont.tablets) {
      await poll(() => heldBean(tablet, beanId)).toMatchObject({ name: "Lab Sidamo", archived: false });
      await poll(() => heldBatch(tablet, batch!.id)).toMatchObject({ weightRemaining: 450, archived: false });
    }

    expect((await place(batch!.id, belmont.location, { atLocation: false })).status).toBe(200);
    for (const tablet of belmont.tablets) {
      await poll(() => heldBatch(tablet, batch!.id)?.archived).toBe(true);
      // With no batch there now, its Bean is no longer offered there.
      await poll(() => heldBean(tablet, beanId)?.archived).toBe(true);
    }
    // The lab still has it.
    expect(heldBatch(lab.tablets[0]!, batch!.id)).toMatchObject({ archived: false });
    const finished = (await send<{ batch: BatchView }>("GET", `/bean-batches/${batch!.id}`)).batch;
    expect(finished.locations.map((here) => here.location.name)).toEqual(["Lab"]);
    expect(finished.finished.map((here) => here.location.name)).toEqual(["Belmont"]);
    // A remaining weight is set only where the batch is.
    expect((await place(batch!.id, belmont.location, { remainingWeight: 10 })).status).toBe(409);
  });

  it("writes a Bean edited here to every tablet that holds it, at every Location", async () => {
    const north = await locationWith("North", [21021]);
    const south = await locationWith("South", [21022]);
    const bean = await createBean({ roaster: "Roux", name: "Edited Kenya", notes: "Blackcurrant" });
    await createBatch(bean.id, [{ locationId: north.location.id }, { locationId: south.location.id }]);
    for (const tablet of [...north.tablets, ...south.tablets]) await poll(() => heldBean(tablet, bean.id)?.notes).toBe("Blackcurrant");

    const edited = await send<{ bean: BeanView }>("PATCH", `/beans/${bean.id}`, { content: { notes: "Blackcurrant, cola", region: "Nyeri", processing: null } });
    expect(edited.bean.content).toMatchObject({ notes: "Blackcurrant, cola", region: "Nyeri" });
    for (const tablet of [...north.tablets, ...south.tablets]) {
      await poll(() => heldBean(tablet, bean.id)).toMatchObject({ notes: "Blackcurrant, cola", region: "Nyeri" });
    }
    const versions = (await send<{ versions: { fields: Record_; source: { account: { id: string } | null } }[] }>("GET", `/beans/${bean.id}/history`)).versions;
    expect(versions[0]).toMatchObject({ fields: { notes: "Blackcurrant, cola", region: "Nyeri" }, source: { account: { id: expect.any(String) } } });

    // A barista's edit made offline before it, which arrives after, loses to it, and is kept as a Conflict.
    const tablet = north.tablets[0]!;
    tablet.loseNetwork();
    await tablet.editBean(heldBean(tablet, bean.id)!.id, { notes: "Offline notes" });
    await send("PATCH", `/beans/${bean.id}`, { content: { notes: "Management notes" } });
    tablet.restoreNetwork();
    await poll(() => heldBean(tablet, bean.id)?.notes).toBe("Management notes");
    await poll(async () => (await send<{ conflicts: { field: string; value: unknown }[] }>("GET", `/beans/${bean.id}/conflicts`)).conflicts).toEqual([
      expect.objectContaining({ field: "notes", value: "Offline notes" }),
    ]);
  });

  it("refuses to create a Bean whose roaster and name the Library has, naming that Bean", async () => {
    const bean = await createBean({ roaster: "Sandbox", name: "Heirloom" });
    const response = await api.call("POST", "/beans", { content: { roaster: " sandbox", name: "HEIRLOOM " } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ existing: { id: bean.id, roaster: "Sandbox", name: "Heirloom" } });
    // Archived, it is still that Bean.
    await send("PUT", `/beans/${bean.id}/archived`, { archived: true });
    expect((await api.call("POST", "/beans", { content: { roaster: "Sandbox", name: "Heirloom" } })).status).toBe(409);
    expect((await api.call("POST", "/beans", { content: { roaster: "Sandbox" } })).status).toBe(400);
    expect((await api.call("POST", "/beans", { content: { roaster: "Sandbox", name: "Other", altitude: ["high"] } })).status).toBe(400);
  });

  it("archives an Archived Grinder on its Location's tablets, and restoring it un-archives it", async () => {
    const cafe = await locationWith("Grinder cafe", [21031, 21032]);
    const elsewhere = await locationWith("Grinder elsewhere", [21033]);
    const created = await send<{ grinder: GrinderView }>("POST", "/grinders", { locationId: cafe.location.id, content: { model: "EG-1", burrSize: 80 } }, api, 201);
    const id = created.grinder.id;
    expect(created.grinder).toMatchObject({ archived: false, location: { id: cafe.location.id }, content: { model: "EG-1", burrSize: 80, settingType: "numeric" } });
    for (const tablet of cafe.tablets) await poll(() => heldGrinder(tablet, id)).toMatchObject({ model: "EG-1", archived: false });

    expect((await send<{ grinder: GrinderView }>("PUT", `/grinders/${id}/archived`, { archived: true })).grinder.archived).toBe(true);
    for (const tablet of cafe.tablets) await poll(() => heldGrinder(tablet, id)?.archived).toBe(true);
    expect((await send<{ grinder: GrinderView }>("PUT", `/grinders/${id}/archived`, { archived: false })).grinder.archived).toBe(false);
    for (const tablet of cafe.tablets) await poll(() => heldGrinder(tablet, id)?.archived).toBe(false);
    await send("PATCH", `/grinders/${id}`, { content: { notes: "Dialled for espresso" } });
    for (const tablet of cafe.tablets) await poll(() => heldGrinder(tablet, id)?.notes).toBe("Dialled for espresso");
    expect(elsewhere.tablets[0]!.grinders()).toEqual([]);
  });

  it("archives an Archived Bean and its batches on every tablet, and restoring it brings them back where they were", async () => {
    const cafe = await locationWith("Archive cafe", [21041]);
    const bean = await createBean({ roaster: "Roux", name: "Archived Huila" });
    const batch = await createBatch(bean.id, [{ locationId: cafe.location.id }]);
    const tablet = cafe.tablets[0]!;
    await poll(() => heldBatch(tablet, batch.id)?.archived).toBe(false);

    await send("PUT", `/beans/${bean.id}/archived`, { archived: true });
    await poll(() => heldBatch(tablet, batch.id)?.archived).toBe(true);
    await poll(() => heldBean(tablet, bean.id)?.archived).toBe(true);
    await send("PUT", `/beans/${bean.id}/archived`, { archived: false });
    await poll(() => heldBean(tablet, bean.id)?.archived).toBe(false);
    await poll(() => heldBatch(tablet, batch.id)?.archived).toBe(false);

    await send("PUT", `/bean-batches/${batch.id}/archived`, { archived: true });
    await poll(() => heldBatch(tablet, batch.id)?.archived).toBe(true);
    await send("PUT", `/bean-batches/${batch.id}/archived`, { archived: false });
    await poll(() => heldBatch(tablet, batch.id)?.archived).toBe(false);
    // A batch of an Archived Bean is not added.
    await send("PUT", `/beans/${bean.id}/archived`, { archived: true });
    expect((await api.call("POST", "/bean-batches", { beanId: bean.id, locations: [] })).status).toBe(409);
  });

  it("refuses to hard-delete an item a Shot names", async () => {
    const cafe = await locationWith("Shot cafe", [21051]);
    const tablet = cafe.tablets[0]!;
    const bean = await createBean({ roaster: "Roux", name: "Pulled Guji" });
    const batch = await createBatch(bean.id, [{ locationId: cafe.location.id }]);
    const grinder = (await send<{ grinder: GrinderView }>("POST", "/grinders", { locationId: cafe.location.id, content: { model: "Pulled grinder" } }, api, 201)).grinder;
    await poll(() => heldBatch(tablet, batch.id)).toBeTruthy();
    await poll(() => heldGrinder(tablet, grinder.id)).toBeTruthy();

    // A Shot names them by their ids on the tablet that pulled it.
    const fixture = shotFixture();
    const workflow = fixture.workflow as Record_;
    const shot = {
      ...fixture,
      id: "shot-naming-library-items",
      workflow: {
        ...workflow,
        machine: { ...(workflow.machine as Record_), serialNumber: "21051" },
        context: { ...(workflow.context as Record_), beanBatchId: heldBatch(tablet, batch.id)!.id, grinderId: heldGrinder(tablet, grinder.id)!.id },
      },
    };
    tablet.pullShot(shot);
    await poll(async () => (await api.call("GET", `/shots/${shot.id}`)).status).toBe(200);

    for (const path of [`/bean-batches/${batch.id}`, `/beans/${bean.id}`, `/grinders/${grinder.id}`]) {
      const response = await api.call("DELETE", path);
      expect(response.status).toBe(409);
      expect(((await response.json()) as { message: string }).message).toMatch(/A Shot names/);
    }
    expect(heldBatch(tablet, batch.id)).toBeTruthy();
    expect((await api.call("GET", `/beans/${bean.id}`)).status).toBe(200);
  });

  it("hard-deletes an item no Shot names from the tablets that held it, an offline one once it reconnects, and never takes it in again", async () => {
    const cafe = await locationWith("Delete cafe", [21061, 21062]);
    const [online, offline] = cafe.tablets as [SimulatedTablet, SimulatedTablet];
    const bean = await createBean({ roaster: "Roux", name: "Mistaken Bean" });
    const batch = await createBatch(bean.id, [{ locationId: cafe.location.id }]);
    const grinder = (await send<{ grinder: GrinderView }>("POST", "/grinders", { locationId: cafe.location.id, content: { model: "Mistaken grinder" } }, api, 201)).grinder;
    for (const tablet of cafe.tablets) {
      await poll(() => heldBatch(tablet, batch.id)).toBeTruthy();
      await poll(() => heldGrinder(tablet, grinder.id)).toBeTruthy();
    }
    // A batch a barista made of the Bean on the offline tablet, unknown to the Library, goes with it there.
    offline.loseNetwork();
    await offline.addBatch(heldBean(offline, bean.id)!.id, { notes: "Made offline" });

    const local = { bean: heldBean(online, bean.id)!.id, batch: heldBatch(online, batch.id)!.id, grinder: heldGrinder(online, grinder.id)!.id };
    await send("DELETE", `/beans/${bean.id}`, undefined, api, 204);
    await send("DELETE", `/grinders/${grinder.id}`, undefined, api, 204);
    await poll(() => online.beans()).toEqual([]);
    await poll(() => online.batches()).toEqual([]);
    await poll(() => online.grinders()).toEqual([]);
    expect(online.writes).toEqual(
      expect.arrayContaining([`DELETE /bean-batches/${local.batch}`, `DELETE /beans/${local.bean}`, `DELETE /grinders/${local.grinder}`]),
    );
    expect((await api.call("GET", `/beans/${bean.id}`)).status).toBe(404);
    expect((await api.call("GET", `/bean-batches/${batch.id}`)).status).toBe(404);
    expect((await api.call("GET", `/grinders/${grinder.id}`)).status).toBe(404);

    offline.restoreNetwork();
    await poll(() => offline.beans()).toEqual([]);
    await poll(() => offline.batches()).toEqual([]);
    await poll(() => offline.grinders()).toEqual([]);
    const library = async () => ({
      beans: (await send<{ beans: unknown[] }>("GET", "/beans")).beans.filter((listed) => (listed as BeanView).name === "Mistaken Bean"),
      grinders: (await send<{ grinders: { model: string | null }[] }>("GET", "/grinders")).grinders.filter((listed) => ["Mistaken grinder", "Restored grinder"].includes(listed.model ?? "")),
    });
    expect(await library()).toEqual({ beans: [], grinders: [] });

    // A record carrying a deleted item's global id, as from a Decaid backup restored, is deleted too.
    await online.callApi("POST", "/grinders", { model: "Restored grinder", extras: { decentSyncId: grinder.id } });
    await poll(() => online.grinders()).toEqual([]);
    expect(await library()).toEqual({ beans: [], grinders: [] });
  });

  it("deletes a record that lost its global id while its tablet was offline, but keeps those a Shot pulled offline names", async () => {
    const cafe = await locationWith("Offline cafe", [21071]);
    const tablet = cafe.tablets[0]!;
    const bean = await createBean({ roaster: "Roux", name: "Wiped Bean" });
    await createBatch(bean.id, [{ locationId: cafe.location.id }]);
    const pulled = await createBean({ roaster: "Roux", name: "Pulled offline" });
    const pulledBatch = await createBatch(pulled.id, [{ locationId: cafe.location.id }]);
    const grinder = (await send<{ grinder: GrinderView }>("POST", "/grinders", { locationId: cafe.location.id, content: { model: "Offline grinder" } }, api, 201)).grinder;
    await poll(() => heldBean(tablet, bean.id)).toBeTruthy();
    await poll(() => heldGrinder(tablet, grinder.id)).toBeTruthy();
    await poll(() => heldBatch(tablet, pulledBatch.id)).toBeTruthy();
    const local = {
      bean: heldBean(tablet, bean.id)!.id,
      pulled: heldBean(tablet, pulled.id)!.id,
      pulledBatch: heldBatch(tablet, pulledBatch.id)!.id,
      grinder: heldGrinder(tablet, grinder.id)!.id,
    };

    tablet.loseNetwork();
    // Another plugin wipes a Bean's global id, and a barista pulls a Shot with the Grinder and another Bean's batch.
    expect((await tablet.callApi("PUT", `/beans/${local.bean}`, { extras: {} })).status).toBe(200);
    const fixture = shotFixture();
    const workflow = fixture.workflow as Record_;
    const shot = {
      ...fixture,
      id: "shot-pulled-offline",
      workflow: { ...workflow, machine: { ...(workflow.machine as Record_), serialNumber: "21071" }, context: { ...(workflow.context as Record_), beanBatchId: local.pulledBatch, grinderId: local.grinder } },
    };
    tablet.pullShot(shot);
    await send("DELETE", `/beans/${bean.id}`, undefined, api, 204);
    await send("DELETE", `/beans/${pulled.id}`, undefined, api, 204);
    await send("DELETE", `/grinders/${grinder.id}`, undefined, api, 204);

    tablet.restoreNetwork();
    await poll(() => tablet.beans().find((record) => record.id === local.bean)).toBeUndefined();
    await poll(() => tablet.batches().map((record) => record.id)).toEqual([local.pulledBatch]);
    await poll(async () => (await api.call("GET", `/shots/${shot.id}`)).status).toBe(200);
    // Kept on the tablet, as its Shot names them, the batch with its Bean, but not taken into the Library again.
    expect(tablet.grinders().map((record) => record.id)).toEqual([local.grinder]);
    expect(tablet.beans().map((record) => record.id)).toEqual([local.pulled]);
    expect(tablet.batches().map((record) => record.id)).toEqual([local.pulledBatch]);
    for (const write of [`DELETE /grinders/${local.grinder}`, `DELETE /beans/${local.pulled}`, `DELETE /bean-batches/${local.pulledBatch}`]) {
      expect(tablet.writes).not.toContain(write);
    }
    expect((await send<{ beans: BeanView[] }>("GET", "/beans")).beans.filter((listed) => listed.name === "Pulled offline")).toEqual([]);
    const grinders = (await send<{ grinders: { model: string | null }[] }>("GET", "/grinders")).grinders;
    expect(grinders.filter((listed) => listed.model === "Offline grinder")).toEqual([]);
  });

  it("lets Staff edit Beans and batch details anywhere, but add batches and edit Grinders only at their own Locations, and never hard-delete", async () => {
    const theirs = await api.createLocation("Staff home", "America/Chicago");
    const elsewhere = await api.createLocation("Staff elsewhere", "America/Chicago");
    const staff = await staffAt("staff-87@example.com", theirs);
    const bean = await createBean({ roaster: "Roux", name: "Staff Bean" });
    const batch = await createBatch(bean.id, [{ locationId: elsewhere.id }]);
    const grinder = (await send<{ grinder: GrinderView }>("POST", "/grinders", { locationId: elsewhere.id, content: { model: "Elsewhere grinder" } }, api, 201)).grinder;

    expect((await send<{ bean: BeanView }>("PATCH", `/beans/${bean.id}`, { content: { notes: "Staff notes" } }, staff)).bean.content.notes).toBe("Staff notes");
    await send("PATCH", `/bean-batches/${batch.id}`, { content: { roastLevel: "light" } }, staff);
    await send("PUT", `/bean-batches/${batch.id}/archived`, { archived: true }, staff);
    await send("PUT", `/bean-batches/${batch.id}/archived`, { archived: false }, staff);
    await send("PUT", `/grinders/${grinder.id}/archived`, { archived: true }, staff);
    expect((await createBean({ roaster: "Roux", name: "Staff's own" }, staff)).name).toBe("Staff's own");
    await send("POST", "/bean-batches", { beanId: bean.id, locations: [{ locationId: theirs.id }] }, staff, 201);
    await send("PUT", `/bean-batches/${batch.id}/locations/${theirs.id}`, { atLocation: true, remainingWeight: 200 }, staff);

    expect((await staff.call("POST", "/bean-batches", { beanId: bean.id, locations: [{ locationId: elsewhere.id }] })).status).toBe(403);
    expect((await place(batch.id, elsewhere, { atLocation: false }, staff)).status).toBe(403);
    expect((await place(batch.id, elsewhere, { atLocation: true, remainingWeight: 5 }, staff)).status).toBe(403);
    expect((await staff.call("POST", "/grinders", { locationId: elsewhere.id, content: { model: "Not theirs" } })).status).toBe(403);
    expect((await staff.call("PATCH", `/grinders/${grinder.id}`, { content: { notes: "Not theirs" } })).status).toBe(403);
    for (const path of [`/beans/${bean.id}`, `/bean-batches/${batch.id}`, `/grinders/${grinder.id}`]) expect((await staff.call("DELETE", path)).status).toBe(403);
    expect((await api.call("GET", `/beans/${bean.id}`)).status).toBe(200);
  });
});
