import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { GLOBAL_ID_KEY, type Profile, profileId, readProfile } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, type TestApp, serveTestApp } from "./support/assistants.js";
import { LoadedTablets, emptyLibrary } from "./support/loaded-tablets.js";
import { SimulatedDye2, dye2List, dye2Migrated, selectRecipeInDye2 } from "./support/simulated-dye2.js";
import { type SimulatedTablet, derivedProfile } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 2 for #580: publishing a Draft, and returning to an earlier Profile
// Version, through the REST API and the MCP endpoint, with a real server, a
// second instance sharing its PostgreSQL, and simulated tablets at two
// Locations: a cafe's, running DYE2, with a Profile of its own and a Recipe
// on it loaded, and a roastery's. A new version takes the old one's place at
// the Locations chosen, with the Recipes chosen, and the old one is hidden
// there but where a Recipe not moved names it; a separate Profile leaves the
// one it came from as it is; returning creates nothing; the refusals; a fork;
// Staff and Viewers; a tablet answering under another id; a tablet off when
// a Profile is published to its Location. A new version that changes only
// the title, author or notes of the Profile it started from, so has its id,
// is an edit of that Profile instead (#667). Serials are made up, from 58001.

type Fields = Record<string, unknown>;

interface Place {
  id: string;
  name: string;
}

interface RecipeRef {
  id: string;
  name: string | null;
  location: Place;
}

interface Published {
  profile: { id: string; title: string | null };
  replaced: { id: string; title: string | null } | null;
  shownAt: Place[];
  hiddenAt: Place[];
  keptAt: { location: Place; recipes: RecipeRef[] }[];
  moved: RecipeRef[];
  forked: { id: string; title: string | null; savedAt: string }[];
  edited: string[] | null;
}

interface Draft {
  id: string;
  saves: number;
  profile: Profile;
  profileId: string;
  publishesAs: "version" | "separate";
  newer: { id: string; title: string | null; savedAt: string }[];
  checks: { blocking: { code: string; message: string }[] };
  editsText: string[] | null;
  versionOf: { id: string; text: { title: string; author: string; notes: string } } | null;
}

interface ProfileView {
  id: string;
  content: Fields;
  locations: { location: { id: string; name: string }; shown: boolean }[];
  refusedOn: { machine: { id: string; name: string }; error: string; refusedAt: string }[];
}

const env = { ...ASSISTANT_ENV, SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** Classic Italian espresso, which Decaid bundles, by the id Decaid gives it. */
const CLASSIC = "profile:39e939592679fb194706";
const bundled = (JSON.parse(fs.readFileSync(new URL("./fixtures/decaid/profile-ids-v0.9.2/profile-ids.json", import.meta.url), "utf8")) as { bundled: Fields[] }).bundled;
const classicRecord = bundled.find((record) => record.id === CLASSIC)!;
const classic = readProfile(classicRecord.profile).profile!;

/** Classic Italian's steps with its last pressure step at `pressure`, titled. */
function soak(title: string, pressure: number): Profile {
  const last = classic.steps.map((step) => step.pump).lastIndexOf("pressure");
  return { ...classic, title, author: "Lab", notes: "", steps: classic.steps.map((step, index) => (index === last ? { ...step, pressure } : step)) };
}

/** The cafe's own Profile, which its tablet brings. */
const cafeProfile = soak("Publish soak", 8);
const CAFE_SOAK = profileId(cafeProfile);

/** Waits, in a hook, where expect.poll can't, until `ready` holds: up to 30 s. */
async function until(what: string, ready: () => Promise<boolean> | boolean): Promise<void> {
  for (let waited = 0; waited < 30_000; waited += 100) {
    if (await ready()) return;
    await delay(100);
  }
  throw new Error(`${what} never happened`);
}

describe("Publishing a Draft, and returning to an earlier version", { timeout: 120_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  let otherApi: AdminApi;
  let staff: AdminApi;
  let viewer: AdminApi;
  let adminId: string;
  let cafe: LocationView;
  let roastery: LocationView;
  let cafeMachine: CreatedMachine;
  let roasteryMachine: CreatedMachine;
  let cafeTablet: SimulatedTablet;
  let roasteryTablet: SimulatedTablet;
  let app: TestApp;
  let assistant: Assistant;
  let staffAssistant: Assistant;
  const tablets = new LoadedTablets();
  /** The cafe's Recipes on its Profile: the espresso, loaded on its Machine with a Reference Shot, and the ristretto. */
  const recipes = { espresso: "", ristretto: "" };
  const SHOT = "publish-reference-shot";

  const path = (id: string, rest = "") => `/profiles/${encodeURIComponent(id)}${rest}`;
  const profile = async (id: string, as: AdminApi = api) => (await as.get<{ profile: ProfileView }>(path(id))).profile;
  const shownAt = async (id: string) => (await profile(id)).locations.filter((here) => here.shown).map((here) => here.location.name).sort();
  const recipe = async (id: string) => (await api.get<{ recipe: { content: Fields; referenceShot: { id: string } | null } }>(`/recipes/${id}`)).recipe;
  const start = async (body: Fields, as: AdminApi = api) => (await as.send<{ draft: Draft }>("POST", "/drafts", body, 201)).draft;
  const save = async (draft: Draft, changed: Profile, as: AdminApi = api) => (await as.send<{ draft: Draft }>("PUT", `/drafts/${draft.id}`, { profile: changed, saves: draft.saves }, 200)).draft;
  const publish = async (draft: Draft, body: Fields, as: AdminApi = api) =>
    (await as.send<{ published: Published }>("POST", `/drafts/${draft.id}/publish`, { saves: draft.saves, ...body }, 200)).published;
  const refusal = async (as: AdminApi, method: string, route: string, body: unknown, status: number) => {
    const response = await as.call(method, route, body);
    expect(response.status, `${method} ${route}`).toBe(status);
    return (await response.json()) as { message: unknown; checks?: { code: string }[] };
  };
  /** The tablet's record of the Profile, if it holds one. */
  const held = (tablet: SimulatedTablet, id: string) => tablet.profiles().find((record) => record.id === id);
  const loadedOn = async () => (await api.get<{ machine: { loadedRecipe: { recipe: { id: string } } | null } }>(`/machines/${cafeMachine.machine.id}`)).machine.loadedRecipe?.recipe.id ?? null;
  /** The pressure of the last pressure step of the cafe Machine's Workflow's profile. */
  const workflowPressure = () => {
    const steps = ((cafeTablet.workflow().profile as Fields | undefined)?.steps ?? []) as Fields[];
    return steps.filter((step) => step.pump === "pressure").at(-1)?.pressure;
  };
  const editsOf = async (id: string) =>
    (await api.get<{ versions: { fields: Fields; source: { account: { id: string } | null; machine: unknown } }[] }>(`/recipes/${id}/history`)).versions.filter(
      (version) => version.fields.profileId !== undefined,
    );

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
    otherApi = api.at(other.url);
    adminId = (await api.get<{ account: { id: string } }>("/session")).account.id;
    cafe = await api.createLocation("Publish cafe", "America/Chicago");
    roastery = await api.createLocation("Publish roastery", "America/Chicago");
    cafeMachine = await api.createMachine("Publish cafe 1", cafe.id);
    roasteryMachine = await api.createMachine("Publish roastery 1", roastery.id);
    const own = { ...classicRecord, id: CAFE_SOAK, profile: cafeProfile, isDefault: false };
    cafeTablet = tablets.syncing(cafeMachine, server, { api: { ...emptyLibrary("58001"), ...dye2Migrated(), "/profiles": [classicRecord, own] }, dye2: new SimulatedDye2() });
    roasteryTablet = tablets.syncing(roasteryMachine, other, { api: emptyLibrary("58002") });
    await api.waitForOnline(cafeMachine, roasteryMachine);
    await until("the cafe's Profile joining the Library", async () => (await api.call("GET", path(CAFE_SOAK))).status === 200);

    // Its Recipes on it, the espresso with a Reference Shot pulled at the cafe.
    for (const [key, name, slot] of [["espresso", "Publish Espresso", 1], ["ristretto", "Publish Ristretto", 2]] as const) {
      recipes[key] = (await api.send<{ recipe: { id: string } }>("POST", "/recipes", { locationId: cafe.id, slot, content: { name, profileId: CAFE_SOAK } }, 201)).recipe.id;
    }
    const recorded = JSON.parse(fs.readFileSync(new URL("./fixtures/decaid/simulated-shots-v0.9.2/classic-italian.json", import.meta.url), "utf8")) as Fields;
    const workflow = recorded.workflow as Fields;
    cafeTablet.pullShot({ ...recorded, id: SHOT, workflow: { ...workflow, profile: cafeProfile, machine: { ...(workflow.machine as Fields), serialNumber: "58001" } } });
    await until("the Shot", async () => (await api.call("GET", `/shots/${SHOT}`)).status === 200);
    await api.send("PUT", `/recipes/${recipes.espresso}/reference-shot`, { shotId: SHOT }, 200);

    // The cafe's Machine loads the espresso from DYE2's Select Recipe page.
    const inList = () => (dye2List(cafeTablet, "recipes") as Fields[] | undefined)?.find((record) => record[GLOBAL_ID_KEY] === recipes.espresso);
    await until("the espresso on the cafe's tablet", () => inList() !== undefined);
    cafeTablet.connectMachine();
    await selectRecipeInDye2(cafeTablet, String(inList()!.id));
    await until("the espresso loaded", async () => (await loadedOn()) === recipes.espresso);

    const { link: staffLink } = await api.invite("publish-staff@example.com", "staff", [roastery.id]);
    const staffCookie = await acceptInvite(server.url, staffLink, { name: "Publish Staff", password: "publish staff password" });
    staff = AdminApi.signedInAs(server.url, staffCookie);
    const { link } = await api.invite("publish-viewer@example.com", "viewer");
    viewer = AdminApi.signedInAs(server.url, await acceptInvite(server.url, link, { name: "Publish Viewer", password: "publish viewer password" }));
    app = await serveTestApp();
    assistant = await Assistant.connect(server.url, app, await signIn(server.url, admin));
    staffAssistant = await Assistant.connect(server.url, app, staffCookie);
  });
  afterAll(async () => {
    await tablets.unloadAll();
    await assistant?.close();
    await staffAssistant?.close();
    await app?.close();
    await server?.stop();
  });

  /** The second version, published from the cafe's Profile with the espresso moved. */
  let second = "";

  it("publishes a new version under Decaid's id, saved from the old, with the Recipe chosen moved and the old one kept shown where a Recipe not moved names it", async () => {
    const draft = await save(await start({ profileId: CAFE_SOAK, as: "version" }), soak("Publish soak", 7.5));
    expect(draft.newer).toEqual([]);
    const published = await publish(draft, { locations: [cafe.id], recipes: [recipes.espresso] });
    second = profileId(soak("Publish soak", 7.5));
    expect(published).toEqual({
      profile: { id: second, title: "Publish soak" },
      replaced: { id: CAFE_SOAK, title: "Publish soak" },
      shownAt: [{ id: cafe.id, name: "Publish cafe" }],
      hiddenAt: [],
      keptAt: [{ location: { id: cafe.id, name: "Publish cafe" }, recipes: [{ id: recipes.ristretto, name: "Publish Ristretto", location: { id: cafe.id, name: "Publish cafe" } }] }],
      moved: [{ id: recipes.espresso, name: "Publish Espresso", location: { id: cafe.id, name: "Publish cafe" } }],
      forked: [],
      edited: null,
    });
    // The Draft is gone, and the Profile is the Library's, read through the other instance at once.
    expect((await api.call("GET", `/drafts/${draft.id}`)).status).toBe(404);
    expect((await profile(second, otherApi)).content).toMatchObject({ parentId: CAFE_SOAK, profile: { title: "Publish soak" } });
    expect(await shownAt(second)).toEqual(["Publish cafe"]);
    expect(await shownAt(CAFE_SOAK)).toEqual(["Publish cafe"]);
    const versions = (await api.get<{ versions: { id: string; parentId: string | null; savedBy: { account: { id: string } | null } | null }[] }>(path(second, "/versions"))).versions;
    expect(versions.find((version) => version.id === second)).toMatchObject({ parentId: CAFE_SOAK, savedBy: { account: { id: adminId } } });

    // The espresso names it, an edit in its history by the account, keeping its Reference Shot; the ristretto doesn't.
    expect((await recipe(recipes.espresso)).content.profileId).toBe(second);
    expect((await recipe(recipes.espresso)).referenceShot?.id).toBe(SHOT);
    expect((await editsOf(recipes.espresso))[0]).toMatchObject({ fields: { profileId: second }, source: { account: { id: adminId }, machine: null } });
    expect((await recipe(recipes.ristretto)).content.profileId).toBe(CAFE_SOAK);

    // The cafe's tablet holds it, saved from the one before, which it keeps shown; and its Machine, with the espresso loaded, runs it.
    await expect.poll(() => held(cafeTablet, second), { timeout: 15_000 }).toMatchObject({ parentId: CAFE_SOAK, visibility: "visible" });
    expect(held(cafeTablet, CAFE_SOAK)).toMatchObject({ visibility: "visible" });
    await expect.poll(workflowPressure, { timeout: 15_000 }).toBe(7.5);
    expect(await loadedOn()).toBe(recipes.espresso);
    // The roastery's, where neither is shown, holds neither.
    expect(held(roasteryTablet, second)).toBeUndefined();
  });

  it("returns to an earlier version, moving the Recipe chosen back and hiding the later one, creating nothing", async () => {
    const count = (await api.get<{ profiles: unknown[] }>("/profiles")).profiles.length;
    const returned = (await api.send<{ published: Published }>("POST", path(CAFE_SOAK, "/return"), { from: second, locations: [cafe.id], recipes: [recipes.espresso] }, 200)).published;
    expect(returned).toMatchObject({
      profile: { id: CAFE_SOAK },
      replaced: { id: second },
      hiddenAt: [{ id: cafe.id, name: "Publish cafe" }],
      keptAt: [],
      moved: [{ id: recipes.espresso }],
      forked: [],
    });
    expect((await api.get<{ profiles: unknown[] }>("/profiles")).profiles.length).toBe(count);
    expect(await shownAt(second)).toEqual([]);
    expect(await shownAt(CAFE_SOAK)).toEqual(["Publish cafe"]);
    expect((await recipe(recipes.espresso)).content.profileId).toBe(CAFE_SOAK);
    expect((await recipe(recipes.espresso)).referenceShot?.id).toBe(SHOT);
    await expect.poll(() => held(cafeTablet, second)?.visibility, { timeout: 15_000 }).toBe("hidden");
    await expect.poll(workflowPressure, { timeout: 15_000 }).toBe(8);

    // Only a version of it, other than itself.
    expect((await refusal(api, "POST", path(CAFE_SOAK, "/return"), { from: CAFE_SOAK, locations: [cafe.id] }, 400)).message).toMatch(/itself/);
    expect((await refusal(api, "POST", path(CLASSIC, "/return"), { from: second, locations: [cafe.id] }, 409)).message).toMatch(/not a version/);
    expect((await refusal(api, "POST", path("profile:00000000000000000000", "/return"), { from: second, locations: [cafe.id] }, 404)).message).toBe("No such Profile");

    // Only Recipes at a Location chosen, each once, not Archived, naming the Profile replaced; each refusal leaves everything as it was.
    const ret = path(second, "/return");
    const lungo = (await api.send<{ recipe: { id: string } }>("POST", "/recipes", { locationId: cafe.id, content: { name: "Publish Lungo", profileId: CLASSIC } }, 201)).recipe.id;
    const retired = (await api.send<{ recipe: { id: string } }>("POST", "/recipes", { locationId: cafe.id, content: { name: "Publish Retired", profileId: CAFE_SOAK } }, 201)).recipe.id;
    await api.send("PUT", `/recipes/${retired}/archived`, { archived: true }, 200);
    expect((await refusal(api, "POST", ret, { from: CAFE_SOAK, locations: [roastery.id], recipes: [recipes.espresso] }, 400)).message).toMatch(/at none of the Locations chosen/);
    expect((await refusal(api, "POST", ret, { from: CAFE_SOAK, locations: [cafe.id], recipes: [recipes.espresso, recipes.espresso] }, 400)).message).toMatch(/each Recipe once/);
    expect((await refusal(api, "POST", ret, { from: CAFE_SOAK, locations: [cafe.id], recipes: [retired] }, 409)).message).toMatch(/Archived/);
    expect((await refusal(api, "POST", ret, { from: CAFE_SOAK, locations: [cafe.id], recipes: [lungo] }, 409)).message).toMatch(/doesn't name the Profile being replaced/);
    // Nor to an Archived version.
    await api.send("PUT", path(second, "/archived"), { archived: true }, 200);
    expect((await refusal(api, "POST", ret, { from: CAFE_SOAK, locations: [cafe.id] }, 409)).message).toMatch(/is Archived/);
    await api.send("PUT", path(second, "/archived"), { archived: false }, 200);
    await api.send("PUT", `/recipes/${lungo}/archived`, { archived: true }, 200);
    expect(await shownAt(CAFE_SOAK)).toEqual(["Publish cafe"]);
    expect(await shownAt(second)).toEqual([]);
    expect((await recipe(recipes.espresso)).content.profileId).toBe(CAFE_SOAK);
  });

  it("publishes a new version with every Recipe moved, hiding the old one at the Location, and the tablets there with it", async () => {
    const draft = await save(await start({ profileId: CAFE_SOAK, as: "version" }), soak("Publish soak", 7));
    const published = await publish(draft, { locations: [cafe.id], recipes: [recipes.espresso, recipes.ristretto] });
    expect(published).toMatchObject({ hiddenAt: [{ id: cafe.id }], keptAt: [] });
    expect(published.moved.map((moved) => moved.id).sort()).toEqual([recipes.espresso, recipes.ristretto].sort());
    expect(await shownAt(CAFE_SOAK)).toEqual([]);
    await expect.poll(() => held(cafeTablet, CAFE_SOAK)?.visibility, { timeout: 15_000 }).toBe("hidden");
    await expect.poll(() => held(cafeTablet, published.profile.id)?.visibility, { timeout: 15_000 }).toBe("visible");
    await expect.poll(workflowPressure, { timeout: 15_000 }).toBe(7);
  });

  it("publishes a separate Profile at the Locations chosen, leaving the one it came from as it is", async () => {
    const third = profileId(soak("Publish soak", 7));
    const before = { shown: await shownAt(third), recipes: [(await recipe(recipes.espresso)).content.profileId, (await recipe(recipes.ristretto)).content.profileId] };
    const draft = await save(await start({ profileId: third, as: "separate" }), soak("Publish soak copy", 6.5));
    expect(draft.publishesAs).toBe("separate");
    expect((await refusal(api, "POST", `/drafts/${draft.id}/publish`, { saves: draft.saves, locations: [roastery.id], recipes: [recipes.espresso] }, 400)).message).toMatch(/moves no Recipes/);
    const published = await publish(draft, { locations: [roastery.id] }, otherApi);
    expect(published).toMatchObject({ replaced: null, shownAt: [{ id: roastery.id }], hiddenAt: [], keptAt: [], moved: [] });
    // Saved from the one it came from, as Streamline saves a Duplicate.
    expect((await profile(published.profile.id)).content.parentId).toBe(third);
    expect(await shownAt(published.profile.id)).toEqual(["Publish roastery"]);
    expect({ shown: await shownAt(third), recipes: [(await recipe(recipes.espresso)).content.profileId, (await recipe(recipes.ristretto)).content.profileId] }).toEqual(before);
    // The roastery's tablet, on the other instance, holds it; the cafe's doesn't.
    await expect.poll(() => held(roasteryTablet, published.profile.id)?.visibility, { timeout: 15_000 }).toBe("visible");
    expect(held(cafeTablet, published.profile.id)).toBeUndefined();
  });

  it("refuses steps a Profile has, naming it, a title shown at a Location chosen, what the checks stop, and a Draft saved since it was read", async () => {
    const third = profileId(soak("Publish soak", 7));
    // A new version with another Profile's steps.
    const another = await save(await start({ profileId: third, as: "version" }), soak("Publish soak", 7.5));
    const same = await refusal(api, "POST", `/drafts/${another.id}/publish`, { saves: another.saves, locations: [cafe.id] }, 409);
    expect(same.message).toMatch(/Its steps are those of "Publish soak"/);
    expect(same.checks?.map((check) => check.code)).toEqual(["sameSteps"]);
    // One unchanged, which is the Profile it started from, steps, title, author and notes (#667).
    const unchanged = await start({ profileId: third, as: "version" });
    expect((await refusal(api, "POST", `/drafts/${unchanged.id}/publish`, { saves: unchanged.saves, locations: [cafe.id] }, 409)).checks?.map((check) => check.code)).toEqual(["unchanged"]);

    // A separate Profile titled as one shown at the cafe, refused there.
    const titled = await save(await start({ profileId: third, as: "separate" }), soak("publish SOAK ", 6));
    expect((await refusal(api, "POST", `/drafts/${titled.id}/publish`, { saves: titled.saves, locations: [cafe.id] }, 409)).checks?.map((check) => check.code)).toEqual(["titleInUse"]);
    // A new version shares its title with the versions it replaces.
    const again = await save(await start({ profileId: third, as: "version" }), soak("Publish soak", 6.8));
    expect((await publish(again, { locations: [cafe.id] })).profile.title).toBe("Publish soak");
    // Nor with a separate Profile saved from the chain under a title of its own: the copy published at the roastery above.
    const asCopy = await save(await start({ profileId: third, as: "version" }), soak("Publish soak copy", 6.2));
    expect((await refusal(api, "POST", `/drafts/${asCopy.id}/publish`, { saves: asCopy.saves, locations: [roastery.id] }, 409)).checks?.map((check) => check.code)).toEqual(["titleInUse"]);
    // But not with the bundled Profile its chain was saved from, which is not one of them.
    const fromClassic = await cafeTablet.addProfile(derivedProfile("Publish from Classic", 9.4), { parentId: CLASSIC });
    await expect.poll(async () => (await api.call("GET", path(String(fromClassic.id)))).status, { timeout: 15_000 }).toBe(200);
    await api.send("PUT", path(CLASSIC, `/locations/${cafe.id}`), { shown: true }, 200);
    const asClassic = await save(await start({ profileId: String(fromClassic.id), as: "version" }), soak(classic.title, 6.1));
    expect((await refusal(api, "POST", `/drafts/${asClassic.id}/publish`, { saves: asClassic.saves, locations: [cafe.id] }, 409)).checks?.map((check) => check.code)).toEqual(["titleInUse"]);
    await api.send("PUT", path(CLASSIC, `/locations/${cafe.id}`), { shown: false }, 200);

    // Refused once the Profile is inserted, it leaves none, and the Draft as it was.
    const misplaced = await save(await start({ profileId: third, as: "version" }), soak("Publish soak", 6.3));
    expect((await refusal(api, "POST", `/drafts/${misplaced.id}/publish`, { saves: misplaced.saves, locations: [roastery.id], recipes: [recipes.espresso] }, 400)).message).toMatch(/at none of the Locations chosen/);
    expect((await api.call("GET", path(profileId(soak("Publish soak", 6.3))))).status).toBe(404);
    expect((await api.get<{ draft: Draft }>(`/drafts/${misplaced.id}`)).draft.saves).toBe(misplaced.saves);

    const untitled = await save(await start({ shape: "classic" }), soak("", 5.5));
    expect((await refusal(api, "POST", `/drafts/${untitled.id}/publish`, { saves: untitled.saves, locations: [roastery.id] }, 409)).checks?.map((check) => check.code)).toContain("noTitle");

    // Saved by someone else since the person read it.
    const read = await start({ profileId: CLASSIC, as: "separate" });
    await save(read, soak("Publish saved since", 5.8), otherApi);
    expect((await refusal(api, "POST", `/drafts/${read.id}/publish`, { saves: read.saves, locations: [roastery.id] }, 409)).message).toMatch(/saved since/);
    expect((await refusal(api, "POST", `/drafts/${read.id}/publish`, { saves: read.saves + 1, locations: ["00000000-0000-4000-8000-000000000000"] }, 404)).message).toBe("No such Location");
    expect((await refusal(api, "POST", `/drafts/${read.id}/publish`, { saves: read.saves + 1, locations: [] }, 400)).message).toEqual([expect.stringMatching(/at least one/)]);
    expect((await api.call("GET", `/drafts/${read.id}`)).status).toBe(200);
  });

  /** A Profile the cafe's tablet saves, by a barista, once the Library has it. */
  async function savedOnCafeTablet(title: string, pressure: number): Promise<string> {
    const record = await cafeTablet.addProfile({ ...derivedProfile(title, pressure), author: "Lab", notes: "First notes" });
    await expect.poll(async () => (await api.call("GET", path(String(record.id)))).status, { timeout: 15_000 }).toBe(200);
    return String(record.id);
  }
  const profileCount = async () => (await api.get<{ profiles: unknown[] }>("/profiles")).profiles.length;
  /** The tablet's record of the Profile's title, author and notes, if it holds one. */
  const textOn = (tablet: SimulatedTablet, id: string) => {
    const held = tablet.profiles().find((record) => record.id === id)?.profile as Fields | undefined;
    return held && { title: held.title, author: held.author, notes: held.notes };
  };

  it("publishes a new version that changes only the Profile's notes as an edit of that Profile, written to its tablets, changing nothing else (#667)", async () => {
    const id = await savedOnCafeTablet("Publish text", 9.05);
    const onIt = (await api.send<{ recipe: { id: string } }>("POST", "/recipes", { locationId: cafe.id, content: { name: "Publish Text Espresso", profileId: id } }, 201)).recipe.id;
    const before = { count: await profileCount(), shown: await shownAt(id), content: (await profile(id)).content };

    // Unchanged, it is the Profile itself, which leaves nothing to publish.
    const draft = await start({ profileId: id, as: "version" });
    expect(draft).toMatchObject({ profileId: id, editsText: [] });
    expect((await refusal(api, "POST", `/drafts/${draft.id}/publish`, { saves: draft.saves }, 409)).checks?.map((check) => check.code)).toEqual(["unchanged"]);

    // Its notes reworded: an edit of them, which its checks no longer stop, naming no Location or Recipe.
    const reworded = await save(draft, { ...draft.profile, notes: "Reworded notes" });
    expect(reworded).toMatchObject({ profileId: id, editsText: ["notes"], checks: { blocking: [] } });
    for (const where of [{ locations: [cafe.id] }, { recipes: [onIt] }])
      expect((await refusal(api, "POST", `/drafts/${reworded.id}/publish`, { saves: reworded.saves, ...where }, 400)).message).toMatch(/give no locations or recipes/);
    const published = await publish(reworded, {});
    expect(published).toEqual({ profile: { id, title: "Publish text" }, replaced: null, shownAt: [], hiddenAt: [], keptAt: [], moved: [], forked: [], edited: ["notes"] });

    // The Draft is gone, and the Profile, under its id, read through the other instance, has the notes and nothing else changed.
    expect((await api.call("GET", `/drafts/${reworded.id}`)).status).toBe(404);
    expect(await profileCount()).toBe(before.count);
    const after = (await profile(id, otherApi)).content;
    expect(after.profile).toEqual({ ...(before.content.profile as Fields), notes: "Reworded notes" });
    expect(after.parentId).toEqual(before.content.parentId);
    expect(await shownAt(id)).toEqual(before.shown);
    expect((await recipe(onIt)).content.profileId).toBe(id);
    const history = (await api.get<{ versions: { fields: Fields; source: { account: { id: string } | null; machine: unknown } }[] }>(path(id, "/history"))).versions;
    expect(history[0]).toMatchObject({ fields: { notes: "Reworded notes" }, source: { account: { id: adminId }, machine: null } });

    // The tablet that holds it gets the notes, still one record under its id.
    await expect.poll(() => textOn(cafeTablet, id), { timeout: 15_000 }).toEqual({ title: "Publish text", author: "Lab", notes: "Reworded notes" });
    expect(cafeTablet.profiles().filter((record) => (record.profile as Fields).title === "Publish text").map((record) => record.id)).toEqual([id]);
  });

  it("edits only what the Draft changed since it began: an edit of another field made since stays, and one of the same field is kept as a Lost Edit (#667)", async () => {
    const id = await savedOnCafeTablet("Publish meanwhile", 9.45);
    const draft = await start({ profileId: id, as: "version" });
    // Retitled and given notes on its page after the Draft began, which still holds the title and notes it began with.
    await api.send("PATCH", path(id), { content: { title: "Publish meanwhile (house)", notes: "Page notes" } }, 200);
    const reworded = await save(draft, { ...draft.profile, notes: "Draft notes" });
    expect(reworded).toMatchObject({
      editsText: ["notes"],
      versionOf: { id, text: { title: "Publish meanwhile", author: "Lab", notes: "First notes" } },
      checks: { blocking: [] },
    });
    expect(await publish(reworded, {})).toMatchObject({ profile: { id, title: "Publish meanwhile (house)" }, edited: ["notes"] });
    // The title stays the page's; the Draft's notes, the later edit, win over the page's, which are kept as a Lost Edit.
    expect((await profile(id)).content.profile).toMatchObject({ title: "Publish meanwhile (house)", author: "Lab", notes: "Draft notes" });
    const { lostEdits } = await api.get<{ lostEdits: { field: string; value: unknown }[] }>(path(id, "/history"));
    expect(lostEdits.map(({ field, value }) => ({ field, value }))).toEqual([{ field: "notes", value: "Page notes" }]);

    // A Draft that changes nothing since it began is refused as unchanged, though the Profile changed since.
    const later = await start({ profileId: id, as: "version" });
    await api.send("PATCH", path(id), { content: { author: "Roaster" } }, 200);
    expect((await api.get<{ draft: Draft }>(`/drafts/${later.id}`)).draft).toMatchObject({ editsText: [], checks: { blocking: [{ code: "unchanged" }] } });
  });

  it("refuses, as an edit of the Profile, a title another Profile has, Archived ones too; and as ever steps another Profile has, and a separate Profile with its source's (#667)", async () => {
    const id = await savedOnCafeTablet("Publish retitled", 9.15);
    const draft = await start({ profileId: id, as: "version" });

    // Another Profile's title, as Streamline compares titles: its checks say so, and publishing refuses it, leaving the Draft and the Profile.
    const taken = await save(draft, { ...draft.profile, title: "publish SOAK " });
    expect(taken.editsText).toEqual(["title"]);
    expect(taken.checks.blocking).toEqual([{ code: "titleInUse", step: null, path: "title", message: 'A Profile in the Library is titled "Publish soak" already.' }]);
    expect((await refusal(api, "POST", `/drafts/${taken.id}/publish`, { saves: taken.saves }, 409)).checks?.map((check) => check.code)).toEqual(["titleInUse"]);
    expect((await api.get<{ draft: Draft }>(`/drafts/${taken.id}`)).draft.saves).toBe(taken.saves);
    expect(((await profile(id)).content.profile as Fields).title).toBe("Publish retitled");

    // An Archived Profile's title too, as tablets keep their records hidden.
    const archived = await savedOnCafeTablet("Publish archived title", 9.35);
    await api.send("PUT", path(archived, "/archived"), { archived: true }, 200);
    const asArchived = await save(taken, { ...draft.profile, title: "Publish Archived Title" });
    expect((await refusal(api, "POST", `/drafts/${asArchived.id}/publish`, { saves: asArchived.saves }, 409)).checks?.map((check) => check.code)).toEqual(["titleInUse"]);

    // A title of its own is taken, with its author, as one edit.
    const retitled = await save(asArchived, { ...draft.profile, title: "Publish retitled v2", author: "Coffee lead" });
    expect((await publish(retitled, {})).edited).toEqual(["title", "author"]);
    expect(((await profile(id)).content.profile as Fields)).toMatchObject({ title: "Publish retitled v2", author: "Coffee lead", notes: "First notes" });

    // Steps another Profile has, which it would be, are still refused, naming it.
    const third = profileId(soak("Publish soak", 7));
    const other = await start({ profileId: id, as: "version" });
    const asThird = await save(other, { ...soak("Publish retitled v2", 7) });
    expect(asThird.editsText).toBeNull();
    expect(asThird.profileId).toBe(third);
    expect((await refusal(api, "POST", `/drafts/${asThird.id}/publish`, { saves: asThird.saves, locations: [cafe.id] }, 409)).checks?.map((check) => check.code)).toEqual(["sameSteps"]);

    // A separate Profile needs steps of its own: with its source's, it is refused as ever, a bundled one's too, which only Duplicate starts a Draft from.
    const copy = await start({ profileId: id, as: "separate" });
    expect(copy.editsText).toBeNull();
    expect((await refusal(api, "POST", `/drafts/${copy.id}/publish`, { saves: copy.saves, locations: [cafe.id] }, 409)).checks?.map((check) => check.code)).toEqual(["sameSteps"]);
    expect((await refusal(api, "POST", "/drafts", { profileId: CLASSIC, as: "version" }, 409)).message).toMatch(/bundled/);
    const classicCopy = await start({ profileId: CLASSIC, as: "separate" });
    const fromBundled = await refusal(api, "POST", `/drafts/${classicCopy.id}/publish`, { saves: classicCopy.saves, locations: [cafe.id] }, 409);
    expect(fromBundled.message).toMatch(/Its steps are those of "Classic Italian espresso"/);
    // Any other Draft still names a Location to show it at.
    expect((await refusal(api, "POST", `/drafts/${classicCopy.id}/publish`, { saves: classicCopy.saves }, 400)).message).toEqual([expect.stringMatching(/at least one/)]);
  });

  it("warns of a newer version the Library gained since the Draft began, and publishing then forks the chain", async () => {
    const fourth = profileId(soak("Publish soak", 6.8));
    const draft = await save(await start({ profileId: fourth, as: "version" }), soak("Publish soak", 6.6));
    // A barista saves a change to it on the cafe's tablet meanwhile.
    const saved = await cafeTablet.addProfile(derivedProfile("Publish soak", 9.2), { parentId: fourth });
    await expect.poll(async () => (await api.call("GET", path(String(saved.id)))).status, { timeout: 15_000 }).toBe(200);
    const read = (await api.get<{ draft: Draft }>(`/drafts/${draft.id}`)).draft;
    expect(read.newer).toEqual([{ id: saved.id, title: "Publish soak", savedAt: expect.any(String) }]);
    const published = await publish(read, { locations: [cafe.id] });
    expect(published.forked.map((version) => version.id)).toEqual([saved.id]);
    const versions = (await api.get<{ versions: { id: string; parentId: string | null }[] }>(path(fourth, "/versions"))).versions;
    expect(versions.filter((version) => version.parentId === fourth).map((version) => version.id).sort()).toEqual([String(saved.id), published.profile.id].sort());
  });

  it("publishes a new version whose source the Library deleted since as saved from none, replacing nothing", async () => {
    const gone = await cafeTablet.addProfile(derivedProfile("Publish gone", 9.6));
    await expect.poll(async () => (await api.call("GET", path(String(gone.id)))).status, { timeout: 15_000 }).toBe(200);
    const draft = await save(await start({ profileId: String(gone.id), as: "version" }), soak("Publish gone", 5.9));
    expect((await api.call("DELETE", path(String(gone.id)))).status).toBe(204);
    const published = await publish(draft, { locations: [roastery.id] });
    expect(published).toMatchObject({ replaced: null, hiddenAt: [], keptAt: [], moved: [], forked: [] });
    expect((await profile(published.profile.id)).content.parentId).toBeNull();
  });

  it("lets Staff publish to and return at their own Locations only, and a Viewer neither", async () => {
    const draft = await save(await start({ profileId: CLASSIC, as: "separate" }, staff), soak("Publish by Staff", 5.2), staff);
    expect((await refusal(staff, "POST", `/drafts/${draft.id}/publish`, { saves: draft.saves, locations: [cafe.id, roastery.id] }, 403)).message).toMatch(/only at the Locations they work at/);
    expect((await publish(draft, { locations: [roastery.id] }, staff)).shownAt).toEqual([{ id: roastery.id, name: "Publish roastery" }]);
    const third = profileId(soak("Publish soak", 7));
    expect((await refusal(staff, "POST", path(third, "/return"), { from: profileId(soak("Publish soak", 6.8)), locations: [cafe.id] }, 403)).message).toMatch(/only at the Locations/);

    const forViewer = await start({ profileId: CLASSIC, as: "separate" });
    expect((await refusal(viewer, "POST", `/drafts/${forViewer.id}/publish`, { saves: forViewer.saves, locations: [roastery.id] }, 403)).message).toBe("A Viewer can't change anything");
    expect((await refusal(viewer, "POST", path(third, "/return"), { from: profileId(soak("Publish soak", 6.8)), locations: [cafe.id] }, 403)).message).toBe("A Viewer can't change anything");
  });

  it("reports on the Profile's page a tablet answering under another id", async () => {
    roasteryTablet.hashesProfilesOtherwise = true;
    try {
      const draft = await save(await start({ profileId: CLASSIC, as: "separate" }), soak("Publish rehashed", 5.4));
      const published = await publish(draft, { locations: [roastery.id] });
      await expect
        .poll(async () => (await profile(published.profile.id)).refusedOn, { timeout: 15_000 })
        .toEqual([{ machine: { id: roasteryMachine.machine.id, name: "Publish roastery 1" }, error: expect.stringMatching(/under another id, profile:[0-9a-f]{20}: Decaid computes this Profile's id otherwise/), refusedAt: expect.any(String) }]);
      // The assistant reads it too.
      const { profile: read } = await assistant.call<{ profile: { refusedOn: unknown[] } }>("get_library_item", { kind: "profile", id: published.profile.id });
      expect(read.refusedOn).toHaveLength(1);
    } finally {
      roasteryTablet.hashesProfilesOtherwise = false;
    }
  });

  it("publishes a Draft and returns to a version through an assistant, within the account's Locations", async () => {
    const draft = await save(await start({ profileId: CLASSIC, as: "separate" }), soak("Publish by assistant", 5.6));
    const { published } = await assistant.call<{ published: Published }>("publish_draft", { id: draft.id, saves: draft.saves, locations: [roastery.id] });
    expect(published).toMatchObject({ profile: { id: profileId(soak("Publish by assistant", 5.6)) }, shownAt: [{ id: roastery.id }] });
    expect((await api.call("GET", `/drafts/${draft.id}`)).status).toBe(404);

    const fourth = profileId(soak("Publish soak", 6.8));
    const latest = profileId(soak("Publish soak", 6.6));
    const { published: returned } = await assistant.call<{ published: Published }>("return_to_profile_version", { profileId: fourth, from: latest, locations: [cafe.id] });
    expect(returned).toMatchObject({ profile: { id: fourth }, replaced: { id: latest }, hiddenAt: [{ id: cafe.id }] });

    const staffDraft = await start({ profileId: CLASSIC, as: "separate" });
    const result = await staffAssistant.client.callTool({ name: "publish_draft", arguments: { id: staffDraft.id, saves: staffDraft.saves, locations: [cafe.id] } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/only at the Locations they work at/);
    const staffReturn = await staffAssistant.client.callTool({ name: "return_to_profile_version", arguments: { profileId: latest, from: fourth, locations: [cafe.id] } });
    expect(staffReturn.isError).toBe(true);
    expect(JSON.stringify(staffReturn.content)).toMatch(/only at the Locations/);
  });

  it("publishes a Draft that changes only its Profile's text as an edit of it through an assistant, which get_draft tells apart (#667)", async () => {
    const id = await savedOnCafeTablet("Publish text by assistant", 9.25);
    const draft = await start({ profileId: id, as: "version" });
    const unchanged = await assistant.client.callTool({ name: "publish_draft", arguments: { id: draft.id, saves: draft.saves } });
    expect(unchanged.isError).toBe(true);
    expect(JSON.stringify(unchanged.content)).toMatch(/Nothing has changed/);

    const edited = await save(draft, { ...draft.profile, author: "Coffee lead" });
    expect((await assistant.call<{ draft: Draft }>("get_draft", { id: draft.id })).draft).toMatchObject({ profileId: id, editsText: ["author"], checks: { blocking: [] } });
    const { published } = await assistant.call<{ published: Published }>("publish_draft", { id: draft.id, saves: edited.saves });
    expect(published).toEqual({ profile: { id, title: "Publish text by assistant" }, replaced: null, shownAt: [], hiddenAt: [], keptAt: [], moved: [], forked: [], edited: ["author"] });
    expect((await api.call("GET", `/drafts/${draft.id}`)).status).toBe(404);
    await expect.poll(() => textOn(cafeTablet, id), { timeout: 15_000 }).toEqual({ title: "Publish text by assistant", author: "Coffee lead", notes: "First notes" });

    // A title another Profile has is refused here too; and an edit given a Location to show it at.
    const again = await start({ profileId: id, as: "version" });
    const taken = await save(again, { ...again.profile, title: "Publish soak" });
    const refused = await assistant.client.callTool({ name: "publish_draft", arguments: { id: again.id, saves: taken.saves } });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toMatch(/titled \\"Publish soak\\" already/);
    const notes = await save(taken, { ...again.profile, notes: "By assistant" });
    const placed = await assistant.client.callTool({ name: "publish_draft", arguments: { id: again.id, saves: notes.saves, locations: [cafe.id] } });
    expect(placed.isError).toBe(true);
    expect(JSON.stringify(placed.content)).toMatch(/give no locations or recipes/);
  });

  it("publishes to a Location whose tablet is off, which gets it on connecting", async () => {
    const annex = await api.createLocation("Publish annex", "America/Chicago");
    const annexMachine = await api.createMachine("Publish annex 1", annex.id);
    const draft = await save(await start({ profileId: CLASSIC, as: "separate" }), soak("Publish while off", 5.1));
    const published = await publish(draft, { locations: [annex.id] });
    expect(published.shownAt).toEqual([{ id: annex.id, name: "Publish annex" }]);
    const annexTablet = tablets.syncing(annexMachine, server, { api: emptyLibrary("58003") });
    await api.waitForOnline(annexMachine);
    await expect.poll(() => held(annexTablet, published.profile.id)?.visibility, { timeout: 15_000 }).toBe("visible");
  });
});
