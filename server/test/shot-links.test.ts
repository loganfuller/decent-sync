import { globalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { shotFixture } from "./support/shot-fixtures.js";
import { SimulatedTablet, derivedDe1Pro, derivedProfile, settingsFor } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #92: each Shot is linked to the Library's Bean Batch and
// Grinder it used, through the map of the tablet that reported it, and to the
// Profile it was pulled with, so Shots are filtered by them and each item
// lists its Shots. A Shot reported before its batch joined the Library is
// linked once its tablet's map holds it.
// Through the built plugin in simulated tablets, on two server instances
// sharing one database, with assertions through the REST API. Serials are
// made up, from 26001.

type Record_ = Record<string, unknown>;

interface ShotView {
  id: string;
  machine: { id: string } | null;
  beanBatch: { id: string; bean: { id: string; roaster: string | null; name: string | null }; roastDate: string | null } | null;
  grinder: { id: string; model: string | null } | null;
  profile: { id: string; title: string | null } | null;
}

interface FilterOptions {
  beanBatches: ({ id: string } | null)[];
  grinders: ({ id: string; model: string | null; location: LocationView | null } | null)[];
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** The bundled Profile the WorkFlow skin had selected on the test tablet, which its Shot was not pulled with. */
const SKIN_SELECTED = "profile:98fa00c191551b435845";
/** The bundled Profile the test tablet's Shot was pulled with, which streamline-js loaded into its Workflow. */
const LONDONIUM = "profile:729d284747718d27c93a";

describe("Shots linked to the Library", { timeout: 60_000 }, () => {
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

  /** The built plugin on a tablet of the Machine, polling every 5 s (0.1 s here), its Decaid's Library as given, empty by default. */
  function load(machine: CreatedMachine, serial: string, options: { instance?: TestServer; library?: Record_ } = {}): SimulatedTablet {
    const tablet = SimulatedTablet.load({
      settings: { ...settingsFor({ token: machine.token, serverUrl: (options.instance ?? server).url }), PollSeconds: 5 },
      api: { ...derivedDe1Pro({ serial }), "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [], ...options.library },
      timeScale: 50,
    });
    tablets.push(tablet);
    return tablet;
  }

  async function send<T>(method: string, path: string, body?: unknown, status = 200): Promise<T> {
    const response = await api.call(method, path, body);
    expect(response.status, await response.clone().text()).toBe(status);
    return (await response.json()) as T;
  }
  const poll = <T>(read: () => T) => expect.poll(read, { timeout: 10_000 });
  const held = (records: Record_[], id: string) => records.find((record) => globalIdOf(record) === id);
  const viewShot = async (id: string) => (await send<{ shot: ShotView }>("GET", `/shots/${id}`)).shot;
  /** The ids of the Shots a filtered list holds, in list order. */
  const listed = async (query: string) => (await send<{ shots: ShotView[] }>("GET", `/shots?${query}`)).shots.map((shot) => shot.id);

  /**
   * A Shot pulled on the Machine of that serial, derived from the test
   * tablet's, its Workflow naming the batch and Grinder by the ids given and
   * holding the profile given, if any. The skin's selected profile id stays
   * the fixture's, which names a bundled Profile the Shot was not pulled with.
   */
  function shotWith(id: string, serial: string, context: Record_, profile?: Record_): Record_ {
    const fixture = shotFixture();
    const workflow = fixture.workflow as Record_;
    return {
      ...fixture,
      id,
      workflow: {
        ...workflow,
        ...(profile ? { profile } : {}),
        machine: { ...(workflow.machine as Record_), serialNumber: serial },
        context: { ...(workflow.context as Record_), ...context },
      },
    };
  }

  it("links Shots pulled with a shared batch at two Locations to it, each to its Location's Grinder and to the Profile they were pulled with, and filters by them", async () => {
    const lab = await api.createLocation("Linked lab", "America/Chicago");
    const cafe = await api.createLocation("Linked cafe", "America/New_York");
    const labMachine = await api.createMachine("Linked lab 1", lab.id);
    const cafeMachine = await api.createMachine("Linked cafe 1", cafe.id);
    // The lab tablet holds the bundled Profile the fixture Shot's skin selected, so it joins the Library.
    const selected = (derivedDe1Pro({})["/profiles"] as Record_[]).find((record) => record.id === SKIN_SELECTED)!;
    const labTablet = load(labMachine, "26001", { library: { "/profiles": [selected] } });
    const cafeTablet = load(cafeMachine, "26002", { instance: other });
    for (const { machine } of [labMachine, cafeMachine]) await api.waitForMachine(machine.name, (viewed) => viewed.online);

    const bean = (await send<{ bean: { id: string } }>("POST", "/beans", { content: { roaster: "Roux", name: "Linked Guji" } }, 201)).bean;
    const batch = (
      await send<{ batch: { id: string } }>("POST", "/bean-batches", { beanId: bean.id, content: { roastDate: "2026-10-01" }, locations: [{ locationId: lab.id }, { locationId: cafe.id }] }, 201)
    ).batch;
    const grinder = async (location: LocationView, model: string) =>
      (await send<{ grinder: { id: string } }>("POST", "/grinders", { locationId: location.id, content: { model } }, 201)).grinder;
    const labGrinder = await grinder(lab, "Linked lab EK43");
    const cafeGrinder = await grinder(cafe, "Linked cafe EK43");
    for (const tablet of [labTablet, cafeTablet]) await poll(() => held(tablet.batches(), batch.id)).toBeTruthy();
    await poll(() => held(labTablet.grinders(), labGrinder.id)).toBeTruthy();
    await poll(() => held(cafeTablet.grinders(), cafeGrinder.id)).toBeTruthy();

    // A Profile a lab barista saved joins the Library; the Shot's Workflow holds it as Decaid holds it.
    const profile = (await labTablet.addProfile(derivedProfile("Linked bloom", 7.5))).profile as Record_;
    const libraryProfile = async () => (await send<{ profiles: { id: string; title: string }[] }>("GET", "/profiles")).profiles.find((p) => p.title === "Linked bloom");
    await poll(libraryProfile).toBeTruthy();
    const profileId = (await libraryProfile())!.id;

    // Each tablet names the batch and its Grinder by its own ids.
    const labLocal = { beanBatchId: held(labTablet.batches(), batch.id)!.id, grinderId: held(labTablet.grinders(), labGrinder.id)!.id };
    const cafeLocal = { beanBatchId: held(cafeTablet.batches(), batch.id)!.id, grinderId: held(cafeTablet.grinders(), cafeGrinder.id)!.id };
    expect(labLocal.beanBatchId).not.toBe(cafeLocal.beanBatchId);
    labTablet.pullShot(shotWith("linked-lab-shot", "26001", labLocal, profile));
    // A skin sets the Workflow's profile's target weight to the Shot's yield: still the Profile, as no other matches it but for that.
    labTablet.pullShot(shotWith("linked-yield-shot", "26001", labLocal, { ...profile, target_weight: 41.5 }));
    cafeTablet.pullShot(shotWith("linked-cafe-shot", "26002", cafeLocal));
    await poll(async () => (await api.call("GET", "/shots/linked-cafe-shot")).status).toBe(200);
    await poll(async () => (await api.call("GET", "/shots/linked-lab-shot")).status).toBe(200);
    await poll(async () => (await api.call("GET", "/shots/linked-yield-shot")).status).toBe(200);

    expect(await viewShot("linked-lab-shot")).toMatchObject({
      machine: { id: labMachine.machine.id },
      beanBatch: { id: batch.id, bean: { id: bean.id, roaster: "Roux", name: "Linked Guji" }, roastDate: "2026-10-01T00:00:00.000" },
      grinder: { id: labGrinder.id, model: "Linked lab EK43" },
      profile: { id: profileId, title: "Linked bloom" },
    });
    // The cafe Shot's Workflow holds the fixture's profile, which the Library lacks. The skin's selected id names a
    // Profile the Library has, which its Workflow's profile is not: it is linked to none.
    await poll(async () => (await api.call("GET", `/profiles/${encodeURIComponent(SKIN_SELECTED)}`)).status).toBe(200);
    expect(await viewShot("linked-cafe-shot")).toMatchObject({ machine: { id: cafeMachine.machine.id }, beanBatch: { id: batch.id }, grinder: { id: cafeGrinder.id }, profile: null });

    // The batch's Shots come from Machines at both Locations; each Grinder's from its own.
    expect(new Set(await listed(`beanBatchId=${batch.id}`))).toEqual(new Set(["linked-lab-shot", "linked-yield-shot", "linked-cafe-shot"]));
    expect(new Set(await listed(`beanId=${bean.id}`))).toEqual(new Set(["linked-lab-shot", "linked-yield-shot", "linked-cafe-shot"]));
    expect(new Set(await listed(`grinderId=${labGrinder.id}`))).toEqual(new Set(["linked-lab-shot", "linked-yield-shot"]));
    expect(await listed(`grinderId=${cafeGrinder.id}&machineId=${cafeMachine.machine.id}`)).toEqual(["linked-cafe-shot"]);
    expect(new Set(await listed(`profileId=${encodeURIComponent(profileId)}`))).toEqual(new Set(["linked-lab-shot", "linked-yield-shot"]));
    expect(await listed(`grinderId=${cafeGrinder.id}&machineId=${labMachine.machine.id}`)).toEqual([]);
    expect(await listed(`profileId=${encodeURIComponent(SKIN_SELECTED)}`)).toEqual([]);

    const options = await send<FilterOptions>("GET", "/shots/filters");
    expect(options.beanBatches).toContainEqual(expect.objectContaining({ id: batch.id }));
    expect(options.grinders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: labGrinder.id, model: "Linked lab EK43", location: lab }),
        expect.objectContaining({ id: cafeGrinder.id, model: "Linked cafe EK43", location: cafe }),
      ]),
    );

    // Malformed ids name nothing, as in a path.
    expect((await api.call("GET", "/shots?beanBatchId=not-an-id")).status).toBe(404);
    expect((await api.call("GET", "/shots?grinderId=not-an-id")).status).toBe(404);
  });

  it("links a Shot to the one of two Profiles differing only in target weight that its own matches, and to neither when its own matches neither", async () => {
    const location = await api.createLocation("Weighed cafe", "America/Chicago");
    const machine = await api.createMachine("Weighed cafe 1", location.id);
    const tablet = load(machine, "26041");
    await api.waitForMachine(machine.machine.name, (viewed) => viewed.online);
    const base = derivedProfile("Weighed bloom", 6.5);
    const lighter = (await tablet.addProfile({ ...base, title: "Weighed bloom 36", target_weight: 36 })).profile as Record_;
    const heavier = (await tablet.addProfile({ ...base, title: "Weighed bloom 40", target_weight: 40 })).profile as Record_;
    const libraryId = async (title: string) => (await send<{ profiles: { id: string; title: string }[] }>("GET", "/profiles")).profiles.find((p) => p.title === title)?.id;
    await poll(() => libraryId("Weighed bloom 40")).toBeTruthy();
    await poll(() => libraryId("Weighed bloom 36")).toBeTruthy();
    const [lighterId, heavierId] = [(await libraryId("Weighed bloom 36"))!, (await libraryId("Weighed bloom 40"))!];

    tablet.pullShot(shotWith("weighed-36", "26041", {}, lighter));
    tablet.pullShot(shotWith("weighed-40", "26041", {}, heavier));
    // A skin set its target weight to its yield: either Profile could be it, so it is linked to neither.
    tablet.pullShot(shotWith("weighed-yield", "26041", {}, { ...lighter, target_weight: 37.5 }));
    for (const id of ["weighed-36", "weighed-40", "weighed-yield"]) await poll(async () => (await api.call("GET", `/shots/${id}`)).status).toBe(200);

    expect((await viewShot("weighed-36")).profile).toEqual({ id: lighterId, title: "Weighed bloom 36" });
    expect((await viewShot("weighed-40")).profile).toEqual({ id: heavierId, title: "Weighed bloom 40" });
    expect((await viewShot("weighed-yield")).profile).toBeNull();
    expect(await listed(`profileId=${encodeURIComponent(lighterId)}`)).toEqual(["weighed-36"]);
    expect(await listed(`profileId=${encodeURIComponent(heavierId)}`)).toEqual(["weighed-40"]);
  });

  it("links the test tablet's Shot to the Londonium it was pulled with, which streamline-js sent with its value-0 limiter as none and its yield as target", async () => {
    const location = await api.createLocation("Streamline cafe", "America/Chicago");
    const machine = await api.createMachine("Streamline cafe 1", location.id);
    const londonium = (derivedDe1Pro({})["/profiles"] as Record_[]).find((record) => record.id === LONDONIUM)!;
    const tablet = load(machine, "26051", { library: { "/profiles": [londonium] } });
    await api.waitForMachine(machine.machine.name, (viewed) => viewed.online);
    await poll(async () => (await api.call("GET", `/profiles/${encodeURIComponent(LONDONIUM)}`)).status).toBe(200);

    // The Shot's Workflow's Londonium is not the record's: one step's limiter of value 0 is null, and its target weight is the yield.
    const recorded = (shotFixture().workflow as { profile: { steps: { limiter: unknown }[]; target_weight: number } }).profile;
    const kept = (londonium.profile as { steps: { limiter: unknown }[]; target_weight: number });
    expect(recorded.steps[0]!.limiter).toBeNull();
    expect(kept.steps[0]!.limiter).toEqual({ value: 0, range: 0.6 });
    expect(recorded.target_weight).not.toBe(kept.target_weight);

    tablet.pullShot(shotWith("streamline-shot", "26051", {}));
    await poll(async () => (await api.call("GET", "/shots/streamline-shot")).status).toBe(200);
    expect((await viewShot("streamline-shot")).profile).toEqual({ id: LONDONIUM, title: "Londonium" });
    expect(await listed(`profileId=${encodeURIComponent(LONDONIUM)}&machineId=${machine.machine.id}`)).toEqual(["streamline-shot"]);
  });

  it("keeps a Shot whose batch and Grinder the Library lacks unlinked and listed", async () => {
    const location = await api.createLocation("Unlinked cafe", "America/Chicago");
    const machine = await api.createMachine("Unlinked cafe 1", location.id);
    const tablet = load(machine, "26011");
    await api.waitForMachine(machine.machine.name, (viewed) => viewed.online);

    tablet.pullShot(shotWith("unlinked-shot", "26011", { beanBatchId: "batch-the-library-lacks", grinderId: "grinder-the-library-lacks" }));
    await poll(async () => (await api.call("GET", "/shots/unlinked-shot")).status).toBe(200);
    expect(await viewShot("unlinked-shot")).toMatchObject({ beanBatch: null, grinder: null });
    expect(await listed(`machineId=${machine.machine.id}`)).toEqual(["unlinked-shot"]);
    expect(await listed(`machineId=${machine.machine.id}&beanBatchId=none&grinderId=none`)).toEqual(["unlinked-shot"]);
    const options = await send<FilterOptions>("GET", "/shots/filters");
    expect(options.beanBatches).toContain(null);
    expect(options.grinders).toContain(null);
  });

  it("links a Shot reported before its batch and Grinder joined the Library once the tablet's map holds them", async () => {
    // The Machine is at no Location, so its tablet's batch and Grinder stay out of the Library.
    const machine = await api.createMachine("Before 1");
    const library = derivedDe1Pro({});
    const beans = (library["/beans"] as Record_[]).map((bean) => ({ ...bean, name: `Before ${String(bean.name)}` }));
    const tablet = load(machine, "26021", { library: { "/beans": beans, "/bean-batches": library["/bean-batches"], "/grinders": library["/grinders"] } });
    await api.waitForMachine(machine.machine.name, (viewed) => viewed.online);

    // The test tablet's Shot names one of its batches and grinders.
    tablet.pullShot(shotWith("before-shot", "26021", {}));
    await poll(async () => (await api.call("GET", "/shots/before-shot")).status).toBe(200);
    expect(await viewShot("before-shot")).toMatchObject({ beanBatch: null, grinder: null });

    // Moved to a Location offering no batches or Grinders yet, its tablet brings its own, which join the Library.
    const location = await api.createLocation("Before cafe", "America/Chicago");
    expect((await api.call("POST", `/machines/${machine.machine.id}/location-history`, { locationId: location.id })).status).toBe(201);
    await poll(async () => (await viewShot("before-shot")).beanBatch?.bean.name).toBe("Before Ethiopia Generic 100g Sample");
    const linked = await viewShot("before-shot");
    expect(linked.grinder).toMatchObject({ model: "DF64 v2" });
    expect(await listed(`beanBatchId=${linked.beanBatch!.id}`)).toEqual(["before-shot"]);
  });

  it("keeps a Shot's link when the tablet deletes its record, and refuses to hard-delete what it is linked to", async () => {
    const location = await api.createLocation("Kept cafe", "America/Chicago");
    const machine = await api.createMachine("Kept cafe 1", location.id);
    const tablet = load(machine, "26031", { instance: other });
    await api.waitForMachine(machine.machine.name, (viewed) => viewed.online);
    const bean = (await send<{ bean: { id: string } }>("POST", "/beans", { content: { roaster: "Roux", name: "Kept Guji" } }, 201)).bean;
    const batch = (await send<{ batch: { id: string } }>("POST", "/bean-batches", { beanId: bean.id, content: {}, locations: [{ locationId: location.id }] }, 201)).batch;
    await poll(() => held(tablet.batches(), batch.id)).toBeTruthy();
    const localId = held(tablet.batches(), batch.id)!.id;

    const shot = shotWith("kept-shot", "26031", { beanBatchId: localId });
    tablet.pullShot(shot);
    await poll(async () => (await api.call("GET", "/shots/kept-shot")).status).toBe(200);
    expect((await viewShot("kept-shot")).beanBatch?.id).toBe(batch.id);

    // A barista deletes the batch on the tablet, finishing it there, then rates the Shot.
    expect((await tablet.callApi("DELETE", `/bean-batches/${String(localId)}`)).status).toBeLessThan(300);
    await poll(async () => (await send<{ batch: { locations: unknown[] } }>("GET", `/bean-batches/${batch.id}`)).batch.locations).toEqual([]);
    const { measurements: _, ...metadata } = shot;
    tablet.fire("shotUpdated", { id: shot.id, shot: { ...metadata, updatedAt: "2026-11-01T12:01:00Z", annotations: { enjoyment: 80 } } });
    await poll(async () => (await send<{ shot: { enjoyment: number | null } }>("GET", "/shots/kept-shot")).shot.enjoyment).toBe(80);

    expect((await viewShot("kept-shot")).beanBatch?.id).toBe(batch.id);
    for (const path of [`/bean-batches/${batch.id}`, `/beans/${bean.id}`]) {
      const response = await api.call("DELETE", path);
      expect(response.status).toBe(409);
      expect(((await response.json()) as { message: string }).message).toMatch(/A Shot names/);
    }
  });
});
