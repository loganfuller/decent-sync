import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { globalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, type TestApp, serveTestApp } from "./support/assistants.js";
import { LoadedTablets } from "./support/loaded-tablets.js";
import { quiesced } from "./support/quiet.js";
import { SimulatedDye2, recordedDye2MainTablet } from "./support/simulated-dye2.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { runAsSteps } from "./support/steps.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for #409 (#405, ADR-0026): the Library read through an assistant, a
// test app on the MCP SDK's client connected as a Connected App, against the
// built server, each tool's result matching what the REST API gives the same
// account. Items come from a simulated tablet at Uptown, the built plugin on a
// tablet with DYE2 as recorded in fixtures/decaid/dye2-v0.1.26/, and from the
// REST API at Harbor; Conflicts from the tablet's edits made offline, which
// lose to the REST API's made after them. Serials are made up, from 40901.

type Record_ = Record<string, unknown>;

interface Page {
  total: number;
  offset: number;
  more: boolean;
}

interface Paged<T> extends Page {
  entries: T[];
}

const env = { ...ASSISTANT_ENV, SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** Each kind as the tools name it: the REST API's route and the keys of its list and of one item, and find_library_items's key. */
const KINDS = {
  bean: { path: "/beans", list: "beans", one: "bean", found: "beans" },
  beanBatch: { path: "/bean-batches", list: "batches", one: "batch", found: "beanBatches" },
  profile: { path: "/profiles", list: "profiles", one: "profile", found: "profiles" },
  grinder: { path: "/grinders", list: "grinders", one: "grinder", found: "grinders" },
  basket: { path: "/baskets", list: "baskets", one: "basket", found: "baskets" },
  tool: { path: "/tools", list: "tools", one: "tool", found: "tools" },
  recipe: { path: "/recipes", list: "recipes", one: "recipe", found: "recipes" },
} as const;
type Kind = keyof typeof KINDS;
const EVERY_KIND = Object.keys(KINDS) as Kind[];

/** An ISO 8601 time with its offset. */
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;
/** Chicago's offset, in standard or daylight saving time, and Tokyo's. */
const UPTOWN_TIME = /-0[56]:00$/;
const HARBOR_TIME = /\+09:00$/;
const UTC_TIME = /Z$/;

/**
 * A result, a tool's or the REST API's, as the two are compared: each ISO
 * 8601 time as its instant, since the REST API gives them in UTC and the
 * tools with a Location's offset.
 */
function comparable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (_, field: unknown) => (typeof field === "string" && ISO_TIME.test(field) ? Date.parse(field) : field));
}

/**
 * The Locations offering an item of the kind, as find_library_items filters
 * by them, read from the REST API's view of it: a Bean Batch's those it is
 * at, but none while it or its Bean, one of the Archived Beans given, is
 * Archived.
 */
function locationsOf(kind: Kind, item: Record_, archivedBeans: ReadonlySet<string>): string[] {
  const ids = (entries: unknown) => (entries as { location: LocationView }[]).map((here) => here.location.id);
  switch (kind) {
    case "bean":
      return (item.offeredAt as LocationView[]).map((location) => location.id);
    case "beanBatch":
      return item.archived || archivedBeans.has((item.bean as { id: string }).id) ? [] : ids(item.locations);
    case "profile":
    case "basket":
    case "tool":
      return ids(item.shownAt);
    case "grinder":
    case "recipe":
      return item.location ? [(item.location as LocationView).id] : [];
  }
}

/** What find_library_items reads an item of the kind's name from, ignoring case, from the REST API's view of it. */
function nameOf(kind: Kind, item: Record_): string {
  const bean = (item.bean ?? {}) as Record_;
  const parts = { bean: [item.roaster, item.name], beanBatch: [bean.roaster, bean.name], profile: [item.title], grinder: [item.model], basket: [item.name], tool: [item.name], recipe: [item.name] }[kind];
  return parts.filter((part) => typeof part === "string").join(" ").toLowerCase();
}

describe("the Library through an assistant", { timeout: 120_000 }, () => {
  let server: TestServer;
  let api: AdminApi;
  let app: TestApp;
  let assistant: Assistant;
  let uptown: LocationView;
  let harbor: LocationView;
  let bar: CreatedMachine;
  let tablet: SimulatedTablet;
  /** Harbor's Library, made through the REST API. */
  let made: { bean: string; batch: string; grinder: string; basket: string; tool: string; espresso: string; retired: string };
  /** The tablet's Bean and Grinder whose edits made offline lost, each kept as a Conflict. */
  let conflicted: { bean: string; grinder: string };
  /** A Staff member at Harbor and a Viewer, each with an assistant connected as them, and their REST API. */
  let sam: Person;
  let vic: Person;
  const tablets = new LoadedTablets();

  interface Person {
    assistant: Assistant;
    api: AdminApi;
  }

  runAsSteps();

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
    app = await serveTestApp();
    assistant = await Assistant.connect(server.url, app, await signIn(server.url, admin), { allowed: ["read"] });
    uptown = await api.createLocation("Uptown", "America/Chicago");
    harbor = await api.createLocation("Harbor", "Asia/Tokyo");
  });
  afterAll(async () => {
    await assistant?.close();
    await sam?.assistant.close();
    await vic?.assistant.close();
    await tablets.unloadAll();
    await app?.close();
    await server?.stop();
  });

  /** A Staff member or Viewer with an assistant connected as them, and their REST API. */
  async function person(email: string, role: "staff" | "viewer", locations: LocationView[] = []): Promise<Person> {
    const { link } = await api.invite(email, role, locations.map((location) => location.id));
    const cookie = await acceptInvite(server.url, link, { name: email, password: "a password for apps" });
    return { assistant: await Assistant.connect(server.url, app, cookie, { allowed: ["read"] }), api: AdminApi.signedInAs(server.url, cookie) };
  }

  /** The REST API's list of the kind, as the account reads it: each Location's Recipes for Recipes, the Locations by name. */
  async function restList(kind: Kind, as = api): Promise<Record_[]> {
    if (kind !== "recipe") return (await as.get<Record<string, Record_[]>>(KINDS[kind].path))[KINDS[kind].list]!;
    const { locations } = await as.get<{ locations: LocationView[] }>("/locations");
    return (await Promise.all(locations.map(async (location) => (await as.get<{ recipes: Record_[] }>(`/locations/${location.id}/recipes`)).recipes))).flat();
  }

  /** One item as the REST API returns it, or its history or open Conflicts. */
  async function restItem(kind: Kind, id: string, part: "" | "/history" | "/conflicts" = "", as = api): Promise<Record_> {
    return as.get<Record_>(`${KINDS[kind].path}/${encodeURIComponent(id)}${part}`);
  }

  async function find(kind: Kind, input: Record_ = {}, by = assistant): Promise<Page & { items: Record_[] }> {
    const found = await by.call<Page & Record<string, Record_[]>>("find_library_items", { kind, limit: 50, ...input });
    const { total, offset, more, ...lists } = found;
    expect(Object.keys(lists), kind).toEqual([KINDS[kind].found]);
    return { total, offset, more, items: lists[KINDS[kind].found]! };
  }

  /** A tool's error, which a call must answer with. */
  async function toolError(name: string, args: Record_): Promise<string> {
    const result = await assistant.client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).toBe(true);
    return (result.content as { type: string; text: string }[]).map((block) => block.text).join("\n");
  }

  const held = (records: Record_[], id: string) => records.find((record) => globalIdOf(record) === id);

  it("has Uptown's Library from its tablet's DYE2, Harbor's made through the REST API, and two Conflicts from Uptown's tablet's edits made offline", async () => {
    bar = await api.createMachine("Uptown bar", uptown.id);
    tablet = tablets.syncing(bar, server, { api: recordedDye2MainTablet("40901", "Uptown"), dye2: new SimulatedDye2() });
    await api.waitForOnline(bar);
    await quiesced(api, { tablets: { tablet }, machines: { machine: bar } });

    // Harbor's, made by the Admin, with a Recipe in slot 1 using them and one of Uptown's tablet's Profiles, shown at Harbor too.
    /** Creates an item, and resolves with its id. */
    const send = async (path: string, body: Record_) => Object.values(await api.send<Record<string, { id: string }>>("POST", path, body, 201))[0]!.id;
    const bean = await send("/beans", { content: { roaster: "Roux", name: "Harbor Kenya" } });
    const batch = await send("/bean-batches", { beanId: bean, content: { roastDate: "2026-10-20" }, locations: [{ locationId: harbor.id, remainingWeight: 900 }] });
    const grinder = await send("/grinders", { locationId: harbor.id, content: { model: "Harbor EK43" } });
    const basket = await send("/baskets", { locationId: harbor.id, content: { name: "Harbor 15g" } });
    const tool = await send("/tools", { locationId: harbor.id, content: { name: "Harbor WDT", custom: [{ key: "Needles", value: "8" }] } });
    const retired = await send("/baskets", { locationId: harbor.id, content: { name: "Harbor retired 22g" } });
    await api.send("PUT", `/baskets/${retired}/archived`, { archived: true });
    const { profiles } = await api.get<{ profiles: { id: string; title: string }[] }>("/profiles");
    const adaptive = profiles.find((profile) => profile.title === "Adaptive v3")!.id;
    await api.send("PUT", `/profiles/${encodeURIComponent(adaptive)}/locations/${harbor.id}`, { shown: true });
    const espresso = await send("/recipes", {
      locationId: harbor.id,
      slot: 1,
      content: { name: "Harbor Espresso", beanBatchId: batch, profileId: adaptive, dose: 18, yield: 40, grinderId: grinder, grindSetting: 2.5, basketId: basket, toolIds: [tool] },
    });
    await send("/recipes", { locationId: harbor.id, slot: null, content: { name: "Harbor Decaf", dose: 17 } });
    made = { bean, batch, grinder, basket, tool, espresso, retired };
    // A batch at Harbor whose Bean is Archived, and one Archived itself: each still at Harbor, but offered nowhere.
    const retiredBean = await send("/beans", { content: { roaster: "Roux", name: "Harbor Sumatra" } });
    await send("/bean-batches", { beanId: retiredBean, content: { roastDate: "2026-09-01" }, locations: [{ locationId: harbor.id }] });
    await api.send("PUT", `/beans/${retiredBean}/archived`, { archived: true });
    const sidamo = await send("/beans", { content: { roaster: "Roux", name: "Harbor Sidamo" } });
    const retiredBatch = await send("/bean-batches", { beanId: sidamo, content: { roastDate: "2026-09-02" }, locations: [{ locationId: harbor.id }] });
    await api.send("PUT", `/bean-batches/${retiredBatch}/archived`, { archived: true });

    // Its dose changed by the Admin, then its yield by Harbor's Staff member.
    sam = await person("sam-409@example.com", "staff", [harbor]);
    vic = await person("vic-409@example.com", "viewer");
    await api.send("PATCH", `/recipes/${espresso}`, { content: { dose: 18.5 } });
    await sam.api.send("PATCH", `/recipes/${espresso}`, { content: { yield: 42 } });

    // Uptown's tablet, offline, edits a Bean's notes and a Grinder's burrs; the Admin edits both after, which win.
    const beans = await restList("bean");
    const grinders = await restList("grinder");
    conflicted = {
      bean: beans.find((found) => found.name === "Uptown Fixture Brazil")!.id as string,
      grinder: grinders.find((found) => found.model === "Fixture Grinder 83")!.id as string,
    };
    tablet.loseNetwork();
    await tablet.editBean(held(tablet.beans(), conflicted.bean)!.id, { notes: "Offline notes" });
    await tablet.editGrinder(held(tablet.grinders(), conflicted.grinder)!.id, { burrs: "Offline burrs" });
    // Well after them, whatever the drift between the tablet's clock and PostgreSQL's.
    await delay(1_000);
    await api.send("PATCH", `/beans/${conflicted.bean}`, { content: { notes: "Management notes" } });
    await api.send("PATCH", `/grinders/${conflicted.grinder}`, { content: { burrs: "Management burrs" } });
    tablet.restoreNetwork();
    await expect.poll(async () => (await api.get<{ conflicts: Record_[] }>("/conflicts")).conflicts.length, { timeout: 15_000 }).toBe(2);
    // Nothing left under way, so what the REST API and the assistant read next stays as it is.
    await quiesced(api, { tablets: { tablet }, machines: { machine: bar } });
  });

  it("finds every kind's items as the REST API lists them, from the tablet and the REST API, each time with the offset of the Location it happened at", async () => {
    for (const kind of EVERY_KIND) {
      const rest = await restList(kind);
      const found = await find(kind);
      expect(rest.length, kind).toBeGreaterThan(0);
      expect(comparable(found.items), kind).toEqual(comparable(rest));
      expect(found, kind).toMatchObject({ total: rest.length, offset: 0, more: false });
    }

    const byName = async (kind: Kind, name: string, field = "name") => (await find(kind)).items.find((item) => item[field] === name)!;
    // A Bean joined the Library at Uptown, from its tablet, and one created through the REST API at none, so in UTC.
    expect(await byName("bean", "Uptown Fixture Brazil")).toMatchObject({ createdLocation: { id: uptown.id }, createdAt: expect.stringMatching(UPTOWN_TIME) });
    expect(await byName("bean", "Harbor Kenya")).toMatchObject({ createdLocation: null, createdAt: expect.stringMatching(UTC_TIME), offeredAt: [{ id: harbor.id, name: "Harbor" }] });
    // A batch added at Harbor, since then on Harbor's clock.
    const batch = (await find("beanBatch")).items.find((item) => item.id === made.batch)!;
    expect(batch).toMatchObject({ locations: [{ location: { id: harbor.id }, remainingWeight: 900, since: expect.stringMatching(HARBOR_TIME) }] });
    // A Profile shown at both, each since on that Location's clock.
    const shown = (await byName("profile", "Adaptive v3", "title")).shownAt as { location: LocationView; since: string }[];
    expect(shown.map((here) => [here.location.name, here.since])).toEqual([
      ["Harbor", expect.stringMatching(HARBOR_TIME)],
      ["Uptown", expect.stringMatching(UPTOWN_TIME)],
    ]);
    // Grinders and Recipes, each on the clock of the Location it belongs to.
    expect(await byName("grinder", "Harbor EK43", "model")).toMatchObject({ location: { id: harbor.id }, createdAt: expect.stringMatching(HARBOR_TIME) });
    expect(await byName("grinder", "Fixture Grinder 83", "model")).toMatchObject({ location: { id: uptown.id }, createdAt: expect.stringMatching(UPTOWN_TIME) });
    const recipes = (await find("recipe")).items;
    for (const recipe of recipes) expect(recipe.createdAt).toMatch((recipe.location as LocationView).id === harbor.id ? HARBOR_TIME : UPTOWN_TIME);
    // By Location, Harbor before Uptown, each's in Recipe Slot order, then those in no slot.
    expect(recipes.filter((recipe) => (recipe.location as LocationView).id === harbor.id).map((recipe) => [recipe.slot, recipe.name])).toEqual([
      [1, "Harbor Espresso"],
      [null, "Harbor Decaf"],
    ]);
    expect(recipes.findIndex((recipe) => (recipe.location as LocationView).id === uptown.id)).toBe(2);
    expect(await byName("recipe", "Harbor Espresso")).toMatchObject({
      uses: { beanBatch: { id: made.batch, atLocation: true }, profile: { title: "Adaptive v3" }, grinder: { id: made.grinder, model: "Harbor EK43" }, tools: [{ id: made.tool, name: "Harbor WDT" }] },
      content: { dose: 18.5, yield: 42 },
    });
  });

  it("finds items by Location, by the words of their names, ignoring case, and by whether Archived, as the REST API's lists hold them", async () => {
    const archivedBeans = new Set((await restList("bean")).flatMap((bean) => (bean.archived ? [bean.id as string] : [])));
    expect(archivedBeans.size).toBe(1);
    for (const kind of EVERY_KIND) {
      const rest = await restList(kind);
      const locationsOf_ = (item: Record_) => locationsOf(kind, item, archivedBeans);
      for (const [filter, keeps] of [
        [{ locationId: harbor.id }, (item: Record_) => locationsOf_(item).includes(harbor.id)],
        [{ locationId: uptown.id.toUpperCase() }, (item: Record_) => locationsOf_(item).includes(uptown.id)],
        [{ archived: true }, (item: Record_) => item.archived === true],
        [{ archived: false, locationId: harbor.id }, (item: Record_) => item.archived === false && locationsOf_(item).includes(harbor.id)],
        [{ archived: true, locationId: harbor.id }, (item: Record_) => item.archived === true && locationsOf_(item).includes(harbor.id)],
        [{ name: " FIXTURE " }, (item: Record_) => nameOf(kind, item).includes("fixture")],
        [{ name: "harbor 15G" }, (item: Record_) => nameOf(kind, item).includes("harbor") && nameOf(kind, item).includes("15g")],
      ] as const) {
        const found = await find(kind, filter);
        expect(comparable(found.items), `${kind} ${JSON.stringify(filter)}`).toEqual(comparable(rest.filter(keeps)));
        expect(found.total).toBe(found.items.length);
      }
    }

    const names = async (kind: Kind, filter: Record_, field = "name") => (await find(kind, filter)).items.map((item) => item[field]);
    // Each word anywhere in what names it: a Bean's roaster and name, and a batch's Bean's.
    expect(await names("bean", { name: "roux kenya" })).toEqual(["Harbor Kenya"]);
    expect(await names("beanBatch", { name: "Kenya Roux" }, "id")).toEqual([made.batch]);
    expect(await names("beanBatch", { name: "Fixture Roasters Ethiopia" }, "roastDate")).toEqual(["2026-10-01T00:00:00.000"]);
    expect(await names("grinder", { name: "grinder 83" }, "model")).toEqual(["Fixture Grinder 83"]);
    expect(await names("recipe", { name: "espresso", locationId: harbor.id })).toEqual(["Harbor Espresso"]);
    // An Archived Basket is shown nowhere, but found as Archived.
    expect(await names("basket", { locationId: harbor.id })).toEqual(["Harbor 15g"]);
    expect(await names("basket", { archived: true })).toEqual(["Harbor retired 22g"]);
    expect(await names("tool", { locationId: harbor.id, name: "wdt" })).toEqual(["Harbor WDT"]);
    expect(await names("tool", { locationId: uptown.id })).toEqual([]);
    // Harbor offers one batch: neither the one Archived nor the one whose Bean is, though both are listed at Harbor.
    expect(await names("beanBatch", { locationId: harbor.id }, "id")).toEqual([made.batch]);
    expect(await names("beanBatch", { locationId: harbor.id, archived: true }, "id")).toEqual([]);
    const atHarbor = (await find("beanBatch", { name: "harbor" })).items;
    expect(atHarbor.map((batch) => [(batch.bean as Record_).name, batch.archived, (batch.locations as { location: LocationView }[]).map((here) => here.location.name)])).toEqual([
      ["Harbor Kenya", false, ["Harbor"]],
      ["Harbor Sidamo", true, ["Harbor"]],
      ["Harbor Sumatra", false, ["Harbor"]],
    ]);

    // A Location that doesn't exist is refused, as the REST API refuses a Location's Recipes, for every kind.
    const nowhere = randomUUID();
    expect((await api.call("GET", `/locations/${nowhere}/recipes`)).status).toBe(404);
    for (const kind of EVERY_KIND) {
      expect(await toolError("find_library_items", { kind, locationId: nowhere })).toBe("No such Location");
      expect(await toolError("find_library_items", { kind, locationId: "not-a-location" })).toBe("No such Location");
    }
    expect(await toolError("find_library_items", { kind: "stock" })).toContain("kind");
    expect(await toolError("find_library_items", { kind: "bean", name: "x".repeat(501) })).toContain("name");
  });

  it("pages each list as the REST API's would be, at most 50 a page, saying how many match and whether more follow", async () => {
    const rest = await restList("recipe");
    expect(rest.length).toBeGreaterThan(6);
    const pages: unknown[] = [];
    for (let offset = 0; ; offset += 3) {
      const page = await find("recipe", { limit: 3, offset });
      expect(page).toMatchObject({ total: rest.length, offset, more: offset + 3 < rest.length });
      pages.push(...page.items);
      if (!page.more) break;
    }
    expect(comparable(pages)).toEqual(comparable(rest));
    // 20 by default.
    const first = await assistant.call<Page & { recipes: unknown[] }>("find_library_items", { kind: "recipe" });
    expect(first.recipes).toHaveLength(Math.min(20, rest.length));
    expect(await find("recipe", { offset: rest.length })).toMatchObject({ items: [], total: rest.length, more: false });
    expect(await toolError("find_library_items", { kind: "recipe", limit: 51 })).toContain("limit");
    expect(await toolError("find_library_items", { kind: "recipe", limit: 0 })).toContain("limit");
  });

  it("reads one item of each kind as the REST API returns it", async () => {
    const ids: Record<Kind, string> = {
      bean: conflicted.bean,
      beanBatch: made.batch,
      profile: ((await restList("profile")).find((profile) => profile.title === "Adaptive v3")!.id as string),
      grinder: conflicted.grinder,
      basket: made.basket,
      tool: made.tool,
      recipe: made.espresso,
    };
    for (const kind of EVERY_KIND) {
      const read = await assistant.call<Record_>("get_library_item", { kind, id: ids[kind] });
      expect(Object.keys(read), kind).toEqual([kind]);
      expect(comparable(read[kind]), kind).toEqual(comparable((await restItem(kind, ids[kind]))[KINDS[kind].one]));
    }
    // A Bean with its batches, and a Recipe's id read in any case, as the REST API reads one.
    expect(((await assistant.call<{ bean: { batches: unknown[] } }>("get_library_item", { kind: "bean", id: made.bean })).bean.batches)).toEqual([
      expect.objectContaining({ id: made.batch }),
    ]);
    expect((await assistant.call<{ recipe: Record_ }>("get_library_item", { kind: "recipe", id: made.espresso.toUpperCase() })).recipe.id).toBe(made.espresso);

    // Ids malformed or naming nothing, as the REST API says of them.
    for (const kind of EVERY_KIND) {
      for (const id of ["not-an-id", kind === "profile" ? "profile:00000000000000000000" : randomUUID()]) {
        const response = await api.call("GET", `${KINDS[kind].path}/${encodeURIComponent(id)}`);
        expect(response.status, `${kind} ${id}`).toBe(404);
        expect(await toolError("get_library_item", { kind, id })).toBe(((await response.json()) as { message: string }).message);
      }
    }
    expect(await toolError("get_library_item", { kind: "profile", id: "" })).toBe("No such Profile");
  });

  it("reads a Recipe's history and Conflicts when asked for, as the REST API gives them: what changed and who changed it, on the clock of its Location", async () => {
    const read = await assistant.call<{ recipe: Record_; history: Paged<Record_>; conflicts: Paged<Record_> }>("get_library_item", {
      kind: "recipe",
      id: made.espresso,
      history: true,
      conflicts: true,
    });
    const { versions } = (await restItem("recipe", made.espresso, "/history")) as { versions: Record_[] };
    expect(comparable(read.history.entries)).toEqual(comparable(versions));
    expect(read.history).toMatchObject({ total: 4, offset: 0, more: false });
    expect(read.conflicts).toEqual({ entries: [], total: 0, offset: 0, more: false });
    const adminId = (await api.get<{ account: { id: string } }>("/session")).account.id;
    const samId = (await sam.api.get<{ account: { id: string } }>("/session")).account.id;
    // The latest first: the yield changed by Harbor's Staff member, the dose by the Admin, and the Recipe made in slot 1, each named to an Admin.
    const byAdmin = { machine: null, tabletId: null, account: { id: adminId, name: "Ada Admin" }, connectedApp: null };
    expect(read.history.entries.map(({ fields, source, editedAt }) => ({ fields, source, editedAt }))).toEqual([
      { fields: { yield: 42 }, source: { machine: null, tabletId: null, account: { id: samId, name: "sam-409@example.com" }, connectedApp: null }, editedAt: expect.stringMatching(HARBOR_TIME) },
      { fields: { dose: 18.5 }, source: byAdmin, editedAt: expect.stringMatching(HARBOR_TIME) },
      { fields: { slot: 1 }, source: byAdmin, editedAt: expect.stringMatching(HARBOR_TIME) },
      { fields: expect.objectContaining({ name: "Harbor Espresso", dose: 18 }), source: byAdmin, editedAt: expect.stringMatching(HARBOR_TIME) },
    ]);
    // Paged, without asking for its Conflicts.
    const second = await assistant.call<Record_ & { history: Paged<Record_> }>("get_library_item", { kind: "recipe", id: made.espresso, history: true, limit: 1, offset: 1 });
    expect(second).not.toHaveProperty("conflicts");
    expect(comparable(second.history.entries)).toEqual(comparable(versions.slice(1, 2)));
    expect(second.history).toMatchObject({ total: 4, offset: 1, more: true });
    // Neither unless asked for.
    expect(Object.keys(await assistant.call<Record_>("get_library_item", { kind: "recipe", id: made.espresso }))).toEqual(["recipe"]);
  });

  it("reads a Bean Batch's and a Profile's history as the REST API gives it, each edit of a Location's state on that Location's clock and of their content in UTC", async () => {
    const adaptive = (await restList("profile")).find((profile) => profile.title === "Adaptive v3")!.id as string;
    for (const [kind, id] of [["beanBatch", made.batch], ["profile", adaptive]] as const) {
      const { history } = await assistant.call<{ history: Paged<Record_> }>("get_library_item", { kind, id, history: true });
      const { versions } = (await restItem(kind, id, "/history")) as { versions: Record_[] };
      expect(comparable(history.entries), kind).toEqual(comparable(versions));
      const where = history.entries.map((entry) => (entry.location as LocationView | null)?.name ?? null);
      // Its joining the Library, and its batch added at Harbor with its weight there, or the Profile shown there.
      expect(where, kind).toEqual(expect.arrayContaining([null, "Harbor"]));
      history.entries.forEach((entry, at) => {
        const clock = { Harbor: HARBOR_TIME, Uptown: UPTOWN_TIME }[where[at] ?? ""] ?? UTC_TIME;
        expect([entry.editedAt, entry.receivedAt], `${kind} at ${where[at]}`).toEqual([expect.stringMatching(clock), expect.stringMatching(clock)]);
      });
    }
  });

  it("lists the open Conflicts, and an item's, as the REST API gives them, each on the clock of the Location its item belongs to, or in UTC", async () => {
    const { conflicts } = await api.get<{ conflicts: Record_[] }>("/conflicts");
    const listed = await assistant.call<{ conflicts: Record_[] } & Page>("list_conflicts");
    expect(comparable(listed.conflicts)).toEqual(comparable(conflicts));
    expect(listed).toMatchObject({ total: 2, offset: 0, more: false });
    // A Grinder's, Uptown's, and a Bean's, which belongs to no Location.
    const about = (id: string) => listed.conflicts.find((conflict) => (conflict.item as Record_).id === id)!;
    const onClock = (time: RegExp) => ({ editedAt: expect.stringMatching(time), createdAt: expect.stringMatching(time) });
    expect(about(conflicted.grinder)).toMatchObject({
      item: { kind: "grinder", name: "Fixture Grinder 83" },
      field: "burrs",
      value: "Offline burrs",
      location: null,
      source: { machine: { id: bar.machine.id, name: "Uptown bar" }, tabletId: expect.any(String), account: null },
      current: { value: "Management burrs", source: { machine: null, account: { name: "Ada Admin" } }, editedAt: expect.stringMatching(UPTOWN_TIME) },
      resolvable: true,
      ...onClock(UPTOWN_TIME),
    });
    expect(about(conflicted.bean)).toMatchObject({
      item: { kind: "bean", name: "Fixture Roasters Uptown Fixture Brazil" },
      field: "notes",
      value: "Offline notes",
      current: { value: "Management notes", editedAt: expect.stringMatching(UTC_TIME) },
      ...onClock(UTC_TIME),
    });

    const page = await assistant.call<{ conflicts: Record_[] } & Page>("list_conflicts", { limit: 1, offset: 1 });
    expect(comparable(page.conflicts)).toEqual(comparable(conflicts.slice(1)));
    expect(page).toMatchObject({ total: 2, offset: 1, more: false });

    for (const [kind, id] of [["bean", conflicted.bean], ["grinder", conflicted.grinder]] as const) {
      const read = await assistant.call<{ conflicts: Paged<Record_> }>("get_library_item", { kind, id, conflicts: true });
      expect(read.conflicts.entries).toEqual([about(id)]);
      expect(comparable(read.conflicts.entries)).toEqual(comparable((await restItem(kind, id, "/conflicts")).conflicts));
    }
  });

  it("gives Staff and Viewers what the REST API gives them: other accounts unnamed, and only the Conflicts they may resolve marked so", async () => {
    for (const [who, { assistant: theirs, api: rest }, resolves] of [
      // Harbor's Staff member resolves the Bean's anywhere, but not Uptown's Grinder's; a Viewer neither.
      ["Staff", sam, { bean: true, grinder: false }],
      ["Viewer", vic, { bean: false, grinder: false }],
    ] as const) {
      const { conflicts } = await rest.get<{ conflicts: Record_[] }>("/conflicts");
      const listed = await theirs.call<{ conflicts: Record_[] }>("list_conflicts");
      expect(comparable(listed.conflicts), who).toEqual(comparable(conflicts));
      expect(Object.fromEntries(listed.conflicts.map((conflict) => [(conflict.item as Record_).kind, conflict.resolvable])), who).toEqual(resolves);
      expect(listed.conflicts.map((conflict) => (conflict.current as { source: { account: Record_ } }).source.account.name), who).toEqual([null, null]);

      const read = await theirs.call<{ recipe: Record_; history: Paged<{ source: { account: Record_ | null } }> }>("get_library_item", {
        kind: "recipe",
        id: made.espresso,
        history: true,
      });
      expect(comparable(read.history.entries), who).toEqual(comparable(((await restItem("recipe", made.espresso, "/history", rest)) as { versions: unknown[] }).versions));
      expect(read.history.entries.slice(0, 2).map((version) => version.source.account?.name), who).toEqual([null, null]);
      for (const kind of EVERY_KIND) expect(comparable((await find(kind, {}, theirs)).items), `${who} ${kind}`).toEqual(comparable(await restList(kind, rest)));
    }
  });
});
