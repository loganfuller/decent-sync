import { PrismaPg } from "@prisma/adapter-pg";
import { globalIdOf } from "@decent-sync/protocol";
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

// Seam 1, the REST API and the assistant tools for ticket #707: the Recipes
// that name a Bean Batch, as its page lists them, and the Bean Batches at a
// Location, as the Location's page lists them, each with that Location's own
// Remaining Weight, Shots and Batch Moves (ADR-0037). Tablets are simulated,
// running the built plugin. Serials are made up, from 70701.

type Record_ = Record<string, unknown>;

interface NamingRecipe {
  id: string;
  name: string | null;
  location: LocationView | null;
  slot: number | null;
  batchFinished: boolean;
}

interface BatchHere {
  id: string;
  bean: { id: string; roaster: string | null; name: string | null };
  roastDate: string | null;
  batchCode: string | null;
  remainingWeight: number | null;
  entered: { weight: number; at: string; by: unknown; arrivedFrom: LocationView | null } | null;
  used: { shots: number; weight: number } | null;
  moved: { in: number; from: { location: LocationView; weight: number }[]; away: number; to: { location: LocationView; weight: number }[] } | null;
  since: string;
  recipes: { id: string; name: string | null; slot: number | null }[];
}

interface BatchPage {
  total: number;
  offset: number;
  more: boolean;
  beanBatches: BatchHere[];
}

interface BatchItem {
  beanBatch: { id: string; recipes: (Omit<NamingRecipe, "location"> & { location: LocationView | null; dose: number | null; yield: number | null })[] };
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

/** A time that many minutes from now: after a weight entered just now. */
const minutes = (count: number) => new Date(Date.now() + count * 60_000);

describe("A Bean Batch's Recipes and a Location's Bean Batches", { timeout: 120_000 }, () => {
  let server: TestServer;
  let api: AdminApi;
  let app: TestApp;
  let assistant: Assistant;
  let lab: Place;
  let cafe: Place;
  let bean: string;
  const opened: Assistant[] = [];
  const tablets = new LoadedTablets();
  let serials = 70700;
  let shots = 0;

  /** A Location with one Machine, whose tablet is online. */
  async function placeNamed(name: string): Promise<Place> {
    const location = await api.createLocation(name, "America/Chicago");
    const machine = await api.createMachine(`${name} bar`, location.id);
    const serial = String(++serials);
    const tablet = tablets.syncing(machine, server, { api: emptyLibrary(serial) });
    await api.waitForOnline(machine);
    return { location, machine, tablet, serial };
  }

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
    app = await serveTestApp();
    assistant = await Assistant.connect(server.url, app, await signIn(server.url, admin));
    lab = await placeNamed("Lists lab");
    cafe = await placeNamed("Lists cafe");
    bean = await beanNamed("Listed Guji");
  });
  afterAll(async () => {
    for (const theirs of opened) await theirs.close();
    await assistant?.close();
    await tablets.unloadAll();
    await app?.close();
    await server?.stop();
  });

  const beanNamed = async (name: string) => (await api.send<{ bean: { id: string } }>("POST", "/beans", { content: { roaster: "Roux", name } }, 201)).bean.id;
  const idOf = (where: Place | LocationView) => ("location" in where ? where.location.id : where.id);
  const held = (tablet: SimulatedTablet, id: string) => tablet.batches().find((record) => globalIdOf(record) === id);
  const namingOver = async (id: string, as: AdminApi = api) => (await as.get<{ batch: { recipes: NamingRecipe[] } }>(`/bean-batches/${id}`)).batch.recipes;
  const batchesAt = async (where: Place | LocationView, as: AdminApi = api) => (await as.get<{ batches: BatchHere[] }>(`/locations/${idOf(where)}/bean-batches`)).batches;
  /** The batch's row in the Location's list, or undefined where the list has none. */
  const rowAt = async (where: Place | LocationView, id: string) => (await batchesAt(where)).find((batch) => batch.id === id);
  /** Every page of a Location's batches as the tool lists them. */
  async function listed(where: Place | LocationView, as: Assistant = assistant): Promise<BatchHere[]> {
    const all: BatchHere[] = [];
    for (;;) {
      const page = await as.call<BatchPage>("list_location_batches", { locationId: idOf(where), limit: 50, offset: all.length });
      all.push(...page.beanBatches);
      if (!page.more) return all;
    }
  }
  const move = (id: string, from: Place | LocationView, to: Place | LocationView, amount: number | "all" | "some") =>
    api.send("POST", `/bean-batches/${id}/moves`, { fromLocationId: idOf(from), toLocationId: idOf(to), amount });

  /** A batch of a Bean created at the Location, once the Location's tablet holds it. */
  async function batchAt(place: Place, entry: Record_ = {}, content: Record_ = {}, of: string = bean): Promise<string> {
    const { batch } = await api.send<{ batch: { id: string } }>("POST", "/bean-batches", { beanId: of, content, locations: [{ locationId: place.location.id, ...entry }] }, 201);
    await expect.poll(() => held(place.tablet, batch.id)).toBeTruthy();
    return batch.id;
  }

  /** A Recipe at the Location naming the batch, in the slot given or none. */
  async function recipeAt(where: Place | LocationView, name: string, batchId: string, slot: number | null = null, content: Record_ = {}): Promise<string> {
    return (await api.send<{ recipe: { id: string } }>("POST", "/recipes", { locationId: idOf(where), slot, content: { name, beanBatchId: batchId, ...content } }, 201)).recipe.id;
  }

  /** Pulls a Shot on the Location's Machine with the batch in its Workflow, measuring the dose, and waits until the server has linked it. */
  async function pull(place: Place, batchId: string, dose: number): Promise<void> {
    const id = `lists-${++shots}`;
    const fixture = shotFixture();
    const workflow = fixture.workflow as Record_;
    place.tablet.pullShot({
      ...fixture,
      id,
      timestamp: minutes(1).toISOString(),
      annotations: { ...((fixture.annotations ?? {}) as Record_), actualDoseWeight: dose },
      workflow: {
        ...workflow,
        machine: { ...(workflow.machine as Record_), serialNumber: place.serial },
        context: { ...(workflow.context as Record_), beanBatchId: held(place.tablet, batchId)!.id },
      },
    });
    await expect.poll(async () => ((await (await api.call("GET", `/shots/${id}`)).json()) as { shot?: { beanBatch: { id: string } | null } }).shot?.beanBatch?.id, { timeout: 15_000 }).toBe(batchId);
  }

  it("lists every Recipe that names a batch, at any Location, with its Location and its Recipe Slot or none, and none of another batch of its Bean or Archived, over REST and get_library_item", async () => {
    const id = await batchAt(lab, {}, { roastDate: "2026-11-18" });
    const other = await batchAt(lab, {}, { roastDate: "2026-11-10" });
    const slotted = await recipeAt(lab, "Listed espresso", id, 2, { dose: 20, yield: 46 });
    const unslotted = await recipeAt(lab, "Listed long", id);
    // A Recipe at another Location takes the batch there.
    const elsewhere = await recipeAt(cafe, "Listed at the cafe", id, 5);
    await recipeAt(lab, "Names the other roast", other, 3);
    const archived = await recipeAt(lab, "Listed and Archived", id);
    await api.send("PUT", `/recipes/${archived}/archived`, { archived: true });

    const recipes = await namingOver(id);
    // By Location name, then slot, then those in no slot.
    expect(recipes.map((recipe) => recipe.id)).toEqual([elsewhere, slotted, unslotted]);
    expect(recipes).toMatchObject([
      { name: "Listed at the cafe", location: { id: cafe.location.id, name: "Lists cafe" }, slot: 5, batchFinished: false },
      { name: "Listed espresso", location: { id: lab.location.id, name: "Lists lab" }, slot: 2, batchFinished: false },
      { name: "Listed long", location: { id: lab.location.id }, slot: null, batchFinished: false },
    ]);
    expect((await namingOver(other)).map((recipe) => recipe.name)).toEqual(["Names the other roast"]);

    await api.send("PATCH", `/recipes/${unslotted}`, { content: { yield: 36 } });
    // The tool gives each as the REST API does.
    expect((await assistant.call<BatchItem>("get_library_item", { kind: "beanBatch", id })).beanBatch.recipes).toEqual(await namingOver(id));
    const { beanBatch } = await assistant.call<BatchItem>("get_library_item", { kind: "beanBatch", id });
    expect(beanBatch.recipes).toEqual([
      { id: elsewhere, name: "Listed at the cafe", location: cafe.location, slot: 5, dose: null, yield: null, batchFinished: false },
      { id: slotted, name: "Listed espresso", location: lab.location, slot: 2, dose: 20, yield: 46, batchFinished: false },
      { id: unslotted, name: "Listed long", location: lab.location, slot: null, dose: null, yield: 36, batchFinished: false },
    ]);
  });

  it("lists none for a batch no Recipe names", async () => {
    const id = await batchAt(lab);
    expect(await namingOver(id)).toEqual([]);
    expect((await assistant.call<BatchItem>("get_library_item", { kind: "beanBatch", id })).beanBatch.recipes).toEqual([]);
  });

  it("still lists a Recipe at a Location the batch was moved away from, or finished at, as one whose batch is finished there", async () => {
    const id = await batchAt(lab, { remainingWeight: 900 });
    const atLab = await recipeAt(lab, "Left behind", id);
    const atCafe = await recipeAt(cafe, "Finished under", id);
    await move(id, lab, cafe, "all");
    expect(await namingOver(id)).toMatchObject([
      { id: atCafe, batchFinished: false },
      { id: atLab, location: { id: lab.location.id }, batchFinished: true },
    ]);
    await api.send("PUT", `/bean-batches/${id}/locations/${cafe.location.id}`, { atLocation: false });
    expect(await namingOver(id)).toMatchObject([
      { id: atCafe, batchFinished: true },
      { id: atLab, batchFinished: true },
    ]);
    const { beanBatch } = await assistant.call<BatchItem>("get_library_item", { kind: "beanBatch", id });
    expect(beanBatch.recipes.map((recipe) => [recipe.id, recipe.batchFinished])).toEqual([
      [atCafe, true],
      [atLab, true],
    ]);
    // Neither Location's list has a batch finished there.
    expect(await rowAt(lab, id)).toBeUndefined();
    expect(await rowAt(cafe, id)).toBeUndefined();
  });

  it("marks a batch's Recipes as finished there once it or its Bean is Archived, as each Recipe's own read does", async () => {
    const own = await beanNamed("Listed, then retired");
    const id = await batchAt(lab, { remainingWeight: 400 }, {}, own);
    const atLab = await recipeAt(lab, "Archived under", id);
    const atCafe = await recipeAt(cafe, "Archived under at the cafe", id);
    /** Each Recipe's flag on the batch's page, and on its own read. */
    const flags = async () => {
      const named = await namingOver(id);
      const read = await Promise.all([atLab, atCafe].map(async (recipe) => (await api.get<{ recipe: { batchFinished: boolean } }>(`/recipes/${recipe}`)).recipe.batchFinished));
      return { named: [atLab, atCafe].map((recipe) => named.find((each) => each.id === recipe)!.batchFinished), read };
    };
    expect(await flags()).toEqual({ named: [false, false], read: [false, false] });
    await api.send("PUT", `/bean-batches/${id}/archived`, { archived: true });
    expect(await flags()).toEqual({ named: [true, true], read: [true, true] });
    await api.send("PUT", `/bean-batches/${id}/archived`, { archived: false });
    expect(await flags()).toEqual({ named: [false, false], read: [false, false] });
    await api.send("PUT", `/beans/${own}/archived`, { archived: true });
    expect(await flags()).toEqual({ named: [true, true], read: [true, true] });
  });

  it("says on a batch's read whether its Bean is Archived, which its own archived flag doesn't (#732)", async () => {
    const own = await beanNamed("Read, then retired");
    const id = await batchAt(lab, { remainingWeight: 400 }, {}, own);
    const read = async () => (await api.get<{ batch: { archived: boolean; beanArchived: boolean } }>(`/bean-batches/${id}`)).batch;
    expect(await read()).toMatchObject({ archived: false, beanArchived: false });
    await api.send("PUT", `/beans/${own}/archived`, { archived: true });
    expect(await read()).toMatchObject({ archived: false, beanArchived: true });
  });

  it("lists a Location's batches with each one's Bean, roast date, Batch Code, weight there, what its count starts from, the Shots and moves since, and the Recipes there that name it, as list_location_batches does", async () => {
    const id = await batchAt(lab, { remainingWeight: 1000 }, { roastDate: "2026-11-18", batchCode: "LR-70701" });
    const slotted = await recipeAt(lab, "Here in a slot", id, 7);
    const unslotted = await recipeAt(lab, "Here in no slot", id);
    await recipeAt(cafe, "At the cafe, not here", id);
    const archived = await recipeAt(lab, "Here and Archived", id, 8);
    await api.send("PUT", `/recipes/${archived}/archived`, { archived: true });
    await pull(lab, id, 18);
    await pull(lab, id, 20);
    await move(id, lab, cafe, 100);

    expect(await rowAt(lab, id)).toMatchObject({
      id,
      bean: { id: bean, roaster: "Roux", name: "Listed Guji" },
      // As Decaid records a date.
      roastDate: expect.stringMatching(/^2026-11-18/),
      batchCode: "LR-70701",
      remainingWeight: 862,
      entered: { weight: 1000, arrivedFrom: null },
      used: { shots: 2, weight: 38 },
      moved: { in: 0, from: [], away: 100, to: [{ location: { id: cafe.location.id }, weight: 100 }] },
      // Those at this Location only, not Archived, the one in a slot first.
      recipes: [
        { id: slotted, name: "Here in a slot", slot: 7 },
        { id: unslotted, name: "Here in no slot", slot: null },
      ],
    });
    const rest = await batchesAt(lab);
    expect(rest.every((batch) => !("location" in batch) && !("locations" in batch))).toBe(true);
    // The tool lists the same batches with the same fields, its times with the Location's offset.
    const tool = await listed(lab);
    expect(comparable(tool)).toEqual(comparable(rest));
    expect(tool.find((batch) => batch.id === id)!.entered!.at).toMatch(/[+-]\d\d:\d\d$/);
    const page = await assistant.call<BatchPage>("list_location_batches", { locationId: lab.location.id, limit: 1 });
    expect(page).toMatchObject({ total: rest.length, offset: 0, more: rest.length > 1 });
    expect(page.beanBatches).toHaveLength(1);
  });

  it("lists a batch at two Locations in each one's list with that Location's weight, Shots and moves, not the other's", async () => {
    const id = await batchAt(lab, { remainingWeight: 6000 });
    await move(id, lab, cafe, 5700);
    await expect.poll(() => held(cafe.tablet, id)?.archived, { timeout: 15_000 }).toBe(false);
    await pull(cafe, id, 20);
    await pull(cafe, id, 20);
    await pull(lab, id, 15);
    const cafeRecipe = await recipeAt(cafe, "Two places, the cafe's", id);

    expect(await rowAt(lab, id)).toMatchObject({
      remainingWeight: 285,
      entered: { weight: 6000, arrivedFrom: null },
      used: { shots: 1, weight: 15 },
      moved: { in: 0, from: [], away: 5700, to: [{ location: { id: cafe.location.id }, weight: 5700 }] },
      recipes: [],
    });
    expect(await rowAt(cafe, id)).toMatchObject({
      remainingWeight: 5660,
      entered: { weight: 5700, arrivedFrom: { id: lab.location.id } },
      used: { shots: 2, weight: 40 },
      moved: { in: 0, from: [], away: 0, to: [] },
      recipes: [{ id: cafeRecipe, slot: null }],
    });
    expect((await listed(cafe)).find((batch) => batch.id === id)).toMatchObject({ remainingWeight: 5660, used: { shots: 2, weight: 40 }, recipes: [{ id: cafeRecipe }] });
    expect((await listed(lab)).find((batch) => batch.id === id)).toMatchObject({ remainingWeight: 285, used: { shots: 1, weight: 15 }, recipes: [] });
  });

  it("reads a batch with no weight at the Location as untracked there, never zero, though it has a weight at another", async () => {
    const id = await batchAt(lab, { remainingWeight: 500 });
    await api.send("PUT", `/bean-batches/${id}/locations/${cafe.location.id}`, { atLocation: true });
    const untracked = { remainingWeight: null, entered: null, used: null, moved: null };
    expect(await rowAt(cafe, id)).toMatchObject(untracked);
    expect((await listed(cafe)).find((batch) => batch.id === id)).toMatchObject(untracked);
    expect(await rowAt(lab, id)).toMatchObject({ remainingWeight: 500 });
    // One whose Shots have used all that was entered reads zero, and stays in the list.
    const empty = await batchAt(lab, { remainingWeight: 10 });
    await pull(lab, empty, 18);
    expect(await rowAt(lab, empty)).toMatchObject({ remainingWeight: 0, used: { shots: 1, weight: 18 } });
  });

  it("lists none finished at the Location, Archived, or of an Archived Bean, the latest roasted first, says a Location has none, and refuses a Location there is none of", async () => {
    const annex = await api.createLocation("Lists annex", "Europe/Vienna");
    expect(await batchesAt(annex)).toEqual([]);
    expect(await assistant.call<BatchPage>("list_location_batches", { locationId: annex.id })).toEqual({ total: 0, offset: 0, more: false, beanBatches: [] });

    const put = (id: string, body: Record_) => api.send("PUT", `/bean-batches/${id}/locations/${annex.id}`, body);
    const older = await batchAt(lab, {}, { roastDate: "2026-10-01" });
    const newer = await batchAt(lab, {}, { roastDate: "2026-11-20" });
    const finished = await batchAt(lab, {}, { roastDate: "2026-11-21" });
    const archived = await batchAt(lab, {}, { roastDate: "2026-11-22" });
    const retired = await beanNamed("Listed and retired");
    const ofRetired = await batchAt(lab, {}, { roastDate: "2026-11-23" }, retired);
    for (const id of [older, newer, finished, archived, ofRetired]) await put(id, { atLocation: true, remainingWeight: 250 });
    await put(finished, { atLocation: false });
    await api.send("PUT", `/bean-batches/${archived}/archived`, { archived: true });
    await api.send("PUT", `/beans/${retired}/archived`, { archived: true });

    expect((await batchesAt(annex)).map((batch) => batch.id)).toEqual([newer, older]);
    const page = await assistant.call<BatchPage>("list_location_batches", { locationId: annex.id });
    expect(page.beanBatches.map((batch) => batch.id)).toEqual([newer, older]);
    // Its times are given with the Location's own offset.
    expect(page.beanBatches[0]!.since).toMatch(/\+0[12]:00$/);

    expect((await api.call("GET", "/locations/00000000-0000-4000-8000-000000000000/bean-batches")).status).toBe(404);
    const refused = await assistant.client.callTool({ name: "list_location_batches", arguments: { locationId: "00000000-0000-4000-8000-000000000000" } });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("No such Location");
  });

  it("lets a Viewer read both, and Staff read the list of a Location they don't work at, over REST and the tools", async () => {
    const id = await batchAt(cafe, { remainingWeight: 300 });
    const recipe = await recipeAt(cafe, "Read by all", id);
    const signedUp = async (email: string, role: "staff" | "viewer", locations: LocationView[]) => {
      const { link } = await api.invite(email, role, locations.map((location) => location.id));
      const cookie = await acceptInvite(server.url, link, { name: email, password: "a password for lists" });
      // A Viewer can allow an app only to read.
      const theirs = await Assistant.connect(server.url, app, cookie, role === "viewer" ? { allowed: ["read"] } : {});
      opened.push(theirs);
      return { api: AdminApi.signedInAs(server.url, cookie), assistant: theirs };
    };
    const startedBy = (batch: BatchHere | undefined) => (batch?.entered?.by as { account: { name: string | null } | null } | undefined)?.account;
    // An Admin reads who started the count; Staff and Viewers read that it was an account, not whose.
    expect(startedBy((await batchesAt(cafe)).find((batch) => batch.id === id))).toMatchObject({ name: admin.name });
    // Staff work at the lab only; the cafe's list is theirs to read all the same.
    for (const reader of [await signedUp("sam-707@example.com", "staff", [lab.location]), await signedUp("vic-707@example.com", "viewer", [])]) {
      expect((await batchesAt(cafe, reader.api)).find((batch) => batch.id === id)).toMatchObject({ remainingWeight: 300, recipes: [{ id: recipe }] });
      expect(startedBy((await batchesAt(cafe, reader.api)).find((batch) => batch.id === id))).toMatchObject({ name: null });
      expect(startedBy((await listed(cafe, reader.assistant)).find((batch) => batch.id === id))).toMatchObject({ name: null });
      expect((await batchesAt(lab, reader.api)).length).toBeGreaterThan(0);
      expect((await namingOver(id, reader.api)).map((named) => named.id)).toEqual([recipe]);
      expect((await listed(cafe, reader.assistant)).find((batch) => batch.id === id)).toMatchObject({ remainingWeight: 300, recipes: [{ id: recipe }] });
      expect((await reader.assistant.call<BatchItem>("get_library_item", { kind: "beanBatch", id })).beanBatch.recipes.map((named) => named.id)).toEqual([recipe]);
    }
  });

  it("says in the tools' descriptions that they give a batch's Recipes and a Location's batches", async () => {
    const { tools } = await assistant.client.listTools();
    const described = (name: string) => tools.find((tool) => tool.name === name)!.description!;
    expect(described("get_library_item")).toContain("A Bean Batch comes with the Recipes that name it (recipes), at any Location, each with its Location and Recipe Slot");
    expect(described("list_location_batches")).toContain("Lists the Bean Batches at one Location");
    expect(described("list_location_batches")).toContain("the Recipes at the Location that name it");
    expect(described("list_location_batches")).toContain("null where it is untracked there, which is not 0");
    expect(described("find_library_items")).toContain("list_location_batches lists one Location's Bean Batches");
  });

  it("reads a Location's list of many batches with no query per batch", async () => {
    const url = new URL(adminDatabaseUrl());
    url.pathname = `/${server.database}`;
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.href }), log: [{ emit: "event", level: "query" }] });
    let queries = 0;
    prisma.$on("query", () => void queries++);
    try {
      const service = new BeanBatchesService(prisma as unknown as PrismaService);
      const counted = async () => {
        queries = 0;
        const { batches } = await service.atLocation(cafe.location.id, { kind: "everything" });
        return { queries, batches: batches.length };
      };
      /** A batch with all a row reads: a weight, a move in and one away, and a Recipe at the Location. */
      const made = async (n: number) => {
        const id = await batchAt(lab, { remainingWeight: 500 + n });
        await move(id, lab, cafe, 100);
        await move(id, cafe, lab, 10);
        await recipeAt(cafe, `Counted ${n}`, id);
      };
      await made(0);
      const few = await counted();
      for (let n = 1; n <= 10; n++) await made(n);
      const many = await counted();
      expect(many.batches).toBe(few.batches + 10);
      expect(many.queries).toBe(few.queries);
    } finally {
      await prisma.$disconnect();
    }
  });
});
