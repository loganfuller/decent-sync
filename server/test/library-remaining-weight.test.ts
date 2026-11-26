import { PrismaPg } from "@prisma/adapter-pg";
import { STARTING_SHAPES, globalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { BeanBatchesService } from "../src/library/bean-batches.service.js";
import type { PrismaService } from "../src/prisma.service.js";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, type TestApp, serveTestApp } from "./support/assistants.js";
import { LoadedTablets, emptyLibrary } from "./support/loaded-tablets.js";
import { shotFixture } from "./support/shot-fixtures.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, adminDatabaseUrl, startTestServer } from "./support/test-server.js";

// Seam 1, the REST API and the assistant tools for ticket #706 (ADR-0037): a
// Bean Batch's Remaining Weight at a Location is the weight last entered
// there less the dose of each Shot linked to the batch that was pulled there
// since, worked out as it is read. Shots are pulled on simulated tablets
// running the built plugin, on two server instances sharing one database.
// Serials are made up, from 70601.

type Record_ = Record<string, unknown>;

interface Source {
  machine: { id: string; name: string } | null;
  tabletId: string | null;
  account: { id: string; name: string | null } | null;
  connectedApp: unknown;
}

interface AtLocation {
  location: LocationView;
  remainingWeight: number | null;
  entered: { weight: number; at: string; by: Source | null } | null;
  used: { shots: number; weight: number } | null;
}

interface BatchView {
  id: string;
  archived: boolean;
  locations: AtLocation[];
  totalRemainingWeight: number | null;
  finished: { location: LocationView }[];
  content: Record_;
}

interface Version {
  fields: Record_;
  location: LocationView | null;
  source: Source;
}

interface Place {
  location: LocationView;
  machine: CreatedMachine;
  tablet: SimulatedTablet;
  serial: string;
}

const env = { ...ASSISTANT_ENV, SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** An ISO 8601 time with its offset. */
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;

/** A result, a tool's or the REST API's, as the two are compared: each time as its instant, as the tools give them with a Location's offset. */
function comparable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (_, field: unknown) => (typeof field === "string" && ISO_TIME.test(field) ? Date.parse(field) : field));
}

/** A time that many minutes from now: after a weight entered just now, or, negative, before it. */
const minutes = (count: number) => new Date(Date.now() + count * 60_000);

describe("A Bean Batch's Remaining Weight at a Location", { timeout: 120_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  let app: TestApp;
  let assistant: Assistant;
  let lab: Place;
  let cafe: Place;
  let bean: string;
  const tablets = new LoadedTablets();
  let serials = 70600;
  let shots = 0;

  /** A Location with one Machine, whose tablet is online through the instance given. */
  async function placeNamed(name: string, instance: TestServer = server): Promise<Place> {
    const location = await api.createLocation(name, "America/Chicago");
    const machine = await api.createMachine(`${name} bar`, location.id);
    const serial = String(++serials);
    const tablet = tablets.syncing(machine, instance, { api: emptyLibrary(serial) });
    await api.waitForOnline(machine);
    return { location, machine, tablet, serial };
  }

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
    app = await serveTestApp();
    assistant = await Assistant.connect(server.url, app, await signIn(server.url, admin));
    lab = await placeNamed("Weight lab");
    cafe = await placeNamed("Weight cafe", other);
    bean = (await api.send<{ bean: { id: string } }>("POST", "/beans", { content: { roaster: "Roux", name: "Weighed Guji" } }, 201)).bean.id;
  });
  afterAll(async () => {
    await assistant?.close();
    await tablets.unloadAll();
    await app?.close();
    await server?.stop();
  });

  const getBatch = async (id: string, as: AdminApi = api) => (await as.get<{ batch: BatchView }>(`/bean-batches/${id}`)).batch;
  const at = (batch: BatchView, place: Place) => batch.locations.find((here) => here.location.id === place.location.id);
  /** The batch's Remaining Weight at the Location: undefined where it is not there, null where it is untracked there. */
  const weightAt = async (id: string, place: Place) => at(await getBatch(id), place)?.remainingWeight;
  const put = (id: string, place: Place, body: Record_, as: AdminApi = api) => as.call("PUT", `/bean-batches/${id}/locations/${place.location.id}`, body);
  const versions = async (id: string) => (await api.get<{ versions: Version[] }>(`/bean-batches/${id}/history`)).versions;
  const held = (tablet: SimulatedTablet, id: string) => tablet.batches().find((record) => globalIdOf(record) === id);

  /** A batch of the Bean created at the Location, as the request's Location entry and content give it, once the Location's tablet holds it. */
  async function batchAt(place: Place, entry: Record_ = {}, content: Record_ = {}): Promise<string> {
    const { batch } = await api.send<{ batch: BatchView }>("POST", "/bean-batches", { beanId: bean, content, locations: [{ locationId: place.location.id, ...entry }] }, 201);
    await expect.poll(() => held(place.tablet, batch.id)).toBeTruthy();
    return batch.id;
  }

  /** Adds the batch at another Location, with the weight given if any, once the Location's tablet holds it. */
  async function addAt(id: string, place: Place, remainingWeight?: number): Promise<void> {
    expect((await put(id, place, { atLocation: true, ...(remainingWeight === undefined ? {} : { remainingWeight }) })).status).toBe(200);
    await expect.poll(() => held(place.tablet, id)?.archived).toBe(false);
  }

  /**
   * Pulls a Shot on the Location's Machine with the batch in its Workflow,
   * named by the tablet's own id for it, and waits until the server has
   * linked it. `target` is the dose its Workflow was set to and `actual` the
   * dose it measured, each left out of the record where not given.
   */
  async function pull(place: Place, batchId: string, { target, actual, pulledAt = minutes(1), changes = {} }: { target?: number; actual?: number; pulledAt?: Date; changes?: Record_ }): Promise<string> {
    const id = `weight-${++shots}`;
    const fixture = shotFixture();
    const workflow = fixture.workflow as Record_;
    const { targetDoseWeight, ...context } = workflow.context as Record_;
    const { actualDoseWeight, ...annotations } = (fixture.annotations ?? {}) as Record_;
    place.tablet.pullShot({
      ...fixture,
      id,
      timestamp: pulledAt.toISOString(),
      annotations: { ...annotations, ...(actual === undefined ? {} : { actualDoseWeight: actual }) },
      workflow: {
        ...workflow,
        machine: { ...(workflow.machine as Record_), serialNumber: place.serial },
        context: { ...context, beanBatchId: held(place.tablet, batchId)!.id, ...(target === undefined ? {} : { targetDoseWeight: target }) },
      },
      ...changes,
    });
    await expect.poll(async () => ((await (await api.call("GET", `/shots/${id}`)).json()) as { shot?: { beanBatch: { id: string } | null } }).shot?.beanBatch?.id, { timeout: 15_000 }).toBe(batchId);
    return id;
  }

  /** Runs a statement on the server's database, for what the server offers no way to do to a Shot. */
  async function sql(text: string, values: unknown[]): Promise<void> {
    const database = await server.connectDatabase();
    try {
      await database.query(text, values);
    } finally {
      await database.end();
    }
  }

  /** A tool's error, which the call must answer with. */
  async function toolError(name: string, args: Record_): Promise<string> {
    const result = await assistant.client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).toBe(true);
    return (result.content as { text: string }[]).map((block) => block.text).join("\n");
  }

  /** The REST API's refusal of a request, which must be refused with the status, as its message. */
  async function restRefusal(method: string, path: string, body: unknown, status: number): Promise<string> {
    const response = await api.call(method, path, body);
    expect(response.status, path).toBe(status);
    const { message } = (await response.json()) as { message: string | string[] };
    return Array.isArray(message) ? message.join("; ") : message;
  }

  it("takes a Shot's dose from the weight entered at the Location it was pulled at and no other, in the batch's read, the list, its Bean's read and the assistant tools, with the weight entered, who entered it, what Shots used and the total", async () => {
    const id = await batchAt(lab, { remainingWeight: 1000 }, { roastDate: "2026-11-20" });
    await addAt(id, cafe, 500);
    expect(await getBatch(id)).toMatchObject({ totalRemainingWeight: 1500, locations: [{ remainingWeight: 500, used: { shots: 0, weight: 0 } }, { remainingWeight: 1000, used: { shots: 0, weight: 0 } }] });

    await pull(lab, id, { target: 18, actual: 18.5 });
    const batch = await getBatch(id);
    const me = (await api.get<{ account: { id: string } }>("/session")).account.id;
    expect(at(batch, lab)).toMatchObject({
      remainingWeight: 981.5,
      entered: { weight: 1000, by: { machine: null, account: { id: me }, connectedApp: null } },
      used: { shots: 1, weight: 18.5 },
    });
    expect(Date.parse(at(batch, lab)!.entered!.at)).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(at(batch, cafe)).toMatchObject({ remainingWeight: 500, entered: { weight: 500 }, used: { shots: 0, weight: 0 } });
    expect(batch.totalRemainingWeight).toBe(1481.5);

    // The list, and the Bean's read, give the same.
    const { batches } = await api.get<{ batches: BatchView[] }>("/bean-batches");
    const { content: _content, finished: _finished, ...summary } = batch;
    expect(batches.find((listed) => listed.id === id)).toEqual(summary);
    const read = await api.get<{ bean: { batches: BatchView[] } }>(`/beans/${bean}`);
    expect(read.bean.batches.find((listed) => listed.id === id)).toEqual(summary);

    // The assistant tools read what the REST API does.
    const got = await assistant.call<{ beanBatch: Record_ }>("get_library_item", { kind: "beanBatch", id });
    expect(comparable(got.beanBatch)).toEqual(comparable(batch));
    const found = await assistant.call<{ beanBatches: { id: string }[] }>("find_library_items", { kind: "beanBatch", limit: 50 });
    expect(comparable(found.beanBatches.find((listed) => listed.id === id))).toEqual(comparable(summary));

    // A Shot at the cafe falls on the cafe's weight alone.
    await pull(cafe, id, { target: 20 });
    expect(await getBatch(id)).toMatchObject({ totalRemainingWeight: 1461.5, locations: [{ remainingWeight: 480 }, { remainingWeight: 981.5 }] });
  });

  it("names the account that entered a weight to an Admin, and not to Staff", async () => {
    const id = await batchAt(lab, { remainingWeight: 300 });
    const { link } = await api.invite("weight-staff@example.com", "staff", [lab.location.id]);
    const staff = AdminApi.signedInAs(server.url, await acceptInvite(server.url, link, { name: "Sam", password: "a password for weights" }));
    expect(at(await getBatch(id), lab)!.entered!.by!.account!.name).toBe(admin.name);
    expect(at(await getBatch(id, staff), lab)!.entered!.by!.account).toMatchObject({ name: null });
  });

  it("subtracts a Shot's measured dose, else the dose its Workflow was set to, else nothing, an Unfinished Shot's too, and nothing for a Shot pulled before the weight was entered", async () => {
    const id = await batchAt(lab, { remainingWeight: 400 });
    await pull(lab, id, { target: 18, actual: 17.2 });
    expect(await weightAt(id, lab)).toBe(382.8);
    await pull(lab, id, { target: 19 });
    expect(await weightAt(id, lab)).toBe(363.8);
    await pull(lab, id, {});
    expect(at(await getBatch(id), lab)).toMatchObject({ remainingWeight: 363.8, used: { shots: 3, weight: 36.2 } });

    // One that never poured, as coffee ground and thrown away.
    const unfinished = await pull(lab, id, { target: 18, changes: { measurements: [] } });
    expect((await api.get<{ shot: { spec: { unfinished: boolean } } }>(`/shots/${unfinished}`)).shot.spec.unfinished).toBe(true);
    expect(await weightAt(id, lab)).toBe(345.8);

    // One pulled before the weight was entered is in the weight already.
    await pull(lab, id, { target: 18, pulledAt: minutes(-60) });
    expect(at(await getBatch(id), lab)).toMatchObject({ remainingWeight: 345.8, used: { shots: 4, weight: 54.2 } });
  });

  it("subtracts a Trial Shot, pulled on a Draft's steps", async () => {
    const id = await batchAt(lab, { remainingWeight: 250 });
    await api.send("PATCH", `/locations/${lab.location.id}`, { triesDrafts: true });
    const profile = { ...STARTING_SHAPES.find((shape) => shape.key === "blooming")!.profile, title: "Weighed trial" };
    const { draft } = await api.send<{ draft: { id: string } }>("POST", "/drafts", { file: profile }, 201);
    await api.send("PUT", `/drafts/${draft.id}/following`, { machineId: lab.machine.machine.id }, 200);
    type Trying = { following: { state: string } | null; trialShots: { shot: { id: string } }[] };
    const trying = async () => (await api.get<{ trying: Trying }>(`/drafts/${draft.id}/trying`)).trying;
    await expect.poll(async () => (await trying()).following?.state, { timeout: 15_000 }).toBe("current");
    await expect.poll(() => (lab.tablet.workflow().profile as { title?: string }).title).toContain("Weighed trial");

    // A Shot on the Draft's steps, as the tablet's Workflow holds them.
    const fixture = shotFixture();
    const shotId = `weight-trial-${++shots}`;
    lab.tablet.pullShot({
      ...fixture,
      id: shotId,
      timestamp: minutes(2).toISOString(),
      annotations: { actualDoseWeight: 15 },
      workflow: {
        ...lab.tablet.workflow(),
        machine: { ...((fixture.workflow as Record_).machine as Record_), serialNumber: lab.serial },
        context: { ...((fixture.workflow as Record_).context as Record_), beanBatchId: held(lab.tablet, id)!.id },
      },
    });
    await expect.poll(async () => (await trying()).trialShots.map((each) => each.shot.id), { timeout: 15_000 }).toContain(shotId);
    await expect.poll(() => weightAt(id, lab)).toBe(235);
  });

  it("subtracts a Shot that reaches the server after a later Shot, pulled after the weight was entered", async () => {
    const id = await batchAt(lab, { remainingWeight: 200 });
    await pull(lab, id, { target: 18, pulledAt: minutes(10) });
    expect(await weightAt(id, lab)).toBe(182);
    // As from a tablet that was offline: pulled earlier, stored later.
    await pull(lab, id, { target: 20, pulledAt: minutes(5) });
    expect(at(await getBatch(id), lab)).toMatchObject({ remainingWeight: 162, used: { shots: 2, weight: 38 } });
  });

  it("changes no weight for a Shot pulled where the batch is untracked or is not, or on a Machine with no Location", async () => {
    const id = await batchAt(lab, { remainingWeight: 600 });
    await addAt(id, cafe);
    expect(await weightAt(id, cafe)).toBeNull();
    // Untracked at the cafe: its Shot is counted nowhere.
    const there = await pull(cafe, id, { target: 18 });
    expect(await getBatch(id)).toMatchObject({ totalRemainingWeight: 600, locations: [{ remainingWeight: null, entered: null, used: null }, { remainingWeight: 600, used: { shots: 0 } }] });
    // Finished at the cafe, where it is no longer, another Shot there changes nothing either.
    expect((await put(id, cafe, { atLocation: false })).status).toBe(200);
    await sql(`UPDATE shots SET pulled_at = now() + interval '3 minutes' WHERE id = $1`, [there]);
    expect(await getBatch(id)).toMatchObject({ totalRemainingWeight: 600, locations: [{ remainingWeight: 600, used: { shots: 0 } }] });

    // A Shot whose Machine had no Location when it was pulled has none.
    const counted = await pull(lab, id, { target: 18 });
    expect(await weightAt(id, lab)).toBe(582);
    await sql(`UPDATE shots SET location_id = NULL WHERE id = $1`, [counted]);
    expect(await weightAt(id, lab)).toBe(600);
  });

  it("follows a Shot whose dose changes, whose batch changes, and that is deleted", async () => {
    const id = await batchAt(lab, { remainingWeight: 500 });
    const second = await batchAt(lab, { remainingWeight: 100 });
    const shot = await pull(lab, id, { target: 18 });
    expect(await weightAt(id, lab)).toBe(482);

    // Its dose is weighed on the tablet afterwards.
    expect((await lab.tablet.callApi("PUT", `/shots/${shot}`, { annotations: { actualDoseWeight: 21.5 } })).status).toBe(200);
    await expect.poll(() => weightAt(id, lab), { timeout: 15_000 }).toBe(478.5);

    // The server offers no way to link a Shot to another batch or to delete one, so each is made in the database: the weight is read from the records.
    await sql(`UPDATE shots SET library_batch_id = $2::uuid WHERE id = $1`, [shot, second]);
    expect(await weightAt(id, lab)).toBe(500);
    expect(await weightAt(second, lab)).toBe(78.5);
    await sql(`DELETE FROM shots WHERE id = $1`, [shot]);
    expect(await weightAt(second, lab)).toBe(100);
  });

  it("reads a batch with no weight entered at a Location as untracked there, never as zero, and clearing a weight makes it so", async () => {
    const id = await batchAt(lab);
    expect(await getBatch(id)).toMatchObject({ totalRemainingWeight: null, locations: [{ remainingWeight: null, entered: null, used: null }] });
    await pull(lab, id, { target: 18, pulledAt: minutes(-5) });
    expect(await weightAt(id, lab)).toBeNull();

    expect((await put(id, lab, { remainingWeight: 240 })).status).toBe(200);
    expect(await weightAt(id, lab)).toBe(240);
    await pull(lab, id, { target: 18, pulledAt: minutes(2) });
    expect(await weightAt(id, lab)).toBe(222);
    // Clearing it is entering none.
    expect((await put(id, lab, { remainingWeight: null })).status).toBe(200);
    expect(await getBatch(id)).toMatchObject({ totalRemainingWeight: null, locations: [{ remainingWeight: null, entered: null, used: null }] });
    expect((await versions(id))[0]).toMatchObject({ fields: { remainingWeight: null }, location: { id: lab.location.id } });
    // Through the assistant tool too.
    await assistant.call("set_location_offering", { kind: "beanBatch", id, locationId: lab.location.id, remainingWeight: 150 });
    // The Shot above is timed after this entry too, so it counts against it.
    expect(await weightAt(id, lab)).toBe(132);
    const cleared = await assistant.call<{ beanBatch: BatchView }>("set_location_offering", { kind: "beanBatch", id, locationId: lab.location.id, remainingWeight: null });
    expect(cleared.beanBatch.locations).toMatchObject([{ remainingWeight: null, entered: null, used: null }]);
  });

  it("creates a batch at exactly one Location, refusing none and two as a bad request, over REST and through the assistant tool", async () => {
    const both = [{ locationId: lab.location.id }, { locationId: cafe.location.id }];
    for (const locations of [[], both]) {
      const message = await restRefusal("POST", "/bean-batches", { beanId: bean, locations }, 400);
      expect(message).toContain("the one Location the batch is created at");
      expect(await toolError("create_bean_batch", { beanId: bean, locations })).toBe(message);
    }
    expect(await restRefusal("POST", "/bean-batches", { beanId: bean }, 400)).toContain("the one Location");
    expect(await toolError("create_bean_batch", { beanId: bean })).toContain("the one Location");
  });

  it("starts a batch created with a roasted weight and no remaining weight at that weight at its Location, over REST and through the assistant tool, and leaves one given null untracked", async () => {
    const id = await batchAt(lab, {}, { weight: 6000 });
    expect(await getBatch(id)).toMatchObject({ totalRemainingWeight: 6000, locations: [{ remainingWeight: 6000, entered: { weight: 6000 } }], content: { weight: 6000 } });
    await expect.poll(() => held(lab.tablet, id)?.weightRemaining).toBe(6000);

    const { beanBatch } = await assistant.call<{ beanBatch: BatchView }>("create_bean_batch", { beanId: bean, weight: 5000, locations: [{ locationId: lab.location.id }] });
    expect(beanBatch).toMatchObject({ totalRemainingWeight: 5000, locations: [{ remainingWeight: 5000, entered: { weight: 5000 } }] });

    // A remaining weight given is the one it starts at, and null leaves it untracked.
    expect(await weightAt(await batchAt(lab, { remainingWeight: 5700 }, { weight: 6000 }), lab)).toBe(5700);
    expect(await weightAt(await batchAt(lab, { remainingWeight: null }, { weight: 6000 }), lab)).toBeNull();
    // With no roasted weight, it is untracked.
    expect(await weightAt(await batchAt(lab), lab)).toBeNull();
  });

  it("refuses a create or an add that gives a remaining weight of zero as a bad request, over REST and through the assistant tools", async () => {
    const before = (await api.get<{ batches: unknown[] }>("/bean-batches")).batches.length;
    for (const [locations, content] of [
      [[{ locationId: lab.location.id, remainingWeight: 0 }], {}],
      [[{ locationId: lab.location.id }], { weight: 0 }],
    ] as [Record_[], Record_][]) {
      const message = await restRefusal("POST", "/bean-batches", { beanId: bean, content, locations }, 400);
      expect(message).toContain("not added with a remaining weight of 0");
      expect(await toolError("create_bean_batch", { beanId: bean, ...content, locations })).toBe(message);
    }
    expect((await api.get<{ batches: unknown[] }>("/bean-batches")).batches).toHaveLength(before);

    const id = await batchAt(lab, { remainingWeight: 300 });
    const message = await restRefusal("PUT", `/bean-batches/${id}/locations/${cafe.location.id}`, { atLocation: true, remainingWeight: 0 }, 400);
    expect(message).toContain("not added with a remaining weight of 0");
    expect(await toolError("set_location_offering", { kind: "beanBatch", id, locationId: cafe.location.id, offered: true, remainingWeight: 0 })).toBe(message);
    expect((await getBatch(id)).locations.map((here) => here.location.id)).toEqual([lab.location.id]);
  });

  it("leaves a weight that Shots would take below zero at zero, the batch still at its Location, on its tablet and not Archived", async () => {
    const id = await batchAt(lab, { remainingWeight: 30 });
    await pull(lab, id, { target: 18 });
    await pull(lab, id, { target: 18, pulledAt: minutes(2) });
    const batch = await getBatch(id);
    expect(batch).toMatchObject({ archived: false, totalRemainingWeight: 0, finished: [], locations: [{ remainingWeight: 0, entered: { weight: 30 }, used: { shots: 2, weight: 36 } }] });
    expect((await versions(id)).some((version) => version.fields.atLocation === false)).toBe(false);
    expect(held(lab.tablet, id)).toMatchObject({ archived: false });
  });

  it("finishes a batch at the Location a weight of zero is entered for, over REST, through the assistant tool and from a tablet, as a finish made by a weight of zero in its history, leaving its other Location alone", async () => {
    const me = (await api.get<{ account: { id: string } }>("/session")).account.id;
    /** A batch at both Locations, 400 g at the lab and 300 g at the cafe. */
    const shared = async () => {
      const id = await batchAt(lab, { remainingWeight: 400 });
      await addAt(id, cafe, 300);
      return id;
    };
    /** What a batch finished at the lab by a weight of zero reads as: gone from the lab alone, and archived on the lab's tablet. */
    const finishedAtLab = async (id: string, by: Record_) => {
      const batch = await getBatch(id);
      expect(batch).toMatchObject({ archived: false, totalRemainingWeight: 300, locations: [{ location: { id: cafe.location.id }, remainingWeight: 300 }], finished: [{ location: { id: lab.location.id } }] });
      const [latest, ...earlier] = await versions(id);
      expect(latest).toMatchObject({ fields: { remainingWeight: 0, atLocation: false }, location: { id: lab.location.id }, source: by });
      // One entry: no weight entered apart from the finish.
      expect(earlier.some((version) => version.location?.id === lab.location.id && version.fields.remainingWeight === 0)).toBe(false);
      await expect.poll(() => held(lab.tablet, id)?.archived, { timeout: 15_000 }).toBe(true);
      expect(held(cafe.tablet, id)).toMatchObject({ archived: false });
    };

    const overRest = await shared();
    expect((await put(overRest, lab, { remainingWeight: 0 })).status).toBe(200);
    await finishedAtLab(overRest, { account: { id: me }, connectedApp: null, machine: null });

    const throughTool = await shared();
    const answered = await assistant.call<{ beanBatch: BatchView }>("set_location_offering", { kind: "beanBatch", id: throughTool, locationId: lab.location.id, remainingWeight: 0 });
    expect(answered.beanBatch.locations.map((here) => here.location.id)).toEqual([cafe.location.id]);
    await finishedAtLab(throughTool, { account: { id: me }, connectedApp: expect.anything(), machine: null });

    // A barista sets weightRemaining to zero on the lab's tablet.
    const fromTablet = await shared();
    await lab.tablet.editBatch(held(lab.tablet, fromTablet)!.id, { weightRemaining: 0 });
    await expect.poll(async () => (await getBatch(fromTablet)).finished.length, { timeout: 15_000 }).toBe(1);
    await finishedAtLab(fromTablet, { account: null, machine: { id: lab.machine.machine.id } });
  });

  it("keeps a batch a barista un-archives holding zero at the Location, as the tablet has it, since the same change added it there", async () => {
    const id = await batchAt(lab, { remainingWeight: 100 });
    const local = held(lab.tablet, id)!.id;
    await lab.tablet.editBatch(local, { archived: true });
    await expect.poll(async () => (await getBatch(id)).finished.length, { timeout: 15_000 }).toBe(1);
    await lab.tablet.editBatch(local, { archived: false, weightRemaining: 0 });
    await expect.poll(async () => (await getBatch(id)).locations, { timeout: 15_000 }).toMatchObject([{ location: { id: lab.location.id }, remainingWeight: 0 }]);
    expect((await getBatch(id)).finished).toEqual([]);
    expect(held(lab.tablet, id)).toMatchObject({ archived: false, weightRemaining: 0 });
  });

  it("reads a list of many batches with no query per batch", async () => {
    const url = new URL(adminDatabaseUrl());
    url.pathname = `/${server.database}`;
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.href }), log: [{ emit: "event", level: "query" }] });
    let queries = 0;
    prisma.$on("query", () => void queries++);
    try {
      const service = new BeanBatchesService(prisma as unknown as PrismaService);
      const counted = async () => {
        queries = 0;
        const batches = await service.list({ kind: "everything" });
        return { queries, batches: batches.length };
      };
      const few = await counted();
      for (let made = 0; made < 12; made++) await batchAt(lab, { remainingWeight: 100 + made });
      const many = await counted();
      expect(many.batches).toBe(few.batches + 12);
      expect(many.queries).toBe(few.queries);
    } finally {
      await prisma.$disconnect();
    }
  });
});
