import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { GLOBAL_ID_KEY, globalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, type TestApp, serveTestApp } from "./support/assistants.js";
import { LoadedTablets, emptyLibrary } from "./support/loaded-tablets.js";
import { quiesced } from "./support/quiet.js";
import { dye2List } from "./support/simulated-dye2.js";
import { type SimulatedTablet, derivedProfile } from "./support/simulated-tablet.js";
import { runAsSteps } from "./support/steps.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for #411 (#405, ADR-0026): Beans and Bean Batches created and edited
// through an assistant, items Archived and restored, and what a Location
// offers changed, by a test app on the MCP SDK's client connected as a
// Connected App, against the built server. Each change shows in the REST API
// as the account's, through that Connected App, and reaches a simulated
// tablet at Uptown, connected to the other of two instances, as a change in
// the management interface does; what the REST API refuses is refused with
// its message, and a Connected App that may only read, or a Viewer's, is
// refused with 403 insufficient_scope. Serials are made up, from 41190.

type Record_ = Record<string, unknown>;

const env = { ...ASSISTANT_ENV, SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** An ISO 8601 time with its offset. */
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;

/** A result, a tool's or the REST API's, as the two are compared: each time as its instant, as the tools give them with a Location's offset. */
function comparable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (_, field: unknown) => (typeof field === "string" && ISO_TIME.test(field) ? Date.parse(field) : field));
}

/** Each kind's REST API: its route and the key of one item. */
const KINDS = {
  bean: { path: "/beans", one: "bean" },
  beanBatch: { path: "/bean-batches", one: "batch" },
  profile: { path: "/profiles", one: "profile" },
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
  fields: Record_;
  location: LocationView | null;
  source: Source;
}

describe("Changing the Library through an assistant", { timeout: 120_000 }, () => {
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
  /** What the assistant made: a Bean with a batch at Uptown. */
  let made: { bean: string; batch: string };
  /** Items made through the REST API at Uptown. */
  let uptownItems: { profile: string; grinder: string; basket: string; tool: string; recipe: string };
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
  async function versions(kind: Kind, id: string, as = api): Promise<Version[]> {
    return (await as.get<{ versions: Version[] }>(`${KINDS[kind].path}/${encodeURIComponent(id)}/history`)).versions;
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
  const inList = (key: "baskets" | "equipment", id: string) => {
    const list = dye2List(tablet, key);
    return Array.isArray(list) ? (list as Record_[]).find((record) => record[GLOBAL_ID_KEY] === id) : undefined;
  };

  it("has Uptown's tablet online through the other instance, with a Profile it saved, and a Grinder, Basket, Tool and Recipe made through the REST API", async () => {
    machine = await api.createMachine("Uptown bar", uptown.id);
    tablet = tablets.syncing(machine, other, { api: emptyLibrary("41190") });
    await api.waitForOnline(machine);
    const profile = String((await tablet.addProfile(derivedProfile("Uptown Bloom", 8.25))).id);
    await expect.poll(async () => (await api.call("GET", `/profiles/${encodeURIComponent(profile)}`)).status).toBe(200);
    const send = async (path: string, body: Record_) => Object.values(await api.send<Record<string, { id: string }>>("POST", path, body, 201))[0]!.id;
    uptownItems = {
      profile,
      grinder: await send("/grinders", { locationId: uptown.id, content: { model: "Uptown EK43" } }),
      basket: await send("/baskets", { locationId: uptown.id, content: { name: "Uptown 18g" } }),
      tool: await send("/tools", { locationId: uptown.id, content: { name: "Uptown WDT" } }),
      recipe: await send("/recipes", { locationId: uptown.id, slot: 1, content: { name: "Uptown Espresso", dose: 18 } }),
    };
    await expect.poll(() => inList("baskets", uptownItems.basket)).toMatchObject({ name: "Uptown 18g" });
    await expect.poll(() => inList("equipment", uptownItems.tool)).toMatchObject({ name: "Uptown WDT" });
  });

  it("creates a Bean and a batch of it at Uptown, and edits each, every change in the REST API as the Admin's through the Connected App, and on Uptown's tablet", async () => {
    const created = await assistant.call<{ bean: Record_ }>("create_bean", { roaster: "Roux", name: "Assistant Kenya", country: "Kenya", altitude: [1700, 1900] });
    const bean = created.bean.id as string;
    expect(comparable(created.bean)).toEqual(comparable(await restItem("bean", bean)));
    expect(created.bean).toMatchObject({ roaster: "Roux", name: "Assistant Kenya", content: { roaster: "Roux", name: "Assistant Kenya", country: "Kenya", altitude: [1700, 1900], decaf: false } });

    const batched = await assistant.call<{ beanBatch: Record_ }>("create_bean_batch", {
      beanId: bean,
      roastDate: "2026-11-01",
      weight: 1000,
      locations: [{ locationId: uptown.id, remainingWeight: 900 }],
    });
    const batch = batched.beanBatch.id as string;
    made = { bean, batch };
    expect(comparable(batched.beanBatch)).toEqual(comparable(await restItem("beanBatch", batch)));
    expect(batched.beanBatch).toMatchObject({ content: { roastDate: "2026-11-01T00:00:00.000", weight: 1000 }, locations: [{ location: { id: uptown.id }, remainingWeight: 900 }] });
    await expect.poll(() => held(tablet.beans(), bean)).toMatchObject({ roaster: "Roux", name: "Assistant Kenya", country: "Kenya", archived: false });
    await expect.poll(() => held(tablet.batches(), batch)).toMatchObject({ roastDate: "2026-11-01T00:00:00.000", weight: 1000, weightRemaining: 900, archived: false });

    // Only the fields given, null clearing one.
    const edited = await assistant.call<{ bean: { content: Record_ } }>("edit_bean", { id: bean, notes: "Blackcurrant", country: null });
    expect(edited.bean.content).toMatchObject({ notes: "Blackcurrant", altitude: [1700, 1900] });
    expect(edited.bean.content).not.toHaveProperty("country");
    await expect.poll(() => held(tablet.beans(), bean)?.notes).toBe("Blackcurrant");
    expect(held(tablet.beans(), bean)?.country ?? null).toBeNull();
    const batchEdited = await assistant.call<{ beanBatch: { content: Record_ } }>("edit_bean_batch", { id: batch.toUpperCase(), roastLevel: "Light", openDate: "2026-11-03" });
    expect(batchEdited.beanBatch.content).toMatchObject({ roastLevel: "Light", openDate: "2026-11-03T00:00:00.000", weight: 1000 });
    await expect.poll(() => held(tablet.batches(), batch)).toMatchObject({ roastLevel: "Light", openDate: "2026-11-03T00:00:00.000" });

    // Each version, the batch's at Uptown included, the Admin's through the Connected App: one id, the app's name and host.
    const adminId = (await api.get<{ account: { id: string } }>("/session")).account.id;
    const beanVersions = await versions("bean", bean);
    throughApp = beanVersions[0]!.source;
    expect(throughApp).toEqual({
      machine: null,
      tabletId: null,
      account: { id: adminId, name: "Ada Admin" },
      connectedApp: { id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: "Test Assistant", host: new URL(app.clientId).host },
    });
    const batchVersions = await versions("beanBatch", batch);
    expect(beanVersions.map((version) => version.fields)).toEqual([{ notes: "Blackcurrant", country: null }, expect.objectContaining({ name: "Assistant Kenya" })]);
    expect(batchVersions.map((version) => [version.location?.name ?? null, version.fields])).toEqual([
      [null, { roastLevel: "Light", openDate: "2026-11-03T00:00:00.000" }],
      ["Uptown", { remainingWeight: 900 }],
      ["Uptown", { atLocation: true }],
      [null, expect.objectContaining({ roastDate: "2026-11-01T00:00:00.000" })],
    ]);
    for (const version of [...beanVersions, ...batchVersions]) expect(version.source).toEqual(throughApp);

    // The assistant reads its history as the REST API gives it.
    const { history } = await assistant.call<{ history: { entries: unknown[] } }>("get_library_item", { kind: "beanBatch", id: batch, history: true });
    expect(comparable(history.entries)).toEqual(comparable(batchVersions));
  });

  it("Archives and restores an item of each kind, as the REST API does, each recorded as through the Connected App, and Uptown's tablet follows", async () => {
    const ids: Record<Kind, string> = { bean: made.bean, beanBatch: made.batch, ...uptownItems };
    for (const kind of Object.keys(KINDS) as Kind[]) {
      for (const archived of [true, false]) {
        const result = await assistant.call<Record<string, Record_>>("set_archived", { kind, id: ids[kind], archived });
        expect(Object.keys(result), kind).toEqual([kind]);
        expect(result[kind]!.archived, kind).toBe(archived);
        expect(comparable(result[kind]), kind).toEqual(comparable(await restItem(kind, ids[kind])));
        const [latest] = await versions(kind, ids[kind]);
        expect(latest, `${kind} ${archived}`).toMatchObject({ fields: { archived }, source: throughApp });
        if (kind === "bean" && archived) {
          // An Archived Bean takes its batches with it.
          await expect.poll(() => held(tablet.beans(), made.bean)?.archived).toBe(true);
          await expect.poll(() => held(tablet.batches(), made.batch)?.archived).toBe(true);
        }
        if (kind === "basket") await expect.poll(() => inList("baskets", ids.basket) === undefined, { message: kind }).toBe(archived);
      }
    }
    await expect.poll(() => held(tablet.batches(), made.batch)?.archived).toBe(false);
    await expect.poll(() => held(tablet.beans(), made.bean)?.archived).toBe(false);
    // Archiving what is Archived already changes nothing more.
    await assistant.call("set_archived", { kind: "tool", id: uptownItems.tool, archived: true });
    const before = (await versions("tool", uptownItems.tool)).length;
    await assistant.call("set_archived", { kind: "tool", id: uptownItems.tool, archived: true });
    expect(await versions("tool", uptownItems.tool)).toHaveLength(before);
    await assistant.call("set_archived", { kind: "tool", id: uptownItems.tool, archived: false });
  });

  it("hides and shows a Profile, Basket and Tool at Uptown, and finishes a batch there, adds it again with its remaining weight, and sets that alone", async () => {
    const shownAt = async (kind: Kind, id: string) => ((await restItem(kind, id)).shownAt as { location: LocationView }[]).map((here) => here.location.name);
    const visibility = () => tablet.profiles().find((record) => record.id === uptownItems.profile)?.visibility;
    for (const offered of [false, true]) {
      const profile = await assistant.call<{ profile: Record_ }>("set_location_offering", { kind: "profile", id: uptownItems.profile, locationId: uptown.id, offered });
      expect(comparable(profile.profile)).toEqual(comparable(await restItem("profile", uptownItems.profile)));
      expect(await shownAt("profile", uptownItems.profile)).toEqual(offered ? ["Uptown"] : []);
      await expect.poll(visibility).toBe(offered ? "visible" : "hidden");
      // DYE2 can't hide a Basket or Tool: hidden at Uptown, each leaves its tablet's list.
      for (const [kind, key] of [["basket", "baskets"], ["tool", "equipment"]] as const) {
        const result = await assistant.call<Record<string, Record_>>("set_location_offering", { kind, id: uptownItems[kind], locationId: uptown.id.toUpperCase(), offered });
        expect(comparable(result[kind]), kind).toEqual(comparable(await restItem(kind, uptownItems[kind])));
        expect(await shownAt(kind, uptownItems[kind]), kind).toEqual(offered ? ["Uptown"] : []);
        await expect.poll(() => inList(key, uptownItems[kind]) !== undefined, { message: kind }).toBe(offered);
      }
    }
    const [shown] = await versions("profile", uptownItems.profile);
    expect(shown).toMatchObject({ fields: { shown: true }, location: { id: uptown.id }, source: throughApp });

    const placed = (input: Record_) => assistant.call<{ beanBatch: Record_ }>("set_location_offering", { kind: "beanBatch", id: made.batch, locationId: uptown.id, ...input });
    const finished = await placed({ offered: false });
    expect(finished.beanBatch).toMatchObject({ locations: [], finished: [{ location: { id: uptown.id }, remainingWeight: 900 }] });
    await expect.poll(() => held(tablet.batches(), made.batch)?.archived).toBe(true);
    const again = await placed({ offered: true, remainingWeight: 500 });
    expect(comparable(again.beanBatch)).toEqual(comparable(await restItem("beanBatch", made.batch)));
    expect(again.beanBatch).toMatchObject({ locations: [{ location: { id: uptown.id }, remainingWeight: 500 }] });
    await expect.poll(() => held(tablet.batches(), made.batch)).toMatchObject({ archived: false, weightRemaining: 500 });
    await placed({ remainingWeight: 450 });
    await expect.poll(() => held(tablet.batches(), made.batch)?.weightRemaining).toBe(450);
    expect((await versions("beanBatch", made.batch)).slice(0, 4).map((version) => [version.fields, version.source])).toEqual([
      [{ remainingWeight: 450 }, throughApp],
      [{ remainingWeight: 500 }, throughApp],
      [{ atLocation: true }, throughApp],
      [{ atLocation: false }, throughApp],
    ]);
  });

  it("refuses what the REST API refuses, with its message, and input its schemas refuse", async () => {
    // A Bean of the same roaster and name, an Archived Bean's batch, a remaining weight where the batch isn't, and items that don't exist.
    expect(await toolError(assistant, "create_bean", { roaster: "Roux", name: "Assistant Kenya" })).toBe(
      await restRefusal(api, "POST", "/beans", { content: { roaster: "Roux", name: "assistant kenya" } }, 409),
    );
    const archived = (await api.send<{ bean: { id: string } }>("POST", "/beans", { content: { roaster: "Roux", name: "Retired Sumatra" } }, 201)).bean.id;
    await api.send("PUT", `/beans/${archived}/archived`, { archived: true });
    expect(await toolError(assistant, "create_bean_batch", { beanId: archived, locations: [] })).toBe(
      await restRefusal(api, "POST", "/bean-batches", { beanId: archived, locations: [] }, 409),
    );
    expect(await toolError(assistant, "set_location_offering", { kind: "beanBatch", id: made.batch, locationId: harbor.id, remainingWeight: 10 })).toBe(
      await restRefusal(api, "PUT", `/bean-batches/${made.batch}/locations/${harbor.id}`, { remainingWeight: 10 }, 409),
    );
    const nowhere = randomUUID();
    expect(await toolError(assistant, "edit_bean", { id: nowhere, notes: "x" })).toBe(await restRefusal(api, "PATCH", `/beans/${nowhere}`, { content: { notes: "x" } }, 404));
    expect(await toolError(assistant, "set_archived", { kind: "recipe", id: "not-an-id", archived: true })).toBe(
      await restRefusal(api, "PUT", "/recipes/not-an-id/archived", { archived: true }, 404),
    );
    expect(await toolError(assistant, "set_location_offering", { kind: "basket", id: uptownItems.basket, locationId: nowhere, offered: true })).toBe(
      await restRefusal(api, "PUT", `/baskets/${uptownItems.basket}/locations/${nowhere}`, { shown: true }, 404),
    );
    expect(await toolError(assistant, "create_bean_batch", { beanId: made.bean, locations: [{ locationId: uptown.id }, { locationId: uptown.id }] })).toBe(
      await restRefusal(api, "POST", "/bean-batches", { beanId: made.bean, locations: [{ locationId: uptown.id }, { locationId: uptown.id }] }, 400),
    );
    // A value Decaid would refuse, as the REST API reads it.
    expect(await toolError(assistant, "edit_bean_batch", { id: made.batch, roastDate: "2026-02-30" })).toBe(
      await restRefusal(api, "PATCH", `/bean-batches/${made.batch}`, { content: { roastDate: "2026-02-30" } }, 400),
    );
    expect(await toolError(assistant, "create_bean", { roaster: " ", name: "Blank roaster" })).toBe(await restRefusal(api, "POST", "/beans", { content: { roaster: " ", name: "Blank roaster" } }, 400));

    // What the tools' own inputs take.
    expect(await toolError(assistant, "edit_bean", { id: made.bean })).toBe("Give at least one field to change");
    expect(await toolError(assistant, "create_bean_batch", { beanId: made.bean, roast_date: "2026-11-01" })).toContain("roast_date");
    expect(await toolError(assistant, "create_bean", { name: "No roaster" })).toContain("roaster");
    expect(await toolError(assistant, "edit_bean", { id: made.bean, roaster: null })).toContain("roaster");
    expect(await toolError(assistant, "set_location_offering", { kind: "profile", id: uptownItems.profile, locationId: uptown.id, remainingWeight: 5, offered: true })).toBe(
      "Only a Bean Batch has a remaining weight at a Location",
    );
    expect(await toolError(assistant, "set_location_offering", { kind: "tool", id: uptownItems.tool, locationId: uptown.id })).toBe("Send offered: true to show the Tool at the Location, or false to hide it there");
    expect(await toolError(assistant, "set_location_offering", { kind: "beanBatch", id: made.batch, locationId: uptown.id })).toContain("offered");
    expect(await toolError(assistant, "set_archived", { kind: "stock", id: made.bean, archived: true })).toContain("kind");
    // Nothing of these changed.
    expect((await restItem("bean", made.bean)).name).toBe("Assistant Kenya");
    expect((await api.get<{ beans: unknown[] }>("/beans")).beans).toHaveLength(2);

    // Null for none in a new item, as the REST API takes it.
    const { beanBatch } = await assistant.call<{ beanBatch: { content: Record_; locations: { location: LocationView; remainingWeight: number | null }[] } }>("create_bean_batch", {
      beanId: made.bean,
      roastDate: "2026-11-05",
      notes: null,
      locations: [{ locationId: harbor.id, remainingWeight: null }],
    });
    expect(beanBatch.content).not.toHaveProperty("notes");
    expect(beanBatch.locations).toEqual([expect.objectContaining({ location: expect.objectContaining({ id: harbor.id }), remainingWeight: null })]);
  });

  it("lets Staff change what the REST API lets them, the Library's shared content anywhere but what Locations offer only at their own, refused as it refuses them", async () => {
    const sam = await person("sam-411@example.com", "staff", [harbor]);
    // A Bean's details and Archived state anywhere.
    await sam.assistant.call("edit_bean", { id: made.bean, producer: "Gatomboya" });
    await sam.assistant.call("set_archived", { kind: "bean", id: made.bean, archived: true });
    await sam.assistant.call("set_archived", { kind: "bean", id: made.bean, archived: false });
    // What Harbor offers, but not Uptown.
    const added = await sam.assistant.call<{ beanBatch: { locations: { location: LocationView }[] } }>("set_location_offering", {
      kind: "beanBatch",
      id: made.batch,
      locationId: harbor.id,
      offered: true,
    });
    expect(added.beanBatch.locations.map((here) => here.location.name)).toEqual(["Harbor", "Uptown"]);
    for (const [name, args, method, path, body] of [
      ["create_bean_batch", { beanId: made.bean, locations: [{ locationId: uptown.id }] }, "POST", "/bean-batches", { beanId: made.bean, locations: [{ locationId: uptown.id }] }],
      ["set_location_offering", { kind: "beanBatch", id: made.batch, locationId: uptown.id, offered: false }, "PUT", `/bean-batches/${made.batch}/locations/${uptown.id}`, { atLocation: false }],
      ["set_location_offering", { kind: "basket", id: uptownItems.basket, locationId: uptown.id, offered: false }, "PUT", `/baskets/${uptownItems.basket}/locations/${uptown.id}`, { shown: false }],
      ["set_location_offering", { kind: "profile", id: uptownItems.profile, locationId: uptown.id, offered: false }, "PUT", `/profiles/${encodeURIComponent(uptownItems.profile)}/locations/${uptown.id}`, { shown: false }],
      ["set_archived", { kind: "recipe", id: uptownItems.recipe, archived: true }, "PUT", `/recipes/${uptownItems.recipe}/archived`, { archived: true }],
    ] as const) {
      expect(await toolError(sam.assistant, name, args), `${name} ${JSON.stringify(args)}`).toBe(await restRefusal(sam.api, method, path, body, 403));
    }
    expect(await restItem("recipe", uptownItems.recipe)).toMatchObject({ archived: false });

    // Each change of theirs through their own Connected App, their name shown to an Admin, not to Staff.
    const [restored, archived, producer] = (await versions("bean", made.bean)).slice(0, 3);
    expect([restored!.fields, archived!.fields, producer!.fields]).toEqual([{ archived: false }, { archived: true }, { producer: "Gatomboya" }]);
    const theirApp = producer!.source.connectedApp!;
    expect(theirApp).toMatchObject({ name: "Test Assistant", host: new URL(app.clientId).host });
    expect(theirApp.id).not.toBe(throughApp.connectedApp!.id);
    expect(producer!.source.account).toEqual({ id: sam.id, name: "sam-411@example.com" });
    const asStaff = await versions("bean", made.bean, sam.api);
    expect(asStaff[2]!.source).toEqual({ machine: null, tabletId: null, account: { id: sam.id, name: null }, connectedApp: theirApp });
    expect(asStaff.at(-1)!.source).toEqual({ ...throughApp, account: { id: throughApp.account!.id, name: null } });
  });

  it("refuses every changing tool, from a Connected App that may only read and from a Viewer's, with 403 insufficient_scope naming read and change, changing nothing", async () => {
    const batches = async () => (await api.get<{ batches: unknown[] }>("/bean-batches")).batches.length;
    const before = { batches: await batches(), bean: await restItem("bean", made.bean), batch: await restItem("beanBatch", made.batch) };
    /** Each changing tool, with arguments it would take from an account allowed to change. */
    const calls = (name: string): [string, Record_][] => [
      ["create_bean", { roaster: "Roux", name }],
      ["edit_bean", { id: made.bean, notes: `${name} notes` }],
      ["create_bean_batch", { beanId: made.bean, locations: [{ locationId: uptown.id }] }],
      ["edit_bean_batch", { id: made.batch, notes: `${name} notes` }],
      ["set_archived", { kind: "bean", id: made.bean, archived: true }],
      ["set_location_offering", { kind: "beanBatch", id: made.batch, locationId: uptown.id, offered: false }],
    ];
    const { tools } = await reader.client.listTools();
    expect(tools.filter((tool) => tool.annotations?.readOnlyHint === false).map((tool) => tool.name).sort()).toEqual(calls("").map(([name]) => name).sort());
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
    expect((await reader.call<{ bean: Record_ }>("get_library_item", { kind: "bean", id: made.bean })).bean.archived).toBe(false);

    // A Staff member's Connected App, allowed to change, changes nothing from the call after their account becomes a Viewer.
    const vic = await person("vic-411@example.com", "staff", [uptown]);
    await vic.assistant.call("create_bean", { roaster: "Roux", name: "Before Viewer" });
    await api.send("PUT", `/accounts/${vic.id}/access`, { role: "viewer" });
    await refuse(vic.assistant.tokens.access_token, "As Viewer");

    const names = (await api.get<{ beans: { name: string }[] }>("/beans")).beans.map((bean) => bean.name);
    expect(names).toContain("Before Viewer");
    expect(names).not.toContain("Read-only");
    expect(names).not.toContain("As Viewer");
    expect(await batches()).toBe(before.batches);
    expect(await restItem("bean", made.bean)).toEqual(before.bean);
    expect(await restItem("beanBatch", made.batch)).toEqual(before.batch);
  });

  it("keeps a change through the assistant that a tablet's later edit, made without seeing it, replaced, as a Conflict through the Connected App", async () => {
    // Nothing left under way, so the tablet's record has seen every change before the assistant's.
    await quiesced(api, { tablets: { tablet }, machines: { machine } });
    const local = held(tablet.beans(), made.bean)!.id;
    tablet.loseNetwork();
    await assistant.call("edit_bean", { id: made.bean, notes: "Assistant notes" });
    // Well after it, whatever the drift between the tablet's clock and PostgreSQL's.
    await delay(1_000);
    await tablet.editBean(local, { notes: "Tablet notes" });
    tablet.restoreNetwork();
    await expect.poll(async () => (await api.get<{ conflicts: Record_[] }>(`/beans/${made.bean}/conflicts`)).conflicts, { timeout: 15_000 }).toEqual([
      expect.objectContaining({ field: "notes", value: "Assistant notes", source: throughApp, current: expect.objectContaining({ value: "Tablet notes" }) }),
    ]);
    expect(held(tablet.beans(), made.bean)?.notes).toBe("Tablet notes");
    const { conflicts } = await api.get<{ conflicts: Record_[] }>("/conflicts");
    expect(comparable((await assistant.call<{ conflicts: Record_[] }>("list_conflicts")).conflicts)).toEqual(comparable(conflicts));
  });
});
