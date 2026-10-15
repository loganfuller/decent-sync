import { GLOBAL_ID_KEY } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { type Dye2Key, dye2List } from "./support/simulated-dye2.js";
import { NO_DYE2_LISTS, SimulatedTablet, derivedDe1Pro, settingsFor } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 and the REST API for ticket #139: Baskets and Tools created,
// edited, Archived and restored in the management interface reach the DYE2
// lists of the tablets at the Locations showing them, through the built
// plugin in simulated tablets, on two server instances sharing PostgreSQL.
// Serials are made up, from 43001.

type Record_ = Record<string, unknown>;

interface EquipmentView {
  id: string;
  name: string | null;
  archived: boolean;
  shownAt: { location: LocationView; since: string }[];
  createdLocation: LocationView | null;
  content: Record_;
  locations: { location: LocationView; shown: boolean }[];
}

interface VersionView {
  fields: Record_;
  location: LocationView | null;
  source: { machine: unknown; tabletId: string | null; account: { id: string } | null };
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

describe("Baskets and Tools in the management interface", { timeout: 90_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  const tablets: SimulatedTablet[] = [];

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => {
    await Promise.all(tablets.map((tablet) => tablet.unload()));
    await other?.stop();
    await server?.stop();
  });

  /** The built plugin on a tablet of the Machine, polling every 5 s (0.1 s here), its Library and DYE2's lists empty. */
  function load(machine: CreatedMachine, serial: string, instance: TestServer): SimulatedTablet {
    const tablet = SimulatedTablet.load({
      settings: { ...settingsFor({ token: machine.token, serverUrl: instance.url }), PollSeconds: 5 },
      api: { ...derivedDe1Pro({ serial }), "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [], ...NO_DYE2_LISTS },
      timeScale: 50,
    });
    tablets.push(tablet);
    return tablet;
  }

  /** A Location with a Machine whose tablet is online through the instance. */
  async function locationWith(name: string, serial: number, instance: TestServer): Promise<{ location: LocationView; tablet: SimulatedTablet }> {
    const location = await api.createLocation(name, "America/Chicago");
    const machine = await api.createMachine(`${name} 1`, location.id);
    const tablet = load(machine, String(serial), instance);
    await api.waitForOnline(machine);
    return { location, tablet };
  }

  const create = (kind: "baskets" | "tools", location: LocationView, content: Record_, as: AdminApi = api) =>
    as.send<Record<string, EquipmentView>>("POST", `/${kind}`, { locationId: location.id, content }, 201).then((created) => created[kind === "baskets" ? "basket" : "tool"]!);
  const edit = (kind: "baskets" | "tools", id: string, content: Record_, as: AdminApi = api) =>
    as.send<Record<string, EquipmentView>>("PATCH", `/${kind}/${id}`, { content }).then((edited) => edited[kind === "baskets" ? "basket" : "tool"]!);
  const archive = (kind: "baskets" | "tools", id: string, archived: boolean, as: AdminApi = api) => as.call("PUT", `/${kind}/${id}/archived`, { archived });
  const versions = async (kind: "baskets" | "tools", id: string) => (await api.get<{ versions: VersionView[] }>(`/${kind}/${id}/history`)).versions;

  /** The tablet's record of the item in DYE2's list, by the global id it carries, if it holds one. */
  const recordOf = (tablet: SimulatedTablet, key: Dye2Key, id: string): Record_ | undefined => {
    const list = dye2List(tablet, key);
    return Array.isArray(list) ? (list as Record_[]).find((record) => record[GLOBAL_ID_KEY] === id) : undefined;
  };
  const poll = <T>(read: () => T) => expect.poll(read, { timeout: 15_000 });

  it("writes a Basket created at a Location to that Location's tablets only, then each edit, and removes it from every tablet while Archived", async () => {
    const lab = await locationWith("Created basket lab", 43001, server);
    const cafe = await locationWith("Created basket cafe", 43002, other);

    const basket = await create("baskets", lab.location, { name: " Lab 18g Precision ", size: "double", diameterMm: 58.5, notes: "For the lab's tests" });
    expect(basket).toMatchObject({
      name: "Lab 18g Precision",
      archived: false,
      shownAt: [{ location: { name: "Created basket lab" } }],
      createdLocation: { name: "Created basket lab" },
      content: { name: "Lab 18g Precision", size: "double", diameterMm: 58.5, notes: "For the lab's tests" },
      locations: [{ location: { name: "Created basket lab" }, shown: true }],
    });
    // Written to the lab's tablet as DYE2 would save it, under an id of the tablet's own; not to the cafe's.
    await poll(() => recordOf(lab.tablet, "baskets", basket.id)).toMatchObject({ name: "Lab 18g Precision", size: "double", diameterMm: 58.5, notes: "For the lab's tests" });
    expect(recordOf(cafe.tablet, "baskets", basket.id)).toBeUndefined();

    // Shown at the cafe, then edited: a field cleared is left out of every record.
    expect((await api.call("PUT", `/baskets/${basket.id}/locations/${cafe.location.id}`, { shown: true })).status).toBe(200);
    await poll(() => recordOf(cafe.tablet, "baskets", basket.id)?.name).toBe("Lab 18g Precision");
    const edited = await edit("baskets", basket.id, { notes: null, diameterMm: 58 });
    expect(edited.content).toEqual({ name: "Lab 18g Precision", size: "double", diameterMm: 58 });
    for (const tablet of [lab.tablet, cafe.tablet]) {
      await poll(() => recordOf(tablet, "baskets", basket.id)?.diameterMm).toBe(58);
      expect(recordOf(tablet, "baskets", basket.id)).not.toHaveProperty("notes");
    }
    const history = await versions("baskets", basket.id);
    expect(history[0]).toMatchObject({ fields: { notes: null, diameterMm: 58 }, location: null, source: { machine: null, account: { id: expect.any(String) } } });
    expect(history.at(-1)).toMatchObject({ fields: { name: "Lab 18g Precision", size: "double" }, location: null });

    // Archived, it is shown nowhere and removed from every list; restored, it is written again where it was shown.
    expect((await archive("baskets", basket.id, true)).status).toBe(200);
    for (const tablet of [lab.tablet, cafe.tablet]) await poll(() => recordOf(tablet, "baskets", basket.id)).toBeUndefined();
    const archived = (await api.get<{ basket: EquipmentView }>(`/baskets/${basket.id}`)).basket;
    expect(archived).toMatchObject({ archived: true, shownAt: [] });
    expect(archived.locations.map((here) => here.shown)).toEqual([true, true]);
    expect((await archive("baskets", basket.id, false)).status).toBe(200);
    for (const tablet of [lab.tablet, cafe.tablet]) await poll(() => recordOf(tablet, "baskets", basket.id)?.diameterMm).toBe(58);
    expect((await versions("baskets", basket.id)).slice(0, 2).map((version) => version.fields)).toEqual([{ archived: false }, { archived: true }]);
  });

  it("refuses a Basket or Tool whose name the Library has, Archived or not, naming that one", async () => {
    const lab = await api.createLocation("Duplicate lab", "America/Chicago");
    const basket = await create("baskets", lab, { name: "Duplicate 20g High-flow" });
    const refused = await api.call("POST", "/baskets", { locationId: lab.id, content: { name: "  duplicate 20G high-flow " } });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ existing: { id: basket.id, name: "Duplicate 20g High-flow", archived: false } });

    const tool = await create("tools", lab, { name: "Duplicate WDT Tool" });
    expect((await archive("tools", tool.id, true)).status).toBe(200);
    const archivedRefusal = await api.call("POST", "/tools", { locationId: lab.id, content: { name: "Duplicate WDT tool" } });
    expect(archivedRefusal.status).toBe(409);
    expect(await archivedRefusal.json()).toMatchObject({ existing: { id: tool.id, archived: true } });
    // With a current Tool of the name as well, which a tablet's record of the name is linked to, that is the one named.
    const current = await create("tools", lab, { name: "Duplicate WDT Tool, current" });
    await edit("tools", current.id, { name: "duplicate wdt tool" });
    const currentRefusal = await api.call("POST", "/tools", { locationId: lab.id, content: { name: "Duplicate WDT Tool" } });
    expect(currentRefusal.status).toBe(409);
    expect(await currentRefusal.json()).toMatchObject({ existing: { id: current.id, name: "duplicate wdt tool", archived: false } });
    // A Basket and a Tool may share a name: each kind is matched by itself.
    expect((await api.call("POST", "/tools", { locationId: lab.id, content: { name: "Duplicate 20g High-flow" } })).status).toBe(201);
  });

  it("writes a Tool's attributes as DYE2 saves them, and each edit of them, to the tablets showing it", async () => {
    const lab = await locationWith("Attribute lab", 43011, other);

    // Names and values are trimmed, and an attribute without a name is left out, as DYE2's page leaves it.
    const tool = await create("tools", lab.location, {
      name: "Attribute WDT Tool",
      custom: [
        { key: " Needles ", value: " 8 " },
        { key: "", value: "dropped" },
      ],
    });
    expect(tool.content).toEqual({ name: "Attribute WDT Tool", custom: [{ key: "Needles", value: "8" }] });
    await poll(() => recordOf(lab.tablet, "equipment", tool.id)?.custom).toEqual([{ key: "Needles", value: "8" }]);
    // One created without attributes holds none, as DYE2's page saves one.
    const screen = await create("tools", lab.location, { name: "Attribute Puck Screen" });
    expect(screen.content).toEqual({ name: "Attribute Puck Screen", custom: [] });

    const attributes = [
      { key: "Needles", value: "10" },
      { key: "Needle size", value: "0.3 mm" },
    ];
    expect((await edit("tools", tool.id, { custom: attributes })).content.custom).toEqual(attributes);
    await poll(() => recordOf(lab.tablet, "equipment", tool.id)?.custom).toEqual(attributes);
    expect((await versions("tools", tool.id))[0]).toMatchObject({ fields: { custom: attributes }, source: { account: { id: expect.any(String) } } });
  });

  it("refuses content DYE2 would not save, and a Location or item that does not exist", async () => {
    const lab = await api.createLocation("Refused lab", "America/Chicago");
    const refused = async (method: string, path: string, body: unknown, status = 400) => expect((await api.call(method, path, body)).status).toBe(status);
    await refused("POST", "/baskets", { locationId: lab.id, content: { size: "double" } });
    await refused("POST", "/baskets", { locationId: lab.id, content: { name: "Refused basket", size: "huge" } });
    await refused("POST", "/baskets", { locationId: lab.id, content: { name: "Refused basket", diameterMm: -1 } });
    await refused("POST", "/baskets", { locationId: lab.id, content: { name: "Refused basket", colour: "red" } });
    await refused("POST", "/baskets", { content: { name: "Refused basket" } });
    await refused("POST", "/tools", { locationId: lab.id, content: { name: "Refused tool", custom: [{ key: "Needles", value: 8 }] } });
    await refused("POST", "/tools", { locationId: lab.id, content: { name: "Refused tool", custom: "Needles: 8" } });
    await refused("POST", "/tools", { locationId: "00000000-0000-4000-8000-000000000000", content: { name: "Refused tool" } }, 404);

    const basket = await create("baskets", lab, { name: "Refused edits basket" });
    await refused("PATCH", `/baskets/${basket.id}`, { content: { name: "" } });
    await refused("PATCH", `/baskets/${basket.id}`, { content: {} });
    await refused("PATCH", "/baskets/00000000-0000-4000-8000-000000000000", { content: { notes: "None" } }, 404);
    await refused("PUT", "/tools/00000000-0000-4000-8000-000000000000/archived", { archived: true }, 404);
    await refused("PUT", `/baskets/${basket.id}/archived`, { archived: "yes" });
    expect((await api.get<{ basket: EquipmentView }>(`/baskets/${basket.id}`)).basket.content).toEqual({ name: "Refused edits basket" });
  });

  it("lets Staff create Baskets and Tools only at their own Locations, and edit, Archive and restore any", async () => {
    const theirs = await api.createLocation("Equipment staff home", "America/Chicago");
    const elsewhere = await api.createLocation("Equipment staff elsewhere", "America/Chicago");
    const staff = await api.staffAt("staff-139@example.com", theirs);

    expect((await staff.call("POST", "/baskets", { locationId: elsewhere.id, content: { name: "Staff elsewhere basket" } })).status).toBe(403);
    expect((await staff.call("POST", "/tools", { locationId: elsewhere.id, content: { name: "Staff elsewhere tool" } })).status).toBe(403);
    const own = await create("tools", theirs, { name: "Staff home tool" }, staff);
    expect(own.shownAt.map((here) => here.location.name)).toEqual(["Equipment staff home"]);

    const basket = await create("baskets", elsewhere, { name: "Staff edited basket" });
    expect((await edit("baskets", basket.id, { notes: "Edited by Staff" }, staff)).content.notes).toBe("Edited by Staff");
    expect((await archive("baskets", basket.id, true, staff)).status).toBe(200);
    expect((await archive("baskets", basket.id, false, staff)).status).toBe(200);
    expect((await staff.call("PUT", `/baskets/${basket.id}/locations/${elsewhere.id}`, { shown: false })).status).toBe(403);
    expect((await api.get<{ basket: EquipmentView }>(`/baskets/${basket.id}`)).basket.shownAt.map((here) => here.location.name)).toEqual(["Equipment staff elsewhere"]);
  });
});
