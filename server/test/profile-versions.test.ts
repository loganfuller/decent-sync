import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type LocationView, acceptInvite, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, type TestApp, serveTestApp } from "./support/assistants.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import { type SimulatedTablet, derivedProfile } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 2 for #578 and #735: what a Profile's page reads beside the Profile,
// through the REST API and the MCP endpoint (get_profile_versions,
// get_library_item, find_library_items), with a real server and a simulated
// tablet saving Profiles as a barista does. A Profile is the lasting thing
// (ADR-0038): one row in the list and one address for each, under an id of
// the server's own, with its Profile Versions under it, numbered in the
// order they joined; a Duplicate a Profile of its own; the Shots of all its
// versions gathered; the Machines still on an earlier version named; and a
// Recipe given any of its ids stored on its current version. Also the
// Recipes naming it, with the Machines that have each loaded, and the
// Machine model it is simulated as unless asked. Serials are made up, from
// 57901.

type Fields = Record<string, unknown>;

interface Version {
  id: string;
  number: number | null;
  current: boolean;
  title: string | null;
  bundled: boolean;
  parentId: string | null;
  savedAt: string;
  savedBy: { machine: { id: string; name: string } | null; account: { id: string; name: string | null } | null } | null;
  shownAt: { location: { name: string } }[];
  shots: number;
}

interface Versions {
  profile: { profileId: string | null; currentVersionId: string };
  versions: Version[];
  earlierOn: { machine: { id: string; name: string }; version: { id: string; number: number | null } }[];
}

interface Listed {
  id: string;
  profileId: string | null;
  versions: number;
  title: string | null;
  startedFrom: { profileId: string; id: string; title: string | null } | null;
}

interface Read extends Listed {
  version: number | null;
  current: { id: string; version: number | null };
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

describe("A Profile, its versions, the Recipes on it and the model it is simulated as", () => {
  let server: TestServer;
  let api: AdminApi;
  let app: TestApp;
  let assistant: Assistant;
  let lab: LocationView;
  let tablet: SimulatedTablet;
  let machineId: string;
  /** Three versions of one Profile, each saved over the one before; a Duplicate of the third; and one whose parent the Library doesn't have. */
  const ids = { first: "", second: "", third: "", copy: "", orphan: "" };
  /** The Profile's own id. */
  let profileId: string;
  let recipeId: string;
  let firstProfile: unknown;
  let workflow: Fields;

  const path = (id: string, rest = "") => `/profiles/${encodeURIComponent(id)}${rest}`;
  const read = async (id: string, as: AdminApi = api) => (await as.get<{ profile: Read }>(path(id))).profile;
  const versions = async (id: string, as: AdminApi = api) => as.get<Versions>(path(id, "/versions"));
  const recipes = async (id: string, as: AdminApi = api) => (await as.get<{ recipes: OnProfile[] }>(path(id, "/recipes"))).recipes;
  const shownAt = async (id: string) => (await api.get<{ profile: { shownAt: unknown[] } }>(path(id))).profile.shownAt;

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
    app = await serveTestApp();
    assistant = await Assistant.connect(server.url, app, await signIn(server.url, admin), { allowed: ["read", "change"] });
    lab = await api.createLocation("Versions lab", "America/Chicago");
    const machine = await api.createMachine("Versions lab 1", lab.id);
    machineId = machine.machine.id;
    tablet = syncingTablet(machine, server, { api: emptyLibrary("57901") });
    await api.waitForOnline(machine);
    const save = async (key: keyof typeof ids, title: string, pressure: number, over?: string) => {
      // Saved over another, as Streamline's Save: the old one is hidden. Hidden first here, and seen hidden by the server, so
      // the new one is placed as its Profile's next version whichever of the plugin's reports carries it.
      if (over !== undefined) {
        await tablet.setProfileVisibility(over, "hidden");
        for (let waited = 0; (await shownAt(over)).length > 0; waited += 100) {
          if (waited > 30_000) throw new Error(`${over} was never hidden`);
          await delay(100);
        }
      }
      const saved = await tablet.addProfile(derivedProfile(title, pressure), over === undefined ? {} : { parentId: over });
      ids[key] = String(saved.id);
      await answers(api, path(ids[key]));
      return saved;
    };
    firstProfile = (await save("first", "Versions Bloom", 8)).profile;
    await save("second", "Versions Bloom", 8.5, ids.first);
    const third = await save("third", "Versions Bloom", 9.5, ids.second);
    // Streamline's Save As New: saved from the third, which stays visible.
    const { body: copy } = await tablet.callApi("POST", "/profiles", { profile: derivedProfile("Versions Bloom, held", 9), parentId: ids.third });
    ids.copy = String((copy as Fields).id);
    await answers(api, path(ids.copy));
    // The orphan's parent, then deleted from the Library by an Admin, as no Shot names it.
    const gone = await tablet.addProfile(derivedProfile("Versions Gone", 6.5));
    await answers(api, path(String(gone.id)));
    await save("orphan", "Versions Orphan", 7, String(gone.id));
    await api.send("DELETE", path(String(gone.id)), undefined, 204);
    // A Shot pulled on the third and one on the first, each as the tablet's Workflow held that version.
    const recorded = JSON.parse(fs.readFileSync(new URL("./fixtures/decaid/simulated-shots-v0.9.2/classic-italian.json", import.meta.url), "utf8")) as Fields;
    workflow = { ...(recorded.workflow as Fields), machine: { ...((recorded.workflow as Fields).machine as Fields), serialNumber: "57901" } };
    tablet.pullShot({ ...recorded, id: "versions-shot", workflow: { ...workflow, profile: third.profile } });
    tablet.pullShot({ ...recorded, id: "versions-first-shot", workflow: { ...workflow, profile: firstProfile } });
    await answers(api, "/shots/versions-shot");
    await answers(api, "/shots/versions-first-shot");
    profileId = (await read(ids.third)).profileId!;
    // Recipes naming the third: one for the lab's Machine to load, and one Archived.
    recipeId = (await api.send<{ recipe: { id: string } }>("POST", "/recipes", { locationId: lab.id, slot: 4, content: { name: "Versions Espresso", profileId: ids.third } }, 201)).recipe.id;
    const archived = (await api.send<{ recipe: { id: string } }>("POST", "/recipes", { locationId: lab.id, slot: null, content: { name: "Versions Retired", profileId: ids.third } }, 201)).recipe.id;
    await api.send("PUT", `/recipes/${archived}/archived`, { archived: true });
  });
  afterAll(async () => {
    await tablet?.unload();
    await assistant?.close();
    await app?.close();
    await server?.stop();
  });

  it("lists one row for each Profile, under its own id beside its current version's, a Duplicate a Profile of its own started from it", async () => {
    const listed = (await api.get<{ profiles: Listed[] }>("/profiles")).profiles.filter((profile) => profile.title?.startsWith("Versions "));
    expect(listed.map((profile) => profile.id).sort()).toEqual([ids.third, ids.copy, ids.orphan].sort());
    const row = (id: string) => listed.find((profile) => profile.id === id)!;
    expect(profileId).toMatch(/^[0-9a-f-]{36}$/);
    expect(row(ids.third)).toMatchObject({ profileId, versions: 3, startedFrom: null });
    expect(row(ids.copy)).toMatchObject({ versions: 1, startedFrom: { profileId, id: ids.third, title: "Versions Bloom" } });
    expect(row(ids.copy).profileId).not.toBe(profileId);
    // One saved from a Profile the Library no longer has is a Profile of its own, started from none.
    expect(row(ids.orphan)).toMatchObject({ versions: 1, startedFrom: null });
    expect(new Set(listed.map((profile) => profile.profileId)).size).toBe(3);
  });

  it("reads a Profile at its own id as its current version, and at a version's Decaid id as that version of it", async () => {
    expect(await read(profileId)).toMatchObject({ id: ids.third, profileId, version: 3, versions: 3, current: { id: ids.third, version: 3 } });
    expect(await read(profileId.toUpperCase())).toMatchObject({ id: ids.third });
    expect(await read(ids.first)).toMatchObject({ id: ids.first, profileId, version: 1, versions: 3, current: { id: ids.third, version: 3 } });
    expect(await read(ids.copy)).toMatchObject({ id: ids.copy, version: 1, current: { id: ids.copy, version: 1 } });
    for (const none of ["profile:00000000000000000000", "0f8e5d34-6c1b-4f0a-9d2e-7b3c4a5f6e81"]) {
      expect((await api.call("GET", path(none))).status).toBe(404);
      expect((await api.call("GET", path(none, "/versions"))).status).toBe(404);
      expect((await api.call("GET", path(none, "/recipes"))).status).toBe(404);
    }
  });

  it("lists the Profile's versions, numbered as they joined, the latest first, with which is current, who saved each and its Shots", async () => {
    const listed = await versions(profileId);
    expect(listed.profile).toEqual({ profileId, currentVersionId: ids.third });
    expect(listed.versions.map((version) => [version.id, version.number, version.current])).toEqual([
      [ids.third, 3, true],
      [ids.second, 2, false],
      [ids.first, 1, false],
    ]);
    expect(Object.fromEntries(listed.versions.map((version) => [version.id, version.parentId]))).toEqual({ [ids.first]: null, [ids.second]: ids.first, [ids.third]: ids.second });
    for (const version of listed.versions) expect(version.savedBy?.machine?.name).toBe("Versions lab 1");
    expect(Object.fromEntries(listed.versions.map((version) => [version.id, version.shots]))).toEqual({ [ids.first]: 1, [ids.second]: 0, [ids.third]: 1 });
    // No earlier version is shown: the Profile is shown where its current version is.
    expect(listed.versions.map((version) => version.shownAt.map((at) => at.location.name))).toEqual([["Versions lab"], [], []]);
    // Read through any of its versions, they are the same.
    expect(await versions(ids.first)).toEqual(listed);
    expect(await versions(ids.second)).toEqual(listed);
    // A Duplicate is among no other Profile's versions, and has its own.
    expect((await versions(ids.copy)).versions).toMatchObject([{ id: ids.copy, number: 1, current: true, parentId: null }]);
    // The orphan was saved over one deleted since: it keeps the number it took, and is the Profile's one version.
    expect((await versions(ids.orphan)).versions).toMatchObject([{ id: ids.orphan, number: 2, current: true, parentId: null }]);
  });

  it("gathers the Shots of all the Profile's versions, each with its version, and those of one version by its Decaid id", async () => {
    interface Shot {
      id: string;
      profile: { id: string; profileId: string | null; version: number | null } | null;
    }
    const shots = async (by: string) => (await api.get<{ shots: Shot[] }>(`/shots?profileId=${encodeURIComponent(by)}`)).shots;
    const ofProfile = await shots(profileId);
    expect(Object.fromEntries(ofProfile.map((shot) => [shot.id, shot.profile]))).toEqual({
      "versions-shot": expect.objectContaining({ id: ids.third, profileId, version: 3 }),
      "versions-first-shot": expect.objectContaining({ id: ids.first, profileId, version: 1 }),
    });
    expect((await shots(ids.first)).map((shot) => shot.id)).toEqual(["versions-first-shot"]);
    expect(await shots(ids.second)).toEqual([]);
    expect(await shots((await read(ids.copy)).profileId!)).toEqual([]);
    const found = await assistant.callWithinBudget<{ shots: Shot[] }>("find_shots", { profileId });
    expect(found.result.shots.map((shot) => [shot.id, shot.profile?.version]).sort()).toEqual([
      ["versions-first-shot", 1],
      ["versions-shot", 3],
    ]);
  });

  it("names a Machine whose Workflow holds an earlier version with no Recipe loaded, and never one with a Loaded Recipe", async () => {
    expect((await versions(profileId)).earlierOn).toEqual([]);
    // The barista picked the Profile before it changed: the Workflow still holds the first version's steps.
    tablet.setWorkflow({ ...workflow, profile: firstProfile });
    await expect.poll(async () => (await versions(profileId)).earlierOn, { timeout: 15_000 }).toEqual([{ machine: { id: machineId, name: "Versions lab 1" }, version: { id: ids.first, number: 1 } }]);
    // Named on the Profile only, and the server set no Workflow because of it.
    expect((await versions(ids.copy)).earlierOn).toEqual([]);
    const held = await api.get<{ workflow: { workflow: { profile: unknown } } | null }>(`/machines/${machineId}/workflow`);
    expect(held.workflow?.workflow.profile).toEqual(firstProfile);
    const viaAssistant = await assistant.callWithinBudget<Versions>("get_profile_versions", { profileId: ids.second });
    expect(viaAssistant.result.earlierOn).toEqual([{ machine: { id: machineId, name: "Versions lab 1" }, version: { id: ids.first, number: 1 } }]);
    // With a Recipe loaded, the Machine follows the Recipe, so is not listed.
    const database = await server.connectDatabase();
    try {
      await database.query("INSERT INTO loaded_recipes (machine_id, recipe_id, loaded_at) VALUES ($1, $2, now())", [machineId, recipeId]);
    } finally {
      await database.end();
    }
    expect((await versions(profileId)).earlierOn).toEqual([]);
  });

  it("lists the Recipes naming the Profile, not Archived, with the Machines that have each loaded, read by any of its ids", async () => {
    const expected = [
      { recipe: expect.objectContaining({ id: recipeId, name: "Versions Espresso", slot: 4, location: expect.objectContaining({ name: "Versions lab" }) }), loadedOn: [{ id: machineId, name: "Versions lab 1" }] },
    ];
    expect(await recipes(profileId)).toEqual(expected);
    expect(await recipes(ids.third)).toEqual(expected);
    expect(await recipes(ids.second)).toEqual(expected);
    expect(await recipes(ids.copy)).toEqual([]);
  });

  it("stores the current version's id in a Recipe created or edited with the Profile's id or any of its versions'", async () => {
    const named = async (id: string) => (await api.get<{ recipe: { content: Fields } }>(`/recipes/${id}`)).recipe.content.profileId;
    const create = async (name: string, given: string) =>
      (await api.send<{ recipe: { id: string } }>("POST", "/recipes", { locationId: lab.id, slot: null, content: { name, profileId: given } }, 201)).recipe.id;
    const byProfile = await create("Versions By Profile", profileId);
    const byEarlier = await create("Versions By Earlier", ids.first);
    expect(await named(byProfile)).toBe(ids.third);
    expect(await named(byEarlier)).toBe(ids.third);
    // No earlier version was shown at the Location for it.
    expect(await shownAt(ids.first)).toEqual([]);
    const onCopy = await create("Versions On Copy", ids.copy);
    expect(await named(onCopy)).toBe(ids.copy);
    await api.send("PATCH", `/recipes/${onCopy}`, { content: { profileId: ids.second } });
    expect(await named(onCopy)).toBe(ids.third);
    await api.send("PATCH", `/recipes/${onCopy}`, { content: { profileId: (await read(ids.copy)).profileId } });
    expect(await named(onCopy)).toBe(ids.copy);
    // Through an assistant too.
    const made = await assistant.callWithinBudget<{ recipe: { id: string; content: Fields } }>("create_recipe", { locationId: lab.id, name: "Versions By Assistant", profileId });
    expect(made.result.recipe.content.profileId).toBe(ids.third);
    const edited = await assistant.callWithinBudget<{ recipe: { content: Fields } }>("edit_recipe", { id: onCopy, profileId: ids.first });
    expect(edited.result.recipe.content.profileId).toBe(ids.third);
    // An id naming no Profile is refused as ever.
    expect((await api.call("POST", "/recipes", { locationId: lab.id, slot: null, content: { name: "Versions None", profileId: "0f8e5d34-6c1b-4f0a-9d2e-7b3c4a5f6e81" } })).status).toBe(400);
  });

  it("edits, shows and Archives the Profile through any of its ids, acting on its current version", async () => {
    const cafe = await api.createLocation("Versions annexe", "America/Chicago");
    await api.send("PUT", path(ids.first, `/locations/${cafe.id}`), { shown: true });
    expect((await shownAt(ids.third)).length).toBe(2);
    expect(await shownAt(ids.first)).toEqual([]);
    await api.send("PUT", path(profileId, `/locations/${cafe.id}`), { shown: false });
    expect((await shownAt(ids.third)).length).toBe(1);
    const edited = await api.send<{ profile: { id: string; content: { profile: { notes: string } } } }>("PATCH", path(ids.second), { content: { notes: "Versions notes" } });
    expect(edited.profile).toMatchObject({ id: ids.third, content: { profile: { notes: "Versions notes" } } });
    // The Profile takes again a title its own earlier versions keep.
    await api.send("PATCH", path(profileId), { content: { title: "Versions Bloom, renamed" } });
    await api.send("PATCH", path(profileId), { content: { title: "Versions Bloom" } });
    expect((await read(profileId)).title).toBe("Versions Bloom");
    // Another Profile's it does not.
    expect((await api.call("PATCH", path(profileId), { content: { title: "Versions Orphan" } })).status).toBe(409);
    // The assistant's tools act on the current version by an earlier one's id, and answer with what they changed.
    const offered = await assistant.callWithinBudget<{ profile: { id: string } }>("set_location_offering", { kind: "profile", id: ids.first, locationId: cafe.id, offered: true });
    expect(offered.result.profile.id).toBe(ids.third);
    expect((await shownAt(ids.third)).length).toBe(2);
    await assistant.callWithinBudget("set_location_offering", { kind: "profile", id: ids.first, locationId: cafe.id, offered: false });
    const archived = await assistant.callWithinBudget<{ profile: { id: string; archived: boolean } }>("set_archived", { kind: "profile", id: ids.first, archived: true });
    expect(archived.result.profile).toMatchObject({ id: ids.third, archived: true });
    expect((await assistant.callWithinBudget<{ profile: { archived: boolean } }>("set_archived", { kind: "profile", id: profileId, archived: false })).result.profile.archived).toBe(false);
  });

  it("is read by Staff away from its Locations and by a Viewer", async () => {
    const away = await api.createLocation("Versions cafe", "America/Chicago");
    const staff = await api.staffAt("versions-staff@example.com", away);
    const { link } = await api.invite("versions-viewer@example.com", "viewer");
    const viewer = AdminApi.signedInAs(server.url, await acceptInvite(server.url, link, { name: "Versions Viewer", password: "versions viewer password" }));
    const expected = await versions(profileId);
    expect((await versions(profileId, staff)).versions.map((version) => version.id)).toEqual(expected.versions.map((version) => version.id));
    expect((await versions(profileId, viewer)).versions.map((version) => version.id)).toEqual(expected.versions.map((version) => version.id));
    expect(await recipes(profileId, viewer)).toEqual(await recipes(profileId));
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
    await api.send("PUT", path(ids.orphan, `/locations/${bar.id}`), { shown: true });
    // Shown at the lab's DE1 and the bar's Bengle, a DE1; at the bar alone, a Bengle.
    expect(await modelOf(ids.orphan)).toBe("DE1");
    await api.send("PUT", path(ids.orphan, `/locations/${lab.id}`), { shown: false });
    expect(await modelOf(ids.orphan)).toBe("Bengle");
    expect(await simulatedAs(ids.orphan)).toBe("Bengle");
    expect(await simulatedAs(ids.orphan, "?model=DE1")).toBe("DE1");
    const { result } = await assistant.callWithinBudget<{ model: string }>("simulate_profile", { profileId: ids.orphan, curves: false });
    expect(result.model).toBe("Bengle");
    // A Profile's own id simulates its current version.
    const own = await api.get<{ simulation: { profile: { id: string } } }>(path(profileId, "/simulation"));
    expect(own.simulation.profile.id).toBe(ids.third);
  });

  it("is read through an assistant by Profile, with the Profile's id beside Decaid's (get_profile_versions, get_library_item, find_library_items)", async () => {
    const { result } = await assistant.callWithinBudget<Versions & { recipes: Fields[] }>("get_profile_versions", { profileId });
    const rest = await versions(profileId);
    expect(result.profile).toEqual(rest.profile);
    expect(result.versions.map((version) => [version.id, version.number, version.current])).toEqual(rest.versions.map((version) => [version.id, version.number, version.current]));
    expect(result.versions[0]).toMatchObject({ id: ids.third, number: 3, current: true, parentId: ids.second, shots: 1, savedBy: { machine: { name: "Versions lab 1" } } });
    expect(result.recipes).toContainEqual({ recipe: expect.objectContaining({ id: recipeId, name: "Versions Espresso", slot: 4 }), loadedOn: [{ id: machineId, name: "Versions lab 1" }] });
    // By any of its versions' ids, the same Profile.
    expect((await assistant.callWithinBudget<Versions>("get_profile_versions", { profileId: ids.first })).result.versions.map((version) => version.id)).toEqual(rest.versions.map((version) => version.id));

    const item = async (itemId: string) => (await assistant.callWithinBudget<{ profile: Read }>("get_library_item", { kind: "profile", id: itemId })).result.profile;
    expect(await item(profileId)).toMatchObject({ id: ids.third, profileId, version: 3, versions: 3, current: { id: ids.third, version: 3 }, startedFrom: null });
    expect(await item(ids.first)).toMatchObject({ id: ids.first, profileId, version: 1, current: { id: ids.third, version: 3 } });
    expect(await item(ids.copy)).toMatchObject({ id: ids.copy, versions: 1, startedFrom: { profileId, id: ids.third } });

    const found = await assistant.callWithinBudget<{ profiles: Listed[] }>("find_library_items", { kind: "profile", name: "Versions Bloom" });
    expect(found.result.profiles.map((profile) => profile.id).sort()).toEqual([ids.third, ids.copy].sort());
    expect(found.result.profiles.find((profile) => profile.id === ids.third)).toMatchObject({ profileId, versions: 3 });
  });

  // Last, as it removes versions.
  it("leaves a Profile whose current version is hard-deleted its latest other version, and removes one deleted with its last", async () => {
    const copyProfile = (await read(ids.copy)).profileId!;
    const recipesOnCopy = (await recipes(ids.copy)).map((on) => on.recipe.id);
    for (const id of recipesOnCopy) await api.send("DELETE", `/recipes/${id}`, undefined, 204);
    await api.send("DELETE", path(copyProfile), undefined, 204);
    expect((await api.call("GET", path(copyProfile))).status).toBe(404);
    expect((await api.call("GET", path(ids.copy))).status).toBe(404);
    // The second has no Shot or Recipe: deleted alone, the Profile keeps its other versions and their numbers.
    await api.send("DELETE", path(ids.second), undefined, 204);
    expect((await versions(profileId)).versions.map((version) => [version.id, version.number, version.current])).toEqual([
      [ids.third, 3, true],
      [ids.first, 1, false],
    ]);
  });
});
