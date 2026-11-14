import { type Chunk, MAX_CHUNKED_LENGTH, MAX_SHOTS_PAGE, REQUESTS_WIRE_REVISION, dye2GlobalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { LoadedTablets, emptyLibrary, recipeNamedInWorkflow } from "./support/loaded-tablets.js";
import { longShot, shotFixture } from "./support/shot-fixtures.js";
import { SimulatedDye2, dye2List, openDye2Dashboard, recordedDye2MainTablet } from "./support/simulated-dye2.js";
import { RawConnection, type SimulatedTablet, helloWith, settingsFor } from "./support/simulated-tablet.js";
import { StandInServer } from "./support/stand-in-server.js";
import { runAsSteps } from "./support/steps.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #509 (milestone 8, ADR-0030): a Skin on a tablet lists
// the Shots at its Machine's Location, whichever Machine pulled them, and
// reads any of them whole. It calls the plugin's `shots` and `shot`
// endpoints, the plugin asks the server with a `request` over its
// connection, behind what the tablet has still to report, and the server's
// `answer` comes back in the same call. Through the built plugin in
// simulated tablets against a real server: two at Belmont, the left one
// running DYE2 with the recording's recipes (fixtures/decaid/dye2-v0.1.26/),
// which become Belmont's Recipes and are written to the right one; and one
// at the Lab. Each Shot is derived from a Shot
// Decaid recorded, changing its id, time, recorded hardware and what a row
// gives. Then who is refused, against the real server and a stand-in for
// one of the release before requests, and the requests themselves with raw
// frames. Serials are made up, from 50901.

type Record_ = Record<string, unknown>;

// Heartbeats every 30 s, the default: while a call to the plugin's endpoint awaits its answer the tablet runs at real
// time, its heartbeats with it, so a server expecting one a second would drop a call that took three.
const env = { SYNC_HELLO_TIMEOUT_SECONDS: "10", SYNC_HEARTBEAT_SECONDS: "30" };

const LEFT_SERIAL = "50901";
const RIGHT_SERIAL = "50902";
const LAB_SERIAL = "50903";
/** Hardware no Machine has, whose Shots a Pending Machine holds. */
const UNKNOWN_SERIAL = "50909";

/** The record id of the recording's library recipe, in slot 1 (fixtures/decaid/dye2-v0.1.26/library.json). */
const LIBRARY = "05fd1e80-61e3-46ef-b202-2cbad5eb7983";
/** The record id of its Brazil, in slot 2. */
const BRAZIL = "2";

/** The time between a pulled Shot's samples. */
const SAMPLE_MS = 100;

interface Recipe {
  id: string;
  name: string | null;
  recordId: string | null;
}

interface Row {
  id: string;
  pulledAt: string;
  machine: { id: string; name: string };
  onThisTablet: boolean;
  recipe: Recipe | null;
  unfinished: boolean;
  hasNote: boolean;
  referenceOf: Recipe[];
}

interface Page {
  shots: Row[];
  nextCursor: string | null;
}

const tablets = new LoadedTablets();
afterAll(() => tablets.unloadAll());

/** Calls one of the plugin's endpoints as a Skin does: the HTTP status and the JSON answered. */
async function call(tablet: SimulatedTablet, endpoint: "shots" | "shot", query: Record<string, string> = {}, method = "GET"): Promise<{ status: number; body: Record_ }> {
  const answer = await tablet.callEndpoint(endpoint, { query, method });
  expect(answer.headers["Content-Type"]).toBe("application/json");
  return { status: answer.status, body: JSON.parse(answer.body) as Record_ };
}

/** A page of the tablet's Location's Shots, as its `shots` endpoint answers it. */
async function page(tablet: SimulatedTablet, query: Record<string, string> = {}): Promise<Page> {
  const { status, body } = await call(tablet, "shots", query);
  expect(status, JSON.stringify(body)).toBe(200);
  return body as unknown as Page;
}

const ids = (listed: Page) => listed.shots.map((shot) => shot.id);
const whole = (tablet: SimulatedTablet, id: string) => call(tablet, "shot", { id });
const requestsSent = (tablet: SimulatedTablet) => (tablet.sent as Record_[]).filter((frame) => frame.type === "request");
/** Once the plugin has been welcomed, as a Skin listening on `changes` is told. */
const welcomed = (tablet: SimulatedTablet) => expect.poll(() => tablet.pushes("changes").at(-1)).toEqual({ what: "connection", connected: true });

/** A Shot pulled at a UTC time on the hardware of that serial, derived from the fixture with the changes given. */
function shotOf(id: string, pulledAt: string, serial: string, changes: Record_ = {}): Record_ {
  const fixture = shotFixture();
  const workflow = fixture.workflow as Record_;
  return { ...fixture, id, timestamp: pulledAt, workflow: { ...workflow, machine: { ...(workflow.machine as Record_), model: "DE1Pro", serialNumber: serial } }, ...changes };
}

/** Resolves once `holds` does, as expect.poll, which a hook can't call, waits. */
async function until(holds: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await holds())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const NO_SUCH_SHOT = { status: 404, body: { code: "noSuchShot", message: expect.stringContaining("No Shot") } };
const invalidRequest = (message: string) => ({ status: 400, body: { code: "invalidRequest", message: expect.stringContaining(message) } });

describe("A Location's Shots on its tablets", { timeout: 120_000 }, () => {
  let server: TestServer;
  let api: AdminApi;
  let belmont: LocationView;
  let lab: LocationView;
  let leftMachine: CreatedMachine;
  let rightMachine: CreatedMachine;
  let labMachine: CreatedMachine;
  let left: SimulatedTablet;
  let right: SimulatedTablet;
  let labTablet: SimulatedTablet;
  /** Belmont's Recipes the left tablet's library recipe and Brazil became. */
  let library: string;
  let brazil: string;
  /** Belmont's Shots as its tablets list them at first, newest first. */
  const BELMONT = ["skin-left-recipe", "skin-right-moved", "skin-right-long", "skin-left-rated", "skin-right-unfinished", "skin-left-early", "skin-right-cleaning", "skin-tie-left", "skin-tie-right"];

  runAsSteps();

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
    belmont = await api.createLocation("Belmont", "America/Chicago");
    lab = await api.createLocation("Lab", "America/Denver");
    leftMachine = await api.createMachine("Belmont Left");
    rightMachine = await api.createMachine("Belmont Right");
    labMachine = await api.createMachine("Lab 1");
    // Each was at its Location long before its Shots were pulled.
    for (const [machine, location] of [[leftMachine, belmont], [rightMachine, belmont], [labMachine, lab]] as const) {
      await api.send("POST", `/machines/${machine.machine.id}/location-history`, { locationId: location.id, effectiveFrom: "2025-01-01T00:00:00Z" }, 201);
    }
    left = tablets.syncing(leftMachine, server, { api: recordedDye2MainTablet(LEFT_SERIAL, "Skin shots"), dye2: new SimulatedDye2() });
    right = tablets.syncing(rightMachine, server, { api: emptyLibrary(RIGHT_SERIAL) });
    labTablet = tablets.syncing(labMachine, server, { api: emptyLibrary(LAB_SERIAL) });
    await api.waitForOnline(leftMachine, rightMachine, labMachine);
    // The left tablet's recipes join Belmont's Recipes, and its records carry their ids.
    await until(async () => (await api.get<{ recipes: unknown[] }>(`/locations/${belmont.id}/recipes`)).recipes.length === 8);
    await until(() => recipeRecords(left).length === 8 && recipeRecords(left).every((record) => dye2GlobalIdOf(record) !== null));
    library = dye2GlobalIdOf(recipeRecords(left).find((record) => record.id === LIBRARY))!;
    brazil = dye2GlobalIdOf(recipeRecords(left).find((record) => record.id === BRAZIL))!;

    const fixture = shotFixture();
    const context = (fixture.workflow as Record_).context as Record_;
    const samples = fixture.measurements as Record_[];
    left.pullShot(shotOf("skin-left-early", "2026-02-10T15:00:00Z", LEFT_SERIAL));
    // Rated and noted, with every value a row gives recorded.
    left.pullShot(
      shotOf("skin-left-rated", "2026-02-10T17:00:00Z", LEFT_SERIAL, {
        workflow: {
          ...(fixture.workflow as Record_),
          machine: { ...((fixture.workflow as Record_).machine as Record_), model: "DE1Pro", serialNumber: LEFT_SERIAL },
          context: { ...context, coffeeRoaster: "Skin Roasters", coffeeName: "Skin Blend", baristaName: "Skin Barista", targetDoseWeight: 18.5, targetYield: 37 },
        },
        annotations: { ...(fixture.annotations as Record_), actualDoseWeight: 18.2, actualYield: 36.4, enjoyment: 8, espressoNotes: "Sweet, a little thin" },
      }),
    );
    // Its first two samples alone, as a Shot stopped in its preinfusion at once: an Unfinished Shot.
    right.pullShot(shotOf("skin-right-unfinished", "2026-02-10T16:00:00Z", RIGHT_SERIAL, { measurements: samples.slice(0, 2) }));
    // A cleaning cycle stopped as soon: nothing poured, but a Shot Summary counts it as cleaning, not as unfinished.
    const profile = (fixture.workflow as Record_).profile as Record_;
    right.pullShot(
      shotOf("skin-right-cleaning", "2026-02-10T14:00:00Z", RIGHT_SERIAL, {
        workflow: { ...(shotOf("", "", RIGHT_SERIAL).workflow as Record_), profile: { ...profile, beverage_type: "cleaning" } },
        measurements: samples.slice(0, 2),
      }),
    );
    // Larger than 1 MiB.
    right.pullShot(longShot("skin-right-long", { timestamp: "2026-02-10T18:00:00Z", workflow: shotOf("", "", RIGHT_SERIAL).workflow }));
    right.pullShot(shotOf("skin-right-moved", "2026-03-01T10:00:00Z", RIGHT_SERIAL));
    // Pulled at the same moment, on either Machine: the list orders them by id.
    left.pullShot(shotOf("skin-tie-left", "2026-02-10T12:00:00Z", LEFT_SERIAL));
    right.pullShot(shotOf("skin-tie-right", "2026-02-10T12:00:00Z", RIGHT_SERIAL));
    labTablet.pullShot(shotOf("skin-lab", "2026-02-10T19:00:00Z", LAB_SERIAL));
    // On hardware no Machine has: a Pending Machine holds it, at no Location.
    right.pullShot(shotOf("skin-pending", "2026-02-10T20:00:00Z", UNKNOWN_SERIAL));

    // The library recipe applied on the left tablet from DYE2's dashboard, and a Shot pulled with it loaded, now.
    expect((await (await openDye2Dashboard(left)).applyRecipe(LIBRARY)).workflow?.status).toBe(200);
    await until(() => recipeNamedInWorkflow(left) === library);
    await until(
      async () => (await api.get<{ machine: { loadedRecipe: { recipe: { id: string } } | null } }>(`/machines/${leftMachine.machine.id}`)).machine.loadedRecipe?.recipe.id === library,
    );
    const startedAt = Date.now() - (samples.length - 1) * SAMPLE_MS;
    left.pullShot({
      ...fixture,
      id: "skin-left-recipe",
      timestamp: new Date(startedAt).toISOString(),
      workflow: { ...structuredClone(left.workflow()), machine: { ...((fixture.workflow as Record_).machine as Record_), serialNumber: LEFT_SERIAL } },
      measurements: samples.map((sample, index) => ({
        ...sample,
        machine: { ...(sample.machine as Record_), timestamp: new Date(startedAt + index * SAMPLE_MS).toISOString().slice(0, -1) },
      })),
    });
    await until(async () => (await api.get<{ total: number }>("/shots?limit=1")).total === 11);
    await until(async () => (await api.get<{ shot: { recipe: { id: string } | null } }>("/shots/skin-left-recipe")).shot.recipe?.id === library);
  });
  afterAll(async () => {
    await tablets.unloadAll();
    await server?.stop();
  });

  const recipeRecords = (tablet: SimulatedTablet): Record_[] => {
    const list = dye2List(tablet, "recipes");
    return Array.isArray(list) ? (list as Record_[]) : [];
  };
  const restShot = async (id: string) => (await api.get<{ shot: Record_ }>(`/shots/${id}`)).shot;
  const row = async (tablet: SimulatedTablet, id: string) => (await page(tablet)).shots.find((shot) => shot.id === id);

  it("lists its Location's Shots newest first, whichever Machine pulled them, and leaves out another Location's and a Pending Machine's", async () => {
    for (const tablet of [left, right]) expect(await page(tablet)).toMatchObject({ shots: BELMONT.map((id) => ({ id })), nextCursor: null });
    expect(await page(labTablet)).toMatchObject({ shots: [{ id: "skin-lab", machine: { id: labMachine.machine.id, name: "Lab 1" }, onThisTablet: true }], nextCursor: null });
    // The list is the management interface's for the Location.
    expect((await api.get<{ shots: { id: string }[] }>(`/shots?locationId=${belmont.id}`)).shots.map((shot) => shot.id)).toEqual(BELMONT);
    // One request for each call, with nothing of its page named, which the server answered and never acknowledged.
    const request = requestsSent(labTablet).at(-1)!;
    expect(request).toEqual({ type: "request", id: expect.any(String), ask: "shots" });
    expect(labTablet.acks(request.id)).toBe(0);
  });

  it("pages by cursor to the end, a page of up to 50, across two Shots pulled at the same moment", async () => {
    for (const limit of [1, 3, 4, 8, 9, MAX_SHOTS_PAGE]) {
      const pages: Page[] = [];
      for (let cursor: string | null | undefined; cursor !== null; cursor = pages.at(-1)!.nextCursor) {
        pages.push(await page(left, { limit: String(limit), ...(cursor && { cursor }) }));
        expect(pages.length, `limit ${limit}`).toBeLessThanOrEqual(BELMONT.length);
      }
      expect(pages.flatMap(ids), `limit ${limit}`).toEqual(BELMONT);
      // Every page but the last is full, and the last holds a Shot: a list that ends on a full page ends there.
      expect(pages.map((each) => each.shots.length), `limit ${limit}`).toEqual(
        Array.from({ length: Math.ceil(BELMONT.length / limit) }, (_, index) => Math.min(limit, BELMONT.length - index * limit)),
      );
    }
    expect(requestsSent(left).at(-1)).toEqual({ type: "request", id: expect.any(String), ask: "shots", limit: MAX_SHOTS_PAGE });
    // A cursor is the server's: the same one read by the other tablet gives the same page.
    const first = await page(left, { limit: "2" });
    expect(requestsSent(left).at(-1)).toMatchObject({ limit: 2 });
    expect(ids(await page(right, { limit: "2", cursor: first.nextCursor! }))).toEqual(BELMONT.slice(2, 4));
    expect(requestsSent(right).at(-1)).toEqual({ type: "request", id: expect.any(String), ask: "shots", limit: 2, cursor: first.nextCursor });
  });

  it("gives each row's fields as the Shot recorded them, and whether this tablet holds it", async () => {
    const rated = await restShot("skin-left-rated");
    const expected = {
      id: "skin-left-rated",
      pulledAt: "2026-02-10T17:00:00.000Z",
      machine: { id: leftMachine.machine.id, name: "Belmont Left" },
      onThisTablet: true,
      recipe: null,
      bean: { roaster: "Skin Roasters", name: "Skin Blend" },
      dose: 18.2,
      targetDose: 18.5,
      yield: 36.4,
      targetYield: 37,
      duration: rated.duration,
      rating: 8,
      barista: "Skin Barista",
      hasNote: true,
      unfinished: false,
      referenceOf: [],
    };
    expect(expected.duration).toEqual(expect.any(Number));
    expect(await row(left, "skin-left-rated")).toEqual(expected);
    // The same Shot on the tablet beside it, which does not hold it.
    expect(await row(right, "skin-left-rated")).toEqual({ ...expected, onThisTablet: false });
    for (const [tablet, held] of [[left, true], [right, false]] as const) {
      const listed = (await page(tablet)).shots;
      expect(listed.map((shot) => [shot.id, shot.onThisTablet])).toEqual(BELMONT.map((id) => [id, id.startsWith("skin-left") || id === "skin-tie-left" ? held : !held]));
      expect(listed.every((shot) => shot.machine.id === (shot.id.startsWith("skin-left") || shot.id === "skin-tie-left" ? leftMachine : rightMachine).machine.id)).toBe(true);
    }
    // A Shot that recorded neither a rating nor a note.
    expect(await row(left, "skin-left-early")).toMatchObject({ rating: null, hasNote: false, barista: "Fixture Barista", dose: 18, yield: 35.9 });
  });

  it("marks an Unfinished Shot, as a Shot Summary counts one, and not a cleaning Shot in which nothing poured", async () => {
    expect((await page(left)).shots.filter((shot) => shot.unfinished).map((shot) => shot.id)).toEqual(["skin-right-unfinished"]);
    expect(await row(left, "skin-right-cleaning")).toMatchObject({ unfinished: false });
    const summary = await api.get<{ groups: { counts: { unfinished: number; cleaningAndCalibration: number } }[] }>(`/shots/summary?locationId=${belmont.id}`);
    expect(summary.groups[0]!.counts).toMatchObject({ unfinished: 1, cleaningAndCalibration: 1 });
  });

  it("names a row's Recipe by the tablet's own record id, and by none on a tablet that holds no record of it", async () => {
    // Each tablet's own record of the Recipe: the one the left tablet saved, and the one the server wrote to the right.
    for (const tablet of [left, right]) {
      const own = recipeRecords(tablet).find((record) => dye2GlobalIdOf(record) === library)!;
      expect(own.id).toBe(LIBRARY);
      expect((await row(tablet, "skin-left-recipe"))!.recipe).toEqual({ id: library, name: "Fixture Library Recipe", recordId: own.id });
    }
    expect((await page(left)).shots.filter((shot) => shot.recipe !== null).map((shot) => shot.id)).toEqual(["skin-left-recipe"]);

    // A third Machine at Belmont whose tablet has reported no recipes and been written none: it is named no record.
    const third = await api.createMachine("Belmont Third", belmont.id);
    const raw = await RawConnection.welcomed(server.url, helloWith(third.token));
    raw.send({ type: "request", id: "page", ask: "shots", limit: 1 });
    const answers = () => (raw.messages as Record_[]).filter((message) => message.type === "answer");
    await expect.poll(() => answers().length).toBe(1);
    expect(answers()[0]).toMatchObject({ result: { shots: [{ id: "skin-left-recipe", onThisTablet: false, recipe: { id: library, name: "Fixture Library Recipe", recordId: null } }] } });
    raw.send({ type: "request", id: "whole", ask: "shot", shotId: "skin-left-recipe" });
    await expect.poll(() => answers().length).toBe(2);
    expect(answers()[1]).toMatchObject({ result: { recipe: { id: library, name: "Fixture Library Recipe", recordId: null } } });
    await raw.close();
  });

  it("marks a Reference Shot with its Location's Recipes it is the reference of, and no other Location's or Archived Recipe", async () => {
    const choose = (recipeId: string, shotId: string) => api.send("PUT", `/recipes/${recipeId}/reference-shot`, { shotId });
    await choose(library, "skin-left-rated");
    await choose(brazil, "skin-left-rated");
    // The Lab's own Recipe takes a Belmont Shot as its reference, which Belmont's tablets are not told.
    const labRecipe = (await api.send<{ recipe: { id: string } }>("POST", "/recipes", { locationId: lab.id, slot: "next", content: { name: "Lab espresso", dose: 18, yield: 36 } }, 201)).recipe;
    await choose(labRecipe.id, "skin-left-rated");

    const both = [
      { id: brazil, name: "Fixture Brazil Espresso", recordId: BRAZIL },
      { id: library, name: "Fixture Library Recipe", recordId: LIBRARY },
    ];
    expect((await row(left, "skin-left-rated"))!.referenceOf).toEqual(both);
    expect((await row(right, "skin-left-rated"))!.referenceOf).toEqual(both);
    expect((await page(left)).shots.filter((shot) => shot.referenceOf.length > 0).map((shot) => shot.id)).toEqual(["skin-left-rated"]);
    // The REST API names all three, wherever they belong.
    expect(((await restShot("skin-left-rated")).referenceOf as unknown[]).length).toBe(3);

    // Archived, the Brazil is offered nowhere, and its reference is no mark on a tablet.
    await api.send("PUT", `/recipes/${brazil}/archived`, { archived: true });
    expect((await row(left, "skin-left-rated"))!.referenceOf).toEqual([both[1]]);
    expect((await whole(left, "skin-left-rated")).body.referenceOf).toEqual([both[1]]);
  });

  it("reads a Shot whole as its own tablet holds it, with the Recipe it was pulled with", async () => {
    const held = async (tablet: SimulatedTablet, id: string) => (await tablet.callApi("GET", `/shots/${id}`)).body;
    // The left tablet's own, read by the right one, and by the left.
    const recipeShot = await whole(right, "skin-left-recipe");
    expect(recipeShot).toEqual({
      status: 200,
      body: { shot: await held(left, "skin-left-recipe"), recipe: { id: library, name: "Fixture Library Recipe", recordId: LIBRARY }, referenceOf: [] },
    });
    expect((recipeShot.body.shot as Record_).measurements).toHaveLength((shotFixture().measurements as unknown[]).length);
    expect(requestsSent(right).at(-1)).toEqual({ type: "request", id: expect.any(String), ask: "shot", shotId: "skin-left-recipe" });
    expect((await whole(left, "skin-left-recipe")).body).toEqual(recipeShot.body);
    // An Unfinished Shot is read as any other.
    expect((await whole(left, "skin-right-unfinished")).body).toEqual({ shot: await held(right, "skin-right-unfinished"), recipe: null, referenceOf: [] });
  });

  it("reads a Shot larger than 1 MiB whole, in chunks the plugin confirms", async () => {
    const chunksBefore = (left.received as Record_[]).filter((frame) => frame.type === "chunk").length;
    const answer = await left.callEndpoint("shot", { query: { id: "skin-right-long" } });
    expect(answer.status).toBe(200);
    expect(Buffer.byteLength(answer.body)).toBeGreaterThan(1024 * 1024);
    expect((JSON.parse(answer.body) as Record_).shot).toEqual((await right.callApi("GET", "/shots/skin-right-long")).body);
    const chunks = (left.received as Record_[]).filter((frame) => frame.type === "chunk").slice(chunksBefore);
    expect(chunks.length).toBeGreaterThan(4);
    expect((left.sent as Record_[]).filter((frame) => frame.type === "chunkReceived").length).toBeGreaterThanOrEqual(chunks.length);
  });

  it("refuses any Shot its list does not list as no such Shot, whether or not the server holds it", async () => {
    // Another Location's, a Pending Machine's, and none at all: each answered alike.
    expect((await api.call("GET", "/shots/skin-lab")).status).toBe(200);
    expect((await api.call("GET", "/shots/skin-pending")).status).toBe(200);
    for (const id of ["skin-lab", "skin-pending", "skin-no-such-shot", "x".repeat(200), "nul\u0000"]) expect(await whole(left, id), id).toEqual(NO_SUCH_SHOT);
    expect(await whole(labTablet, "skin-left-early")).toEqual(NO_SUCH_SHOT);
    expect((await whole(labTablet, "skin-lab")).status).toBe(200);
  });

  it("refuses a request it can't read with what is wrong with it, and answers nothing but a GET", async () => {
    const asked = requestsSent(left).length;
    for (const limit of ["0", "51", "-1", "2.5", "ten", ""]) expect(await call(left, "shots", { limit }), limit).toEqual(invalidRequest("limit"));
    expect(await call(left, "shot")).toEqual(invalidRequest("id"));
    expect(await call(left, "shot", { id: "" })).toEqual(invalidRequest("id"));
    for (const endpoint of ["shots", "shot"] as const) {
      const posted = await left.callEndpoint(endpoint, { method: "POST", body: {}, query: { id: "skin-left-early" } });
      expect([posted.status, posted.headers.Allow]).toEqual([405, "GET"]);
    }
    // None of those was asked of the server. A cursor is the server's to read: one it never gave is refused there.
    expect(requestsSent(left)).toHaveLength(asked);
    for (const cursor of ["", "not a cursor", Buffer.from("[1]").toString("base64url"), Buffer.from('["then","skin-left-early"]').toString("base64url"), Buffer.from("[1e300,\"skin-left-early\"]").toString("base64url")]) {
      expect(await call(left, "shots", { cursor }), cursor).toEqual(invalidRequest("cursor"));
    }
    expect(requestsSent(left)).toHaveLength(asked + 5);
  });

  it("drops a Shot from the list once its Machine's Location History is corrected, and lists it at the Location it is credited to", async () => {
    // The right Machine was at the Lab on the first of March after all, and back at Belmont the next day.
    await api.send("POST", `/machines/${rightMachine.machine.id}/location-history`, { locationId: lab.id, effectiveFrom: "2026-03-01T00:00:00Z" }, 201);
    await api.send("POST", `/machines/${rightMachine.machine.id}/location-history`, { locationId: belmont.id, effectiveFrom: "2026-03-02T00:00:00Z" }, 201);
    const remaining = BELMONT.filter((id) => id !== "skin-right-moved");
    for (const tablet of [left, right]) expect(ids(await page(tablet))).toEqual(remaining);
    // Its own tablet, still at Belmont, reads it no more, though it holds it; the Lab's lists it, and reads it whole.
    expect(await whole(right, "skin-right-moved")).toEqual(NO_SUCH_SHOT);
    expect(await page(labTablet)).toMatchObject({
      shots: [{ id: "skin-right-moved", machine: { id: rightMachine.machine.id, name: "Belmont Right" }, onThisTablet: false }, { id: "skin-lab" }],
    });
    expect((await whole(labTablet, "skin-right-moved")).body.shot).toEqual((await right.callApi("GET", "/shots/skin-right-moved")).body);
  });

  // A Pending Machine's Shot is at no Location until it is adopted (`shots_location_check`), so no tablet's list held it
  // before this either, as the first test saw: dismissing it only hides it from the Shots list too.
  it("leaves a dismissed Pending Machine's Shot out, as the Shots list does", async () => {
    const pending = (await api.pendingMachines()).find((machine) => machine.serial === UNKNOWN_SERIAL);
    expect((await api.call("POST", `/pending-machines/${pending!.id}/dismiss`)).status).toBe(200);
    expect((await api.call("GET", "/shots/skin-pending")).status).toBe(404);
    for (const tablet of [left, right, labTablet]) {
      expect(ids(await page(tablet))).not.toContain("skin-pending");
      expect(await whole(tablet, "skin-pending")).toEqual(NO_SUCH_SHOT);
    }
  });

  it("lists a Shot just pulled on its tablet, asking once the server has stored it", async () => {
    // A page read before it was pulled: the page after it is the same once it has been.
    const before = await page(left, { limit: "2" });
    const next = ids(await page(left, { limit: "2", cursor: before.nextCursor! }));
    // Decaid is slow to read the Shot, so its delivery is still to come as the Skin asks.
    const release = left.holdShotReads();
    const shot = shotOf("skin-left-just-pulled", new Date().toISOString(), LEFT_SERIAL);
    left.pullShot(shot);
    await expect.poll(() => left.inFlightRequests.map((request) => request.route)).toContain("/shots/skin-left-just-pulled");
    const asked = requestsSent(left).length;
    const listing = page(left, { limit: "1" });
    const reading = whole(left, "skin-left-just-pulled");
    // Neither request goes out ahead of the Shot.
    await new Promise((resolve) => setImmediate(resolve));
    expect(requestsSent(left)).toHaveLength(asked);
    expect((left.sent as Record_[]).filter((frame) => frame.type === "shot" && frame.shotId === "skin-left-just-pulled")).toEqual([]);

    release();
    expect(ids(await listing)).toEqual(["skin-left-just-pulled"]);
    expect(await reading).toMatchObject({ status: 200, body: { shot: { id: "skin-left-just-pulled" } } });
    const sent = (left.sent as Record_[]).map((frame) => (frame.type === "shot" ? frame.shotId : frame.type));
    expect(sent.indexOf("skin-left-just-pulled")).toBeLessThan(sent.lastIndexOf("request") - 1);
    // The cursor given before it was pulled still starts where its page ended: no row repeats, and none is skipped.
    expect(ids(await page(left, { limit: "2", cursor: before.nextCursor! }))).toEqual(next);
    expect(ids(await page(left, { limit: "3" }))).toEqual(["skin-left-just-pulled", ...ids(before)]);
  });
});

describe("The plugin's shots and shot endpoints, for a Machine that is not served", () => {
  let server: TestServer;
  let api: AdminApi;
  let location: LocationView;

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
    location = await api.createLocation("Skin shots, refusals", "America/Chicago");
  });
  afterAll(async () => {
    await tablets.unloadAll();
    await server?.stop();
  });

  /** Both endpoints' answers to the tablet. */
  const both = async (tablet: SimulatedTablet) => [await call(tablet, "shots"), await call(tablet, "shot", { id: "skin-any-shot" })];

  it("refuses a Capture-only Machine as one, and serves it once it takes part", async () => {
    const machine = await api.createMachine("Skin shots, capture-only", location.id);
    const tablet = tablets.syncing(machine, server, { api: emptyLibrary(50_911) });
    await welcomed(tablet);
    expect(await both(tablet)).toEqual([
      { status: 200, body: { shots: [], nextCursor: null } },
      { status: 404, body: { code: "noSuchShot", message: expect.any(String) } },
    ]);
    await api.send("PUT", `/machines/${machine.machine.id}/sharing`, { sharing: false });
    const refusal = { status: 409, body: { code: "captureOnly", message: expect.stringContaining("Capture-only Machine") } };
    expect(await both(tablet)).toEqual([refusal, refusal]);
    await api.send("PUT", `/machines/${machine.machine.id}/sharing`, { sharing: true });
    expect((await call(tablet, "shots")).status).toBe(200);

    // At no Location, it is a Capture-only Machine too.
    const nowhere = tablets.syncing(await api.createMachine("Skin shots, at no Location"), server, { api: emptyLibrary(50_912) });
    await welcomed(nowhere);
    expect(await both(nowhere)).toEqual([refusal, refusal]);
  });

  it("refuses a tablet whose machine is a Pending Machine's hardware", async () => {
    const machine = await api.createMachine("Skin shots, other hardware", location.id);
    // The Machine's own tablet binds its token to its hardware, and goes.
    const own = tablets.syncing(machine, server, { api: emptyLibrary(50_913) });
    await api.waitForMachine("Skin shots, other hardware", (viewed) => viewed.identification === "identified" && viewed.serial !== null);
    await own.unload();
    // The same token on a tablet whose machine is other hardware: a mismatch, held as a Pending Machine.
    const tablet = tablets.syncing(machine, server, { api: emptyLibrary(50_914) });
    await welcomed(tablet);
    await expect.poll(async () => (await api.pendingMachines()).map((pending) => pending.serial)).toContain("50914");
    const refusal = { status: 409, body: { code: "hardwareMismatch", message: expect.stringContaining("token") } };
    expect(await both(tablet)).toEqual([refusal, refusal]);
  });

  it("refuses at once, asking nothing, while the plugin is not connected", async () => {
    const machine = await api.createMachine("Skin shots, not connected", location.id);
    const tablet = tablets.syncing(machine, server, { api: emptyLibrary(50_915) });
    await welcomed(tablet);
    expect((await call(tablet, "shots")).status).toBe(200);
    const asked = requestsSent(tablet).length;
    tablet.loseNetwork();
    await expect.poll(() => tablet.pushes("changes").at(-1)).toEqual({ what: "connection", connected: false });
    for (const calling of [tablet.callEndpoint("shots"), tablet.callEndpoint("shot", { query: { id: "skin-any-shot" } })]) {
      // At once: answered before anything else can happen, a timer or an answer from anywhere.
      const first = await Promise.race([calling, new Promise<string>((resolve) => setImmediate(() => resolve("waited")))]);
      expect(first).toMatchObject({ status: 503 });
      expect(JSON.parse((await calling).body)).toEqual({ code: "unreachable", message: expect.stringContaining("can't be reached") });
    }
    expect(requestsSent(tablet)).toHaveLength(asked);
    // A plugin with no settings to connect with answers the same.
    const unset = tablets.load({ settings: {} });
    expect(await both(unset)).toEqual([expect.objectContaining({ status: 503, body: expect.objectContaining({ code: "unreachable" }) }), expect.objectContaining({ status: 503 })]);
  });

  it("refuses a server of the release before requests as too old to ask, sending it nothing", async () => {
    const standIn = await StandInServer.start({ wireRevision: REQUESTS_WIRE_REVISION - 1 });
    try {
      const tablet = tablets.load({ settings: settingsFor({ token: "stand-in token 50916", serverUrl: standIn.url }), api: emptyLibrary(50_916), timeScale: 50 });
      await welcomed(tablet);
      const refusal = { status: 503, body: { code: "serverTooOld", message: expect.stringContaining("too old") } };
      expect(await both(tablet)).toEqual([refusal, refusal]);
      expect(requestsSent(tablet)).toEqual([]);
    } finally {
      await standIn.stop();
    }
  });

  describe("requests and answers, with raw frames", () => {
    const answersTo = (raw: RawConnection, id: string) => (raw.messages as Record_[]).filter((message) => message.type === "answer" && message.id === id);
    /** Sends a request and resolves with its answer. */
    async function ask(raw: RawConnection, request: Record_ & { id: string }): Promise<Record_> {
      raw.send({ type: "request", ...request });
      await expect.poll(() => answersTo(raw, request.id).length).toBe(1);
      return answersTo(raw, request.id)[0]!;
    }

    it("answers a served connection with a page and a Shot, each once, and refuses a cursor that is none and a Shot it does not list", async () => {
      const here = await api.createLocation("Skin shots, raw frames", "America/Chicago");
      const machine = await api.createMachine("Skin shots, raw frames", here.id);
      const raw = await RawConnection.welcomed(server.url, helloWith(machine.token));
      // Its own Shot, pulled now, so at its Location, recording no hardware, so credited to the Machine reporting it, and
      // delivered just ahead of the request: the answer follows its storing.
      const fixture = shotFixture();
      const workflow = fixture.workflow as Record_;
      const shot = { ...fixture, id: "skin-raw-shot", timestamp: new Date().toISOString(), workflow: { ...workflow, machine: { ...(workflow.machine as Record_), provenanceStatus: "unavailable" } } };
      raw.send({ type: "shot", id: "shot-first", shotId: shot.id, shot });
      const listed = await ask(raw, { id: "page", ask: "shots", limit: 1 });
      expect(listed).toEqual({
        type: "answer",
        id: "page",
        ask: "shots",
        result: { shots: [expect.objectContaining({ id: "skin-raw-shot", machine: { id: machine.machine.id, name: "Skin shots, raw frames" }, onThisTablet: true })], nextCursor: null },
      });
      const types = (raw.messages as Record_[]).filter((message) => message.id === "shot-first" || message.id === "page").map((message) => message.type);
      expect(types).toEqual(["ack", "answer"]);
      expect(await ask(raw, { id: "whole", ask: "shot", shotId: "skin-raw-shot" })).toMatchObject({ type: "answer", id: "whole", ask: "shot", result: { shot: { id: "skin-raw-shot" }, recipe: null, referenceOf: [] } });
      expect(await ask(raw, { id: "none", ask: "shot", shotId: "skin-no-such-shot" })).toEqual({ type: "answer", id: "none", ask: "shot", refused: "noSuchShot" });
      expect(await ask(raw, { id: "cursor", ask: "shots", cursor: "none of the server's" })).toEqual({ type: "answer", id: "cursor", ask: "shots", refused: "invalidCursor" });
      expect(raw.acks("page") + raw.acks("whole") + raw.acks("none") + raw.acks("cursor")).toBe(0);
    });

    it("leaves requests unanswered while more waits to be sent on their connection than twice the longest message, and answers again once it is taken", async () => {
      const here = await api.createLocation("Skin shots, waiting answers", "America/Chicago");
      const holder = await api.createMachine("Skin shots, holding a long Shot", here.id);
      const tablet = tablets.syncing(holder, server, { api: emptyLibrary(50_917) });
      await welcomed(tablet);
      tablet.pullShot(longShot("skin-waiting-long", { timestamp: new Date().toISOString(), workflow: shotOf("", "", "50917").workflow }));
      await expect.poll(async () => (await api.call("GET", "/shots/skin-waiting-long")).status).toBe(200);

      // A tablet beside it that takes nothing it is sent: all but the first chunks of its answers wait in the server.
      const raw = await RawConnection.welcomed(server.url, helloWith((await api.createMachine("Skin shots, slow to take answers", here.id)).token));
      const chunks = () => (raw.messages as Chunk[]).filter((frame) => frame.type === "chunk");
      const asked = 40;
      for (let index = 0; index < asked; index++) raw.send({ type: "request", id: `long-${index}`, ask: "shot", shotId: "skin-waiting-long" });
      await expect.poll(() => server.output()).toMatch(/Leaving the requests of Machine Skin shots, slow to take answers .* unanswered/);
      // Every request has had its turn once a delivery sent after them is acknowledged.
      await raw.deliver({ type: "machineState", id: "after-the-requests", observedAt: new Date().toISOString(), state: "idle", substate: "idle" });

      // It takes them after all, confirming each chunk as it arrives and putting each answer back together.
      const answers: { id: string; bytes: number }[] = [];
      const parts = new Map<string, string[]>();
      let taken = 0;
      const take = () => {
        for (const chunk of chunks().slice(taken)) {
          raw.send({ type: "chunkReceived", id: chunk.id, index: chunk.index });
          const held = [...(parts.get(chunk.id) ?? []), chunk.data];
          parts.set(chunk.id, held);
          if (chunk.index < chunk.count - 1) continue;
          const answer = JSON.parse(held.join("")) as Record_;
          expect(answer).toMatchObject({ type: "answer", ask: "shot", result: { shot: { id: "skin-waiting-long" } } });
          answers.push({ id: String(answer.id), bytes: Buffer.byteLength(held.join("")) });
          parts.delete(chunk.id);
        }
        taken = chunks().length;
      };
      // Until a request is answered again: the status, asked anew each time, as one asked too soon has no answer either.
      let statuses = 0;
      await expect
        .poll(
          () => {
            take();
            raw.send({ type: "request", id: `status-${statuses++}`, ask: "status" });
            return (raw.messages as Record_[]).some((message) => message.type === "answer" && message.ask === "status");
          },
          { timeout: 60_000, interval: 20 },
        )
        .toBe(true);
      // And then the Shot once more, which waits its turn behind every answer still to come.
      raw.send({ type: "request", id: "last", ask: "shot", shotId: "skin-waiting-long" });
      await expect.poll(() => (take(), answers.at(-1)?.id), { timeout: 60_000, interval: 20 }).toBe("last");

      // The first requests were answered, in order, each whole, until what waited passed the limit; the rest never were.
      const first = answers.slice(0, -1);
      expect(first.map((answer) => answer.id)).toEqual(first.map((_, index) => `long-${index}`));
      expect(first.length).toBeGreaterThan(1);
      expect(first.length).toBeLessThan(asked);
      // All but the last of them waited as it was read, but for the first chunks sent: within the limit.
      expect(first.slice(0, -1).reduce((sum, answer) => sum + answer.bytes, 0)).toBeLessThanOrEqual(2 * MAX_CHUNKED_LENGTH + 1024 * 1024);
    });

    it("refuses a request from a Capture-only connection as not served", async () => {
      const machine = await api.createMachine("Skin shots, raw capture-only");
      const raw = await RawConnection.welcomed(server.url, helloWith(machine.token));
      expect(await ask(raw, { id: "page", ask: "shots" })).toEqual({ type: "answer", id: "page", ask: "shots", refused: "captureOnly" });
      expect(await ask(raw, { id: "whole", ask: "shot", shotId: "skin-any-shot" })).toEqual({ type: "answer", id: "whole", ask: "shot", refused: "captureOnly" });
    });

    it("ends a connection whose request names a page no plugin asks for, or no Shot", async () => {
      const machine = await api.createMachine("Skin shots, raw refusals", location.id);
      for (const [request, field] of [[{ ask: "shots", limit: MAX_SHOTS_PAGE + 1 }, "request.limit"], [{ ask: "shots", cursor: 7 }, "request.cursor"], [{ ask: "shot" }, "request.shotId"]] as const) {
        const raw = await RawConnection.welcomed(server.url, helloWith(machine.token));
        raw.send({ type: "request", id: "refused", ...request });
        expect((await raw.closed).code).toBe(4000);
        expect(raw.messages.at(-1)).toMatchObject({ type: "error", code: "protocol_error", message: expect.stringContaining(field) });
      }
    });
  });
});
