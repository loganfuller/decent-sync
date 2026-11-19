import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type LocationView, acceptInvite, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, type TestApp, serveTestApp } from "./support/assistants.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import { type SimulatedTablet, derivedProfile } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 2 for #578: what a Profile's page reads beside the Profile, through
// the REST API and the MCP endpoint (get_profile_versions), with a real
// server and a simulated tablet saving Profiles as a barista does: its
// Profile Versions, the chain of Decaid's parentId links, forks and all,
// with who saved each and the Shots on each; the Recipes naming it, with the
// Machines that have each loaded; and the Machine model it is simulated as
// unless asked, from the Machines where it is shown. Serials are made up,
// from 57901.

type Fields = Record<string, unknown>;

interface Version {
  id: string;
  title: string | null;
  bundled: boolean;
  parentId: string | null;
  savedAt: string;
  savedBy: { machine: { id: string; name: string } | null; account: { id: string; name: string | null } | null } | null;
  shownAt: { location: { name: string } }[];
  shots: number;
}

interface OnProfile {
  recipe: { id: string; name: string | null; slot: number | null; location: { name: string } | null };
  loadedOn: { id: string; name: string }[];
}

const env = { ...ASSISTANT_ENV, SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** Waits, in a hook, where expect.poll can't, until the route answers 200: up to 30 s. */
async function answers(api: AdminApi, path: string): Promise<void> {
  for (let waited = 0; waited < 30_000; waited += 100) {
    if ((await api.call("GET", path)).status === 200) return;
    await delay(100);
  }
  throw new Error(`${path} never answered 200`);
}

describe("A Profile's versions, the Recipes on it and the model it is simulated as", () => {
  let server: TestServer;
  let api: AdminApi;
  let app: TestApp;
  let assistant: Assistant;
  let lab: LocationView;
  let tablet: SimulatedTablet;
  let machineId: string;
  /** The first saved, two saved from it (a fork), one saved from the second, and one whose parent the Library doesn't have. */
  const ids = { first: "", second: "", fork: "", third: "", orphan: "" };
  let recipeId: string;

  const path = (id: string, rest = "") => `/profiles/${encodeURIComponent(id)}${rest}`;
  const versions = async (id: string, as: AdminApi = api) => (await as.get<{ versions: Version[] }>(path(id, "/versions"))).versions;
  const recipes = async (id: string, as: AdminApi = api) => (await as.get<{ recipes: OnProfile[] }>(path(id, "/recipes"))).recipes;

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
    app = await serveTestApp();
    assistant = await Assistant.connect(server.url, app, await signIn(server.url, admin), { allowed: ["read"] });
    lab = await api.createLocation("Versions lab", "America/Chicago");
    const machine = await api.createMachine("Versions lab 1", lab.id);
    machineId = machine.machine.id;
    tablet = syncingTablet(machine, server, { api: emptyLibrary("57901") });
    await api.waitForOnline(machine);
    const save = async (key: keyof typeof ids, title: string, pressure: number, parentId?: string) => {
      const saved = await tablet.addProfile(derivedProfile(title, pressure), parentId === undefined ? {} : { parentId });
      ids[key] = String(saved.id);
      await answers(api, path(ids[key]));
      return saved;
    };
    await save("first", "Versions Bloom", 8);
    await save("second", "Versions Bloom", 8.5, ids.first);
    await save("fork", "Versions Bloom, held", 9, ids.first);
    const third = await save("third", "Versions Bloom", 9.5, ids.second);
    // The orphan's parent, then deleted from the Library by an Admin, as no Shot names it.
    const gone = await tablet.addProfile(derivedProfile("Versions Gone", 6.5));
    await answers(api, path(String(gone.id)));
    await save("orphan", "Versions Orphan", 7, String(gone.id));
    await api.send("DELETE", path(String(gone.id)), undefined, 204);
    // A Shot pulled on the third, as the tablet's Workflow held it.
    const recorded = JSON.parse(fs.readFileSync(new URL("./fixtures/decaid/simulated-shots-v0.9.2/classic-italian.json", import.meta.url), "utf8")) as Fields;
    const workflow = recorded.workflow as Fields;
    tablet.pullShot({ ...recorded, id: "versions-shot", workflow: { ...workflow, profile: third.profile, machine: { ...(workflow.machine as Fields), serialNumber: "57901" } } });
    await answers(api, "/shots/versions-shot");
    // Recipes naming the third: one loaded on the lab's Machine, and one Archived.
    recipeId = (await api.send<{ recipe: { id: string } }>("POST", "/recipes", { locationId: lab.id, slot: 4, content: { name: "Versions Espresso", profileId: ids.third } }, 201)).recipe.id;
    const archived = (await api.send<{ recipe: { id: string } }>("POST", "/recipes", { locationId: lab.id, slot: null, content: { name: "Versions Retired", profileId: ids.third } }, 201)).recipe.id;
    await api.send("PUT", `/recipes/${archived}/archived`, { archived: true });
    const database = await server.connectDatabase();
    try {
      await database.query("INSERT INTO loaded_recipes (machine_id, recipe_id, loaded_at) VALUES ($1, $2, now())", [machineId, recipeId]);
    } finally {
      await database.end();
    }
  });
  afterAll(async () => {
    await tablet?.unload();
    await assistant?.close();
    await app?.close();
    await server?.stop();
  });

  it("lists every Profile in the chain through it, forks and all, the latest saved first, each with who saved it and its Shots", async () => {
    const chain = await versions(ids.second);
    expect(chain.map((version) => version.id)).toEqual([ids.third, ids.fork, ids.second, ids.first]);
    expect(Object.fromEntries(chain.map((version) => [version.id, version.parentId]))).toEqual({ [ids.first]: null, [ids.second]: ids.first, [ids.fork]: ids.first, [ids.third]: ids.second });
    for (const version of chain) expect(version.savedBy?.machine?.name).toBe("Versions lab 1");
    expect(Object.fromEntries(chain.map((version) => [version.id, version.shots]))).toEqual({ [ids.first]: 0, [ids.second]: 0, [ids.fork]: 0, [ids.third]: 1 });
    // A tablet hides the Profile a new one was saved from, as Streamline does.
    expect(chain.find((version) => version.id === ids.first)!.shownAt).toEqual([]);
    expect(chain.find((version) => version.id === ids.third)!.shownAt.map((at) => at.location.name)).toEqual(["Versions lab"]);
    // Read through any of them, the chain is the same.
    expect((await versions(ids.fork)).map((version) => version.id)).toEqual(chain.map((version) => version.id));
    // One saved from a Profile the Library doesn't have starts a chain of its own.
    expect(await versions(ids.orphan)).toMatchObject([{ id: ids.orphan, parentId: null }]);
    expect((await api.call("GET", path("profile:00000000000000000000", "/versions"))).status).toBe(404);
  });

  it("lists the Recipes naming a Profile, not Archived, with the Machines that have each loaded", async () => {
    expect(await recipes(ids.third)).toEqual([
      { recipe: expect.objectContaining({ id: recipeId, name: "Versions Espresso", slot: 4, location: expect.objectContaining({ name: "Versions lab" }) }), loadedOn: [{ id: machineId, name: "Versions lab 1" }] },
    ]);
    expect(await recipes(ids.second)).toEqual([]);
    expect((await api.call("GET", path("profile:00000000000000000000", "/recipes"))).status).toBe(404);
  });

  it("is read by Staff away from its Locations and by a Viewer", async () => {
    const away = await api.createLocation("Versions cafe", "America/Chicago");
    const staff = await api.staffAt("versions-staff@example.com", away);
    const { link } = await api.invite("versions-viewer@example.com", "viewer");
    const viewer = AdminApi.signedInAs(server.url, await acceptInvite(server.url, link, { name: "Versions Viewer", password: "versions viewer password" }));
    const expected = await versions(ids.third);
    expect(await versions(ids.third, staff)).toEqual(expected);
    expect(await versions(ids.third, viewer)).toEqual(expected);
    expect(await recipes(ids.third, viewer)).toEqual(await recipes(ids.third));
  });

  it("is simulated as a Bengle only where every Machine at the Locations showing it is one", async () => {
    const modelOf = async (id: string) => (await api.get<{ profile: { machineModel: string } }>(path(id))).profile.machineModel;
    const simulatedAs = async (id: string, query = "") => (await api.get<{ simulation: { model: string } }>(path(id, `/simulation${query}`))).simulation.model;
    expect(await modelOf(ids.third)).toBe("DE1");
    // Shown nowhere, a DE1.
    expect(await modelOf(ids.first)).toBe("DE1");
    const bar = await api.createLocation("Versions Bengle bar", "America/Chicago");
    const bengle = await api.createMachine("Versions Bengle 1", bar.id);
    const database = await server.connectDatabase();
    try {
      await database.query("UPDATE machines SET model = 'Bengle' WHERE id = $1", [bengle.machine.id]);
    } finally {
      await database.end();
    }
    await api.send("PUT", path(ids.fork, `/locations/${bar.id}`), { shown: true });
    // Shown at the lab's DE1 and the bar's Bengle, a DE1; at the bar alone, a Bengle.
    expect(await modelOf(ids.fork)).toBe("DE1");
    await api.send("PUT", path(ids.fork, `/locations/${lab.id}`), { shown: false });
    expect(await modelOf(ids.fork)).toBe("Bengle");
    expect(await simulatedAs(ids.fork)).toBe("Bengle");
    expect(await simulatedAs(ids.fork, "?model=DE1")).toBe("DE1");
    const { result } = await assistant.callWithinBudget<{ model: string }>("simulate_profile", { profileId: ids.fork, curves: false });
    expect(result.model).toBe("Bengle");
  });

  it("is read through an assistant as the REST API reads it (get_profile_versions)", async () => {
    const { result } = await assistant.callWithinBudget<{ versions: Fields[]; recipes: Fields[] }>("get_profile_versions", { profileId: ids.third });
    const rest = await versions(ids.third);
    expect(result.versions.map((version) => version.id)).toEqual(rest.map((version) => version.id));
    expect(result.versions[0]).toMatchObject({ id: ids.third, parentId: ids.second, shots: 1, savedBy: { machine: { name: "Versions lab 1" } } });
    expect(result.recipes).toEqual([{ recipe: expect.objectContaining({ id: recipeId, name: "Versions Espresso", slot: 4 }), loadedOn: [{ id: machineId, name: "Versions lab 1" }] }]);
  });
});
