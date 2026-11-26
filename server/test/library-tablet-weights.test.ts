import { globalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { LoadedTablets, emptyLibrary } from "./support/loaded-tablets.js";
import { shotFixture } from "./support/shot-fixtures.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #705 (ADR-0037): a tablet's record of a Bean Batch holds
// its own Location's Remaining Weight of it, written by the server after each
// Shot pulled there and each Batch Move, and such a write is never read back
// as a weight a barista entered. Simulated tablets running the built plugin,
// two at the bar, each on its own server instance sharing one database, and
// one at the annex. Serials are made up, from 70501.

type Record_ = Record<string, unknown>;

interface AtLocation {
  location: LocationView;
  remainingWeight: number | null;
  entered: { weight: number; at: string } | null;
  used: { shots: number; weight: number } | null;
}

interface BatchView {
  id: string;
  locations: AtLocation[];
  totalRemainingWeight: number | null;
  finished: { location: LocationView }[];
}

interface Version {
  fields: Record_;
  location: LocationView | null;
  source: { machine: { id: string } | null; account: { id: string } | null };
}

/** A Machine at a Location, with its tablet. */
interface Bar {
  location: LocationView;
  machine: CreatedMachine;
  tablet: SimulatedTablet;
  serial: string;
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };
const WAIT = { timeout: 15_000 };

/** A time that many minutes from now: after a weight entered just now. */
const minutes = (count: number) => new Date(Date.now() + count * 60_000);

describe("A tablet's record of a Bean Batch holds its Location's Remaining Weight", { timeout: 120_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  /** The bar's two Machines, the second connected through the other instance. */
  let one: Bar;
  let two: Bar;
  /** The annex's one Machine. */
  let annex: Bar;
  let bean: string;
  const tablets = new LoadedTablets();
  let serials = 70500;
  let shots = 0;

  async function machineAt(location: LocationView, name: string, instance: TestServer): Promise<Bar> {
    const machine = await api.createMachine(name, location.id);
    const serial = String(++serials);
    const tablet = tablets.syncing(machine, instance, { api: emptyLibrary(serial) });
    await api.waitForOnline(machine);
    return { location, machine, tablet, serial };
  }

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
    const bar = await api.createLocation("Held bar", "America/Chicago");
    one = await machineAt(bar, "Held bar 1", server);
    two = await machineAt(bar, "Held bar 2", other);
    annex = await machineAt(await api.createLocation("Held annex", "America/Chicago"), "Held annex 1", server);
    bean = (await api.send<{ bean: { id: string } }>("POST", "/beans", { content: { roaster: "Roux", name: "Held Guji" } }, 201)).bean.id;
  });
  afterAll(async () => {
    await tablets.unloadAll();
    await other?.stop();
    await server?.stop();
  });

  const getBatch = async (id: string) => (await api.get<{ batch: BatchView }>(`/bean-batches/${id}`)).batch;
  const at = (batch: BatchView, place: Bar) => batch.locations.find((here) => here.location.id === place.location.id);
  const put = (id: string, place: Bar, body: Record_) => api.call("PUT", `/bean-batches/${id}/locations/${place.location.id}`, body);
  const history = (id: string) => api.get<{ versions: Version[]; lostEdits: unknown[] }>(`/bean-batches/${id}/history`);
  const held = (tablet: SimulatedTablet, id: string) => tablet.batches().find((record) => globalIdOf(record) === id);
  const weightOn = (place: Bar, id: string) => held(place.tablet, id)?.weightRemaining;
  /** Waits until each of the tablets holds the weight on its record of the batch. */
  const holds = async (id: string, weight: number | null, ...places: Bar[]) => {
    for (const place of places) await expect.poll(() => weightOn(place, id) ?? null, WAIT).toBe(weight);
  };
  const move = (id: string, from: Bar, to: Bar, amount: number | "all") =>
    api.send<{ batch: BatchView }>("POST", `/bean-batches/${id}/moves`, { fromLocationId: from.location.id, toLocationId: to.location.id, amount });

  /** A batch of the Bean created at the bar with the weight given, if any, once both of its tablets hold it. */
  async function batchAtBar(remainingWeight?: number): Promise<string> {
    const entry = { locationId: one.location.id, ...(remainingWeight === undefined ? {} : { remainingWeight }) };
    const { batch } = await api.send<{ batch: BatchView }>("POST", "/bean-batches", { beanId: bean, content: {}, locations: [entry] }, 201);
    for (const place of [one, two]) await expect.poll(() => held(place.tablet, batch.id), WAIT).toBeTruthy();
    return batch.id;
  }

  /** Adds the batch at the annex with the weight given, once its tablet holds it. */
  async function addAtAnnex(id: string, remainingWeight: number): Promise<void> {
    expect((await put(id, annex, { atLocation: true, remainingWeight })).status).toBe(200);
    await expect.poll(() => held(annex.tablet, id)?.archived, WAIT).toBe(false);
  }

  /** The Shot a Machine pulls with the batch in its Workflow, named by its tablet's own id for it, measuring that dose. */
  function shotOf(place: Bar, batchId: string, dose: number, pulledAt = minutes(1)): Record_ {
    const fixture = shotFixture();
    const workflow = fixture.workflow as Record_;
    const { actualDoseWeight, ...annotations } = (fixture.annotations ?? {}) as Record_;
    return {
      ...fixture,
      id: `held-${++shots}`,
      timestamp: pulledAt.toISOString(),
      annotations: { ...annotations, actualDoseWeight: dose },
      workflow: {
        ...workflow,
        machine: { ...(workflow.machine as Record_), serialNumber: place.serial },
        context: { ...(workflow.context as Record_), beanBatchId: held(place.tablet, batchId)!.id },
      },
    };
  }

  /** Pulls a Shot of that dose with the batch on the Machine. */
  const pull = (place: Bar, batchId: string, dose: number, pulledAt?: Date) => place.tablet.pullShot(shotOf(place, batchId, dose, pulledAt));

  it("writes the new weight to every tablet at a Shot's Location, the one that pulled it included, leaving another Location's tablet its own, with no history entry and the weight last entered as it was", async () => {
    const id = await batchAtBar(500);
    await addAtAnnex(id, 300);
    await holds(id, 500, one, two);
    const before = { history: await history(id), entered: at(await getBatch(id), one)!.entered };

    pull(one, id, 18);
    await holds(id, 482, one, two);
    pull(two, id, 19.5);
    await holds(id, 462.5, two, one);
    expect(weightOn(annex, id)).toBe(300);

    // A Shot at the annex lowers its tablet's alone.
    pull(annex, id, 20);
    await holds(id, 280, annex);
    expect([weightOn(one, id), weightOn(two, id)]).toEqual([462.5, 462.5]);

    // The writes are no weights entered: the history is as it was, and so is what each count starts from.
    const batch = await getBatch(id);
    expect(at(batch, one)).toMatchObject({ remainingWeight: 462.5, entered: before.entered, used: { shots: 2, weight: 37.5 } });
    expect(at(batch, annex)).toMatchObject({ remainingWeight: 280, entered: { weight: 300 } });
    expect(await history(id)).toEqual(before.history);
    // Nor does a later report of the tablets' batches bring one: each holds what the server knows it to hold.
    await one.tablet.editBatch(held(one.tablet, id)!.id, { roastLevel: "light" });
    await expect.poll(() => held(two.tablet, id)?.roastLevel, WAIT).toBe("light");
    expect((await history(id)).versions.filter((version) => "remainingWeight" in version.fields)).toEqual(before.history.versions.filter((version) => "remainingWeight" in version.fields));
    expect((await history(id)).lostEdits).toEqual([]);
  });

  it("takes a barista's change of the weight made after such a write as a weight entered at the Location, which the next Shot there subtracts from, and keeps no Lost Edit for the weight it replaced", async () => {
    const id = await batchAtBar(400);
    // Pulled now, so that the weight entered below, timed by its tablet, is entered after it.
    pull(one, id, 18, new Date());
    await holds(id, 382, one, two);

    // Weighed on the second tablet, which holds the weight the server wrote it, not the one the count started from.
    await two.tablet.editBatch(held(two.tablet, id)!.id, { weightRemaining: 350 });
    await expect.poll(async () => at(await getBatch(id), two)?.entered?.weight, WAIT).toBe(350);
    await holds(id, 350, one, two);
    const { versions, lostEdits } = await history(id);
    expect(versions[0]).toMatchObject({ fields: { remainingWeight: 350 }, location: { id: two.location.id }, source: { machine: { id: two.machine.machine.id }, account: null } });
    // It had seen the count it replaced, written to it since: nothing was lost.
    expect(lostEdits).toEqual([]);

    pull(one, id, 20, minutes(2));
    await holds(id, 330, one, two);
    expect(at(await getBatch(id), one)).toMatchObject({ remainingWeight: 330, entered: { weight: 350 }, used: { shots: 1, weight: 20 } });
  });

  it("writes a tablet that was offline while Shots were pulled on another Machine at its Location the current weight when it returns", async () => {
    const id = await batchAtBar(250);
    two.tablet.loseNetwork();
    try {
      pull(one, id, 18);
      pull(one, id, 18.4, minutes(2));
      await holds(id, 213.6, one);
      expect(weightOn(two, id)).toBe(250);
    } finally {
      two.tablet.restoreNetwork();
    }
    await holds(id, 213.6, two);
    expect((await history(id)).versions.filter((version) => "remainingWeight" in version.fields)).toHaveLength(1);
  });

  it("leaves every tablet at the Location with the right weight once a tablet catches up with several Shots of one batch", async () => {
    const id = await batchAtBar(300);
    const untouched = await history(id);
    one.tablet.loseNetwork();
    try {
      for (const [index, dose] of [18, 18.2, 17.9, 18.1, 19].entries()) pull(one, id, dose, minutes(index + 1));
    } finally {
      one.tablet.restoreNetwork();
    }
    await holds(id, 208.8, one, two);
    expect(at(await getBatch(id), one)).toMatchObject({ remainingWeight: 208.8, used: { shots: 5, weight: 91.2 } });
    expect(await history(id)).toEqual(untouched);
  });

  it("writes no weight to the tablets of a Location the batch is untracked at", async () => {
    const untracked = await batchAtBar();
    const tracked = await batchAtBar(200);
    const before = [one, two].map((place) => ({ ...held(place.tablet, untracked) }));
    const writes = [one, two].map((place) => place.tablet.writes.length);

    pull(one, untracked, 18);
    // A Shot of a tracked batch after it, whose write shows the tablets were looked at since.
    pull(one, tracked, 18, minutes(2));
    await holds(tracked, 182, one, two);
    await expect.poll(async () => ((await (await api.call("GET", `/shots/held-${shots - 1}`)).json()) as { shot?: { beanBatch: { id: string } | null } }).shot?.beanBatch?.id, WAIT).toBe(untracked);

    expect([one, two].map((place) => held(place.tablet, untracked))).toEqual(before);
    for (const [index, place] of [one, two].entries()) {
      const since = place.tablet.writes.slice(writes[index]);
      expect(since).toEqual([`PUT /bean-batches/${String(held(place.tablet, tracked)!.id)}`]);
    }
    expect(at(await getBatch(untracked), one)).toMatchObject({ remainingWeight: null });
  });

  it("finishes nothing for a zero the server writes after Shots, even where the tablet's answer to it was lost, while a barista's own change to zero finishes the batch at the Location", async () => {
    const id = await batchAtBar(30);
    pull(two, id, 18);
    await holds(id, 12, one, two);
    const before = await history(id);

    // A third Machine at the bar, loaded here as its plugin is loaded again below. Its network goes as the write of
    // zero reaches its tablet, and its plugin stops before it can answer.
    let three = await machineAt(one.location, "Held bar 3", server);
    await holds(id, 12, three);
    three.tablet.cutConnectionAfter((frame) => {
      const write = frame as { type?: unknown; globalId?: unknown; fields?: { weightRemaining?: unknown } };
      const matches = write.type === "write" && write.globalId === id && write.fields?.weightRemaining === 0;
      if (matches) queueMicrotask(() => three.tablet.loseNetwork());
      return matches;
    });
    pull(two, id, 18, minutes(2));
    await holds(id, 0, two, one, three);
    await api.waitForMachine(three.machine.machine.name, (viewed) => !viewed.online);
    // Loaded again, its report holds a zero the server has no answer for: the server's own, and no weight entered.
    three = { ...three, tablet: await three.tablet.reload() };
    await api.waitForOnline(three.machine);
    // A later change on it is taken in, so its report has been.
    await three.tablet.editBatch(held(three.tablet, id)!.id, { roastLevel: "dark" });
    await expect.poll(() => held(two.tablet, id)?.roastLevel, WAIT).toBe("dark");

    const batch = await getBatch(id);
    expect(batch.finished).toEqual([]);
    expect(at(batch, one)).toMatchObject({ remainingWeight: 0, entered: { weight: 30 }, used: { shots: 2, weight: 36 } });
    for (const place of [one, two, three]) expect(held(place.tablet, id)).toMatchObject({ archived: false, weightRemaining: 0 });
    const after = await history(id);
    expect(after.versions.filter((version) => "remainingWeight" in version.fields || "atLocation" in version.fields)).toEqual(
      before.versions.filter((version) => "remainingWeight" in version.fields || "atLocation" in version.fields),
    );
    expect(after.lostEdits).toEqual([]);

    // A barista's own zero, on a record holding a weight the server wrote after a Shot.
    const emptied = await batchAtBar(200);
    pull(one, emptied, 18, minutes(3));
    await holds(emptied, 182, one, two);
    await two.tablet.editBatch(held(two.tablet, emptied)!.id, { weightRemaining: 0 });
    await expect.poll(async () => (await getBatch(emptied)).finished.map((here) => here.location.id), WAIT).toEqual([one.location.id]);
    expect((await history(emptied)).versions[0]).toMatchObject({ fields: { remainingWeight: 0, atLocation: false }, source: { machine: { id: two.machine.machine.id } } });
    for (const place of [one, two]) await expect.poll(() => held(place.tablet, emptied)?.archived, WAIT).toBe(true);
  });

  it("writes the tablets at the Location left and at the Location joined their Locations' new weights after a move of an amount, with no history entry beyond the move's", async () => {
    const id = await batchAtBar(1000);
    await addAtAnnex(id, 100);
    pull(one, id, 20);
    await holds(id, 980, one, two);
    pull(annex, id, 10);
    await holds(id, 90, annex);
    const before = (await history(id)).versions;

    await move(id, one, annex, 300);
    await holds(id, 680, one, two);
    await holds(id, 390, annex);
    // Neither count started again: each is what was entered, with the Shots and the move since.
    const batch = await getBatch(id);
    expect(at(batch, one)).toMatchObject({ remainingWeight: 680, entered: { weight: 1000 } });
    expect(at(batch, annex)).toMatchObject({ remainingWeight: 390, entered: { weight: 100 } });
    // A change on each tablet since is taken in with the weight the server wrote it.
    await annex.tablet.editBatch(held(annex.tablet, id)!.id, { roastLevel: "light" });
    await expect.poll(() => held(one.tablet, id)?.roastLevel, WAIT).toBe("light");
    const after = await history(id);
    const weighed = (versions: Version[]) => versions.filter((version) => "remainingWeight" in version.fields || "movedAmount" in version.fields || "atLocation" in version.fields);
    expect(weighed(after.versions).slice(1)).toEqual(weighed(before));
    expect(weighed(after.versions)[0]).toMatchObject({ fields: { movedAmount: 300 } });
    expect(after.lostEdits).toEqual([]);
  });

  it("brings a batch to the tablets at the Location joined by a move of all with the weight that was moved, and archives it on those it left", async () => {
    const id = await batchAtBar(600);
    pull(two, id, 18);
    await holds(id, 582, one, two);
    expect(held(annex.tablet, id)).toBeUndefined();

    const moved = await move(id, one, annex, "all");
    expect(moved.batch).toMatchObject({ totalRemainingWeight: 582, locations: [{ location: { id: annex.location.id }, remainingWeight: 582 }] });
    await expect.poll(() => held(annex.tablet, id), WAIT).toMatchObject({ archived: false, weightRemaining: 582 });
    for (const place of [one, two]) await expect.poll(() => held(place.tablet, id), WAIT).toMatchObject({ archived: true, weightRemaining: 0 });
    // The zero written where it left is no weight entered there.
    const { versions, lostEdits } = await history(id);
    expect(versions.filter((version) => version.source.machine !== null)).toEqual([]);
    expect(lostEdits).toEqual([]);

    // A Shot where it arrived lowers what its tablet holds.
    pull(annex, id, 22, minutes(2));
    await holds(id, 560, annex);
  });
});
