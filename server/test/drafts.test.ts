import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { type Profile, STARTING_SHAPES, checkProfile, profileId, readProfile, simulateProfile, standardPuck } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type LocationView, acceptInvite, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, type TestApp, serveTestApp } from "./support/assistants.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 2 for #579: Drafts through the REST API and the MCP endpoint, with a
// real server, a second instance sharing its PostgreSQL, and a simulated
// tablet whose Decaid holds a bundled Profile and one of its own. A Draft is
// started from a Profile, a starting shape or a file, saved as it changes,
// read through the other instance at once, simulated and discarded, by
// Admins and Staff; a Viewer sees none, and no tablet is written one.
// Serials are made up, from 57901.

type Fields = Record<string, unknown>;

interface Source {
  account: { id: string; name: string | null } | null;
  connectedApp: { id: string; name: string } | null;
}

interface Draft {
  id: string;
  title: string;
  startedFrom: { id: string; title: string | null; bundled: boolean | null } | null;
  shape: { key: string; title: string } | null;
  publishesAs: "version" | "separate";
  savedBy: Source;
  savedAt: string;
  saves: number;
  createdAt: string;
  profile: Profile;
  profileId: string;
  models: string[];
  machineModel: string;
  checks: { blocking: Array<{ code: string; step: number | null; message: string }>; advice: Array<{ code: string; step: number | null }> };
  editsText: string[] | null;
}

interface Between {
  saves: number;
  savedBy: Source;
  savedAt: string;
}

/** Classic Italian espresso, which Decaid bundles, by the id Decaid gives it. */
const CLASSIC = "profile:39e939592679fb194706";

const env = { ...ASSISTANT_ENV, SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

const bundled = (JSON.parse(fs.readFileSync(new URL("./fixtures/decaid/profile-ids-v0.9.2/profile-ids.json", import.meta.url), "utf8")) as { bundled: Fields[] }).bundled;
const classicRecord = bundled.find((record) => record.id === CLASSIC)!;
const classic = readProfile(classicRecord.profile).profile!;
/** A Profile of the lab's own: Classic Italian's steps with its last step at 8 bar, under the id Decaid gives that. */
const labProfile: Profile = {
  ...classic,
  title: "Lab soak",
  author: "Lab",
  notes: "",
  steps: classic.steps.map((step, index) => (index === classic.steps.length - 1 && step.pump === "pressure" ? { ...step, pressure: 8 } : step)),
};
const LAB = profileId(labProfile);

describe("Drafts", () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  let otherApi: AdminApi;
  let staff: AdminApi;
  let viewer: AdminApi;
  let adminId: string;
  let lab: LocationView;
  let tablet: SimulatedTablet;
  let app: TestApp;
  let assistant: Assistant;
  let viewerAssistant: Assistant;

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
    otherApi = api.at(other.url);
    adminId = (await api.get<{ account: { id: string } }>("/session")).account.id;
    lab = await api.createLocation("Draft lab", "America/Chicago");
    const machine = await api.createMachine("Draft lab 1", lab.id);
    const own = { ...classicRecord, id: LAB, profile: labProfile, isDefault: false };
    tablet = syncingTablet(machine, server, { api: { ...emptyLibrary("57901"), "/profiles": [classicRecord, own] } });
    await api.waitForOnline(machine);
    // Until the lab's Profile joins the Library: expect.poll can't run in a hook.
    for (let waited = 0; (await api.call("GET", `/profiles/${encodeURIComponent(LAB)}`)).status !== 200; waited += 100) {
      if (waited > 30_000) throw new Error("The lab's Profile never joined the Library");
      await delay(100);
    }
    const { link } = await api.invite("sam@example.com", "staff", [lab.id]);
    const staffCookie = await acceptInvite(server.url, link, { name: "Sam Staff", password: "sam's password" });
    staff = AdminApi.signedInAs(server.url, staffCookie);
    const { link: viewerLink } = await api.invite("val@example.com", "viewer");
    const viewerCookie = await acceptInvite(server.url, viewerLink, { name: "Val Viewer", password: "val's password" });
    viewer = AdminApi.signedInAs(server.url, viewerCookie);
    app = await serveTestApp();
    assistant = await Assistant.connect(server.url, app, await signIn(server.url, admin));
    viewerAssistant = await Assistant.connect(server.url, app, viewerCookie, { allowed: ["read"] });
  });
  afterAll(async () => {
    await assistant?.close();
    await viewerAssistant?.close();
    await app?.close();
    await server?.stop();
  });

  const start = async (body: Fields, as: AdminApi = api) => as.send<{ draft: Draft; held: Fields[] }>("POST", "/drafts", body, 201);
  const read = async (id: string, as: AdminApi = api) => (await as.get<{ draft: Draft }>(`/drafts/${id}`)).draft;
  const save = (id: string, body: Fields, as: AdminApi = api) => as.send<{ draft: Draft; between: Between | null }>("PUT", `/drafts/${id}`, body, 200);
  const refusal = async (as: AdminApi, method: string, path: string, body: unknown, status: number) => {
    const response = await as.call(method, path, body);
    expect(response.status, `${method} ${path}`).toBe(status);
    return ((await response.json()) as { message: unknown }).message;
  };
  /** A tool's error, which the call must answer with. */
  const toolError = async (by: Assistant, name: string, args: Fields) => {
    const result = await by.client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).toBe(true);
    return (result.content as { text: string }[]).map((block) => block.text).join("\n");
  };

  it("starts from a Profile, by Edit, as a new version of it, its profile as it is, and is read through another instance at once", async () => {
    const { draft, held } = await start({ profileId: LAB, as: "version" });
    expect(held).toEqual([]);
    expect(draft).toMatchObject({
      title: "Lab soak",
      startedFrom: { id: LAB, title: "Lab soak", bundled: false },
      shape: null,
      publishesAs: "version",
      savedBy: { account: { id: adminId, name: admin.name }, connectedApp: null },
      saves: 1,
      profile: labProfile,
      profileId: LAB,
      models: ["DE1"],
      machineModel: "DE1",
    });
    // Unchanged, it is the Profile itself, steps, title, author and notes, which publishing would refuse (#667).
    expect(draft.editsText).toEqual([]);
    expect(draft.checks.blocking).toEqual([{ code: "unchanged", step: null, message: 'Nothing has changed: its steps, title, author and notes are those of "Lab soak", which it started from.' }]);
    expect(await read(draft.id, otherApi)).toEqual(draft);
  });

  it("starts from any Profile, by Duplicate, a bundled one too, as a separate Profile titled as a copy; Edit of a bundled one is refused, and so is switching its duplicate to a new version", async () => {
    const { draft } = await start({ profileId: CLASSIC, as: "separate" });
    expect(draft).toMatchObject({ title: "Classic Italian espresso copy", startedFrom: { id: CLASSIC, title: "Classic Italian espresso", bundled: true }, publishesAs: "separate" });
    expect(draft.profile).toEqual({ ...classic, title: "Classic Italian espresso copy" });
    expect(await refusal(api, "POST", "/drafts", { profileId: CLASSIC, as: "version" }, 409)).toBe(
      '"Classic Italian espresso" is one of Decaid\'s bundled Profiles, which only Duplicate starts a Draft from, as a separate Profile',
    );
    expect(await refusal(api, "PUT", `/drafts/${draft.id}`, { publishesAs: "version", saves: draft.saves }, 409)).toBe(
      '"Classic Italian espresso" is one of Decaid\'s bundled Profiles, which a Draft can only publish as a separate Profile from',
    );
    expect((await read(draft.id)).publishesAs).toBe("separate");
    expect(await refusal(api, "POST", "/drafts", { profileId: "profile:00000000000000000000", as: "separate" }, 404)).toBe("No such Profile");
    expect(await refusal(api, "POST", "/drafts", { profileId: LAB }, 400)).toBe('as must be "version", to Edit the Profile, or "separate", to Duplicate it');
  });

  it("starts from a starting shape, and from a file, a bare profile or a whole record, holding what is out of range and saying so", async () => {
    for (const shape of STARTING_SHAPES) {
      const { draft } = await start({ shape: shape.key });
      expect(draft, shape.key).toMatchObject({ title: shape.profile.title, startedFrom: null, shape: { key: shape.key, title: shape.title }, publishesAs: "separate", profile: shape.profile });
      expect(draft.checks, shape.key).toEqual({ blocking: [], advice: [] });
    }
    expect(await refusal(api, "POST", "/drafts", { shape: "nothing" }, 400)).toBe(`shape must be one of ${STARTING_SHAPES.map((shape) => shape.key).join(", ")}`);

    const tooHigh = { ...labProfile, title: "Too high", steps: labProfile.steps.map((step) => (step.pump === "pressure" ? { ...step, pressure: 13 } : step)) };
    const { draft: bare, held } = await start({ file: tooHigh });
    const pressured = tooHigh.steps.flatMap((step, index) => (step.pump === "pressure" ? [index] : []));
    expect(held).toEqual(pressured.map((step) => ({ step, path: `steps.${step}.pressure`, from: 13, to: 12 })));
    expect(bare.profile.steps.filter((step) => step.pump === "pressure").map((step) => step.pressure)).toEqual(pressured.map(() => 12));
    expect(bare).toMatchObject({ title: "Too high", startedFrom: null, shape: null, publishesAs: "separate" });
    const { draft: whole, held: none } = await start({ file: { ...classicRecord, profile: { ...classic, title: "From a record" } } });
    expect(none).toEqual([]);
    expect(whole.profile).toEqual({ ...classic, title: "From a record" });
    expect(await refusal(api, "POST", "/drafts", { file: { steps: [{ pump: "steam" }] } }, 400)).toMatch(/^That file is not a profile Decaid reads: Step 1/);
    expect(await refusal(api, "POST", "/drafts", { shape: "classic", file: classic }, 400)).toMatch(/^Start a Draft from one of/);
  });

  it("saves as it changes, taking a save made after another's and saying another came between", async () => {
    const { draft } = await start({ profileId: LAB, as: "version" });
    const softer = { ...draft.profile, steps: draft.profile.steps.map((step, index) => (index === 0 ? { ...step, temperature: step.temperature - 1 } : step)) };
    const first = await save(draft.id, { profile: softer, saves: 1 });
    expect(first.between).toBeNull();
    expect(first.draft).toMatchObject({ saves: 2, profile: softer, profileId: profileId(softer) });
    expect(Date.parse(first.draft.savedAt)).toBeGreaterThanOrEqual(Date.parse(draft.savedAt));
    // A step's temperature is outside the id's steps key but in its id: the Draft no longer has the Library's steps.
    expect(first.draft.checks.blocking).toEqual([]);

    // Staff, on the other instance, saves over it having started from the first count: taken, and told of the Admin's save.
    const later = { ...softer, title: "Lab soak, longer", steps: softer.steps.map((step) => ({ ...step, seconds: step.seconds + 1 })) };
    const second = await save(draft.id, { profile: later, saves: 1 }, staff.at(other.url));
    expect(second.draft).toMatchObject({ saves: 3, title: "Lab soak, longer", profile: later });
    expect(second.between).toEqual({ saves: 1, savedBy: { machine: null, tabletId: null, account: { id: adminId, name: null }, connectedApp: null }, savedAt: first.draft.savedAt });
    expect((await read(draft.id)).profile).toEqual(later);
    expect((await read(draft.id)).savedBy.account?.name).toBe("Sam Staff");

    // What it will publish as, alone; only one started from a Profile is a new version of one.
    expect((await save(draft.id, { publishesAs: "separate", saves: 3 })).draft).toMatchObject({ publishesAs: "separate", saves: 4, profile: later });
    const shaped = (await start({ shape: "blank" })).draft;
    expect(await refusal(api, "PUT", `/drafts/${shaped.id}`, { publishesAs: "version", saves: 1 }, 400)).toBe("Only a Draft started from a Profile can publish as a new version of it");

    // Held to the widest ranges of the account's models, DE1s alone here.
    const fast = { ...later, steps: later.steps.map((step, index) => (index === 0 && step.pump === "flow" ? { ...step, flow: 16 } : step)) };
    expect(later.steps[0]!.pump).toBe("flow");
    expect(await refusal(api, "PUT", `/drafts/${draft.id}`, { profile: fast, saves: 4 }, 400)).toEqual([`Step 1, "${later.steps[0]!.name}": its flow is 16, outside 0 to 15, which no Machine of the account runs`]);
    expect(await refusal(api, "PUT", `/drafts/${draft.id}`, { profile: { ...later, steps: [{ pump: "steam" }] }, saves: 4 }, 400)).toMatch(/^profile can't be read as Decaid reads one/);
    expect(await refusal(api, "PUT", `/drafts/${draft.id}`, { profile: later }, 400)).toEqual(["saves must be the count of saves the change started from, a whole number from 1"]);
    expect(await refusal(api, "PUT", "/drafts/00000000-0000-7000-8000-000000000000", { profile: later, saves: 1 }, 404)).toBe("No such Draft");
  });

  it("lists every Draft, the one saved last first, each with what it will become and who saved it last", async () => {
    const { draft } = await start({ shape: "lever" });
    await save(draft.id, { profile: { ...draft.profile, title: "Listed lever" }, saves: 1 }, staff);
    const { drafts } = await otherApi.get<{ drafts: Array<Omit<Draft, "profile">> }>("/drafts");
    expect(drafts[0]).toMatchObject({ id: draft.id, title: "Listed lever", shape: { key: "lever", title: "Declining lever" }, publishesAs: "separate", saves: 2, savedBy: { account: { name: "Sam Staff" } } });
    expect(drafts[0]).not.toHaveProperty("profile");
    const saved = drafts.map((each) => Date.parse(each.savedAt));
    expect(saved).toEqual([...saved].sort((a, b) => b - a));
    expect(drafts.some((each) => each.startedFrom?.id === LAB && each.publishesAs === "version")).toBe(true);
  });

  it("is discarded, leaving nothing behind, and is written to no tablet", async () => {
    const { draft } = await start({ shape: "classic" });
    await api.send("DELETE", `/drafts/${draft.id}`, undefined, 204);
    expect(await refusal(otherApi, "GET", `/drafts/${draft.id}`, undefined, 404)).toBe("No such Draft");
    expect(await refusal(api, "DELETE", `/drafts/${draft.id}`, undefined, 404)).toBe("No such Draft");
    expect((await api.get<{ drafts: Draft[] }>("/drafts")).drafts.map((each) => each.id)).not.toContain(draft.id);

    // With Drafts held, a change to the lab's own Profile reaches its tablet, and nothing of any Draft does.
    await api.send("PATCH", `/profiles/${encodeURIComponent(LAB)}`, { content: { notes: "Written while Drafts are held" } }, 200);
    await expect.poll(() => tablet.profiles().find((record) => record.id === LAB)?.profile, { timeout: 30_000 }).toMatchObject({ notes: "Written while Drafts are held" });
    const held = (await api.get<{ drafts: Draft[] }>("/drafts")).drafts;
    expect(held.length).toBeGreaterThan(0);
    expect(tablet.profiles().map((record) => record.id).sort()).toEqual([CLASSIC, LAB].sort());
  });

  it("lets Staff do all of this as Admins do, and a Viewer none of it, who sees no Draft", async () => {
    const { draft } = await start({ profileId: LAB, as: "version" }, staff);
    const staffId = (await staff.get<{ account: { id: string } }>("/session")).account.id;
    // Staff see no account's name, their own either, which the page shows as theirs by its id.
    expect(draft.savedBy.account).toEqual({ id: staffId, name: null });
    expect((await staff.get<{ drafts: Draft[] }>("/drafts")).drafts.find((each) => each.savedBy.account?.id === adminId)?.savedBy.account?.name).toBeNull();
    await staff.send("PUT", `/drafts/${draft.id}`, { publishesAs: "separate", saves: 1 }, 200);
    await staff.send("GET", `/drafts/${draft.id}/simulation`, undefined, 200);
    expect(await refusal(viewer, "GET", "/drafts", undefined, 403)).toBe("A Viewer sees no Drafts");
    expect(await refusal(viewer, "GET", `/drafts/${draft.id}`, undefined, 403)).toBe("A Viewer sees no Drafts");
    expect(await refusal(viewer, "GET", `/drafts/${draft.id}/simulation`, undefined, 403)).toBe("A Viewer sees no Drafts");
    expect(await refusal(viewer, "POST", "/drafts", { shape: "classic" }, 403)).toBe("A Viewer can't change anything");
    expect(await refusal(viewer, "PUT", `/drafts/${draft.id}`, { publishesAs: "version", saves: 2 }, 403)).toBe("A Viewer can't change anything");
    expect(await refusal(viewer, "DELETE", `/drafts/${draft.id}`, undefined, 403)).toBe("A Viewer can't change anything");
    await staff.send("DELETE", `/drafts/${draft.id}`, undefined, 204);
  });

  it("is simulated as a Library Profile is, on the model of the Profile it started from, with the run's checks", async () => {
    const { draft } = await start({ profileId: CLASSIC, as: "separate" });
    const { simulation } = await api.get<{ simulation: Fields & { run: unknown; checks: Draft["checks"] } }>(`/drafts/${draft.id}/simulation`);
    const run = simulateProfile({ profile: draft.profile, puck: standardPuck(0), dose: 18, stopAt: 36, model: "DE1" });
    expect(simulation).toMatchObject({ draft: { id: draft.id, title: draft.title }, model: "DE1", puck: { kind: "standard", grind: 0 }, dose: 18, stopAt: 36, fit: null });
    expect(simulation.run).toEqual(run);
    expect(simulation.checks).toEqual(checkProfile(draft.profile, { models: ["DE1"], libraryProfiles: [{ id: CLASSIC, title: "Classic Italian espresso" }], run }));
    // Its 3 s forced rise to 9 bar, which the pour carries on, is too short to be judged as not reaching it.
    expect(simulation.checks.advice.map((check) => check.code)).not.toContain("targetNotReached");
    expect((await api.get<{ simulation: { model: string; stopAt: number | null } }>(`/drafts/${draft.id}/simulation?model=Bengle&stopAt=0`)).simulation).toMatchObject({ model: "Bengle", stopAt: null });
    // A file of more steps than a machine takes is kept, and can't be simulated.
    const long = { ...classic, title: "Long", steps: Array.from({ length: 21 }, (_, index) => ({ ...classic.steps[index % classic.steps.length]!, name: `Step ${index + 1}` })) };
    const { draft: kept } = await start({ file: long });
    expect(kept.checks.blocking.map((check) => check.code)).toEqual(["tooManySteps"]);
    expect(await refusal(api, "GET", `/drafts/${kept.id}/simulation`, undefined, 409)).toBe("The Draft has 21 steps, more than the 20 a machine takes, so it can't be simulated");
  });

  it("is listed, read, started, changed, simulated and discarded by an assistant, within the budget, as the REST API does", async () => {
    const { result: created } = await assistant.callWithinBudget<{ draft: Draft; held: Fields[] }>("create_draft", { profileId: LAB, as: "version" });
    expect(created.held).toEqual([]);
    const lab = (await api.get<{ profile: { profile: Profile } }>(`/profiles/${encodeURIComponent(LAB)}`)).profile.profile;
    expect(created.draft).toMatchObject({ startedFrom: { id: LAB }, publishesAs: "version", saves: 1, profile: lab });
    expect(created.draft.savedBy.connectedApp).toMatchObject({ name: expect.any(String) });
    expect(created.draft).toEqual({ ...(await read(created.draft.id)) });

    const changed = { ...created.draft.profile, title: "Lab soak, assisted", steps: created.draft.profile.steps.slice(0, -1) };
    const { result: edited } = await assistant.callWithinBudget<{ draft: Draft; between: Between | null }>("edit_draft", { id: created.draft.id, saves: 1, profile: changed });
    expect(edited).toEqual({ draft: await read(created.draft.id), between: null });
    expect(edited.draft.profile).toEqual(changed);

    const { result: shaped } = await assistant.callWithinBudget<{ draft: Draft }>("create_draft", { shape: "blooming" });
    expect(shaped.draft.profile).toEqual(STARTING_SHAPES.find((shape) => shape.key === "blooming")!.profile);
    const { result: given } = await assistant.callWithinBudget<{ draft: Draft; held: Fields[] }>("create_draft", { profile: { ...classic, title: "Described", tank_temperature: 120 } });
    expect(given.held).toEqual([{ step: null, path: "tank_temperature", from: 120, to: 110 }]);

    const { result: listed } = await assistant.callWithinBudget<{ drafts: Draft[] }>("list_drafts");
    expect(listed.drafts).toEqual((await api.get<{ drafts: Draft[] }>("/drafts")).drafts);
    // With how it is tried (#581): followed on no Machine, where no Location tries Drafts.
    expect((await assistant.callWithinBudget<{ draft: Draft }>("get_draft", { id: edited.draft.id })).result.draft).toEqual({ ...edited.draft, following: null, machines: [], trialShots: [] });

    const { result: simulated } = await assistant.callWithinBudget<Fields & { draft: Fields; steps: unknown[]; checks: Fields }>("simulate_draft", { id: edited.draft.id, grind: 0.5, curves: false });
    const rest = (await api.get<{ simulation: Fields & { run: Fields } }>(`/drafts/${edited.draft.id}/simulation?grind=0.5`)).simulation;
    expect(simulated).toMatchObject({ draft: { id: edited.draft.id, title: "Lab soak, assisted" }, puck: { kind: "standard", grind: 0.5 }, duration: rest.run.duration, steps: rest.run.steps, checks: rest.checks });
    expect(simulated).not.toHaveProperty("curves");

    expect((await assistant.callWithinBudget<{ discarded: true }>("discard_draft", { id: shaped.draft.id })).result).toEqual({ discarded: true });
    expect(await refusal(api, "GET", `/drafts/${shaped.draft.id}`, undefined, 404)).toBe("No such Draft");
    expect(await toolError(assistant, "create_draft", { profileId: CLASSIC, as: "version" })).toMatch(/one of Decaid's bundled Profiles/);
    expect(await toolError(assistant, "create_draft", { profileId: LAB })).toMatch(/^Give as with profileId/);
    expect(await toolError(assistant, "edit_draft", { id: edited.draft.id, saves: 2 })).toBe("Give profile, publishesAs or both to change");
  });

  it("is seen by no Viewer's assistant", async () => {
    for (const [name, args] of [["list_drafts", {}], ["get_draft", { id: "00000000-0000-7000-8000-000000000000" }], ["simulate_draft", { id: "00000000-0000-7000-8000-000000000000" }]] as const) {
      expect(await toolError(viewerAssistant, name, args), name).toBe("A Viewer sees no Drafts");
    }
  });
});
