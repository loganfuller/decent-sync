import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { GLOBAL_ID_KEY, RECIPE_SLOT_FIELD, globalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, type TestApp, serveTestApp } from "./support/assistants.js";
import { LoadedTablets, emptyLibrary, recipeIdInWorkflow } from "./support/loaded-tablets.js";
import { quiesced } from "./support/quiet.js";
import { SimulatedDye2, dye2List, dye2Migrated, selectRecipeInDye2 } from "./support/simulated-dye2.js";
import { type SimulatedTablet, derivedProfile } from "./support/simulated-tablet.js";
import { runAsSteps } from "./support/steps.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for #412 (#405, ADR-0026): Grinders, Baskets, Tools and Recipes
// created and edited through an assistant, Recipes put in Recipe Slots and
// copied to another Location, and Conflicts' values used and dismissed, by a
// test app on the MCP SDK's client connected as a Connected App, against the
// built server. Each result matches the REST API's; each change shows in the
// REST API as the account's, through that Connected App, and reaches a
// simulated tablet at Uptown running DYE2, connected to the other of two
// instances, as a change in the management interface does, a Recipe edit
// reaching the Workflow of the Machine that has it loaded (ADR-0022). What
// the REST API refuses is refused with its message, and a Connected App that
// may only read, or a Viewer's, is refused with 403 insufficient_scope.
// Serials are made up, from 41200.

type Record_ = Record<string, unknown>;

const env = { ...ASSISTANT_ENV, SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** An ISO 8601 time with its offset. */
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;

/** A result, a tool's or the REST API's, as the two are compared: each time as its instant, as the tools give them with a Location's offset. */
function comparable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (_, field: unknown) => (typeof field === "string" && ISO_TIME.test(field) ? Date.parse(field) : field));
}

/** Each kind's REST API this ticket changes: its route and the key of one item. */
const KINDS = {
  grinder: { path: "/grinders", one: "grinder" },
  basket: { path: "/baskets", one: "basket" },
  tool: { path: "/tools", one: "tool" },
  recipe: { path: "/recipes", one: "recipe" },
} as const;
type Kind = keyof typeof KINDS;

interface Source {
  machine: unknown;
  tabletId: unknown;
  account: { id: string; name: string | null } | null;
  connectedApp: { id: string; name: string; host: string } | null;
}

interface Version {
  id: string;
  fields: Record_;
  location: LocationView | null;
  source: Source;
  editedAt: string;
  copiedFrom: { id: string; name: string | null; location: LocationView | null } | null;
}

interface Conflict {
  id: string;
  field: string;
  value: unknown;
  source: Source;
  state: string;
  current: { value: unknown; source: Source | null; editedAt: string | null; versionId: string | null };
  resolvable: boolean;
}

describe("Changing equipment, Recipes and Conflicts through an assistant", { timeout: 120_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  let app: TestApp;
  /** The Admin's assistant, which may read and change, and another of theirs, which may only read. */
  let assistant: Assistant;
  let reader: Assistant;
  let uptown: LocationView;
  let harbor: LocationView;
  let machine: CreatedMachine;
  let tablet: SimulatedTablet;
  /** Who made a change through the Admin's assistant, as the REST API names it to an Admin. */
  let throughApp: Source;
  /** Made through the REST API: a Profile Uptown's tablet saved, and a Bean with a batch at Uptown. */
  let library: { profile: string; bean: string; batch: string };
  /** Made through the assistant at Uptown. */
  let made: { grinder: string; basket: string; tool: string; recipe: string; ristretto: string };
  const tablets = new LoadedTablets();
  const opened: Assistant[] = [];

  runAsSteps();

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
    app = await serveTestApp();
    const cookie = await signIn(server.url, admin);
    assistant = await Assistant.connect(server.url, app, cookie);
    reader = await Assistant.connect(server.url, app, cookie, { allowed: ["read"] });
    opened.push(assistant, reader);
    uptown = await api.createLocation("Uptown", "America/Chicago");
    harbor = await api.createLocation("Harbor", "Asia/Tokyo");
  });
  afterAll(async () => {
    for (const each of opened) await each.close();
    await tablets.unloadAll();
    await app?.close();
    await server?.stop();
  });

  /** A Staff member or Viewer, with an assistant connected as them that may read and change, their REST API and their account's id. */
  async function person(email: string, role: "staff" | "viewer", locations: LocationView[]): Promise<{ assistant: Assistant; api: AdminApi; id: string }> {
    const { link } = await api.invite(email, role, locations.map((location) => location.id));
    const cookie = await acceptInvite(server.url, link, { name: email, password: "a password for apps" });
    const theirs = await Assistant.connect(server.url, app, cookie, { allowed: role === "viewer" ? ["read"] : ["read", "change"] });
    opened.push(theirs);
    const rest = AdminApi.signedInAs(server.url, cookie);
    return { assistant: theirs, api: rest, id: (await rest.get<{ account: { id: string } }>("/session")).account.id };
  }

  /** An item as the REST API returns it, as an account reads it. */
  async function restItem(kind: Kind, id: string, as = api): Promise<Record_> {
    return (await as.get<Record<string, Record_>>(`${KINDS[kind].path}/${encodeURIComponent(id)}`))[KINDS[kind].one]!;
  }

  /** An item's versions, the latest first, as the REST API gives them. */
  async function versions(kind: Kind | "beanBatch" | "profile", id: string, as = api): Promise<Version[]> {
    const path = kind === "beanBatch" ? "/bean-batches" : kind === "profile" ? "/profiles" : KINDS[kind].path;
    return (await as.get<{ versions: Version[] }>(`${path}/${encodeURIComponent(id)}/history`)).versions;
  }

  /** A tool's error, which the call must answer with. */
  async function toolError(by: Assistant, name: string, args: Record_): Promise<string> {
    const result = await by.client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).toBe(true);
    return (result.content as { text: string }[]).map((block) => block.text).join("\n");
  }

  /** The REST API's refusal of a request, which must be refused with the status, as its message. */
  async function restRefusal(as: AdminApi, method: string, path: string, body: unknown, status: number): Promise<string> {
    const response = await as.call(method, path, body);
    expect(response.status, path).toBe(status);
    const { message } = (await response.json()) as { message: string | string[] };
    return Array.isArray(message) ? message.join("; ") : message;
  }

  const held = (records: Record_[], id: string) => records.find((record) => globalIdOf(record) === id);
  /** The tablet's record of a Basket, Tool or Recipe in DYE2's list, by the global id it carries. */
  const inList = (key: "baskets" | "equipment" | "recipes", id: string) => {
    const list = dye2List(tablet, key);
    return Array.isArray(list) ? (list as Record_[]).find((record) => record[GLOBAL_ID_KEY] === id) : undefined;
  };
  /** The slot each of the tablet's recipes is in, `-` for none, and its name, in its list's order. */
  const slotsOn = () => {
    const list = dye2List(tablet, "recipes");
    return (Array.isArray(list) ? (list as Record_[]) : []).map((record) => `${String(record[RECIPE_SLOT_FIELD] ?? "-")}:${String(record.name)}`);
  };
  const loadedOn = async () =>
    (await api.get<{ machine: { loadedRecipe: { recipe: { id: string } } | null } }>(`/machines/${machine.machine.id}`)).machine.loadedRecipe?.recipe.id ?? null;
  const context = () => (tablet.workflow().context ?? {}) as Record_;

  it("has Uptown's tablet online through the other instance, running DYE2, with a Profile it saved, and a Bean with a batch at Uptown made through the REST API", async () => {
    machine = await api.createMachine("Uptown bar", uptown.id);
    tablet = tablets.syncing(machine, other, { api: { ...emptyLibrary("41200"), ...dye2Migrated() }, dye2: new SimulatedDye2() });
    await api.waitForOnline(machine);
    const profile = String((await tablet.addProfile(derivedProfile("Uptown Bloom", 8.25))).id);
    await expect.poll(async () => (await api.call("GET", `/profiles/${encodeURIComponent(profile)}`)).status).toBe(200);
    const bean = (await api.send<{ bean: { id: string } }>("POST", "/beans", { content: { roaster: "Roux", name: "Assistant Guji" } }, 201)).bean.id;
    const batch = (await api.send<{ batch: { id: string } }>("POST", "/bean-batches", { beanId: bean, content: { roastDate: "2026-11-01" }, locations: [{ locationId: uptown.id }] }, 201)).batch.id;
    library = { profile, bean, batch };
    await expect.poll(() => held(tablet.batches(), batch)).toBeDefined();
  });

  it("creates and edits a Grinder, Basket and Tool, each as the REST API reads it, recorded as the Admin's through the Connected App, and on Uptown's tablet", async () => {
    const grinder = (await assistant.call<{ grinder: Record_ }>("create_grinder", { locationId: uptown.id, model: "Assistant EK43", burrSize: 98, burrType: "flat" })).grinder;
    const basket = (await assistant.call<{ basket: Record_ }>("create_basket", { locationId: uptown.id, name: "Assistant 18g", size: "double", diameterMm: 58.5 })).basket;
    const tool = (await assistant.call<{ tool: Record_ }>("create_tool", { locationId: uptown.id, name: "Assistant Screen", custom: [{ key: "thickness", value: "1.7 mm" }] })).tool;
    made = { grinder: grinder.id as string, basket: basket.id as string, tool: tool.id as string, recipe: "", ristretto: "" };
    for (const [kind, item] of [["grinder", grinder], ["basket", basket], ["tool", tool]] as const) {
      expect(comparable(item), kind).toEqual(comparable(await restItem(kind, item.id as string)));
    }
    // A new Grinder holds Decaid's numbered dial; each shown at Uptown only.
    expect(grinder).toMatchObject({ model: "Assistant EK43", location: { id: uptown.id }, content: { model: "Assistant EK43", burrSize: 98, burrType: "flat", settingType: "numeric" } });
    expect(basket).toMatchObject({ name: "Assistant 18g", shownAt: [{ location: { id: uptown.id } }], content: { name: "Assistant 18g", size: "double", diameterMm: 58.5 } });
    expect(tool).toMatchObject({ name: "Assistant Screen", content: { name: "Assistant Screen", custom: [{ key: "thickness", value: "1.7 mm" }] } });
    await expect.poll(() => held(tablet.grinders(), made.grinder)).toMatchObject({ model: "Assistant EK43", burrSize: 98 });
    await expect.poll(() => inList("baskets", made.basket)).toMatchObject({ name: "Assistant 18g", size: "double" });
    await expect.poll(() => inList("equipment", made.tool)).toMatchObject({ name: "Assistant Screen" });

    // Only the fields given, null clearing one; a Tool's attribute with no key left out, as DYE2's page leaves it.
    const grinderEdited = (await assistant.call<{ grinder: Record_ }>("edit_grinder", { id: made.grinder, notes: "New burrs", burrSize: null })).grinder;
    expect(comparable(grinderEdited)).toEqual(comparable(await restItem("grinder", made.grinder)));
    expect(grinderEdited.content).toMatchObject({ model: "Assistant EK43", notes: "New burrs", burrType: "flat" });
    expect(grinderEdited.content).not.toHaveProperty("burrSize");
    const basketEdited = (await assistant.call<{ basket: Record_ }>("edit_basket", { id: made.basket.toUpperCase(), notes: "Ridgeless", diameterMm: null })).basket;
    expect(comparable(basketEdited)).toEqual(comparable(await restItem("basket", made.basket)));
    expect(basketEdited.content).toEqual({ name: "Assistant 18g", size: "double", notes: "Ridgeless" });
    const toolEdited = (await assistant.call<{ tool: Record_ }>("edit_tool", { id: made.tool, custom: [{ key: " thickness ", value: "2 mm" }, { key: " ", value: "dropped" }] })).tool;
    expect(comparable(toolEdited)).toEqual(comparable(await restItem("tool", made.tool)));
    expect(toolEdited.content).toEqual({ name: "Assistant Screen", custom: [{ key: "thickness", value: "2 mm" }] });
    await expect.poll(() => held(tablet.grinders(), made.grinder)).toMatchObject({ notes: "New burrs" });
    expect(held(tablet.grinders(), made.grinder)?.burrSize ?? null).toBeNull();
    await expect.poll(() => inList("baskets", made.basket)).toMatchObject({ notes: "Ridgeless" });
    await expect.poll(() => inList("equipment", made.tool)?.custom).toEqual([{ key: "thickness", value: "2 mm" }]);

    // Every version the Admin's through the Connected App: one id, the app's name and host.
    const adminId = (await api.get<{ account: { id: string } }>("/session")).account.id;
    const grinderVersions = await versions("grinder", made.grinder);
    throughApp = grinderVersions[0]!.source;
    expect(throughApp).toEqual({
      machine: null,
      tabletId: null,
      account: { id: adminId, name: "Ada Admin" },
      connectedApp: { id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: "Test Assistant", host: new URL(app.clientId).host },
    });
    expect(grinderVersions.map((version) => version.fields)).toEqual([{ notes: "New burrs", burrSize: null }, expect.objectContaining({ model: "Assistant EK43", archived: false })]);
    expect((await versions("basket", made.basket)).map((version) => [version.location?.name ?? null, version.fields])).toEqual([
      [null, { notes: "Ridgeless", diameterMm: null }],
      ["Uptown", { shown: true }],
      [null, expect.objectContaining({ name: "Assistant 18g" })],
    ]);
    for (const kind of ["grinder", "basket", "tool"] as const) {
      for (const version of await versions(kind, made[kind])) expect(version.source, kind).toEqual(throughApp);
    }
  });

  it("creates a Recipe in a slot, using what the Library has, and edits it, as the REST API reads it, on Uptown's tablet and into the Workflow of the Machine that has it loaded", async () => {
    const { recipe } = await assistant.call<{ recipe: Record_ }>("create_recipe", {
      locationId: uptown.id,
      slot: 1,
      name: "Assistant Espresso",
      beverage: "Espresso",
      beanBatchId: library.batch,
      profileId: library.profile,
      dose: 18,
      yield: 36,
      grinderId: made.grinder,
      grindSetting: "2.5",
      basketId: made.basket,
      toolIds: [made.tool],
      toolAttributes: { [made.tool]: [{ key: "thickness", value: "1.7 mm" }] },
      steamTemperature: 150,
      hotWaterVolume: 120,
    });
    made.recipe = recipe.id as string;
    expect(comparable(recipe)).toEqual(comparable(await restItem("recipe", made.recipe)));
    expect(recipe).toMatchObject({
      name: "Assistant Espresso",
      location: { id: uptown.id },
      slot: 1,
      archived: false,
      // A grind setting that reads as a number is kept as one, and the Recipe's Bean is its batch's.
      content: { beanId: library.bean, beanBatchId: library.batch, grindSetting: 2.5, steamTemperature: 150, hotWaterVolume: 120, steamMode: "flow", hotWaterMode: "vol" },
      uses: { bean: { id: library.bean }, beanBatch: { id: library.batch, atLocation: true }, profile: { id: library.profile }, grinder: { id: made.grinder }, basket: { id: made.basket }, tools: [{ id: made.tool }] },
    });
    await expect.poll(slotsOn).toEqual(["1:Assistant Espresso"]);

    // The Machine loads it from DYE2's Select Recipe page.
    const recordId = String(inList("recipes", made.recipe)!.id);
    tablet.connectMachine();
    await selectRecipeInDye2(tablet, recordId);
    await expect.poll(loadedOn).toBe(made.recipe);
    await expect.poll(() => context().grinderSetting).toBe("2.5");

    // An edit through the assistant reaches the tablet's record and the Workflow, as one in the management interface does (ADR-0022).
    const { recipe: edited } = await assistant.call<{ recipe: Record_ }>("edit_recipe", { id: made.recipe, dose: 18.5, grindSetting: 2.8, steamTemperature: null });
    expect(comparable(edited)).toEqual(comparable(await restItem("recipe", made.recipe)));
    expect(edited.content).toMatchObject({ dose: 18.5, yield: 36, grindSetting: 2.8 });
    expect(edited.content).not.toHaveProperty("steamTemperature");
    await expect.poll(() => [context().targetDoseWeight, context().grinderSetting], { timeout: 15_000 }).toEqual([18.5, "2.8"]);
    expect(recipeIdInWorkflow(tablet)).toBe(recordId);
    expect(await loadedOn()).toBe(made.recipe);
    await expect.poll(() => (inList("recipes", made.recipe)?.dashboardVariables as Record_ | undefined)?.dose).toBe(18.5);

    // Its versions but any the Machine's load gained it: the edit, its slot at Uptown and its creation, each through the Connected App.
    const recipeVersions = (await versions("recipe", made.recipe)).filter((version) => version.source.machine === null);
    expect(recipeVersions.map((version) => [version.location?.name ?? null, version.fields, version.source])).toEqual([
      [null, { dose: 18.5, grindSetting: 2.8, steamTemperature: null }, throughApp],
      ["Uptown", { slot: 1 }, throughApp],
      [null, expect.objectContaining({ name: "Assistant Espresso", dose: 18 }), throughApp],
    ]);
  });

  it("puts a Recipe in a slot, swapping it with the one there, in the next free one and in none, keeping its identity and the Machine that has it loaded", async () => {
    made.ristretto = (await assistant.call<{ recipe: { id: string } }>("create_recipe", { locationId: uptown.id, slot: 2, name: "Assistant Ristretto", dose: 18, yield: 27 })).recipe.id;
    await expect.poll(slotsOn).toEqual(["1:Assistant Espresso", "2:Assistant Ristretto"]);
    const recordIds = () => [inList("recipes", made.recipe)?.id, inList("recipes", made.ristretto)?.id];
    const before = recordIds();
    const slot = async (id: string, chosen: number | "next" | null) => {
      const { recipe } = await assistant.call<{ recipe: Record_ }>("set_recipe_slot", { id, slot: chosen });
      expect(comparable(recipe)).toEqual(comparable(await restItem("recipe", id)));
      return recipe.slot;
    };

    expect(await slot(made.recipe, 2)).toBe(2);
    expect((await restItem("recipe", made.ristretto)).slot).toBe(1);
    await expect.poll(slotsOn).toEqual(["2:Assistant Espresso", "1:Assistant Ristretto"]);
    // The lowest free slot, which is never its own; then none, kept at Uptown.
    expect(await slot(made.recipe, "next")).toBe(3);
    expect(await slot(made.recipe, null)).toBeNull();
    await expect.poll(slotsOn).toEqual(["-:Assistant Espresso", "1:Assistant Ristretto"]);
    // Each keeps its record and its id, and the Machine keeps it loaded.
    expect(recordIds()).toEqual(before);
    expect(await loadedOn()).toBe(made.recipe);
    expect(recipeIdInWorkflow(tablet)).toBe(before[0]);
    expect(await slot(made.recipe, 1)).toBe(1);
    expect((await restItem("recipe", made.ristretto)).slot).toBeNull();
    await expect.poll(slotsOn).toEqual(["1:Assistant Espresso", "-:Assistant Ristretto"]);
    // Its own slot again, by its id in upper case, changes nothing.
    const moves = (await versions("recipe", made.recipe)).length;
    expect(await slot(made.recipe.toUpperCase(), 1)).toBe(1);
    expect(await versions("recipe", made.recipe)).toHaveLength(moves);

    // Each move a version at Uptown through the Connected App.
    expect((await versions("recipe", made.recipe)).slice(0, 4).map((version) => [version.location?.name, version.fields, version.source])).toEqual([
      ["Uptown", { slot: 1 }, throughApp],
      ["Uptown", { slot: null }, throughApp],
      ["Uptown", { slot: 3 }, throughApp],
      ["Uptown", { slot: 2 }, throughApp],
    ]);
    expect((await versions("recipe", made.ristretto)).slice(0, 2).map((version) => [version.fields, version.source])).toEqual([
      [{ slot: null }, throughApp],
      [{ slot: 1 }, throughApp],
    ]);
  });

  it("copies a Recipe to Harbor with Harbor's Grinder, offering what it uses there, its history naming the Recipe it was copied from", async () => {
    const harborGrinder = (await api.send<{ grinder: { id: string } }>("POST", "/grinders", { locationId: harbor.id, content: { model: "Harbor EK43" } }, 201)).grinder.id;
    const { recipe: copy } = await assistant.call<{ recipe: Record_ }>("copy_recipe", { id: made.recipe, locationId: harbor.id, slot: "next", grinderId: harborGrinder });
    expect(comparable(copy)).toEqual(comparable(await restItem("recipe", copy.id as string)));
    expect(copy).toMatchObject({
      name: "Assistant Espresso",
      location: { id: harbor.id },
      slot: 1,
      // Its grind setting kept as a starting point, and its steam, hot water and flush settings the Recipe's.
      content: { grinderId: harborGrinder, grindSetting: 2.8, beanBatchId: library.batch, dose: 18.5, hotWaterVolume: 120 },
      uses: { beanBatch: { id: library.batch, atLocation: true }, profile: { id: library.profile }, basket: { id: made.basket }, tools: [{ id: made.tool }] },
    });
    // What it uses is offered at Harbor from then on, each the Admin's change there through the Connected App.
    const atHarbor = async (kind: "beanBatch" | "profile" | Kind, id: string) => (await versions(kind, id)).find((version) => version.location?.id === harbor.id);
    expect(await atHarbor("beanBatch", library.batch)).toMatchObject({ fields: { atLocation: true }, source: throughApp });
    expect(await atHarbor("profile", library.profile)).toMatchObject({ fields: { shown: true }, source: throughApp });
    expect(await atHarbor("basket", made.basket)).toMatchObject({ fields: { shown: true }, source: throughApp });
    expect(await atHarbor("tool", made.tool)).toMatchObject({ fields: { shown: true }, source: throughApp });
    const [first] = (await versions("recipe", copy.id as string)).slice(-1);
    expect(first).toMatchObject({ source: throughApp, copiedFrom: { id: made.recipe, name: "Assistant Espresso", location: { id: uptown.id } } });
    // The Recipe copied is not changed.
    expect((await versions("recipe", made.recipe))[0]!.fields).toEqual({ slot: 1 });

    // With no Grinder, and no batch in place of the Recipe's.
    const { recipe: bare } = await assistant.call<{ recipe: { content: Record_ } }>("copy_recipe", { id: made.recipe, locationId: harbor.id, grinderId: null, beanBatchId: null });
    expect(bare).toMatchObject({ slot: null, content: { grindSetting: 2.8, dose: 18.5 } });
    for (const field of ["grinderId", "beanBatchId", "beanId"]) expect(bare.content).not.toHaveProperty(field);
  });

  it("refuses what the REST API refuses, with its message, and input its schemas refuse", async () => {
    const nowhere = randomUUID();
    const recipesAt = async (location: LocationView) => (await api.get<{ recipes: unknown[] }>(`/locations/${location.id}/recipes`)).recipes.length;
    const counts = async () => [
      (await api.get<{ grinders: unknown[] }>("/grinders")).grinders.length,
      (await api.get<{ baskets: unknown[] }>("/baskets")).baskets.length,
      (await api.get<{ tools: unknown[] }>("/tools")).tools.length,
      await recipesAt(uptown),
      await recipesAt(harbor),
    ];
    const before = await counts();
    const harborGrinder = (await api.get<{ grinders: { id: string; model: string }[] }>("/grinders")).grinders.find((grinder) => grinder.model === "Harbor EK43")!.id;
    const ristretto = await restItem("recipe", made.ristretto);
    for (const [name, args, method, path, body, status] of [
      // No such Location, item or Recipe.
      ["create_grinder", { locationId: nowhere, model: "Nowhere EK43" }, "POST", "/grinders", { locationId: nowhere, content: { model: "Nowhere EK43" } }, 404],
      ["create_basket", { locationId: nowhere, name: "Nowhere 18g" }, "POST", "/baskets", { locationId: nowhere, content: { name: "Nowhere 18g" } }, 404],
      ["edit_tool", { id: nowhere, name: "Nothing" }, "PATCH", `/tools/${nowhere}`, { content: { name: "Nothing" } }, 404],
      ["edit_recipe", { id: "not-an-id", dose: 18 }, "PATCH", "/recipes/not-an-id", { content: { dose: 18 } }, 404],
      ["create_recipe", { locationId: uptown.id, profileId: "profile:none" }, "POST", "/recipes", { locationId: uptown.id, content: { profileId: "profile:none" } }, 400],
      ["copy_recipe", { id: nowhere, locationId: harbor.id, grinderId: null }, "POST", `/recipes/${nowhere}/copies`, { locationId: harbor.id, grinderId: null }, 404],
      ["resolve_conflict", { id: nowhere, resolution: "dismiss" }, "POST", `/conflicts/${nowhere}/dismiss`, {}, 404],
      // A name the Library has, ignoring case, and a model left blank.
      ["create_basket", { locationId: uptown.id, name: " assistant 18G " }, "POST", "/baskets", { locationId: uptown.id, content: { name: " assistant 18G " } }, 409],
      ["create_tool", { locationId: harbor.id, name: "ASSISTANT SCREEN" }, "POST", "/tools", { locationId: harbor.id, content: { name: "ASSISTANT SCREEN" } }, 409],
      ["create_grinder", { locationId: uptown.id, model: " " }, "POST", "/grinders", { locationId: uptown.id, content: { model: " " } }, 400],
      // Values Decaid and DYE2 would refuse, as the REST API reads them.
      // Several problems, named in the order of the tool's fields.
      ["edit_grinder", { id: made.grinder, burrSize: -1, settingType: "dial" }, "PATCH", `/grinders/${made.grinder}`, { content: { burrSize: -1, settingType: "dial" } }, 400],
      ["edit_basket", { id: made.basket, size: "huge" }, "PATCH", `/baskets/${made.basket}`, { content: { size: "huge" } }, 400],
      ["edit_recipe", { id: made.recipe, steamTemperature: 171, steamStopTemperature: 20, hotWaterFlow: 9, flushDuration: 2.5 }, "PATCH", `/recipes/${made.recipe}`, { content: { steamTemperature: 171, steamStopTemperature: 20, hotWaterFlow: 9, flushDuration: 2.5 } }, 400],
      ["create_recipe", { locationId: uptown.id, grindSetting: -1 }, "POST", "/recipes", { locationId: uptown.id, content: { grindSetting: -1 } }, 400],
      ["create_recipe", { locationId: uptown.id, slot: 10 }, "POST", "/recipes", { locationId: uptown.id, slot: 10, content: {} }, 400],
      ["edit_recipe", { id: made.recipe, toolIds: ["not-an-id"] }, "PATCH", `/recipes/${made.recipe}`, { content: { toolIds: ["not-an-id"] } }, 400],
      // What a Recipe may use at its Location: another's Grinder, attributes of a Tool it doesn't use.
      ["edit_recipe", { id: made.recipe, grinderId: harborGrinder }, "PATCH", `/recipes/${made.recipe}`, { content: { grinderId: harborGrinder } }, 409],
      ["create_recipe", { locationId: uptown.id, toolAttributes: { [made.tool]: [] } }, "POST", "/recipes", { locationId: uptown.id, content: { toolAttributes: { [made.tool]: [] } } }, 400],
      ["copy_recipe", { id: made.recipe, locationId: harbor.id, grinderId: made.grinder }, "POST", `/recipes/${made.recipe}/copies`, { locationId: harbor.id, grinderId: made.grinder }, 409],
      // A copy to the Recipe's own Location.
      ["copy_recipe", { id: made.recipe, locationId: uptown.id, grinderId: null }, "POST", `/recipes/${made.recipe}/copies`, { locationId: uptown.id, grinderId: null }, 400],
      ["set_recipe_slot", { id: made.recipe, slot: 0 }, "PUT", `/recipes/${made.recipe}/slot`, { slot: 0 }, 400],
    ] as const) {
      expect(await toolError(assistant, name, args), `${name} ${JSON.stringify(args)}`).toBe(await restRefusal(api, method, path, body, status));
    }
    // An Archived Recipe is in no slot.
    await api.send("PUT", `/recipes/${made.ristretto}/archived`, { archived: true });
    expect(await toolError(assistant, "set_recipe_slot", { id: made.ristretto, slot: 3 })).toBe(await restRefusal(api, "PUT", `/recipes/${made.ristretto}/slot`, { slot: 3 }, 409));
    await api.send("PUT", `/recipes/${made.ristretto}/archived`, { archived: false });

    // What the tools' own inputs take.
    expect(await toolError(assistant, "edit_recipe", { id: made.recipe })).toBe("Give at least one field to change");
    expect(await toolError(assistant, "edit_grinder", { id: made.grinder })).toBe("Give at least one field to change");
    expect(await toolError(assistant, "create_recipe", { locationId: uptown.id, ratio: 2 })).toContain("ratio");
    expect(await toolError(assistant, "create_recipe", { locationId: uptown.id, beanId: library.bean })).toContain("beanId");
    expect(await toolError(assistant, "create_grinder", { locationId: uptown.id })).toContain("model");
    expect(await toolError(assistant, "edit_basket", { id: made.basket, name: null })).toContain("name");
    expect(await toolError(assistant, "set_recipe_slot", { id: made.recipe })).toContain("slot");
    expect(await toolError(assistant, "copy_recipe", { id: made.recipe, locationId: harbor.id })).toContain("grinderId");
    expect(await toolError(assistant, "resolve_conflict", { id: nowhere, resolution: "keep" })).toContain("resolution");
    // Nothing of these changed.
    expect(await counts()).toEqual(before);
    expect(await restItem("recipe", made.ristretto)).toEqual({ ...ristretto, archived: false });
    expect((await versions("recipe", made.recipe))[0]!.fields).toEqual({ slot: 1 });
  });

  it("lets Staff change what the REST API lets them: Baskets' and Tools' details anywhere, but Grinders and Recipes, and what they create, only at their own Locations", async () => {
    const sam = await person("sam-412@example.com", "staff", [harbor]);
    // A Basket's and Tool's details anywhere, through their own Connected App, named to an Admin.
    await sam.assistant.call("edit_basket", { id: made.basket, notes: "Sam's notes" });
    await sam.assistant.call("edit_tool", { id: made.tool, name: "Assistant Screen" });
    const [edited] = await versions("basket", made.basket);
    expect(edited).toMatchObject({ fields: { notes: "Sam's notes" }, source: { account: { id: sam.id, name: "sam-412@example.com" }, connectedApp: { name: "Test Assistant" } } });
    expect(edited!.source.connectedApp!.id).not.toBe(throughApp.connectedApp!.id);
    // At Harbor, a Grinder created and a Recipe copied there from Uptown.
    const grinder = (await sam.assistant.call<{ grinder: { id: string } }>("create_grinder", { locationId: harbor.id, model: "Sam's EK43" })).grinder.id;
    await sam.assistant.call("edit_grinder", { id: grinder, notes: "Harbor's" });
    const { recipe: copy } = await sam.assistant.call<{ recipe: { id: string; location: LocationView } }>("copy_recipe", { id: made.recipe, locationId: harbor.id, grinderId: grinder });
    expect(copy.location.id).toBe(harbor.id);
    await sam.assistant.call("set_recipe_slot", { id: copy.id, slot: null });
    await sam.assistant.call("edit_recipe", { id: copy.id, name: "Harbor Espresso" });

    // At Uptown, as the REST API refuses them.
    for (const [name, args, method, path, body] of [
      ["create_grinder", { locationId: uptown.id, model: "Sam's Uptown EK43" }, "POST", "/grinders", { locationId: uptown.id, content: { model: "Sam's Uptown EK43" } }],
      ["edit_grinder", { id: made.grinder, notes: "Sam's" }, "PATCH", `/grinders/${made.grinder}`, { content: { notes: "Sam's" } }],
      ["create_basket", { locationId: uptown.id, name: "Sam's Basket" }, "POST", "/baskets", { locationId: uptown.id, content: { name: "Sam's Basket" } }],
      ["create_tool", { locationId: uptown.id, name: "Sam's Tool" }, "POST", "/tools", { locationId: uptown.id, content: { name: "Sam's Tool" } }],
      ["create_recipe", { locationId: uptown.id, name: "Sam's Recipe" }, "POST", "/recipes", { locationId: uptown.id, content: { name: "Sam's Recipe" } }],
      ["edit_recipe", { id: made.recipe, dose: 20 }, "PATCH", `/recipes/${made.recipe}`, { content: { dose: 20 } }],
      ["set_recipe_slot", { id: made.ristretto, slot: 2 }, "PUT", `/recipes/${made.ristretto}/slot`, { slot: 2 }],
      ["copy_recipe", { id: copy.id, locationId: uptown.id, grinderId: null }, "POST", `/recipes/${copy.id}/copies`, { locationId: uptown.id, grinderId: null }],
    ] as const) {
      expect(await toolError(sam.assistant, name, args), `${name} ${JSON.stringify(args)}`).toBe(await restRefusal(sam.api, method, path, body, 403));
    }
    expect((await restItem("recipe", made.recipe)).content).toMatchObject({ dose: 18.5 });
    expect((await restItem("recipe", made.ristretto)).slot).toBeNull();
    expect((await restItem("grinder", made.grinder)).content).toMatchObject({ notes: "New burrs" });
  });

  it("uses one Conflict's value over the value now the person was shown, and dismisses another, each as the REST API would, refusing what it refuses", async () => {
    // An edit of Uptown's Grinder through the assistant that the tablet's later edit, made offline without seeing it, replaces.
    await quiesced(api, { tablets: { tablet }, machines: { machine } });
    const local = held(tablet.grinders(), made.grinder)!.id;
    tablet.loseNetwork();
    await assistant.call("edit_grinder", { id: made.grinder, notes: "Assistant notes", burrs: "Assistant burrs" });
    // Well after it, whatever the drift between the tablet's clock and PostgreSQL's.
    await delay(1_000);
    await tablet.editGrinder(local, { notes: "Tablet notes", burrs: "Tablet burrs" });
    tablet.restoreNetwork();
    const open = async () => (await api.get<{ conflicts: Conflict[] }>(`/grinders/${made.grinder}/conflicts`)).conflicts;
    await expect.poll(async () => (await open()).map((entry) => [entry.field, entry.value, entry.source]).sort(), { timeout: 15_000 }).toEqual([
      ["burrs", "Assistant burrs", throughApp],
      ["notes", "Assistant notes", throughApp],
    ]);
    const [burrs, notes] = (await open()).sort((a, b) => a.field.localeCompare(b.field)) as [Conflict, Conflict];

    // A Staff member elsewhere, the version shown missing or since replaced, refused as the REST API refuses them.
    const harborStaff = await person("hal-412@example.com", "staff", [harbor]);
    expect(await toolError(harborStaff.assistant, "resolve_conflict", { id: notes.id, resolution: "dismiss" })).toBe(
      await restRefusal(harborStaff.api, "POST", `/conflicts/${notes.id}/dismiss`, {}, 403),
    );
    expect(await toolError(harborStaff.assistant, "resolve_conflict", { id: notes.id, resolution: "use", seen: notes.current.versionId })).toBe(
      await restRefusal(harborStaff.api, "POST", `/conflicts/${notes.id}/use`, { seen: notes.current.versionId }, 403),
    );
    expect(await toolError(assistant, "resolve_conflict", { id: notes.id, resolution: "use" })).toBe(await restRefusal(api, "POST", `/conflicts/${notes.id}/use`, {}, 400));
    expect(await toolError(assistant, "resolve_conflict", { id: notes.id, resolution: "use", seen: randomUUID() })).toBe(
      await restRefusal(api, "POST", `/conflicts/${notes.id}/use`, { seen: randomUUID() }, 409),
    );

    // Its value used over the value now, which the person was shown: a new edit through the Connected App, on the tablet.
    const { conflict: used } = await assistant.call<{ conflict: Conflict }>("resolve_conflict", { id: notes.id, resolution: "use", seen: notes.current.versionId });
    const [latest] = await versions("grinder", made.grinder);
    expect(latest).toMatchObject({ fields: { notes: "Assistant notes" }, source: throughApp });
    expect(comparable(used)).toEqual(comparable({ ...notes, state: "used", current: { value: "Assistant notes", source: throughApp, editedAt: latest!.editedAt, versionId: latest!.id } }));
    await expect.poll(() => held(tablet.grinders(), made.grinder)?.notes).toBe("Assistant notes");
    // Dismissed, closed with nothing else changed.
    const { conflict: dismissed } = await assistant.call<{ conflict: Conflict }>("resolve_conflict", { id: burrs.id, resolution: "dismiss" });
    expect(comparable(dismissed)).toEqual(comparable({ ...burrs, state: "dismissed" }));
    expect((await restItem("grinder", made.grinder)).content).toMatchObject({ notes: "Assistant notes", burrs: "Tablet burrs" });
    expect((await versions("grinder", made.grinder))[0]!.id).toBe(latest!.id);
    expect(await open()).toEqual([]);
    // Each closed once.
    expect(await toolError(assistant, "resolve_conflict", { id: notes.id, resolution: "dismiss" })).toBe(await restRefusal(api, "POST", `/conflicts/${notes.id}/dismiss`, {}, 409));
    expect(await toolError(assistant, "resolve_conflict", { id: burrs.id, resolution: "use", seen: null })).toBe(
      await restRefusal(api, "POST", `/conflicts/${burrs.id}/use`, { seen: null }, 409),
    );
  });

  it("refuses each of these tools, from a Connected App that may only read and from a Viewer's, with 403 insufficient_scope naming read and change, changing nothing", async () => {
    const recipes = async () => (await api.get<{ recipes: unknown[] }>(`/locations/${uptown.id}/recipes`)).recipes;
    const before = {
      grinders: (await api.get<{ grinders: unknown[] }>("/grinders")).grinders,
      baskets: (await api.get<{ baskets: unknown[] }>("/baskets")).baskets,
      tools: (await api.get<{ tools: unknown[] }>("/tools")).tools,
      uptown: await recipes(),
      harbor: (await api.get<{ recipes: unknown[] }>(`/locations/${harbor.id}/recipes`)).recipes,
    };
    /** Each tool of this ticket, with arguments it would take from an account allowed to change. */
    const calls = (name: string): [string, Record_][] => [
      ["create_grinder", { locationId: uptown.id, model: name }],
      ["edit_grinder", { id: made.grinder, notes: name }],
      ["create_basket", { locationId: uptown.id, name }],
      ["edit_basket", { id: made.basket, notes: name }],
      ["create_tool", { locationId: uptown.id, name }],
      ["edit_tool", { id: made.tool, custom: [{ key: "note", value: name }] }],
      ["create_recipe", { locationId: uptown.id, name }],
      ["edit_recipe", { id: made.recipe, name }],
      ["set_recipe_slot", { id: made.recipe, slot: null }],
      ["copy_recipe", { id: made.recipe, locationId: harbor.id, grinderId: null }],
      ["resolve_conflict", { id: randomUUID(), resolution: "dismiss" }],
    ];
    const refuse = async (accessToken: string, who: string) => {
      for (const [name, args] of calls(who)) {
        const refused = await Assistant.rawCall(server.url, accessToken, "tools/call", { name, arguments: args });
        expect(refused.status, `${who} ${name}`).toBe(403);
        const challenge = refused.headers.get("www-authenticate") ?? "";
        expect(challenge, `${who} ${name}`).toMatch(/^Bearer /);
        expect(challenge, `${who} ${name}`).toContain('error="insufficient_scope"');
        expect(challenge, `${who} ${name}`).toContain('scope="read change"');
      }
    };
    await refuse(reader.tokens.access_token, "Read-only");
    // It still reads.
    expect((await reader.call<{ recipe: Record_ }>("get_library_item", { kind: "recipe", id: made.recipe })).recipe.slot).toBe(1);

    // A Staff member's Connected App, allowed to change, changes nothing from the call after their account becomes a Viewer.
    const vic = await person("vic-412@example.com", "staff", [uptown]);
    await vic.assistant.call("edit_basket", { id: made.basket, notes: "Before Viewer" });
    await api.send("PUT", `/accounts/${vic.id}/access`, { role: "viewer" });
    await refuse(vic.assistant.tokens.access_token, "As Viewer");

    expect((await api.get<{ grinders: unknown[] }>("/grinders")).grinders).toEqual(before.grinders);
    expect((await api.get<{ tools: unknown[] }>("/tools")).tools).toEqual(before.tools);
    expect(await recipes()).toEqual(before.uptown);
    expect((await api.get<{ recipes: unknown[] }>(`/locations/${harbor.id}/recipes`)).recipes).toEqual(before.harbor);
    const baskets = (await api.get<{ baskets: { content: Record_ }[] }>("/baskets")).baskets;
    expect(baskets).toHaveLength(before.baskets.length);
    expect((await restItem("basket", made.basket)).content).toMatchObject({ notes: "Before Viewer" });
  });
});
