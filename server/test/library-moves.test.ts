import { PrismaPg } from "@prisma/adapter-pg";
import { globalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { BeanBatchesService } from "../src/library/bean-batches.service.js";
import type { PrismaService } from "../src/prisma.service.js";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, type TestApp, serveTestApp } from "./support/assistants.js";
import { LoadedTablets, emptyLibrary } from "./support/loaded-tablets.js";
import { waitForLockWaits } from "./support/lock-waits.js";
import { shotFixture } from "./support/shot-fixtures.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, adminDatabaseUrl, startTestServer } from "./support/test-server.js";

// Seam 1, the REST API and the assistant tools for ticket #704 (ADR-0037): a
// Batch Move takes a Bean Batch from one Location it is at to another, all of
// it or part of its weight, and never changes the batch's total. Tablets are
// simulated, running the built plugin, on two server instances sharing one
// database. Serials are made up, from 70401.

type Record_ = Record<string, unknown>;

interface Source {
  machine: { id: string; name: string } | null;
  tabletId: string | null;
  account: { id: string; name: string | null } | null;
  connectedApp: unknown;
}

interface MovedWith {
  location: LocationView;
  weight: number;
}

interface AtLocation {
  location: LocationView;
  remainingWeight: number | null;
  entered: { weight: number; at: string; by: Source | null; arrivedFrom: LocationView | null } | null;
  used: { shots: number; weight: number } | null;
  moved: { in: number; from: MovedWith[]; away: number; to: MovedWith[] } | null;
}

interface BatchView {
  id: string;
  archived: boolean;
  locations: AtLocation[];
  totalRemainingWeight: number | null;
  finished: { location: LocationView; remainingWeight: number | null }[];
  content: Record_;
}

interface LostEdit {
  field: string;
  value: unknown;
  location: LocationView | null;
  source: Source;
  lostTo: { value: unknown; source: Source } | null;
}

interface Version {
  fields: Record_;
  location: LocationView | null;
  source: Source;
  move: { from: LocationView | null; to: LocationView | null; amount: number | null; all: boolean } | null;
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

describe("A Batch Move between Locations", { timeout: 120_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  let otherApi: AdminApi;
  let app: TestApp;
  let assistant: Assistant;
  let lab: Place;
  let cafe: Place;
  let annex: LocationView;
  let bean: string;
  let me: string;
  const opened: Assistant[] = [];
  const tablets = new LoadedTablets();
  let serials = 70400;
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
    const cookie = await signIn(server.url, admin);
    otherApi = AdminApi.signedInAs(other.url, cookie);
    app = await serveTestApp();
    assistant = await Assistant.connect(server.url, app, cookie);
    lab = await placeNamed("Move lab");
    cafe = await placeNamed("Move cafe", other);
    // A third Location, with no tablet.
    annex = await api.createLocation("Move annex", "America/Chicago");
    bean = (await api.send<{ bean: { id: string } }>("POST", "/beans", { content: { roaster: "Roux", name: "Moved Guji" } }, 201)).bean.id;
    me = (await api.get<{ account: { id: string } }>("/session")).account.id;
  });
  afterAll(async () => {
    for (const theirs of opened) await theirs.close();
    await assistant?.close();
    await tablets.unloadAll();
    await app?.close();
    await other?.stop();
    await server?.stop();
  });

  const getBatch = async (id: string, as: AdminApi = api) => (await as.get<{ batch: BatchView }>(`/bean-batches/${id}`)).batch;
  const at = (batch: BatchView, where: Place | LocationView) => batch.locations.find((here) => here.location.id === idOf(where));
  const idOf = (where: Place | LocationView) => ("location" in where ? where.location.id : where.id);
  /** The batch's Remaining Weight at the Location: undefined where it is not there, null where it is untracked there. */
  const weightAt = async (id: string, where: Place | LocationView) => at(await getBatch(id), where)?.remainingWeight;
  const put = (id: string, where: Place | LocationView, body: Record_, as: AdminApi = api) => as.call("PUT", `/bean-batches/${id}/locations/${idOf(where)}`, body);
  const versions = async (id: string, as: AdminApi = api) => (await as.get<{ versions: Version[] }>(`/bean-batches/${id}/history`)).versions;
  const held = (tablet: SimulatedTablet, id: string) => tablet.batches().find((record) => globalIdOf(record) === id);
  const moveBody = (from: Place | LocationView, to: Place | LocationView, amount: number | "all" | "some") => ({ fromLocationId: idOf(from), toLocationId: idOf(to), amount });
  /** Moves the batch over REST, which must answer with the status. */
  const move = async (id: string, from: Place | LocationView, to: Place | LocationView, amount: number | "all" | "some", as: AdminApi = api) =>
    (await as.send<{ batch: BatchView }>("POST", `/bean-batches/${id}/moves`, moveBody(from, to, amount))).batch;

  /** A batch of the Bean created at the Location, as the request's Location entry and content give it, once the Location's tablet holds it. */
  async function batchAt(place: Place, entry: Record_ = {}, content: Record_ = {}): Promise<string> {
    const { batch } = await api.send<{ batch: BatchView }>("POST", "/bean-batches", { beanId: bean, content, locations: [{ locationId: place.location.id, ...entry }] }, 201);
    await expect.poll(() => held(place.tablet, batch.id)).toBeTruthy();
    return batch.id;
  }

  /** Pulls a Shot on the Location's Machine with the batch in its Workflow, measuring the dose, and waits until the server has linked it. */
  async function pull(place: Place, batchId: string, dose: number, pulledAt: Date = minutes(1)): Promise<string> {
    const id = `move-${++shots}`;
    place.tablet.pullShot(shotOf(place, batchId, id, dose, pulledAt));
    await expect.poll(async () => ((await (await api.call("GET", `/shots/${id}`)).json()) as { shot?: { beanBatch: { id: string } | null } }).shot?.beanBatch?.id, { timeout: 15_000 }).toBe(batchId);
    return id;
  }

  /** A Shot's record as the Location's tablet would hold it, with the batch in its Workflow by the tablet's own id for it. */
  function shotOf(place: Place, batchId: string, id: string, dose: number, pulledAt: Date): Record_ {
    const fixture = shotFixture();
    const workflow = fixture.workflow as Record_;
    return {
      ...fixture,
      id,
      timestamp: pulledAt.toISOString(),
      annotations: { ...((fixture.annotations ?? {}) as Record_), actualDoseWeight: dose },
      workflow: {
        ...workflow,
        machine: { ...(workflow.machine as Record_), serialNumber: place.serial },
        context: { ...(workflow.context as Record_), beanBatchId: held(place.tablet, batchId)!.id },
      },
    };
  }

  /** A tool's error, which the call must answer with. */
  async function toolError(name: string, args: Record_, as: Assistant = assistant): Promise<string> {
    const result = await as.client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).toBe(true);
    return (result.content as { text: string }[]).map((block) => block.text).join("\n");
  }

  /** The REST API's refusal of a request, which must be refused with the status, as its message. */
  async function restRefusal(path: string, body: unknown, status: number, as: AdminApi = api): Promise<string> {
    const response = await as.call("POST", path, body);
    expect(response.status, path).toBe(status);
    const { message } = (await response.json()) as { message: string | string[] };
    return Array.isArray(message) ? message.join("; ") : message;
  }

  /** A Staff member, with an assistant connected as them, their REST API and their account's id. */
  async function staffAt(email: string, ...locations: LocationView[]): Promise<{ assistant: Assistant; api: AdminApi }> {
    const { link } = await api.invite(email, "staff", locations.map((location) => location.id));
    const cookie = await acceptInvite(server.url, link, { name: email, password: "a password for moves" });
    const theirs = await Assistant.connect(server.url, app, cookie);
    opened.push(theirs);
    return { assistant: theirs, api: AdminApi.signedInAs(server.url, cookie) };
  }

  it("moves an amount over REST: it leaves one Location's weight and joins the other's, the total unchanged, read with what was moved since each count started and where a count arrived from, as the list and the assistant tools read it", async () => {
    const id = await batchAt(lab, { remainingWeight: 6000 }, { roastDate: "2026-11-18" });
    const moved = await move(id, lab, cafe, 5700);
    expect(moved.totalRemainingWeight).toBe(6000);
    // The batch was not at the cafe: it is added there, and the amount arriving is where its count starts.
    expect(at(moved, cafe)).toMatchObject({
      remainingWeight: 5700,
      entered: { weight: 5700, by: { account: { id: me }, machine: null }, arrivedFrom: { id: lab.location.id, name: "Move lab" } },
      used: { shots: 0, weight: 0 },
      moved: { in: 0, from: [], away: 0, to: [] },
    });
    // The lab's count does not start again: its weight is what was entered, less what moved away.
    expect(at(moved, lab)).toMatchObject({
      remainingWeight: 300,
      entered: { weight: 6000, arrivedFrom: null },
      moved: { in: 0, from: [], away: 5700, to: [{ location: { id: cafe.location.id }, weight: 5700 }] },
    });
    expect(moved.finished).toEqual([]);
    await expect.poll(() => held(cafe.tablet, id)?.archived, { timeout: 15_000 }).toBe(false);
    // The cafe's tablets hold the weight its count starts from.
    expect(held(cafe.tablet, id)).toMatchObject({ weightRemaining: 5700 });
    expect(held(lab.tablet, id)).toMatchObject({ archived: false });

    // A second delivery to a Location that has some raises its weight by the amount, and some moved back lowers it.
    const again = await move(id, lab, cafe, 100);
    expect(at(again, cafe)).toMatchObject({ remainingWeight: 5800, entered: { weight: 5700 }, moved: { in: 100, from: [{ location: { id: lab.location.id }, weight: 100 }], away: 0, to: [] } });
    expect(at(again, lab)).toMatchObject({ remainingWeight: 200, moved: { away: 5800 } });
    const back = await move(id, cafe, lab, 50.5, otherApi);
    expect(back).toMatchObject({ totalRemainingWeight: 6000 });
    expect(at(back, cafe)).toMatchObject({ remainingWeight: 5749.5, moved: { in: 100, away: 50.5, to: [{ location: { id: lab.location.id }, weight: 50.5 }] } });
    expect(at(back, lab)).toMatchObject({ remainingWeight: 250.5, moved: { in: 50.5, from: [{ location: { id: cafe.location.id }, weight: 50.5 }], away: 5800 } });

    // The list, the Bean's read and the assistant tools give the same.
    const batch = await getBatch(id);
    const { content: _content, finished: _finished, ...summary } = batch;
    const { batches } = await api.get<{ batches: BatchView[] }>("/bean-batches");
    expect(batches.find((listed) => listed.id === id)).toEqual(summary);
    const read = await api.get<{ bean: { batches: BatchView[] } }>(`/beans/${bean}`);
    expect(read.bean.batches.find((listed) => listed.id === id)).toEqual(summary);
    const got = await assistant.call<{ beanBatch: Record_ }>("get_library_item", { kind: "beanBatch", id });
    expect(comparable(got.beanBatch)).toEqual(comparable(batch));
    const found = await assistant.call<{ beanBatches: { id: string }[] }>("find_library_items", { kind: "beanBatch", limit: 50 });
    expect(comparable(found.beanBatches.find((listed) => listed.id === id))).toEqual(comparable(summary));
  });

  it("moves an amount through the assistant tool as REST does, as one history entry naming both Locations and the amount, made by the account through its Connected App", async () => {
    const id = await batchAt(lab, { remainingWeight: 1000 });
    const answered = await assistant.call<{ beanBatch: BatchView }>("move_bean_batch", { id, fromLocationId: lab.location.id, toLocationId: cafe.location.id, amount: 400 });
    expect(answered.beanBatch.totalRemainingWeight).toBe(1000);
    expect(at(answered.beanBatch, lab)).toMatchObject({ remainingWeight: 600, moved: { away: 400 } });
    expect(at(answered.beanBatch, cafe)).toMatchObject({ remainingWeight: 400, entered: { weight: 400, arrivedFrom: { id: lab.location.id } } });
    expect(comparable(answered.beanBatch)).toEqual(comparable(await getBatch(id)));

    await move(id, cafe, lab, 150);
    const [second, first, ...earlier] = await versions(id);
    // One entry each: nothing else was kept for the add at the cafe or for either weight.
    expect(earlier.every((version) => version.move === null)).toBe(true);
    expect(earlier.some((version) => version.location?.id === cafe.location.id)).toBe(false);
    expect(first).toMatchObject({
      location: { id: cafe.location.id },
      move: { from: { id: lab.location.id, name: "Move lab" }, to: { id: cafe.location.id, name: "Move cafe" }, amount: 400, all: false },
      fields: { movedFrom: lab.location.id, movedAmount: 400, movedAll: false, atLocation: true, remainingWeight: 400 },
      source: { account: { id: me, name: admin.name }, machine: null, connectedApp: { name: expect.any(String) } },
    });
    expect(second).toMatchObject({
      location: { id: lab.location.id },
      move: { from: { id: cafe.location.id }, to: { id: lab.location.id }, amount: 150, all: false },
      source: { account: { id: me }, machine: null, connectedApp: null },
    });
    // It set nothing at the lab but its weight, by the move's row.
    expect(second!.fields).toEqual({ movedFrom: cafe.location.id, movedAmount: 150, movedAll: false });
    // The assistant reads the entry as the REST API does.
    const history = await assistant.call<{ history: { entries: Record_[] } }>("get_library_item", { kind: "beanBatch", id, history: true });
    expect(history.history.entries[0]).toMatchObject({ move: { from: { id: cafe.location.id }, to: { id: lab.location.id }, amount: 150, all: false }, lost: false });
    expect(history.history.entries[1]).toMatchObject({ move: { from: { id: lab.location.id }, to: { id: cafe.location.id }, amount: 400, all: false } });
  });

  it("moves all: everything the Location left had joins the other, and the batch is finished where it left, archived on its tablets and un-archived on the joined Location's, over REST and through the assistant tool", async () => {
    for (const through of ["rest", "tool"] as const) {
      const id = await batchAt(lab, { remainingWeight: 2920 });
      await pull(lab, id, 20);
      const batch =
        through === "rest"
          ? await move(id, lab, cafe, "all")
          : (await assistant.call<{ beanBatch: BatchView }>("move_bean_batch", { id, fromLocationId: lab.location.id, toLocationId: cafe.location.id, amount: "all" })).beanBatch;
      expect(batch.locations.map((here) => here.location.id), through).toEqual([cafe.location.id]);
      expect(batch).toMatchObject({ archived: false, totalRemainingWeight: 2900, finished: [{ location: { id: lab.location.id }, remainingWeight: 0 }] });
      expect(at(batch, cafe)).toMatchObject({ remainingWeight: 2900, entered: { weight: 2900, arrivedFrom: { id: lab.location.id } }, moved: { in: 0, away: 0 } });
      const [latest] = await versions(id);
      expect(latest).toMatchObject({
        location: { id: cafe.location.id },
        move: { from: { id: lab.location.id }, to: { id: cafe.location.id }, amount: 2900, all: true },
        fields: { movedFrom: lab.location.id, movedAmount: 2900, movedAll: true, atLocation: true, remainingWeight: 2900 },
      });
      await expect.poll(() => held(lab.tablet, id)?.archived, { timeout: 15_000 }).toBe(true);
      await expect.poll(() => held(cafe.tablet, id)?.archived, { timeout: 15_000 }).toBe(false);
      expect(held(cafe.tablet, id)).toMatchObject({ weightRemaining: 2900 });
    }
  });

  it("moves all to a Location that has the batch already, raising its weight there by what the Location left had, and moves it back to a Location it was finished at, where the amount arriving is where its count starts", async () => {
    const id = await batchAt(lab, { remainingWeight: 1000 });
    await move(id, lab, cafe, 400);
    const all = await move(id, lab, cafe, "all");
    expect(all).toMatchObject({ totalRemainingWeight: 1000, finished: [{ location: { id: lab.location.id }, remainingWeight: 0 }] });
    expect(at(all, cafe)).toMatchObject({ remainingWeight: 1000, entered: { weight: 400 }, moved: { in: 600, away: 0 } });
    await expect.poll(() => held(lab.tablet, id)?.archived, { timeout: 15_000 }).toBe(true);

    // Sent back in part: the lab is added again, its count starting from what arrives, not from what it had before.
    const back = await move(id, cafe, lab, 300);
    expect(back).toMatchObject({ totalRemainingWeight: 1000, finished: [] });
    expect(at(back, lab)).toMatchObject({ remainingWeight: 300, entered: { weight: 300, arrivedFrom: { id: cafe.location.id } }, moved: { in: 0, away: 0 } });
    expect(at(back, cafe)).toMatchObject({ remainingWeight: 700, moved: { in: 600, away: 300 } });
    await expect.poll(() => held(lab.tablet, id)?.archived, { timeout: 15_000 }).toBe(false);
  });

  it("makes the amount arriving the weight of a Location that has the batch with no weight", async () => {
    const id = await batchAt(lab, { remainingWeight: 800 });
    expect((await put(id, cafe, { atLocation: true })).status).toBe(200);
    expect(await weightAt(id, cafe)).toBeNull();
    const moved = await move(id, lab, cafe, 250);
    expect(moved.totalRemainingWeight).toBe(800);
    expect(at(moved, cafe)).toMatchObject({ remainingWeight: 250, entered: { weight: 250, arrivedFrom: { id: lab.location.id } } });
    expect(at(moved, lab)).toMatchObject({ remainingWeight: 550 });
    // It was there already, so the move added it nowhere: its entry says only the weight it set.
    expect((await versions(id))[0]!.fields).toEqual({ movedFrom: lab.location.id, movedAmount: 250, movedAll: false, remainingWeight: 250 });
  });

  it("refuses an amount of zero and a negative one as a bad request, and one equal to or above what the Location left has, saying to move all or enter a weight, over REST and through the assistant tool", async () => {
    const id = await batchAt(lab, { remainingWeight: 500 });
    const path = `/bean-batches/${id}/moves`;
    const args = (amount: unknown) => ({ id, fromLocationId: lab.location.id, toLocationId: cafe.location.id, amount });
    for (const amount of [0, -5, 0.04]) {
      expect(await restRefusal(path, moveBody(lab, cafe, amount), 400)).toContain("above 0");
      expect(await toolError("move_bean_batch", args(amount))).toContain("above 0");
    }
    for (const amount of [null, "half", "5700"]) expect(await restRefusal(path, { ...moveBody(lab, cafe, 1), amount }, 400)).toContain("above 0");
    for (const amount of [500, 500.5, 9000]) {
      const refusal = await restRefusal(path, moveBody(lab, cafe, amount), 409);
      expect(refusal).toBe("Move lab has 500 g of the batch, and an amount moved is less than what is there: move all of it, or enter a corrected weight there first");
      expect(await toolError("move_bean_batch", args(amount))).toContain(refusal);
    }
    // "Some" is for a batch with no weight where it is.
    expect(await restRefusal(path, moveBody(lab, cafe, "some"), 409)).toBe("Move lab has 500 g of the batch: move all of it, or an amount in grams");
    // A Location to itself, one that does not exist, a batch that does not, and a Location it is not at.
    expect(await restRefusal(path, moveBody(lab, lab, 100), 400)).toContain("same one");
    expect(await restRefusal(path, { ...moveBody(lab, cafe, 100), toLocationId: "00000000-0000-4000-8000-000000000000" }, 404)).toBe("No such Location");
    expect(await restRefusal("/bean-batches/00000000-0000-4000-8000-000000000000/moves", moveBody(lab, cafe, 100), 404)).toBe("No such Bean Batch");
    expect(await restRefusal(path, moveBody(cafe, lab, 100), 409)).toBe("The batch is not at Move cafe: it is moved from a Location it is at");
    expect(await toolError("move_bean_batch", { id, fromLocationId: cafe.location.id, toLocationId: lab.location.id, amount: "all" })).toContain("The batch is not at Move cafe");
    // Nothing moved.
    expect(await getBatch(id)).toMatchObject({ totalRemainingWeight: 500, locations: [{ location: { id: lab.location.id }, remainingWeight: 500, moved: { in: 0, away: 0 } }] });
    expect((await versions(id)).some((version) => version.move !== null)).toBe(false);
    // What the Location left has is what Shots have left of it.
    await pull(lab, id, 100);
    expect(await restRefusal(path, moveBody(lab, cafe, 400), 409)).toContain("Move lab has 400 g of the batch");
    expect(at(await move(id, lab, cafe, 399.9), lab)).toMatchObject({ remainingWeight: 0.1 });
  });

  it("moves a batch with no weight at the Location left as all or as some, changing no weight, and refuses an amount, and some to a Location it is at already", async () => {
    const id = await batchAt(lab, { remainingWeight: null });
    const path = `/bean-batches/${id}/moves`;
    expect(await restRefusal(path, moveBody(lab, cafe, 100), 409)).toBe(
      "No weight is entered for the batch at Move lab, so no amount of it can be moved: move all of it or some of it, or enter its weight there first",
    );
    // Some: added at the cafe, and left at the lab.
    const some = await move(id, lab, cafe, "some");
    expect(some).toMatchObject({ totalRemainingWeight: null, finished: [] });
    expect(some.locations).toMatchObject([
      { location: { id: cafe.location.id }, remainingWeight: null, entered: null, moved: null },
      { location: { id: lab.location.id }, remainingWeight: null, entered: null, moved: null },
    ]);
    expect((await versions(id))[0]).toMatchObject({
      location: { id: cafe.location.id },
      move: { from: { id: lab.location.id }, to: { id: cafe.location.id }, amount: null, all: false },
      fields: { movedFrom: lab.location.id, movedAmount: null, movedAll: false, atLocation: true },
    });
    await expect.poll(() => held(cafe.tablet, id)?.archived, { timeout: 15_000 }).toBe(false);
    expect(await restRefusal(path, moveBody(lab, cafe, "some"), 409)).toBe("The batch is at Move cafe already, and has no weight at Move lab to move: nothing would change");
    expect(await toolError("move_bean_batch", { id, fromLocationId: lab.location.id, toLocationId: cafe.location.id, amount: "some" })).toContain("nothing would change");

    // All: finished at the lab, and at the cafe as it was, with no weight anywhere.
    const all = (await assistant.call<{ beanBatch: BatchView }>("move_bean_batch", { id, fromLocationId: lab.location.id, toLocationId: cafe.location.id, amount: "all" })).beanBatch;
    expect(all).toMatchObject({ totalRemainingWeight: null, finished: [{ location: { id: lab.location.id }, remainingWeight: null }] });
    expect(all.locations).toMatchObject([{ location: { id: cafe.location.id }, remainingWeight: null, entered: null }]);
    expect((await versions(id))[0]).toMatchObject({ move: { amount: null, all: true }, fields: { movedFrom: lab.location.id, movedAmount: null, movedAll: true } });
    await expect.poll(() => held(lab.tablet, id)?.archived, { timeout: 15_000 }).toBe(true);

    // A weight at the Location joined is left as it is by a move that moves none.
    const weighed = await batchAt(lab, { remainingWeight: null });
    expect((await put(weighed, cafe, { atLocation: true, remainingWeight: 120 })).status).toBe(200);
    expect(await move(weighed, lab, cafe, "all")).toMatchObject({ totalRemainingWeight: 120, locations: [{ remainingWeight: 120, entered: { weight: 120, arrivedFrom: null }, moved: { in: 0 } }] });

    // One that brings it back to a Location it was finished at leaves it untracked there, not with the weight that count was left with.
    for (const amount of ["some", "all"] as const) {
      const back = await batchAt(lab, { remainingWeight: null });
      expect((await put(back, cafe, { atLocation: true, remainingWeight: 120 })).status).toBe(200);
      expect((await put(back, cafe, { atLocation: false })).status).toBe(200);
      const moved = await move(back, lab, cafe, amount);
      expect(moved.totalRemainingWeight, amount).toBeNull();
      expect(at(moved, cafe), amount).toMatchObject({ remainingWeight: null, entered: null, moved: null });
      expect((await versions(back))[0], amount).toMatchObject({ fields: { movedAmount: null, atLocation: true, remainingWeight: null } });
    }
  });

  it("keeps a move apart from a weight entered: a Shot pulled at the Location left before the move and stored after it still lowers that Location's weight", async () => {
    const id = await batchAt(lab, { remainingWeight: 1000 });
    // Pulled now, after the weight was entered, and stored only once the amount has moved.
    const pulledAt = new Date();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const moved = await move(id, lab, cafe, 600);
    expect(at(moved, lab)).toMatchObject({ remainingWeight: 400, used: { shots: 0, weight: 0 } });
    lab.tablet.pullShot(shotOf(lab, id, `move-${++shots}`, 18, pulledAt));
    await expect.poll(() => weightAt(id, lab), { timeout: 15_000 }).toBe(382);
    const batch = await getBatch(id);
    expect(at(batch, lab)).toMatchObject({ entered: { weight: 1000 }, used: { shots: 1, weight: 18 }, moved: { away: 600 } });
    expect(at(batch, cafe)).toMatchObject({ remainingWeight: 600 });
    expect(batch.totalRemainingWeight).toBe(982);
  });

  it("starts a Location's count again when a weight is entered there after a move, at either Location, and no longer lists the move as since", async () => {
    const id = await batchAt(lab, { remainingWeight: 1000 });
    await move(id, lab, cafe, 300);
    await move(id, lab, cafe, 100);
    expect(await getBatch(id)).toMatchObject({ totalRemainingWeight: 1000, locations: [{ remainingWeight: 400, moved: { in: 100 } }, { remainingWeight: 600, moved: { away: 400 } }] });

    // Weighed at the lab: what is there is what was entered, and the moves away are no longer since.
    expect((await put(id, lab, { remainingWeight: 580 })).status).toBe(200);
    const weighed = await getBatch(id);
    expect(at(weighed, lab)).toMatchObject({ remainingWeight: 580, entered: { weight: 580, arrivedFrom: null }, moved: { in: 0, from: [], away: 0, to: [] } });
    // The cafe's count is as it was.
    expect(at(weighed, cafe)).toMatchObject({ remainingWeight: 400, entered: { weight: 300, arrivedFrom: { id: lab.location.id } }, moved: { in: 100 } });

    // Weighed at the cafe, through the assistant tool: its count no longer starts with a move.
    await assistant.call("set_location_offering", { kind: "beanBatch", id, locationId: cafe.location.id, remainingWeight: 410 });
    expect(at(await getBatch(id), cafe)).toMatchObject({ remainingWeight: 410, entered: { weight: 410, arrivedFrom: null }, moved: { in: 0, from: [], away: 0, to: [] } });
    // A move after the entries counts since them.
    expect(await move(id, cafe, lab, 10)).toMatchObject({
      totalRemainingWeight: 990,
      locations: [{ remainingWeight: 400, moved: { in: 0, away: 10 } }, { remainingWeight: 590, moved: { in: 10, away: 0 } }],
    });

    // A weight a barista enters on a tablet starts the count again too.
    await expect.poll(() => held(cafe.tablet, id)?.weightRemaining, { timeout: 15_000 }).toBe(410);
    await cafe.tablet.editBatch(held(cafe.tablet, id)!.id, { weightRemaining: 350 });
    await expect.poll(() => weightAt(id, cafe), { timeout: 15_000 }).toBe(350);
    expect(at(await getBatch(id), cafe)).toMatchObject({ entered: { weight: 350, by: { machine: { id: cafe.machine.machine.id } } }, moved: { in: 0, away: 0 } });
  });

  it("keeps a weight a barista entered offline before a move as a Lost Edit that lost to the move, read with what the move left at its Location: zero where it took all, and the amount that arrived where a count started with it", async () => {
    const id = await batchAt(lab, { remainingWeight: 500 });
    expect((await put(id, cafe, { atLocation: true })).status).toBe(200);
    await expect.poll(() => held(cafe.tablet, id)?.archived, { timeout: 15_000 }).toBe(false);
    // Both baristas weigh the bucket while their tablets are offline, and then all of it is moved to the cafe.
    lab.tablet.loseNetwork();
    cafe.tablet.loseNetwork();
    try {
      await lab.tablet.editBatch(held(lab.tablet, id)!.id, { weightRemaining: 450 });
      await cafe.tablet.editBatch(held(cafe.tablet, id)!.id, { weightRemaining: 77 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await move(id, lab, cafe, "all")).toMatchObject({ totalRemainingWeight: 500, locations: [{ location: { id: cafe.location.id }, remainingWeight: 500 }] });
    } finally {
      lab.tablet.restoreNetwork();
      cafe.tablet.restoreNetwork();
    }
    const lostEdits = async () => (await api.get<{ lostEdits: LostEdit[] }>(`/bean-batches/${id}/history`)).lostEdits;
    await expect.poll(async () => (await lostEdits()).length, { timeout: 15_000 }).toBe(2);
    const lost = await lostEdits();
    // Each lost to the move, which the account made, by what it left at that Location.
    expect(lost.find((edit) => edit.location?.id === lab.location.id)).toMatchObject({
      field: "remainingWeight",
      value: 450,
      source: { machine: { id: lab.machine.machine.id } },
      lostTo: { value: 0, source: { account: { id: me } } },
    });
    expect(lost.find((edit) => edit.location?.id === cafe.location.id)).toMatchObject({
      field: "remainingWeight",
      value: 77,
      source: { machine: { id: cafe.machine.machine.id } },
      lostTo: { value: 500, source: { account: { id: me } } },
    });
    // Neither entry changed a weight, and each tablet is written its Location's state again.
    expect(await getBatch(id)).toMatchObject({ totalRemainingWeight: 500, finished: [{ location: { id: lab.location.id }, remainingWeight: 0 }] });
    await expect.poll(() => held(cafe.tablet, id)?.weightRemaining, { timeout: 15_000 }).toBe(500);
    await expect.poll(() => held(lab.tablet, id)?.archived, { timeout: 15_000 }).toBe(true);
  });

  it("starts the joined Location's count from the amount arriving where Shots had used more than it held, so the move keeps the total", async () => {
    const id = await batchAt(lab, { remainingWeight: 1000 });
    await move(id, lab, cafe, 30);
    await expect.poll(() => held(cafe.tablet, id)?.archived, { timeout: 15_000 }).toBe(false);
    // Pulled now, before the next move is made.
    await pull(cafe, id, 45, new Date());
    // The cafe reads zero, having used 15 g more than it held.
    expect(await getBatch(id)).toMatchObject({ totalRemainingWeight: 970, locations: [{ remainingWeight: 0 }, { remainingWeight: 970 }] });
    const moved = await move(id, lab, cafe, 200);
    expect(moved.totalRemainingWeight).toBe(970);
    expect(at(moved, cafe)).toMatchObject({ remainingWeight: 200, entered: { weight: 200, arrivedFrom: { id: lab.location.id } }, used: { shots: 0, weight: 0 }, moved: { in: 0 } });
    expect(at(moved, lab)).toMatchObject({ remainingWeight: 770 });
  });

  it("lets Staff move a batch from a Location in their scope to one outside it and from one outside it to one in it, and refuses a move between two outside it, over REST and through the assistant tool", async () => {
    const sam = await staffAt("sam-704@example.com", lab.location);
    const id = await batchAt(lab, { remainingWeight: 900 });
    const args = (from: Place | LocationView, to: Place | LocationView, amount: number | "all") => ({ id, fromLocationId: idOf(from), toLocationId: idOf(to), amount });

    // From theirs to another, over REST; from another to theirs, through the tool.
    expect(await move(id, lab, cafe, 500, sam.api)).toMatchObject({ totalRemainingWeight: 900 });
    const back = await sam.assistant.call<{ beanBatch: BatchView }>("move_bean_batch", args(cafe, lab, 100));
    expect(back.beanBatch).toMatchObject({ totalRemainingWeight: 900, locations: [{ remainingWeight: 400 }, { remainingWeight: 500 }] });
    // And the other way about by each.
    await sam.assistant.call("move_bean_batch", args(lab, cafe, 50));
    expect(await move(id, cafe, lab, 25, sam.api)).toMatchObject({ locations: [{ remainingWeight: 425 }, { remainingWeight: 475 }] });
    // The move is theirs, named to an Admin and not to them.
    expect((await versions(id))[0]!.source.account).toMatchObject({ name: "sam-704@example.com" });
    expect((await versions(id, sam.api))[0]!.source.account).toMatchObject({ name: null });

    // Between two Locations they do not work at.
    const refusal = "Staff move a batch only from or to a Location they work at";
    expect(await restRefusal(`/bean-batches/${id}/moves`, moveBody(cafe, annex, 10), 403, sam.api)).toBe(refusal);
    expect(await toolError("move_bean_batch", args(cafe, annex, "all"), sam.assistant)).toContain(refusal);
    expect(await getBatch(id)).toMatchObject({ locations: [{ remainingWeight: 425 }, { remainingWeight: 475 }] });

    // Finishing, entering a weight, clearing one and adding without moving still need the Location.
    for (const body of [{ atLocation: false }, { remainingWeight: 300 }, { remainingWeight: null }]) expect((await put(id, cafe, body, sam.api)).status).toBe(403);
    expect((await put(id, annex, { atLocation: true }, sam.api)).status).toBe(403);
    expect((await put(id, lab, { remainingWeight: 470 }, sam.api)).status).toBe(200);

    // A Viewer moves nothing.
    const { link } = await api.invite("vic-704@example.com", "viewer", []);
    const viewer = AdminApi.signedInAs(server.url, await acceptInvite(server.url, link, { name: "Vic", password: "a password for moves" }));
    expect((await viewer.call("POST", `/bean-batches/${id}/moves`, moveBody(lab, cafe, 10))).status).toBe(403);
  });

  /**
   * Makes the requests while the test holds the Location's lock (`lockLocation`), letting go once each waits for it, so
   * they are made at once and the server's locks alone put them in an order.
   */
  async function atOnce(locationId: string, requests: () => Promise<Response>[]): Promise<Response[]> {
    const database = await server.connectDatabase();
    try {
      await database.query("BEGIN");
      await database.query("SELECT pg_advisory_xact_lock(4000007, hashtext($1::text))", [locationId]);
      const made = requests();
      await waitForLockWaits(server, { count: made.length, advisory: true });
      await database.query("COMMIT");
      return await Promise.all(made);
    } finally {
      await database.end();
    }
  }

  it("makes two moves of one batch from one Location at once one after the other, through two instances: its weight is never below zero and the total is what one of the two orders gives", async () => {
    const id = await batchAt(lab, { remainingWeight: 1000 });
    // 700 g to the cafe and 600 g to the annex cannot both be had: whichever is second is refused.
    const [toCafe, toAnnex] = await atOnce(lab.location.id, () => [
      api.call("POST", `/bean-batches/${id}/moves`, moveBody(lab, cafe, 700)),
      otherApi.call("POST", `/bean-batches/${id}/moves`, moveBody(lab, annex, 600)),
    ]);
    expect([toCafe!.status, toAnnex!.status].sort()).toEqual([200, 409]);
    const batch = await getBatch(id);
    expect(batch.totalRemainingWeight).toBe(1000);
    expect(at(batch, lab)!.remainingWeight).toBe(toCafe!.status === 200 ? 300 : 400);
    expect(at(batch, toCafe!.status === 200 ? cafe : annex)!.remainingWeight).toBe(toCafe!.status === 200 ? 700 : 600);
    expect(batch.locations).toHaveLength(2);

    // All and an amount at once: either the amount went first and all took the rest, or all went first and the amount is refused.
    const both = await batchAt(lab, { remainingWeight: 1000 });
    const [all, part] = await atOnce(lab.location.id, () => [
      api.call("POST", `/bean-batches/${both}/moves`, moveBody(lab, cafe, "all")),
      otherApi.call("POST", `/bean-batches/${both}/moves`, moveBody(lab, annex, 250)),
    ]);
    expect(all!.status).toBe(200);
    expect([200, 409]).toContain(part!.status);
    const after = await getBatch(both);
    expect(after.totalRemainingWeight).toBe(1000);
    expect(at(after, lab)).toBeUndefined();
    expect(at(after, cafe)!.remainingWeight).toBe(part!.status === 200 ? 750 : 1000);
    expect(at(after, annex)?.remainingWeight).toBe(part!.status === 200 ? 250 : undefined);

    // Two moves in opposite directions at once, each waiting for the lock of the Location first in id order: had either taken
    // the other first, the two would deadlock once it is let go. Both are made.
    const crossed = await batchAt(lab, { remainingWeight: 1000 });
    await move(crossed, lab, cafe, 500);
    const [first] = [lab.location.id, cafe.location.id].sort((a, b) => a.localeCompare(b));
    const pair = await atOnce(first!, () => [
      api.call("POST", `/bean-batches/${crossed}/moves`, moveBody(lab, cafe, 100)),
      otherApi.call("POST", `/bean-batches/${crossed}/moves`, moveBody(cafe, lab, 40)),
    ]);
    expect(pair.map((response) => response.status)).toEqual([200, 200]);
    expect(await getBatch(crossed)).toMatchObject({ totalRemainingWeight: 1000, locations: [{ remainingWeight: 560 }, { remainingWeight: 440 }] });
  });

  it("adds a batch without moving it, by the placement route and the assistant tool, changing no weight at any other Location", async () => {
    const id = await batchAt(lab, { remainingWeight: 700 });
    expect((await put(id, cafe, { atLocation: true })).status).toBe(200);
    expect(await getBatch(id)).toMatchObject({ totalRemainingWeight: 700, locations: [{ location: { id: cafe.location.id }, remainingWeight: null, moved: null }, { remainingWeight: 700, moved: { in: 0, away: 0 } }] });
    await assistant.call("set_location_offering", { kind: "beanBatch", id, locationId: annex.id, offered: true, remainingWeight: 50 });
    const batch = await getBatch(id);
    expect(at(batch, annex)).toMatchObject({ remainingWeight: 50, entered: { weight: 50, arrivedFrom: null }, moved: { in: 0 } });
    expect(at(batch, lab)).toMatchObject({ remainingWeight: 700, moved: { in: 0, away: 0 } });
    expect((await versions(id)).some((version) => version.move !== null)).toBe(false);
  });

  it("adds a batch a barista un-archives on a tablet at the tablet's Location, taking no weight from the Location that has it", async () => {
    const id = await batchAt(lab, { remainingWeight: 900 });
    await move(id, lab, cafe, "all");
    await expect.poll(() => held(lab.tablet, id)?.archived, { timeout: 15_000 }).toBe(true);
    await lab.tablet.editBatch(held(lab.tablet, id)!.id, { archived: false });
    await expect.poll(async () => (await getBatch(id)).locations.length, { timeout: 15_000 }).toBe(2);
    const batch = await getBatch(id);
    expect(at(batch, cafe)).toMatchObject({ remainingWeight: 900, moved: { in: 0, away: 0 } });
    expect(batch.totalRemainingWeight).toBe(900);
    expect((await versions(id))[0]).toMatchObject({ move: null, location: { id: lab.location.id }, source: { machine: { id: lab.machine.machine.id } } });
  });

  it("adds a batch a Recipe at another Location takes at that Location, changing no weight where it was", async () => {
    const id = await batchAt(lab, { remainingWeight: 640 });
    const response = await api.call("POST", "/recipes", { locationId: cafe.location.id, content: { name: "Moved Guji at the cafe", beanBatchId: id } });
    expect(response.status, await response.clone().text()).toBe(201);
    const batch = await getBatch(id);
    expect(at(batch, cafe)).toMatchObject({ remainingWeight: null, moved: null });
    expect(at(batch, lab)).toMatchObject({ remainingWeight: 640, moved: { in: 0, away: 0 } });
    expect(batch.totalRemainingWeight).toBe(640);
    expect((await versions(id)).some((version) => version.move !== null)).toBe(false);
  });

  it("reads a list of many moved batches with no query per batch", async () => {
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
      for (let made = 0; made < 10; made++) {
        const id = await batchAt(lab, { remainingWeight: 500 + made });
        await move(id, lab, cafe, 100);
        await move(id, lab, annex, 50);
        await move(id, cafe, annex, 10);
      }
      const many = await counted();
      expect(many.batches).toBe(few.batches + 10);
      expect(many.queries).toBe(few.queries);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("reads a batch in one snapshot: a move made between reading its Locations and reading the moves since is in neither, so the total is never short", async () => {
    const id = await batchAt(lab, { remainingWeight: 1000 });
    const url = new URL(adminDatabaseUrl());
    url.pathname = `/${server.database}`;
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.href }) });
    let moveBetween = true;
    // Each transaction's client, whose read of the batch's row makes the move, once, before it answers.
    const inTransaction = (tx: Record_) =>
      new Proxy(tx, {
        get: (target, key) =>
          key !== "beanBatch"
            ? Reflect.get(target, key)
            : {
                findUnique: async (args: unknown) => {
                  const row = await (target.beanBatch as { findUnique: (args: unknown) => Promise<unknown> }).findUnique(args);
                  if (moveBetween) {
                    moveBetween = false;
                    await move(id, lab, cafe, 600);
                  }
                  return row;
                },
              },
      });
    const prismaWithMove = new Proxy(prisma, {
      get: (target, key) =>
        key !== "$transaction"
          ? Reflect.get(target, key)
          : (fn: (tx: Record_) => Promise<unknown>, options: unknown) => (target.$transaction as (fn: unknown, options: unknown) => Promise<unknown>)((tx: Record_) => fn(inTransaction(tx)), options),
    });
    try {
      const during = await new BeanBatchesService(prismaWithMove as unknown as PrismaService).get(id, { kind: "everything" });
      expect(moveBetween).toBe(false);
      expect(during.totalRemainingWeight).toBe(1000);
      expect(during.locations.map((here) => [here.location.id, here.remainingWeight])).toEqual([[lab.location.id, 1000]]);
    } finally {
      await prisma.$disconnect();
    }
    const after = await getBatch(id);
    expect(after.totalRemainingWeight).toBe(1000);
    expect([await weightAt(id, lab), await weightAt(id, cafe)]).toEqual([400, 600]);
  });
});
