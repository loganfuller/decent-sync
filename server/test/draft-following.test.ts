import { randomUUID } from "node:crypto";
import { type Profile, STARTING_SHAPES, dye2GlobalIdOf, profileId, stepsKey } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, type TestApp, serveTestApp } from "./support/assistants.js";
import { LoadedTablets, emptyLibrary, recipeIdInWorkflow } from "./support/loaded-tablets.js";
import { SimulatedDye2, dye2List, recordedDye2MainTablet, selectRecipeInDye2 } from "./support/simulated-dye2.js";
import { startStreamline } from "./support/simulated-streamline.js";
import { shotFixture } from "./support/shot-fixtures.js";
import { RawConnection, type SimulatedTablet, helloWith } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 2 for #581: a Machine following a Draft, and Trial Shots, through the
// REST API and the MCP endpoint, with a real server, a second instance
// sharing its PostgreSQL, and the built plugin in simulated tablets. The lab
// tablet runs DYE2 as recorded (fixtures/decaid/dye2-v0.1.26/ and later), so
// it has a Loaded Recipe for following to end; the others' Libraries are
// empty. A Location is marked by an Admin, a Machine there follows a Draft
// through its Workflow alone, each save reaching it, held while a Shot runs;
// following ends as the Workflow's profile changes, and a Shot pulled with
// the Draft's steps is a Trial Shot. Serials are made up, from 58101.

type Fields = Record<string, unknown>;

interface Following {
  machine: { id: string; name: string; location: { id: string; name: string } | null };
  startedAt: string;
  state: "current" | "waiting" | "ended";
  since: string | null;
  waitingFor: string | null;
  ended: { at: string; why: string } | null;
  has: string | null;
  titleOnTablet: string;
}

interface Trying {
  following: Following | null;
  machines: { id: string; name: string; location: { id: string; name: string }; needsPluginUpdate: boolean; canFollow: boolean; follows: { id: string; title: string } | null }[];
  trialShots: { shot: { id: string; machine: { id: string } | null; profile: { id: string } | null }; trialId: string; steps: "current" | "earlier" }[];
}

interface Draft {
  id: string;
  title: string;
  saves: number;
  profile: Profile;
}

const env = { ...ASSISTANT_ENV, SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** The recording's tablet's record id of the Ethiopia's recipe. */
const ETHIOPIA = "1";
const LAB_SERIAL = "58101";

const blooming = STARTING_SHAPES.find((shape) => shape.key === "blooming")!.profile;
/** The starting shape with its first step's pressure or flow target nudged, so each call's steps are another Profile's. */
const shaped = (title: string, nudge: number): Profile => ({
  ...blooming,
  title,
  steps: blooming.steps.map((step, index) => (index === 0 ? { ...step, seconds: step.seconds + nudge } : step)),
});

describe("A Machine following a Draft", { timeout: 120_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  let staff: AdminApi;
  let away: AdminApi;
  let viewer: AdminApi;
  let lab: LocationView;
  let cafe: LocationView;
  let labMachine: CreatedMachine;
  let secondMachine: CreatedMachine;
  let cafeMachine: CreatedMachine;
  let tablet: SimulatedTablet;
  let second: SimulatedTablet;
  let app: TestApp;
  let assistant: Assistant;
  let viewerAssistant: Assistant;
  const tablets = new LoadedTablets();

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
    lab = await api.createLocation("Trial lab", "America/Chicago");
    cafe = await api.createLocation("Trial cafe", "America/Chicago");
    labMachine = await api.createMachine("Trial lab 1", lab.id);
    secondMachine = await api.createMachine("Trial lab 2", lab.id);
    cafeMachine = await api.createMachine("Trial cafe 1", cafe.id);
    tablet = tablets.syncing(labMachine, server, { api: recordedDye2MainTablet(LAB_SERIAL, "Trial"), dye2: new SimulatedDye2() });
    second = tablets.syncing(secondMachine, other, { api: emptyLibrary("58102") });
    tablets.syncing(cafeMachine, server, { api: emptyLibrary("58103") });
    await api.waitForOnline(labMachine, secondMachine, cafeMachine);
    const cookie = async (email: string, role: "staff" | "viewer", locations: string[]) =>
      acceptInvite(server.url, (await api.invite(email, role, locations)).link, { name: email.split("@")[0]!, password: `${email} password` });
    staff = AdminApi.signedInAs(server.url, await cookie("trial-staff@example.com", "staff", [lab.id]));
    away = AdminApi.signedInAs(server.url, await cookie("trial-away@example.com", "staff", [cafe.id]));
    const viewerCookie = await cookie("trial-viewer@example.com", "viewer", []);
    viewer = AdminApi.signedInAs(server.url, viewerCookie);
    app = await serveTestApp();
    assistant = await Assistant.connect(server.url, app, await signIn(server.url, admin));
    viewerAssistant = await Assistant.connect(server.url, app, viewerCookie, { allowed: ["read"] });
  });
  afterAll(async () => {
    await assistant?.close();
    await viewerAssistant?.close();
    await app?.close();
    await tablets.unloadAll();
    await server?.stop();
  });

  const start = async (profile: Profile, as: AdminApi = api) => (await as.send<{ draft: Draft }>("POST", "/drafts", { file: profile }, 201)).draft;
  const save = async (draft: Draft, profile: Profile, as: AdminApi = api) =>
    (await as.send<{ draft: Draft }>("PUT", `/drafts/${draft.id}`, { profile, saves: draft.saves }, 200)).draft;
  const trying = async (draft: { id: string }, as: AdminApi = api) => (await as.get<{ trying: Trying }>(`/drafts/${draft.id}/trying`)).trying;
  const follow = async (draft: { id: string }, machine: CreatedMachine, as: AdminApi = api) =>
    (await as.send<{ trying: Trying }>("PUT", `/drafts/${draft.id}/following`, { machineId: machine.machine.id }, 200)).trying;
  const refusal = async (as: AdminApi, method: string, path: string, body: unknown, status: number) => {
    const response = await as.call(method, path, body);
    expect(response.status, `${method} ${path}`).toBe(status);
    return ((await response.json()) as { message: unknown }).message;
  };
  const toolError = async (by: Assistant, name: string, args: Fields) => {
    const result = await by.client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).toBe(true);
    return (result.content as { text: string }[]).map((block) => block.text).join("\n");
  };
  const state = async (draft: { id: string }) => (await trying(draft)).following?.state ?? null;
  const workflowProfile = (of: SimulatedTablet) => of.workflow().profile as Profile;
  /** The writes of a Draft the server sent the tablet's plugin. */
  const draftWrites = (of: SimulatedTablet) => of.received.filter((frame) => (frame as Fields).type === "write" && (frame as Fields).kind === "draft");
  /** A Shot the tablet's Machine pulled just now with the Workflow it holds. */
  const shotOf = (of: SimulatedTablet, id: string, serial: string): Fields => {
    const fixture = shotFixture();
    const held = of.workflow();
    return { ...fixture, id, timestamp: new Date().toISOString(), workflow: { ...held, machine: { ...((fixture.workflow as Fields).machine as Fields), serialNumber: serial } } };
  };
  const loadedRecipe = async ({ machine }: CreatedMachine) =>
    (await api.get<{ machine: { loadedRecipe: { recipe: { id: string } } | null } }>(`/machines/${machine.id}`)).machine.loadedRecipe?.recipe.id ?? null;
  /**
   * Has the lab's Machine follow the Draft, and waits until it has its steps
   * and the server holds the Workflow carrying them. The plugin answers the
   * Draft's write, which makes the following current, ahead of the Workflow
   * delivery that write caused, which alone tells the server what the Machine
   * has (#645); the wait reads the poll it makes anyway.
   */
  const followed = async (draft: Draft, machine = labMachine) => {
    await follow(draft, machine);
    await expect
      .poll(
        async () => {
          const following = (await trying(draft)).following;
          // When the titles differ, hasItsSteps holds both, as toMatchObject's diff drops keys the matcher doesn't name.
          return following && { state: following.state, hasItsSteps: following.has === following.titleOnTablet || { has: following.has, titleOnTablet: following.titleOnTablet } };
        },
        { timeout: 15_000 },
      )
      .toMatchObject({ state: "current", hasItsSteps: true });
  };

  it("offers only the Machines of a Location an Admin marked for trying Drafts", async () => {
    const draft = await start(shaped("Offered", 0));
    const listed = async () => (await api.get<{ locations: (LocationView & { triesDrafts: boolean })[] }>("/locations")).locations;
    expect((await listed()).map((location) => location.triesDrafts)).toEqual([false, false]);
    expect((await trying(draft)).machines).toEqual([]);
    expect(await refusal(api, "PUT", `/drafts/${draft.id}/following`, { machineId: labMachine.machine.id }, 409)).toBe("Drafts are not tried at Trial lab: an Admin turns that on for a Location");

    // Only an Admin marks a Location.
    expect((await staff.call("PATCH", `/locations/${lab.id}`, { triesDrafts: true })).status).toBe(403);
    expect(await refusal(api, "PATCH", `/locations/${lab.id}`, { triesDrafts: "yes" }, 400)).toEqual(["triesDrafts must be true or false"]);
    expect((await api.send<{ location: Fields }>("PATCH", `/locations/${lab.id}`, { triesDrafts: true })).location).toEqual({ ...lab, triesDrafts: true });
    expect((await listed()).find((location) => location.id === lab.id)?.triesDrafts).toBe(true);
    const where = { id: lab.id, name: "Trial lab" };
    expect((await trying(draft)).machines).toEqual([
      { id: labMachine.machine.id, name: "Trial lab 1", location: where, needsPluginUpdate: false, canFollow: true, follows: null },
      { id: secondMachine.machine.id, name: "Trial lab 2", location: where, needsPluginUpdate: false, canFollow: true, follows: null },
    ]);
    // Through an assistant too, where an Admin's marks one and every account reads it.
    const { result } = await assistant.callWithinBudget<{ locations: { id: string; triesDrafts: boolean }[] }>("list_locations");
    expect(result.locations.map((location) => [location.id, location.triesDrafts])).toEqual(expect.arrayContaining([[lab.id, true], [cafe.id, false]]));
    expect((await assistant.callWithinBudget<{ location: Fields }>("edit_location", { locationId: lab.id, triesDrafts: true })).result.location).toMatchObject({ triesDrafts: true });

    // A cafe's Machine never follows one, nor a Machine there for anyone, and a Viewer and Staff working elsewhere change nothing.
    expect(await refusal(api, "PUT", `/drafts/${draft.id}/following`, { machineId: cafeMachine.machine.id }, 409)).toBe("Drafts are not tried at Trial cafe: an Admin turns that on for a Location");
    expect(await refusal(away, "PUT", `/drafts/${draft.id}/following`, { machineId: labMachine.machine.id }, 403)).toBe("Only an Admin or Staff working at Trial lab can have its Machines follow a Draft");
    expect((await viewer.call("PUT", `/drafts/${draft.id}/following`, { machineId: labMachine.machine.id })).status).toBe(403);
    expect(await refusal(viewer, "GET", `/drafts/${draft.id}/trying`, undefined, 403)).toBe("A Viewer sees no Drafts");
    expect(await refusal(api, "PUT", `/drafts/${draft.id}/following`, {}, 400)).toBe("machineId must be the id of the Machine to follow the Draft on");
    expect(await refusal(api, "PUT", `/drafts/${draft.id}/following`, { machineId: randomUUID() }, 404)).toBe("No such Machine");
    expect(await refusal(api, "DELETE", `/drafts/${draft.id}/following`, undefined, 409)).toBe("No Machine is following the Draft");
    expect((await trying(draft)).following).toBeNull();
    expect(draftWrites(tablet)).toEqual([]);
  });

  it("sets the Draft's profile as the Machine's Workflow's under its title with (Draft) after it, ending its Loaded Recipe, and again on each save", async () => {
    // The Machine has a Recipe loaded, applied from DYE2's Select Recipe page.
    await expect.poll(() => dye2GlobalIdOf((dye2List(tablet, "recipes") as Fields[]).find((entry) => entry.id === ETHIOPIA)), { timeout: 15_000 }).not.toBeNull();
    expect((await selectRecipeInDye2(tablet, ETHIOPIA)).applied?.workflow?.status).toBe(200);
    await expect.poll(() => loadedRecipe(labMachine), { timeout: 15_000 }).not.toBeNull();
    const before = tablet.workflow().context as Fields;
    const profiles = tablet.profiles().length;

    const draft = await start(shaped("Lab bloom", 0), staff);
    const began = await follow(draft, labMachine, staff);
    expect(began.following).toMatchObject({ machine: { id: labMachine.machine.id, name: "Trial lab 1", location: { id: lab.id, name: "Trial lab" } }, ended: null, titleOnTablet: "Lab bloom (Draft)" });
    await expect.poll(() => state(draft), { timeout: 15_000 }).toBe("current");
    expect(workflowProfile(tablet)).toEqual({ ...draft.profile, title: "Lab bloom (Draft)" });
    // Its dose, yield, Bean Batch, Grinder and Basket stay as they are, and the recipe it named is cleared.
    const { extras: extrasBefore, ...restBefore } = before;
    const { extras, ...rest } = tablet.workflow().context as Fields;
    expect(rest).toEqual(restBefore);
    expect({ ...(extras as Fields), dye: undefined }).toEqual({ ...(extrasBefore as Fields), dye: undefined });
    expect(recipeIdInWorkflow(tablet)).toBeNull();
    await expect.poll(() => loadedRecipe(labMachine), { timeout: 15_000 }).toBeNull();
    // Never a record in the tablet's profile list.
    expect(tablet.profiles()).toHaveLength(profiles);
    const first = (await trying(draft)).following!;
    expect(first).toMatchObject({ state: "current", waitingFor: null, since: expect.any(String) });
    // The change is the plugin's own, named as its write of a Draft.
    await expect
      .poll(async () => (await api.get<{ events: { cause: string; pluginWrite: string | null }[] }>(`/machines/${labMachine.machine.id}/workflow-events?limit=1`)).events[0], { timeout: 15_000 })
      .toMatchObject({ cause: "plugin", pluginWrite: "draft" });

    // Each save reaches it by itself, through the other instance too.
    const saved = await save(draft, shaped("Lab bloom", 2), api.at(other.url));
    await expect.poll(() => workflowProfile(tablet).steps[0]?.seconds, { timeout: 15_000 }).toBe(blooming.steps[0]!.seconds + 2);
    await expect.poll(() => state(saved), { timeout: 15_000 }).toBe("current");
    expect(new Date((await trying(saved)).following!.since!).getTime()).toBeGreaterThan(new Date(first.since!).getTime());
    expect(draftWrites(tablet)).toHaveLength(2);
    // A save that changes nothing of its profile sends nothing.
    const again = await save(saved, saved.profile);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(draftWrites(tablet)).toHaveLength(2);
    expect(await state(again)).toBe("current");
    await api.send("DELETE", `/drafts/${draft.id}`, undefined, 204);
  });

  it("keeps writing the Loaded Recipe where the tablet refuses the Draft before it is ever written", async () => {
    expect((await selectRecipeInDye2(tablet, ETHIOPIA)).applied?.workflow?.status).toBe(200);
    await expect.poll(() => loadedRecipe(labMachine), { timeout: 15_000 }).not.toBeNull();
    tablet.refuseWrites = ({ method, route, body }) =>
      method === "PUT" && route === "/workflow" && String(((body as Fields).profile as Fields | undefined)?.title ?? "").endsWith("(Draft)") ? { status: 400, body: { error: "Not taken" } } : undefined;
    try {
      const draft = await start(shaped("Refused", 14));
      await follow(draft, labMachine);
      await expect.poll(async () => (await trying(draft)).following?.waitingFor ?? null, { timeout: 15_000 }).not.toBeNull();
      expect(await state(draft)).toBe("waiting");
      const recipe = (await loadedRecipe(labMachine))!;
      expect(recipe).not.toBeNull();
      // An edit of the Loaded Recipe still reaches the Machine's Workflow.
      expect((await api.call("PATCH", `/recipes/${recipe}`, { content: { hotWaterVolume: 133 } })).status).toBe(200);
      await expect.poll(() => (tablet.workflow() as Fields & { hotWaterData?: Fields }).hotWaterData?.volume, { timeout: 15_000 }).toBe(133);
      await api.send("DELETE", `/drafts/${draft.id}`, undefined, 204);
    } finally {
      tablet.refuseWrites = undefined;
    }
  });

  it("holds a save while a Shot runs, and ties each Shot pulled on the Draft's steps to the steps it ran, whatever the tablet's brew temperature and yield", async () => {
    let draft = await start(shaped("Held", 0));
    await followed(draft);
    // A Shot begins, and a save is made during it.
    tablet.reportState("espresso", "pouring");
    const sent = draftWrites(tablet).length;
    draft = await save(draft, shaped("Held", 3));
    await expect.poll(() => draftWrites(tablet).length, { timeout: 15_000 }).toBeGreaterThan(sent);
    expect(workflowProfile(tablet).steps[0]?.seconds).toBe(blooming.steps[0]!.seconds);
    expect((await trying(draft)).following).toMatchObject({ state: "waiting" });
    // The Shot ends, stored with the steps it ran, and the save lands.
    tablet.reportState("idle", "idle");
    tablet.pullShot(shotOf(tablet, "trial-held-1", LAB_SERIAL));
    await expect.poll(() => workflowProfile(tablet).steps[0]?.seconds, { timeout: 15_000 }).toBe(blooming.steps[0]!.seconds + 3);
    await expect.poll(() => state(draft), { timeout: 15_000 }).toBe("current");
    await expect.poll(async () => (await trying(draft)).trialShots.map((trial) => [trial.shot.id, trial.steps]), { timeout: 15_000 }).toEqual([["trial-held-1", "earlier"]]);

    // The barista moves the brew temperature and the yield on the tablet, as Streamline's tiles do: the Draft is still followed.
    const held = workflowProfile(tablet);
    const moved = { ...held, target_weight: 41, steps: held.steps.map((step) => ({ ...step, temperature: step.temperature + 1.5 })) };
    expect((await tablet.callApi("PUT", "/workflow", { profile: moved })).status).toBe(200);
    tablet.pullShot(shotOf(tablet, "trial-held-2", LAB_SERIAL));
    await expect.poll(async () => (await trying(draft)).trialShots.map((trial) => [trial.shot.id, trial.steps]), { timeout: 15_000 }).toEqual([
      ["trial-held-2", "current"],
      ["trial-held-1", "earlier"],
    ]);
    expect(await state(draft)).toBe("current");
    const [latest, earlier] = (await trying(draft)).trialShots;
    expect(latest!.shot.machine).toMatchObject({ id: labMachine.machine.id });
    expect(latest!.trialId).not.toBe(earlier!.trialId);
    // An earlier trial opens against the steps it ran, under the Draft's own title.
    const ran = (await api.get<{ trial: { id: string; machine: Fields; profile: Profile } }>(`/drafts/${draft.id}/trials/${earlier!.trialId}`)).trial;
    expect(ran).toMatchObject({ id: earlier!.trialId, machine: { id: labMachine.machine.id, name: "Trial lab 1" }, profile: shaped("Held", 0) });
    expect((await api.get<{ trial: { profile: Profile } }>(`/drafts/${draft.id}/trials/${latest!.trialId}`)).trial.profile).toEqual(shaped("Held", 3));
    expect(await refusal(api, "GET", `/drafts/${draft.id}/trials/${randomUUID()}`, undefined, 404)).toBe("The Draft was tried with no such steps");
    // The simulation moves to the trial's puck, beside the Shot's own figures.
    const simulation = (await api.get<{ simulation: { puck: Fields; fit: unknown } }>(`/drafts/${draft.id}/simulation?shotId=trial-held-2`)).simulation;
    expect(simulation.puck).toMatchObject({ kind: "shot" });

    // An assistant reads them with the Draft, and the steps one ran.
    const { result } = await assistant.callWithinBudget<{ draft: Fields & { trialShots: Fields[]; following: Fields }; trial?: { profile: Profile } }>("get_draft", { id: draft.id, trialId: earlier!.trialId });
    expect(result.draft.trialShots).toEqual([
      expect.objectContaining({ id: "trial-held-2", steps: "current", trialId: latest!.trialId, machine: { id: labMachine.machine.id, name: "Trial lab 1" } }),
      expect.objectContaining({ id: "trial-held-1", steps: "earlier", trialId: earlier!.trialId }),
    ]);
    expect(result.draft.following).toMatchObject({ state: "current", machine: { id: labMachine.machine.id } });
    expect(result.trial?.profile).toEqual(shaped("Held", 0));
    // A Shot pulled on other steps, or on another Machine, is none of the Draft's.
    second.pullShot(shotOf(tablet, "trial-held-elsewhere", "58102"));
    expect((await tablet.callApi("PUT", "/workflow", { profile: { ...held, steps: held.steps.slice(0, 1) } })).status).toBe(200);
    tablet.pullShot(shotOf(tablet, "trial-held-other-steps", LAB_SERIAL));
    await expect.poll(async () => (await api.call("GET", "/shots/trial-held-other-steps")).status, { timeout: 15_000 }).toBe(200);
    await expect.poll(async () => (await api.call("GET", "/shots/trial-held-elsewhere")).status, { timeout: 15_000 }).toBe(200);
    expect((await trying(draft)).trialShots.map((trial) => trial.shot.id)).toEqual(["trial-held-2", "trial-held-1"]);
    await api.send("DELETE", `/drafts/${draft.id}`, undefined, 204);
  });

  it("stops following once the Workflow's profile is no longer the Draft's steps, sends nothing by itself after that, and follows again when asked", async () => {
    let draft = await start(shaped("Taken back", 0));
    await followed(draft);
    // A barista loads a profile on the tablet.
    const classic = tablet.profiles().find((record) => (record.profile as Fields).title === "Classic Italian espresso")!;
    expect((await tablet.callApi("PUT", "/workflow", { profile: classic.profile })).status).toBe(200);
    await expect.poll(() => state(draft), { timeout: 15_000 }).toBe("ended");
    expect((await trying(draft)).following).toMatchObject({ state: "ended", since: null, ended: { at: expect.any(String), why: "workflow" }, has: "Classic Italian espresso", machine: { id: labMachine.machine.id } });
    const sent = draftWrites(tablet).length;
    draft = await save(draft, shaped("Taken back", 1));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(draftWrites(tablet)).toHaveLength(sent);
    expect(workflowProfile(tablet).title).toBe("Classic Italian espresso");

    // One press follows again, which replaces what the Machine has loaded.
    await followed(draft);
    expect(workflowProfile(tablet)).toEqual({ ...shaped("Taken back", 1), title: "Taken back (Draft)" });
    // Streamline's wake profile, where a tablet has it on, ends it the same way.
    const streamline = await startStreamline(tablet);
    await streamline.wake(String(classic.id));
    streamline.stop();
    await expect.poll(() => state(draft), { timeout: 15_000 }).toBe("ended");
    expect((await trying(draft)).following).toMatchObject({ ended: { why: "workflow" }, has: "Classic Italian espresso" });

    // A recipe applied on the Draft's steps but for their temperatures, as DYE2 names one, is the barista's: following ends.
    await followed(draft);
    const held = workflowProfile(tablet);
    const context = tablet.workflow().context as Fields;
    const extras = (context.extras ?? {}) as Fields;
    const recipeWorkflow = {
      profile: { ...held, title: "House", steps: held.steps.map((step) => ({ ...step, temperature: step.temperature - 2 })) },
      context: { ...context, extras: { ...extras, dye: { ...((extras.dye ?? {}) as Fields), recipeId: "trial-house" } } },
    };
    expect((await tablet.callApi("PUT", "/workflow", recipeWorkflow)).status).toBe(200);
    await expect.poll(() => state(draft), { timeout: 15_000 }).toBe("ended");
    expect((await trying(draft)).following).toMatchObject({ ended: { why: "workflow" }, has: "House" });

    // A person turns it off: the Machine keeps the Draft's steps, and a save sends nothing.
    await followed(draft);
    const stopped = (await api.send<{ trying: Trying }>("DELETE", `/drafts/${draft.id}/following`, undefined, 200)).trying;
    expect(stopped.following).toMatchObject({ state: "ended", ended: { why: "stopped" }, has: "Taken back (Draft)" });
    const written = draftWrites(tablet).length;
    draft = await save(draft, shaped("Taken back", 2));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(draftWrites(tablet)).toHaveLength(written);
    await api.send("DELETE", `/drafts/${draft.id}`, undefined, 204);
  });

  it("stops following once steps the Draft was written with earlier are loaded, and counts no Shot pulled after following ended", async () => {
    let draft = await start(shaped("Earlier steps", 10));
    await followed(draft);
    tablet.pullShot(shotOf(tablet, "trial-earlier-1", LAB_SERIAL));
    draft = await save(draft, shaped("Earlier steps", 11));
    await expect.poll(() => state(draft), { timeout: 15_000 }).toBe("current");
    await expect.poll(async () => (await trying(draft)).trialShots.map((trial) => [trial.shot.id, trial.steps]), { timeout: 15_000 }).toEqual([["trial-earlier-1", "earlier"]]);

    // A change of a step's temperature alone makes the steps a Shot ran earlier ones, though it still matches them.
    tablet.pullShot(shotOf(tablet, "trial-earlier-2", LAB_SERIAL));
    await expect.poll(async () => (await trying(draft)).trialShots.map((trial) => trial.steps), { timeout: 15_000 }).toEqual(["current", "earlier"]);
    const warmer = shaped("Earlier steps", 11);
    draft = await save(draft, { ...warmer, steps: warmer.steps.map((step, index) => (index === 0 ? { ...step, temperature: step.temperature + 1 } : step)) });
    await expect.poll(() => state(draft), { timeout: 15_000 }).toBe("current");
    expect((await trying(draft)).trialShots.map((trial) => [trial.shot.id, trial.steps])).toEqual([
      ["trial-earlier-2", "earlier"],
      ["trial-earlier-1", "earlier"],
    ]);

    // A barista loads the profile the Draft started from, the steps it was first written with: following ends, and a save sends nothing.
    expect((await tablet.callApi("PUT", "/workflow", { profile: shaped("Started from", 10) })).status).toBe(200);
    await expect.poll(() => state(draft), { timeout: 15_000 }).toBe("ended");
    expect((await trying(draft)).following).toMatchObject({ ended: { why: "workflow" }, has: "Started from" });
    const sent = draftWrites(tablet).length;
    draft = await save(draft, shaped("Earlier steps", 12));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(draftWrites(tablet)).toHaveLength(sent);
    expect(workflowProfile(tablet).title).toBe("Started from");
    // A Shot pulled on those steps now is none of the Draft's.
    tablet.pullShot(shotOf(tablet, "trial-earlier-after", LAB_SERIAL));
    await expect.poll(async () => (await api.call("GET", "/shots/trial-earlier-after")).status, { timeout: 15_000 }).toBe(200);
    expect((await trying(draft)).trialShots.map((trial) => trial.shot.id)).toEqual(["trial-earlier-2", "trial-earlier-1"]);

    // Followed again, Shots on the steps it is written count from then on.
    await followed(draft);
    tablet.pullShot(shotOf(tablet, "trial-earlier-again", LAB_SERIAL));
    await expect.poll(async () => (await trying(draft)).trialShots.map((trial) => [trial.shot.id, trial.steps]), { timeout: 15_000 }).toEqual([
      ["trial-earlier-again", "current"],
      ["trial-earlier-2", "earlier"],
      ["trial-earlier-1", "earlier"],
    ]);

    // Saved with no steps, it waits, saying why, and nothing is sent.
    const written = draftWrites(tablet).length;
    draft = await save(draft, { ...shaped("Earlier steps", 12), steps: [] });
    await expect.poll(async () => (await trying(draft)).following, { timeout: 15_000 }).toMatchObject({
      state: "waiting",
      waitingFor: "The Draft needs steps, and no more than a machine takes, before the Machine is written it",
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(draftWrites(tablet)).toHaveLength(written);
    await api.send("DELETE", `/drafts/${draft.id}`, undefined, 204);
  });

  it("stops following as the Machine moves, even to another Location that tries Drafts or as a move entered earlier, and not as its entry's time is corrected", async () => {
    const moving = await api.createMachine("Trial lab moving", lab.id);
    const raw = await RawConnection.welcomed(server.url, helloWith(moving.token, { machine: { model: "DE1Pro", serial: "58105" }, tabletId: randomUUID() }));
    const history = async () => (await api.get<{ machine: { locationHistory: { id: string; effectiveFrom: string }[] } }>(`/machines/${moving.machine.id}`)).machine.locationHistory;
    const draft = await start(shaped("Moving trial", 13));
    await follow(draft, moving);
    expect(await state(draft)).toBe("waiting");
    // Following it again on the same Machine leaves it as it is.
    const began = (await trying(draft)).following!.startedAt;
    expect((await follow(draft, moving)).following).toMatchObject({ startedAt: began, ended: null });
    // Its arrival is corrected to a time after following began: it has not moved, and following goes on whatever ends others.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const [arrival] = await history();
    const corrected = new Date(Date.parse(began) + 100).toISOString();
    expect((await api.call("PATCH", `/machines/${moving.machine.id}/location-history/${arrival!.id}`, { effectiveFrom: corrected })).status).toBe(200);
    await api.send("PATCH", `/locations/${cafe.id}`, { triesDrafts: true });
    await api.send("PATCH", `/locations/${cafe.id}`, { triesDrafts: false });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await state(draft)).toBe("waiting");
    await api.send("DELETE", `/drafts/${draft.id}/following`, undefined, 200);
    // Followed again, then moved to the cafe, which tries Drafts now, by an entry dated before following began again: following ends.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const again = (await follow(draft, moving)).following!.startedAt;
    await api.send("PATCH", `/locations/${cafe.id}`, { triesDrafts: true });
    const movedAt = new Date((Date.parse(corrected) + Date.parse(again)) / 2).toISOString();
    await api.send("POST", `/machines/${moving.machine.id}/location-history`, { locationId: cafe.id, effectiveFrom: movedAt }, 201);
    await expect.poll(() => state(draft), { timeout: 15_000 }).toBe("ended");
    expect((await trying(draft)).following).toMatchObject({ ended: { why: "location" }, machine: { id: moving.machine.id } });
    await api.send("PATCH", `/locations/${cafe.id}`, { triesDrafts: false });
    await raw.close();
    await api.send("DELETE", `/drafts/${draft.id}`, undefined, 204);
  });

  it("has a Machine follow one Draft at a time, and ends following where its Location stops trying Drafts", async () => {
    const one = await start(shaped("One at a time", 0));
    const two = await start(shaped("The other", 1));
    await followed(one);
    expect(await refusal(api, "PUT", `/drafts/${two.id}/following`, { machineId: labMachine.machine.id }, 409)).toBe(
      'Trial lab 1 is following another Draft, "One at a time": a Machine follows one Draft at a time, so stop that first',
    );
    expect((await trying(two)).machines.map((machine) => [machine.name, machine.follows])).toEqual([
      ["Trial lab 1", { id: one.id, title: "One at a time" }],
      ["Trial lab 2", null],
    ]);
    // The other Machine, on the other instance, follows the second.
    await followed(two, secondMachine);
    expect(workflowProfile(second)).toEqual({ ...two.profile, title: "The other (Draft)" });
    expect(workflowProfile(tablet).title).toBe("One at a time (Draft)");

    // The Location stops trying Drafts: both end, and nothing more is written.
    await api.send("PATCH", `/locations/${lab.id}`, { triesDrafts: false });
    expect((await trying(one)).following).toMatchObject({ state: "ended", ended: { why: "location" } });
    expect((await trying(two)).following).toMatchObject({ state: "ended", ended: { why: "location" } });
    expect((await trying(one)).machines).toEqual([]);
    const sent = draftWrites(tablet).length;
    await save(one, shaped("One at a time", 4));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(draftWrites(tablet)).toHaveLength(sent);
    await api.send("PATCH", `/locations/${lab.id}`, { triesDrafts: true });
    expect((await trying(one)).following).toMatchObject({ state: "ended" });
    await api.send("DELETE", `/drafts/${one.id}`, undefined, 204);
    await api.send("DELETE", `/drafts/${two.id}`, undefined, 204);
  });

  it("lists a Machine whose tablet never connected as not yet followable, and none as needing its plugin updated", async () => {
    // Every plugin the server accepts follows a Draft: the wire moved on from the revision that brought it (ADR-0025).
    const draft = await start(shaped("Behind", 0));
    // One that never connected can't be judged yet.
    const never = await api.createMachine("Trial lab never", lab.id);
    expect((await trying(draft)).machines.find((machine) => machine.id === never.machine.id)).toMatchObject({ needsPluginUpdate: false, canFollow: false });
    expect(await refusal(api, "PUT", `/drafts/${draft.id}/following`, { machineId: never.machine.id }, 409)).toBe(
      "Trial lab never's tablet has not connected since the server could have it follow a Draft",
    );
    await api.send("DELETE", `/drafts/${draft.id}`, undefined, 204);
  });

  it("stops following as the Draft is published, its Trial Shots on the published steps then the new Profile's, and as it is discarded", async () => {
    let draft = await start(shaped("Published trial", 5));
    await followed(draft);
    tablet.pullShot(shotOf(tablet, "trial-published-earlier", LAB_SERIAL));
    draft = await save(draft, shaped("Published trial", 6));
    await expect.poll(() => state(draft), { timeout: 15_000 }).toBe("current");
    tablet.pullShot(shotOf(tablet, "trial-published", LAB_SERIAL));
    await expect.poll(async () => (await trying(draft)).trialShots.map((trial) => [trial.shot.id, trial.steps]), { timeout: 15_000 }).toEqual([
      ["trial-published", "current"],
      ["trial-published-earlier", "earlier"],
    ]);
    const id = profileId(draft.profile);
    await api.send("POST", `/drafts/${draft.id}/publish`, { saves: draft.saves, locations: [lab.id] }, 200);
    expect(await refusal(api, "GET", `/drafts/${draft.id}/trying`, undefined, 404)).toBe("No such Draft");
    // The Shot on the published steps is the new Profile's, by the Library's ordinary rule, and the earlier one names none.
    await expect
      .poll(async () => (await api.get<{ shots: { id: string }[] }>(`/shots?profileId=${encodeURIComponent(id)}`)).shots.map((shot) => shot.id), { timeout: 15_000 })
      .toEqual(["trial-published"]);
    expect((await api.get<{ shot: { profile: unknown } }>("/shots/trial-published-earlier")).shot.profile).toBeNull();
    expect(stepsKey(workflowProfile(tablet).steps)).toBe(stepsKey(draft.profile.steps));

    // Discarded while followed: the Machine is written nothing more, and another Draft can follow.
    const discarded = await start(shaped("Discarded trial", 7));
    await followed(discarded);
    await api.send("DELETE", `/drafts/${discarded.id}`, undefined, 204);
    const next = await start(shaped("Next trial", 8));
    await followed(next);
    expect(workflowProfile(tablet).title).toBe("Next trial (Draft)");
    await api.send("DELETE", `/drafts/${next.id}`, undefined, 204);
  });

  it("goes on writing the Draft once a move recorded by mistake is removed, the Machine never having left", async () => {
    await api.send("PATCH", `/locations/${cafe.id}`, { triesDrafts: true });
    await api.send("POST", `/machines/${secondMachine.machine.id}/location-history`, { locationId: cafe.id }, 201);
    await api.send("POST", `/machines/${secondMachine.machine.id}/location-history`, { locationId: lab.id }, 201);
    await api.send("PATCH", `/locations/${cafe.id}`, { triesDrafts: false });
    let draft = await start(shaped("Never left", 15));
    await followed(draft, secondMachine);
    const history = (await api.get<{ machine: { locationHistory: { id: string; location: { id: string } }[] } }>(`/machines/${secondMachine.machine.id}`)).machine.locationHistory;
    const mistaken = history.find((entry) => entry.location.id === cafe.id)!;
    expect((await api.call("DELETE", `/machines/${secondMachine.machine.id}/location-history/${mistaken.id}`)).status).toBe(200);
    draft = await save(draft, shaped("Never left", 16));
    await expect.poll(() => workflowProfile(second).steps[0]?.seconds, { timeout: 15_000 }).toBe(blooming.steps[0]!.seconds + 16);
    await expect.poll(() => state(draft), { timeout: 15_000 }).toBe("current");
    await api.send("DELETE", `/drafts/${draft.id}`, undefined, 204);
  });

  it("is started and stopped by an assistant, within its Scope and the budget", async () => {
    const draft = await start(shaped("Assisted trial", 9));
    const { result: began } = await assistant.callWithinBudget<{ trying: Fields & { following: Fields; machines: Fields[] } }>("follow_draft", { id: draft.id, machineId: labMachine.machine.id });
    expect(began.trying.following).toMatchObject({ machine: { id: labMachine.machine.id }, ended: null, titleOnTablet: "Assisted trial (Draft)" });
    await expect.poll(() => state(draft), { timeout: 15_000 }).toBe("current");
    expect(workflowProfile(tablet).title).toBe("Assisted trial (Draft)");
    expect(await toolError(assistant, "follow_draft", { id: draft.id, machineId: cafeMachine.machine.id })).toMatch(/^Drafts are not tried at Trial cafe/);
    const { result: stopped } = await assistant.callWithinBudget<{ trying: { following: Fields } }>("stop_following_draft", { id: draft.id });
    expect(stopped.trying.following).toMatchObject({ state: "ended", ended: { why: "stopped" } });
    expect(await toolError(assistant, "stop_following_draft", { id: draft.id })).toBe("No Machine is following the Draft");
    // A Viewer's assistant, which may only read, has neither tool, and reads no Draft.
    expect(await toolError(viewerAssistant, "get_draft", { id: draft.id })).toBe("A Viewer sees no Drafts");
    await api.send("DELETE", `/drafts/${draft.id}`, undefined, 204);
  });
});
