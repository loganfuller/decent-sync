import { GLOBAL_ID_KEY, globalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { PluginStorage, SimulatedTablet, derivedDe1Pro, settingsFor } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #81: Bean Batches at Locations. A batch entered on a
// tablet joins the Library at that tablet's Location and is written, with its
// Bean, to the Location's other tablets; what a tablet does to a batch or
// Bean acts at its Location (ADR-0008, ADR-0019). Through the built plugin in
// simulated tablets, on two server instances sharing one database, with
// assertions through the REST API and what each simulated tablet's Decaid
// holds. Serials are made up, from 16001.

interface BatchAtLocation {
  location: LocationView;
  remainingWeight: number | null;
  since: string;
}

interface BeanBatchSummary {
  id: string;
  bean: { id: string; roaster: string | null; name: string | null };
  roastDate: string | null;
  archived: boolean;
  locations: BatchAtLocation[];
  createdAt: string;
  createdLocation: LocationView | null;
}

interface BeanBatchView extends BeanBatchSummary {
  content: Record<string, unknown>;
  finished: { location: LocationView; remainingWeight: number | null; finishedAt: string }[];
}

interface BeanSummary {
  id: string;
  name: string | null;
  archived: boolean;
  offeredAt: LocationView[];
}

type Record_ = Record<string, unknown>;

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

describe("Bean Batches at Locations", { timeout: 60_000 }, () => {
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
   * polling every 5 s (0.1 s here), its Decaid holding the beans and batches
   * given, none by default, as on a fresh install.
   */
  function load(
    machine: CreatedMachine,
    serial: string,
    options: {
      instance?: TestServer;
      storage?: PluginStorage;
      beans?: Record_[];
      batches?: Record_[];
      apiDelayMs?: (method: string, path: string) => number;
      answerOnArrival?: boolean;
      pollSeconds?: number;
    } = {},
  ): SimulatedTablet {
    const tablet = SimulatedTablet.load({
      settings: { ...settingsFor({ token: machine.token, serverUrl: (options.instance ?? server).url }), PollSeconds: options.pollSeconds ?? 5 },
      api: { ...derivedDe1Pro({ serial }), "/beans": options.beans ?? [], "/bean-batches": options.batches ?? [] },
      storage: options.storage,
      apiDelayMs: options.apiDelayMs,
      answerOnArrival: options.answerOnArrival,
      timeScale: 50,
    });
    tablets.push(tablet);
    return tablet;
  }

  async function online(...machines: CreatedMachine[]): Promise<void> {
    for (const { machine } of machines) await api.waitForMachine(machine.name, (viewed) => viewed.online);
  }

  const libraryBatches = async () => ((await (await api.call("GET", "/bean-batches")).json()) as { batches: BeanBatchSummary[] }).batches;
  const batchesOf = async (bean: string) => (await libraryBatches()).filter((batch) => batch.bean.name === bean);
  /** Resolves with the Library's one batch of the Bean of that name, once there is one. */
  async function libraryBatch(bean: string): Promise<BeanBatchSummary> {
    await expect.poll(async () => (await batchesOf(bean)).length, { timeout: 10_000 }).toBe(1);
    return (await batchesOf(bean))[0]!;
  }
  const viewBatch = async (id: string) => ((await (await api.call("GET", `/bean-batches/${id}`)).json()) as { batch: BeanBatchView }).batch;
  const libraryBean = async (name: string) =>
    ((await (await api.call("GET", "/beans")).json()) as { beans: BeanSummary[] }).beans.find((bean) => bean.name === name);
  /** Where the batch is, by Location name, with its remaining weight there. */
  const whereAt = async (id: string) => (await viewBatch(id)).locations.map((here) => [here.location.name, here.remainingWeight]);
  const offeredAt = async (name: string) => (await libraryBean(name))?.offeredAt.map((location) => location.name);

  /** The tablet's records of the Library item, each by whether it is archived. */
  const heldBean = (tablet: SimulatedTablet, id: string) => tablet.beans().filter((record) => globalIdOf(record) === id);
  const heldBatch = (tablet: SimulatedTablet, id: string) => tablet.batches().filter((record) => globalIdOf(record) === id);
  /** Resolves once the tablet holds the item once, carrying its global id, with the fields given. */
  async function holds(records: () => Record_[], fields: Record_): Promise<Record_> {
    await expect.poll(() => records().map((record) => ({ ...pick(record, Object.keys(fields)) })), { timeout: 10_000 }).toEqual([fields]);
    return records()[0]!;
  }

  /** A lab with two tablets and a cafe with one, the second lab tablet on the other instance. */
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

  /** A Bean entered on a tablet and a batch of it, as a barista enters them, once the Library has the batch. */
  async function enterBatch(tablet: SimulatedTablet, bean: string, fields: Record_ = {}): Promise<{ record: Record_; batch: BeanBatchSummary }> {
    const entered = await tablet.addBean({ roaster: "Roux", name: bean, country: "Ethiopia" });
    const record = await tablet.addBatch(entered.id, { roastDate: "2026-10-01", roastLevel: "light", weight: 250, notes: "Lab roast", ...fields });
    return { record, batch: await libraryBatch(bean) };
  }

  it("writes a batch created at the lab, with its Bean, to the lab's other tablet, through another instance, and to no cafe tablet", async () => {
    const { labLocation, one, two, cafe } = await lab("Created", 16001);
    const { record, batch } = await enterBatch(one, "Guji Hambela");
    expect(batch).toMatchObject({ roastDate: "2026-10-01T00:00:00.000", archived: false, createdLocation: labLocation });
    expect(batch.locations).toEqual([{ location: labLocation, remainingWeight: 250, since: expect.any(String) }]);
    expect(await offeredAt("Guji Hambela")).toEqual(["Created lab"]);

    // The lab's other tablet is written the Bean, then the batch under its own record of the Bean.
    const bean = await holds(() => heldBean(two, batch.bean.id), { roaster: "Roux", name: "Guji Hambela", archived: false });
    const written = await holds(() => heldBatch(two, batch.id), { roastLevel: "light", weight: 250, weightRemaining: 250, archived: false });
    expect(written).toMatchObject({ beanId: bean.id, roastDate: "2026-10-01T00:00:00.000", notes: "Lab roast", extras: { [GLOBAL_ID_KEY]: batch.id } });
    expect(written.id).not.toBe(record.id);
    const writes = two.writes.filter((write) => write.startsWith("POST "));
    expect(writes).toEqual(["POST /beans", `POST /beans/${String(bean.id)}/batches`]);
    // The tablet that created it is written only the global ids.
    await holds(() => heldBatch(one, batch.id), { id: record.id });
    expect(one.writes.every((write) => write.startsWith("PUT "))).toBe(true);
    // The cafe holds neither.
    expect(cafe.beans()).toEqual([]);
    expect(cafe.batches()).toEqual([]);
    expect((await viewBatch(batch.id)).content).toEqual({ roastDate: "2026-10-01T00:00:00.000", roastLevel: "light", weight: 250, frozen: false, notes: "Lab roast" });
  });

  it("finishes a batch archived on a lab tablet at the lab, archives it on the lab's other tablet, and adds it back once un-archived", async () => {
    const { one, two } = await lab("Archived", 16011);
    const { record, batch } = await enterBatch(one, "Archived Natural");
    await holds(() => heldBatch(two, batch.id), { archived: false });

    await one.editBatch(record.id, { archived: true });
    await expect.poll(() => whereAt(batch.id), { timeout: 10_000 }).toEqual([]);
    expect((await viewBatch(batch.id)).finished.map((here) => here.location.name)).toEqual(["Archived lab"]);
    // Archived on the other tablet, never deleted, so its Shots still find it; the Bean, with no batch there, too.
    await holds(() => heldBatch(two, batch.id), { archived: true });
    await holds(() => heldBean(two, batch.bean.id), { archived: true });
    expect(await offeredAt("Archived Natural")).toEqual([]);
    expect((await libraryBean("Archived Natural"))!.archived).toBe(false);

    await one.editBatch(record.id, { archived: false });
    await expect.poll(() => whereAt(batch.id), { timeout: 10_000 }).toEqual([["Archived lab", 250]]);
    await holds(() => heldBatch(two, batch.id), { archived: false });
    await holds(() => heldBean(two, batch.bean.id), { archived: false });
    expect(await offeredAt("Archived Natural")).toEqual(["Archived lab"]);
  });

  it("archives a batch deleted on one tablet on the Location's other tablet, not deleting it there", async () => {
    const { one, two } = await lab("Deleted", 16021);
    const { record, batch } = await enterBatch(one, "Deleted Washed");
    await holds(() => heldBatch(two, batch.id), { archived: false });
    expect((await one.callApi("DELETE", `/bean-batches/${String(record.id)}`)).status).toBe(200);

    await holds(() => heldBatch(two, batch.id), { archived: true });
    expect(await whereAt(batch.id)).toEqual([]);
    // The tablet that deleted it held it no more, and is not written it again.
    expect(heldBatch(one, batch.id)).toEqual([]);
    expect(one.writes.filter((write) => write.startsWith("POST "))).toEqual([]);
    expect(two.writes.some((write) => write.startsWith("DELETE"))).toBe(false);
  });

  /**
   * A batch at the lab and at the cafe: entered on the first lab tablet, and
   * added at the cafe on a lab tablet that moved there still holding it,
   * where a barista un-archives it. The cafe's other tablet is written it.
   */
  async function atTwoLocations(name: string, serials: number) {
    const setup = await lab(name, serials);
    const { one, two, cafe, machines, cafeLocation } = setup;
    const third = await api.createMachine(`${name} lab 3`, setup.labLocation.id);
    const three = load(third, String(serials + 3));
    await online(third);
    const { batch } = await enterBatch(one, `${name} Blend`);
    await holds(() => heldBatch(two, batch.id), { archived: false });
    await holds(() => heldBatch(three, batch.id), { archived: false });

    // Moved to the cafe, the second lab tablet has the batch archived, as the cafe does not offer it.
    expect((await api.call("POST", `/machines/${machines[1].machine.id}/location-history`, { locationId: cafeLocation.id })).status).toBe(201);
    const moved = await holds(() => heldBatch(two, batch.id), { archived: true });
    await two.editBatch(moved.id, { archived: false });
    await expect.poll(() => whereAt(batch.id), { timeout: 10_000 }).toEqual([[`${name} cafe`, null], [`${name} lab`, 250]]);
    await holds(() => heldBatch(cafe, batch.id), { archived: false });
    await holds(() => heldBean(two, batch.bean.id), { archived: false });
    return { ...setup, three, batch };
  }

  it("makes a weightRemaining changed on one tablet its Location's remaining weight, reaching the Location's other tablets, while another Location's stays", async () => {
    const { one, two, three, cafe, batch } = await atTwoLocations("Weighed", 16031);
    // The cafe counts its own, which reaches the moved tablet there.
    await cafe.editBatch(heldBatch(cafe, batch.id)[0]!.id, { weightRemaining: 200 });
    await expect.poll(() => whereAt(batch.id), { timeout: 10_000 }).toEqual([["Weighed cafe", 200], ["Weighed lab", 250]]);
    await holds(() => heldBatch(two, batch.id), { weightRemaining: 200 });

    await one.editBatch(heldBatch(one, batch.id)[0]!.id, { weightRemaining: 180.5 });
    await expect.poll(() => whereAt(batch.id), { timeout: 10_000 }).toEqual([["Weighed cafe", 200], ["Weighed lab", 180.5]]);
    await holds(() => heldBatch(three, batch.id), { weightRemaining: 180.5 });
    expect(heldBatch(cafe, batch.id)[0]!.weightRemaining).toBe(200);
    expect(heldBatch(two, batch.id)[0]!.weightRemaining).toBe(200);
  });

  it("finishes a Bean's batches at the Location of the tablet that deletes it, and only there, where the Bean stops being offered", async () => {
    const { one, two, three, cafe, batch } = await atTwoLocations("Removed", 16041);
    const logged = [server.output().length, other.output().length] as const;
    const bean = heldBean(one, batch.bean.id)[0]!;
    // As DYE2 deletes a bean: its batches first, since Decaid refuses to delete a bean that has any.
    await one.deleteBean(bean.id);
    expect(one.beans()).toEqual([]);

    await expect.poll(() => whereAt(batch.id), { timeout: 10_000 }).toEqual([["Removed cafe", null]]);
    await holds(() => heldBatch(three, batch.id), { archived: true });
    await holds(() => heldBean(three, batch.bean.id), { archived: true });
    expect(await offeredAt("Removed Blend")).toEqual(["Removed cafe"]);
    // The cafe's tablets keep them.
    expect(heldBatch(cafe, batch.id)).toMatchObject([{ archived: false }]);
    expect(heldBean(cafe, batch.bean.id)).toMatchObject([{ archived: false }]);
    expect(heldBean(two, batch.bean.id)).toMatchObject([{ archived: false }]);
    expect((await libraryBean("Removed Blend"))!.archived).toBe(false);
    // Its batches and the bean, gone in one poll, were taken in together before anything was written on their account.
    expect(server.output().slice(logged[0]) + other.output().slice(logged[1])).not.toContain("did not write");
  });

  it("counts no write refused when a Bean is deleted on a tablet as the server archives it there, its batches reported gone first", async () => {
    const labLocation = await api.createLocation("Gone lab", "UTC");
    const first = await api.createMachine("Gone lab 1", labLocation.id);
    const second = await api.createMachine("Gone lab 2", labLocation.id);
    /** Set once the bean and its batch are to be deleted, as a poll reads the batches after the beans. */
    let deleting: { bean: string; batch: string } | undefined;
    /** The bean deleted, once it is, and how many requests the plugin had made by then. */
    let gone: string | undefined;
    let madeBefore = 0;
    const one: SimulatedTablet = load(first, "16131", {
      apiDelayMs: (method, path) => {
        if (method !== "GET") return 0;
        if (deleting && path.startsWith("/bean-batches?")) {
          // As DYE2 deletes a bean, its batch first: the poll then reads the batches without them.
          void one.callApi("DELETE", `/bean-batches/${deleting.batch}`);
          void one.callApi("DELETE", `/beans/${deleting.bean}`);
          gone = deleting.bean;
          madeBefore = one.requests.length;
          deleting = undefined;
          return 0;
        }
        // Until the plugin has carried out the server's write to the bean, which reads it first, every read of the
        // beans times out, so the report of the delete cannot come before that write, however slow the server.
        const written = one.requests.slice(madeBefore).includes(`/beans/${gone}`);
        return gone !== undefined && path.startsWith("/beans?") && !written ? 30_000 : 0;
      },
    });
    const two = load(second, "16132");
    await online(first, second);
    const { record, batch } = await enterBatch(one, "Gone Typica");
    await holds(() => heldBatch(two, batch.id), { archived: false });
    await holds(() => heldBean(one, batch.bean.id), { extras: { [GLOBAL_ID_KEY]: batch.bean.id } });
    const logged = server.output().length;
    deleting = { bean: String(record.beanId), batch: String(record.id) };

    await expect.poll(() => whereAt(batch.id), { timeout: 10_000 }).toEqual([]);
    await holds(() => heldBean(two, batch.bean.id), { archived: true });
    expect(one.beans()).toEqual([]);
    // The server archived the Bean on the tablet that had deleted it, which Decaid answered with 404: no refusal.
    await expect.poll(() => server.output().slice(logged), { timeout: 10_000 }).toContain(`no longer holds "bean" ${batch.bean.id}`);
    expect(server.output().slice(logged)).not.toContain("did not write");
  });

  it("takes a Bean archived on a tablet away from its Location with its batches there, and offers it again, without them, once un-archived", async () => {
    const { one, two } = await lab("Shelved", 16051);
    const { batch } = await enterBatch(one, "Shelved Honey");
    await holds(() => heldBatch(two, batch.id), { archived: false });
    const bean = heldBean(one, batch.bean.id)[0]!;
    expect((await one.callApi("PUT", `/beans/${String(bean.id)}`, { archived: true })).status).toBe(200);

    await expect.poll(() => whereAt(batch.id), { timeout: 10_000 }).toEqual([]);
    await holds(() => heldBean(two, batch.bean.id), { archived: true });
    await holds(() => heldBatch(two, batch.id), { archived: true });
    // The tablet that archived the Bean has its batch archived too.
    await holds(() => heldBatch(one, batch.id), { archived: true });

    expect((await one.callApi("PUT", `/beans/${String(bean.id)}`, { archived: false })).status).toBe(200);
    await expect.poll(() => offeredAt("Shelved Honey"), { timeout: 10_000 }).toEqual(["Shelved lab"]);
    await holds(() => heldBean(two, batch.bean.id), { archived: false });
    expect(await whereAt(batch.id)).toEqual([]);
    expect(heldBatch(two, batch.id)).toMatchObject([{ archived: true }]);
  });

  it("takes in a batch archived on a tablet just before the server wrote its global id, which kept it archived, rather than undoing it", async () => {
    const cafe = await api.createLocation("Kept cafe", "UTC");
    const first = await api.createMachine("Kept cafe 1", cafe.id);
    const second = await api.createMachine("Kept cafe 2", cafe.id);
    let archived = false;
    // A barista archives the batch on the tablet just as the plugin reads it to write its global id.
    const one: SimulatedTablet = load(first, "16101", {
      apiDelayMs: (method, path) => {
        if (!archived && method === "GET" && /^\/bean-batches\/[^/?]+$/.test(path)) {
          archived = true;
          void one.callApi("PUT", path, { archived: true });
        }
        return 0;
      },
    });
    const two = load(second, "16102");
    await online(first, second);
    const { batch } = await enterBatch(one, "Kept Natural");

    await expect.poll(() => whereAt(batch.id), { timeout: 10_000 }).toEqual([]);
    expect(archived).toBe(true);
    await holds(() => heldBatch(one, batch.id), { archived: true, extras: { [GLOBAL_ID_KEY]: batch.id } });
    await expect.poll(() => heldBatch(two, batch.id).filter((record) => record.archived !== true), { timeout: 10_000 }).toEqual([]);
    expect(await whereAt(batch.id)).toEqual([]);
    expect(heldBatch(one, batch.id)).toMatchObject([{ archived: true }]);
  });

  it("writes the Location's remaining weight again on the same connection when the request after a batch's create fails", async () => {
    const lab_ = await api.createLocation("Retried lab", "UTC");
    const first = await api.createMachine("Retried lab 1", lab_.id);
    const second = await api.createMachine("Retried lab 2", lab_.id);
    const one = load(first, "16111");
    await online(first);
    const { record, batch } = await enterBatch(one, "Retried Gesha");
    await one.editBatch(record.id, { weightRemaining: 120 });
    await expect.poll(() => whereAt(batch.id), { timeout: 10_000 }).toEqual([["Retried lab", 120]]);

    // The other tablet's first update of a batch, the one after its create, times out. It polls once an hour (every
    // 72 s here), so no report of its own comes between the writes.
    let timedOut = false;
    const two = load(second, "16112", {
      pollSeconds: 3600,
      apiDelayMs: (method, path) => {
        if (timedOut || method !== "PUT" || !path.startsWith("/bean-batches/")) return 0;
        timedOut = true;
        return 30_000;
      },
    });
    const logged = server.output().length;
    await holds(() => heldBatch(two, batch.id), { weightRemaining: 120, archived: false });
    expect(timedOut).toBe(true);
    const created = heldBatch(two, batch.id)[0]!;
    expect(two.writes.filter((write) => write.includes("batch"))).toEqual([`POST /beans/${String(created.beanId)}/batches`, `PUT /bean-batches/${String(created.id)}`]);
    expect(server.output().slice(logged)).not.toMatch(/did not write|still due/);
  });

  it("records the answer to a write that reached the tablet as its connection dropped, so the server's own write is not read back as the tablet's", async () => {
    const { one, two } = await lab("Replayed", 16121);
    const { record, batch } = await enterBatch(one, "Replayed Pacamara");
    const own = await holds(() => heldBatch(two, batch.id), { archived: false });
    await two.editBatch(own.id, { archived: true });
    await holds(() => heldBatch(one, batch.id), { archived: true });

    // Added back at the lab, the batch is un-archived on the first tablet, whose network goes as that write arrives.
    one.cutConnectionAfter((frame) => {
      const write = frame as { type?: unknown; globalId?: unknown; fields?: { archived?: unknown } };
      const matches = write.type === "write" && write.globalId === batch.id && write.fields?.archived === false;
      if (matches) queueMicrotask(() => one.loseNetwork());
      return matches;
    });
    await two.editBatch(own.id, { archived: false });
    await holds(() => heldBatch(one, batch.id), { id: record.id, archived: false });
    // While it is away, the batch is finished at the lab again.
    await two.editBatch(own.id, { archived: true });
    await expect.poll(() => whereAt(batch.id), { timeout: 10_000 }).toEqual([]);

    // Back, its outbox sends the answer, then its reports, which hold the batch as the server wrote it: no change.
    one.restoreNetwork();
    await holds(() => heldBatch(one, batch.id), { archived: true });
    expect(await whereAt(batch.id)).toEqual([]);
  });

  it("finishes and Archives nothing for a tablet whose Decaid data was reset, and writes it what its Location offers, its remaining weight included", async () => {
    const lab_ = await api.createLocation("Reset lab", "UTC");
    const first = await api.createMachine("Reset lab 1", lab_.id);
    const second = await api.createMachine("Reset lab 2", lab_.id);
    const one = load(first, "16061");
    const storage = new PluginStorage();
    const two = load(second, "16062", { storage });
    await online(first, second);
    const { record, batch } = await enterBatch(one, "Reset Bourbon");
    await one.editBatch(record.id, { weightRemaining: 120 });
    await expect.poll(() => whereAt(batch.id), { timeout: 10_000 }).toEqual([["Reset lab", 120]]);
    await holds(() => heldBatch(two, batch.id), { weightRemaining: 120 });
    const tabletsBefore = (await api.machineNamed(second.machine.name))!;

    // Its Decaid data reset, the tablet has a new tablet id, and an empty Library.
    await two.unload();
    await api.waitForMachine(second.machine.name, (viewed) => !viewed.online);
    storage.clear();
    const reset = load(second, "16062", { storage });
    await holds(() => heldBatch(reset, batch.id), { weightRemaining: 120, archived: false });
    await holds(() => heldBean(reset, batch.bean.id), { archived: false });
    expect((await api.machineNamed(second.machine.name))!.tablet!.id).not.toBe(tabletsBefore.tablet!.id);
    expect(await whereAt(batch.id)).toEqual([["Reset lab", 120]]);
    expect(await offeredAt("Reset Bourbon")).toEqual(["Reset lab"]);
    expect((await libraryBatch("Reset Bourbon")).archived).toBe(false);
    // Decaid's create sets the remaining weight to the weight, so the Location's is written after it.
    const created = heldBatch(reset, batch.id)[0]!;
    expect(reset.writes.filter((write) => write.includes("batch"))).toEqual([`POST /beans/${String(heldBean(reset, batch.bean.id)[0]!.id)}/batches`, `PUT /bean-batches/${String(created.id)}`]);
  });

  it("sends a tablet's bean batches in full whenever it sends its beans, so a batch whose bean was not yet known is taken in", async () => {
    const cafe = await api.createLocation("Resend cafe", "UTC");
    const machine = await api.createMachine("Resend cafe 1", cafe.id);
    const tablet = load(machine, "16071");
    await online(machine);
    const reports = (name: string) => tablet.sent.filter((frame) => (frame as { type?: unknown; name?: unknown }).type === "collection" && (frame as { name?: unknown }).name === name).length;
    await expect.poll(() => reports("beanBatches"), { timeout: 10_000 }).toBeGreaterThan(0);
    const batchesBefore = reports("beanBatches");
    await tablet.addBean({ roaster: "Roux", name: "Resend Only Bean" });
    await expect.poll(async () => offeredAt("Resend Only Bean"), { timeout: 10_000 }).toEqual(["Resend cafe"]);
    expect(reports("beanBatches")).toBeGreaterThan(batchesBefore);
  });

  it("neither writes to a Machine with no Location nor takes its batches into the Library", async () => {
    const home = await api.createMachine("Batch home machine");
    const tablet = load(home, "16081");
    await online(home);
    const bean = await tablet.addBean({ roaster: "Roux", name: "Home Batch Bean" });
    await tablet.addBatch(bean.id, { weight: 340 });
    await expect
      .poll(async () => {
        const reported = (await (await api.call("GET", `/machines/${home.machine.id}/collections/beanBatches`)).json()) as { collection: { value: Record_[] } | null };
        return reported.collection?.value.length;
      }, { timeout: 10_000 })
      .toBe(1);
    expect(await batchesOf("Home Batch Bean")).toEqual([]);
    expect(tablet.writes).toEqual([]);
  });

  it("reads no batch it wrote as deleted while the tablet's reads of its batches run slow beside the writes", async () => {
    const cafe = await api.createLocation("Slow cafe", "UTC");
    const first = await api.createMachine("Slow cafe 1", cafe.id);
    const second = await api.createMachine("Slow cafe 2", cafe.id);
    const one = load(first, "16091");
    // Decaid reads its list of batches when asked, but the list takes 3 s of the tablet's time to reach the plugin,
    // and its other answers none, so a read of the list begun just before a write's record was made would arrive
    // after the write's answer, were reads and writes not kept apart.
    const two = load(second, "16092", { apiDelayMs: (method, path) => (method === "GET" && path.startsWith("/bean-batches?") ? 3_000 : 0), answerOnArrival: true });
    await online(first, second);
    const bean = await one.addBean({ roaster: "Roux", name: "Slow Blend" });
    for (const weight of [100, 200, 300, 400, 500]) await one.addBatch(bean.id, { weight });
    await expect.poll(async () => (await batchesOf("Slow Blend")).length, { timeout: 10_000 }).toBe(5);
    const ids = (await batchesOf("Slow Blend")).map((batch) => batch.id);
    await expect.poll(() => ids.filter((id) => heldBatch(two, id).length === 1).length, { timeout: 20_000 }).toBe(5);
    // Its next reports hold every batch written: none was finished on its account.
    await expect.poll(async () => (await batchesOf("Slow Blend")).filter((batch) => batch.locations.length === 1).length, { timeout: 10_000 }).toBe(5);
    expect(two.batches().every((record) => record.archived === false)).toBe(true);
  });
});

function pick(record: Record_, keys: string[]): Record_ {
  return Object.fromEntries(keys.map((key) => [key, record[key]]));
}
