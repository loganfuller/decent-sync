import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, type TestApp, serveTestApp } from "./support/assistants.js";
import { LoadedTablets, emptyLibrary } from "./support/loaded-tablets.js";
import { quiesced } from "./support/quiet.js";
import { shotFixture } from "./support/shot-fixtures.js";
import { SimulatedDye2, dye2List, dye2Migrated } from "./support/simulated-dye2.js";
import { type SimulatedTablet, derivedProfile } from "./support/simulated-tablet.js";
import { runAsSteps } from "./support/steps.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for #472 (ADR-0029): a Recipe's Reference Shot, chosen, replaced
// and cleared through the REST API and through an assistant, by a test app
// on the MCP SDK's client connected as a Connected App, against the built
// server. Shots are stored through simulated tablets running the built
// plugin, each derived from a Shot Decaid recorded, changing only its id,
// time, recorded hardware and the profile its Workflow holds. Belmont's
// tablet runs DYE2, so it holds Belmont's Recipes, and is written nothing
// when a Reference Shot changes. Serials are made up, from 47201.

type Record_ = Record<string, unknown>;

const env = { ...ASSISTANT_ENV, SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

const LAB_SERIAL = "47201";
const BELMONT_SERIAL = "47202";
/** Hardware no Machine has, whose Shots a Pending Machine holds. */
const UNKNOWN_SERIAL = "47209";

/** An ISO 8601 time with its offset. */
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;

/**
 * A result, a tool's or the REST API's, as the two are compared: each time as its instant, as the tools give them with a
 * Location's offset, and each number to two decimal places, as the tools give them.
 */
function comparable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (_, field: unknown) => {
    if (typeof field === "string" && ISO_TIME.test(field)) return Date.parse(field);
    return typeof field === "number" ? Math.round(field * 100) / 100 : field;
  });
}

interface ReferenceShot {
  id: string;
  pulledAt: string | null;
  machine: { id: string; name: string } | null;
  location: LocationView | null;
  profileTitle: string | null;
  profile: { id: string; title: string | null } | null;
  targetDose: number | null;
  actualDose: number | null;
  targetYield: number | null;
  actualYield: number | null;
  duration: number | null;
  profileDiffers: boolean;
}

interface RecipeView {
  id: string;
  name: string | null;
  location: LocationView | null;
  slot: number | null;
  archived: boolean;
  content: Record_;
  referenceShot?: ReferenceShot | null;
}

interface Version {
  fields: Record_;
  location: LocationView | null;
  source: { account: { id: string } | null; connectedApp: { id: string; name: string } | null };
}

interface ShotView {
  id: string;
  duration: number | null;
  referenceOf?: { id: string; name: string | null; location: { id: string; name: string } | null }[];
}

/** Resolves once `holds` does, as expect.poll, which a hook can't call, waits. */
async function until(holds: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await holds())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("Choosing a Recipe's Reference Shot", { timeout: 120_000 }, () => {
  let server: TestServer;
  let api: AdminApi;
  let app: TestApp;
  let adminId: string;
  let lab: LocationView;
  let belmont: LocationView;
  let labMachine: CreatedMachine;
  let belmontMachine: CreatedMachine;
  let labTablet: SimulatedTablet;
  let belmontTablet: SimulatedTablet;
  /** The Library's ids of the two Profiles Lab's tablet saved. */
  let bloom: string;
  let other: string;
  /** Made through the REST API: Belmont's espresso on the bloom Profile, its decaf naming none, and Lab's own. */
  let espresso: RecipeView;
  let decaf: RecipeView;
  let labRecipe: RecipeView;
  const tablets = new LoadedTablets();
  const opened: Assistant[] = [];

  runAsSteps();

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
    app = await serveTestApp();
    adminId = (await api.get<{ account: { id: string } }>("/session")).account.id;
    lab = await api.createLocation("Lab", "America/Denver");
    belmont = await api.createLocation("Belmont", "America/Chicago");
    labMachine = await api.createMachine("Lab 1");
    belmontMachine = await api.createMachine("Belmont 1");
    // Each was at its Location long before its Shots were pulled.
    for (const [machine, location] of [[labMachine, lab], [belmontMachine, belmont]] as const) {
      await api.send("POST", `/machines/${machine.machine.id}/location-history`, { locationId: location.id, effectiveFrom: "2025-01-01T00:00:00Z" }, 201);
    }
    labTablet = tablets.syncing(labMachine, server, { api: emptyLibrary(LAB_SERIAL) });
    belmontTablet = tablets.syncing(belmontMachine, server, { api: { ...emptyLibrary(BELMONT_SERIAL), ...dye2Migrated() }, dye2: new SimulatedDye2() });
    await api.waitForOnline(labMachine, belmontMachine);

    // Two Profiles a Lab barista saved join the Library; a Shot's Workflow holds one as Decaid holds it.
    const bloomProfile = (await labTablet.addProfile(derivedProfile("Reference bloom", 7.5))).profile as Record_;
    await labTablet.addProfile(derivedProfile("Other bloom", 8.5));
    const profileId = async (title: string) => (await api.get<{ profiles: { id: string; title: string }[] }>("/profiles")).profiles.find((p) => p.title === title)?.id;
    await until(async () => (await profileId("Reference bloom")) !== undefined && (await profileId("Other bloom")) !== undefined);
    bloom = (await profileId("Reference bloom"))!;
    other = (await profileId("Other bloom"))!;

    labTablet.pullShot(shotOf("lab-bloom", "2026-02-10T15:00:00Z", LAB_SERIAL, bloomProfile));
    // The fixture's own profile, which no tablet saved: it matches none in the Library.
    labTablet.pullShot(shotOf("lab-unsaved", "2026-02-10T16:00:00Z", LAB_SERIAL));
    belmontTablet.pullShot(shotOf("belmont-bloom", "2026-02-10T17:00:00Z", BELMONT_SERIAL, bloomProfile));
    labTablet.pullShot(shotOf("pending-shot", "2026-02-10T18:00:00Z", UNKNOWN_SERIAL));
    await until(async () => (await api.get<{ total: number }>("/shots?limit=1")).total === 4);

    const create = async (location: LocationView, content: Record_) =>
      (await api.send<{ recipe: RecipeView }>("POST", "/recipes", { locationId: location.id, slot: "next", content }, 201)).recipe;
    espresso = await create(belmont, { name: "Belmont espresso", profileId: bloom, dose: 18, yield: 36 });
    decaf = await create(belmont, { name: "Belmont decaf", dose: 18, yield: 40 });
    labRecipe = await create(lab, { name: "Lab espresso", profileId: bloom, dose: 18, yield: 36 });
    // Belmont's tablet holds its Recipes in DYE2's list.
    await until(async () => recordsOn(belmontTablet).length === 2);
  });
  afterAll(async () => {
    for (const each of opened) await each.close();
    await tablets.unloadAll();
    await app?.close();
    await server?.stop();
  });

  /** A Shot pulled at a UTC time on the hardware given, derived from the fixture, its Workflow holding the profile given, if any. */
  function shotOf(id: string, pulledAt: string, serial: string, profile?: Record_): Record_ {
    const fixture = shotFixture();
    const workflow = fixture.workflow as Record_;
    return {
      ...fixture,
      id,
      timestamp: pulledAt,
      workflow: { ...workflow, ...(profile && { profile }), machine: { ...(workflow.machine as Record_), model: "DE1Pro", serialNumber: serial } },
    };
  }

  const recordsOn = (tablet: SimulatedTablet): Record_[] => {
    const list = dye2List(tablet, "recipes");
    return Array.isArray(list) ? (list as Record_[]) : [];
  };
  const recipe = async (id: string, as = api) => (await as.get<{ recipe: RecipeView }>(`/recipes/${id}`)).recipe;
  const choose = (id: string, shotId: string | null, as = api, status = 200) => as.send<{ recipe: RecipeView }>("PUT", `/recipes/${id}/reference-shot`, { shotId }, status);
  const versions = async (id: string) => (await api.get<{ versions: Version[] }>(`/recipes/${id}/history`)).versions;
  const referenceVersions = async (id: string) => (await versions(id)).filter((version) => Object.hasOwn(version.fields, "referenceShotId"));
  const shot = async (id: string, as = api) => (await as.get<{ shot: ShotView }>(`/shots/${encodeURIComponent(id)}`)).shot;
  /** A person invited with the role given, at the Locations given, signed in. */
  async function person(email: string, role: "staff" | "viewer", locations: LocationView[]): Promise<{ api: AdminApi; cookie: string }> {
    const { link } = await api.invite(email, role, locations.map((location) => location.id));
    const cookie = await acceptInvite(server.url, link, { name: email, password: "a password for references" });
    return { api: AdminApi.signedInAs(server.url, cookie), cookie };
  }

  it("makes a Shot from another Location the Recipe's Reference Shot, replaces it and clears it, each a version naming the account, and writes nothing to the tablets", async () => {
    const before = { writes: belmontTablet.storeWrites.length, records: recordsOn(belmontTablet), workflow: belmontTablet.workflow() };
    expect((await recipe(espresso.id)).referenceShot).toBeNull();

    // A Lab Shot on the Recipe's Profile, pulled with no Recipe.
    const lab1 = (await choose(espresso.id, "lab-bloom")).recipe.referenceShot;
    const fixtureShot = await shot("lab-bloom");
    expect(lab1).toEqual({
      id: "lab-bloom",
      pulledAt: "2026-02-10T15:00:00.000Z",
      machine: { id: labMachine.machine.id, name: "Lab 1" },
      location: lab,
      profileTitle: "Reference bloom",
      profile: { id: bloom, title: "Reference bloom" },
      targetDose: 18,
      actualDose: 18,
      targetYield: 36,
      actualYield: 35.9,
      duration: fixtureShot.duration,
      profileDiffers: false,
    });
    expect(lab1!.duration).toBeGreaterThan(0);
    expect((await recipe(espresso.id)).referenceShot).toEqual(lab1);

    // Replaced by a Shot whose profile matches none in the Library: another than the Recipe's.
    expect((await choose(espresso.id, "lab-unsaved")).recipe.referenceShot).toMatchObject({ id: "lab-unsaved", profile: null, profileDiffers: true });
    // Chosen again, it changes nothing and adds no version.
    await choose(espresso.id, "lab-unsaved");
    // Cleared, it has none.
    expect((await choose(espresso.id, null)).recipe.referenceShot).toBeNull();
    await choose(espresso.id, null);

    const kept = await referenceVersions(espresso.id);
    expect(kept.map((version) => version.fields)).toEqual([{ referenceShotId: null }, { referenceShotId: "lab-unsaved" }, { referenceShotId: "lab-bloom" }]);
    for (const version of kept) expect(version).toMatchObject({ location: null, source: { account: { id: adminId }, connectedApp: null } });

    // Nothing reached Belmont's tablet: not its Recipes, not its Workflow.
    await quiesced(api, { tablets: { belmontTablet } });
    expect(belmontTablet.storeWrites.length).toBe(before.writes);
    expect(recordsOn(belmontTablet)).toEqual(before.records);
    expect(belmontTablet.workflow()).toEqual(before.workflow);
  });

  it("says whether the Reference Shot's Profile is the Recipe's: the same, another, one the Library doesn't have, or none for a Recipe naming none", async () => {
    // A Belmont Shot on the Recipe's Profile.
    expect((await choose(espresso.id, "belmont-bloom")).recipe.referenceShot).toMatchObject({ id: "belmont-bloom", location: belmont, profileDiffers: false });
    // The Recipe changes its Profile: the Reference Shot stays, now on another.
    await api.send("PATCH", `/recipes/${espresso.id}`, { content: { profileId: other } });
    expect((await recipe(espresso.id)).referenceShot).toMatchObject({ id: "belmont-bloom", profileDiffers: true });
    await api.send("PATCH", `/recipes/${espresso.id}`, { content: { profileId: bloom } });
    // A Recipe naming no Profile has none to differ from.
    expect((await choose(decaf.id, "lab-unsaved")).recipe.referenceShot).toMatchObject({ id: "lab-unsaved", profile: null, profileDiffers: false });
  });

  it("keeps it through edits to the Recipe's content and its Recipe Slot", async () => {
    await api.send("PATCH", `/recipes/${espresso.id}`, { content: { yield: 38, grindSetting: 8.4 } });
    await api.send("PUT", `/recipes/${espresso.id}/slot`, { slot: 5 });
    await api.send("PUT", `/recipes/${espresso.id}/slot`, { slot: null });
    const read = await recipe(espresso.id);
    expect(read).toMatchObject({ slot: null, content: { yield: 38, grindSetting: 8.4 } });
    expect(read.referenceShot?.id).toBe("belmont-bloom");
    // The Recipe's Location's list doesn't give it; its own read does.
    const listed = (await api.get<{ recipes: RecipeView[] }>(`/locations/${belmont.id}/recipes`)).recipes.find((each) => each.id === espresso.id)!;
    expect(listed).not.toHaveProperty("referenceShot");
  });

  it("names the Recipes a Shot is the Reference Shot of in its read and its row, only where there are any", async () => {
    await choose(labRecipe.id, "belmont-bloom");
    const expected = [
      { id: espresso.id, name: "Belmont espresso", location: belmont },
      { id: labRecipe.id, name: "Lab espresso", location: lab },
    ];
    expect((await shot("belmont-bloom")).referenceOf).toEqual(expected);
    expect((await shot("lab-unsaved")).referenceOf).toEqual([{ id: decaf.id, name: "Belmont decaf", location: belmont }]);
    expect(await shot("lab-bloom")).not.toHaveProperty("referenceOf");
    const { shots } = await api.get<{ shots: ShotView[] }>("/shots");
    expect(Object.fromEntries(shots.map((row) => [row.id, row.referenceOf ?? null]))).toEqual({
      "pending-shot": null,
      "belmont-bloom": expected,
      "lab-unsaved": [{ id: decaf.id, name: "Belmont decaf", location: belmont }],
      "lab-bloom": null,
    });
  });

  it("takes a Shot a Pending Machine holds, reads as none once it is dismissed, refuses it and Shots no list lists, and reads it again once its hardware is adopted", async () => {
    expect((await choose(labRecipe.id, "pending-shot")).recipe.referenceShot).toMatchObject({ id: "pending-shot", machine: null, location: null });
    const pending = (await api.pendingMachines()).find((machine) => machine.serial === UNKNOWN_SERIAL)!;
    await api.send("POST", `/pending-machines/${pending.id}/dismiss`);
    expect((await recipe(labRecipe.id)).referenceShot).toBeNull();

    // Neither a hidden Shot nor one never stored is offered: the list lists neither.
    for (const shotId of ["pending-shot", "no-such-shot"]) {
      const refused = await api.call("PUT", `/recipes/${decaf.id}/reference-shot`, { shotId });
      expect(refused.status, shotId).toBe(400);
      expect(((await refused.json()) as { message: unknown }).message).toBe("No such Shot");
    }
    for (const body of [{}, { shotId: 7 }, { shotId: "" }]) expect((await api.call("PUT", `/recipes/${decaf.id}/reference-shot`, body)).status, JSON.stringify(body)).toBe(400);
    expect((await recipe(decaf.id)).referenceShot?.id).toBe("lab-unsaved");

    // Named as a Machine, its hardware's Shots are listed again, and the Recipe reads its Reference Shot again.
    const adopted = await api.issued(await api.call("POST", `/pending-machines/${pending.id}/machine`, { name: "Adopted 47209" }));
    expect((await recipe(labRecipe.id)).referenceShot).toMatchObject({ id: "pending-shot", machine: { id: adopted.machine.id, name: "Adopted 47209" } });
  });

  it("keeps an Archived Recipe's Reference Shot, which may be cleared but not chosen until the Recipe is restored", async () => {
    await choose(decaf.id, "lab-bloom");
    await api.send("PUT", `/recipes/${decaf.id}/archived`, { archived: true });
    expect((await recipe(decaf.id)).referenceShot?.id).toBe("lab-bloom");
    const refused = await api.call("PUT", `/recipes/${decaf.id}/reference-shot`, { shotId: "belmont-bloom" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { message: unknown }).message).toBe("This Recipe is Archived: restore it before choosing its Reference Shot");
    expect((await choose(decaf.id, null)).recipe.referenceShot).toBeNull();
    await api.send("PUT", `/recipes/${decaf.id}/archived`, { archived: false });
    expect((await choose(decaf.id, "belmont-bloom")).recipe.referenceShot?.id).toBe("belmont-bloom");
  });

  it("starts a copy with the Recipe's Reference Shot, a version of the copy's own, and chooses its own from then on", async () => {
    const { recipe: copy } = await api.send<{ recipe: RecipeView }>("POST", `/recipes/${espresso.id}/copies`, { locationId: lab.id, slot: null, grinderId: null }, 201);
    expect(copy.referenceShot?.id).toBe("belmont-bloom");
    expect((await referenceVersions(copy.id)).map((version) => version.fields)).toEqual([{ referenceShotId: "belmont-bloom" }]);
    await choose(copy.id, "lab-bloom");
    expect((await recipe(espresso.id)).referenceShot?.id).toBe("belmont-bloom");
    await api.send("DELETE", `/recipes/${copy.id}`, undefined, 204);
  });

  it("lets Staff choose and clear one only for their Locations' Recipes, from a Shot anywhere, and Viewers read it and change nothing", async () => {
    const staff = await person("belmont-staff@example.com", "staff", [belmont]);
    expect((await choose(espresso.id, "lab-unsaved", staff.api)).recipe.referenceShot?.id).toBe("lab-unsaved");
    const elsewhere = await staff.api.call("PUT", `/recipes/${labRecipe.id}/reference-shot`, { shotId: "lab-bloom" });
    expect(elsewhere.status).toBe(403);
    expect(((await elsewhere.json()) as { message: unknown }).message).toBe("Staff choose or clear a Recipe's Reference Shot only at the Locations they work at");
    const staffId = (await staff.api.get<{ account: { id: string } }>("/session")).account.id;
    expect((await referenceVersions(espresso.id))[0]).toMatchObject({ fields: { referenceShotId: "lab-unsaved" }, source: { account: { id: staffId } } });

    const viewer = await person("viewer@example.com", "viewer", []);
    expect((await recipe(espresso.id, viewer.api)).referenceShot?.id).toBe("lab-unsaved");
    expect((await shot("lab-unsaved", viewer.api)).referenceOf?.map((each) => each.id)).toEqual([espresso.id]);
    expect((await viewer.api.call("PUT", `/recipes/${espresso.id}/reference-shot`, { shotId: null })).status).toBe(403);
    expect((await recipe(espresso.id)).referenceShot?.id).toBe("lab-unsaved");
  });

  describe("through an assistant", () => {
    let assistant: Assistant;

    beforeAll(async () => {
      assistant = await Assistant.connect(server.url, app, await signIn(server.url, admin));
      opened.push(assistant);
    });

    it("chooses and clears a Recipe's Reference Shot as the REST API does, each change through the Connected App", async () => {
      const chosen = await assistant.call<{ recipe: Record_ }>("set_reference_shot", { id: espresso.id, shotId: "lab-bloom" });
      expect(comparable(chosen.recipe.referenceShot)).toEqual(comparable((await recipe(espresso.id)).referenceShot));
      // Its time is given with the offset of the Location it was pulled at: 08:00 at the Lab.
      expect((chosen.recipe.referenceShot as Record_).pulledAt).toBe("2026-02-10T08:00:00.000-07:00");
      const [latest] = await referenceVersions(espresso.id);
      expect(latest).toMatchObject({ fields: { referenceShotId: "lab-bloom" }, source: { account: { id: adminId }, connectedApp: { name: expect.any(String) } } });

      const read = await assistant.call<{ recipe: Record_ & { referenceShot: unknown } }>("get_library_item", { kind: "recipe", id: espresso.id });
      expect(comparable(read.recipe.referenceShot)).toEqual(comparable((await recipe(espresso.id)).referenceShot));
      // find_library_items lists Recipes as the Location's list does, without it.
      const found = await assistant.call<{ recipes: Record_[] }>("find_library_items", { kind: "recipe", locationId: belmont.id });
      expect(found.recipes.find((each) => each.id === espresso.id)).not.toHaveProperty("referenceShot");

      const cleared = await assistant.call<{ recipe: Record_ }>("set_reference_shot", { id: espresso.id, shotId: null });
      expect(cleared.recipe.referenceShot).toBeNull();
      await assistant.call("set_reference_shot", { id: espresso.id, shotId: "belmont-bloom" });
    });

    it("gives the Recipes a Shot is the Reference Shot of in get_shot and find_shots, only where there are any", async () => {
      // Belmont's two Recipes have the Belmont Shot, by name; the Lab's has the Shot its adopted hardware pulled.
      const read = await assistant.call<Record_>("get_shot", { id: "belmont-bloom" });
      expect(read.referenceOf).toEqual([
        { id: decaf.id, name: "Belmont decaf", location: { id: belmont.id, name: "Belmont" } },
        { id: espresso.id, name: "Belmont espresso", location: { id: belmont.id, name: "Belmont" } },
      ]);
      expect(read.referenceOf).toEqual((await shot("belmont-bloom")).referenceOf!.map(({ id, name, location }) => ({ id, name, location: location && { id: location.id, name: location.name } })));
      expect(await assistant.call<Record_>("get_shot", { id: "lab-bloom" })).not.toHaveProperty("referenceOf");
      const { shots } = await assistant.call<{ shots: Record_[] }>("find_shots", {});
      expect(Object.fromEntries(shots.map((row) => [row.id, row.referenceOf ?? null]))).toEqual({
        "pending-shot": [{ id: labRecipe.id, name: "Lab espresso" }],
        "belmont-bloom": [
          { id: decaf.id, name: "Belmont decaf" },
          { id: espresso.id, name: "Belmont espresso" },
        ],
        "lab-unsaved": null,
        "lab-bloom": null,
      });
    });

    it("refuses what the REST API refuses, with its message, and refuses a Connected App granted only read", async () => {
      const toolError = async (by: Assistant, args: Record_) => {
        const result = await by.client.callTool({ name: "set_reference_shot", arguments: args });
        expect(result.isError, JSON.stringify(result)).toBe(true);
        return (result.content as { text: string }[])[0]!.text;
      };
      const restMessage = async (as: AdminApi, id: string, body: unknown, status: number) => {
        const response = await as.call("PUT", `/recipes/${id}/reference-shot`, body);
        expect(response.status).toBe(status);
        const { message } = (await response.json()) as { message: string | string[] };
        return Array.isArray(message) ? message.join("; ") : message;
      };
      expect(await toolError(assistant, { id: espresso.id, shotId: "no-such-shot" })).toBe(await restMessage(api, espresso.id, { shotId: "no-such-shot" }, 400));

      const staff = await person("lab-staff@example.com", "staff", [lab]);
      const staffAssistant = await Assistant.connect(server.url, app, staff.cookie);
      opened.push(staffAssistant);
      expect(await toolError(staffAssistant, { id: espresso.id, shotId: "lab-bloom" })).toBe(await restMessage(staff.api, espresso.id, { shotId: "lab-bloom" }, 403));
      await staffAssistant.call("set_reference_shot", { id: labRecipe.id, shotId: "lab-bloom" });

      const reader = await Assistant.connect(server.url, app, await signIn(server.url, admin), { allowed: ["read"] });
      opened.push(reader);
      const refused = await Assistant.rawCall(server.url, reader.tokens.access_token, "tools/call", { name: "set_reference_shot", arguments: { id: espresso.id, shotId: null } });
      expect(refused.status).toBe(403);
      expect(refused.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
      expect((await recipe(espresso.id)).referenceShot?.id).toBe("belmont-bloom");
    });
  });
});
