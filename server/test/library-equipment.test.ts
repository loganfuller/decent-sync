import { GLOBAL_ID_KEY } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { type Dye2Key, DYE2_NAMESPACE, dye2List, dye2Recording, saveInDye2 } from "./support/simulated-dye2.js";
import { type DecaidApi, SimulatedTablet, derivedDe1Pro, settingsFor } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #138: Baskets and Tools, which DYE2 keeps in lists in
// Decaid's store, shared through the Library (ADR-0005). One created in DYE2
// on a tablet joins the Library, shown at that tablet's Location only, and is
// written to the Location's other tablets; one of the same name entered at
// another Location is the same item (ADR-0018); edits reach every tablet that
// holds it, merged per field (ADR-0020); deleting a Tool on a tablet hides it
// at its Location only (ADR-0019), and what a Location does not show is
// removed from its tablets' lists. Through the built plugin in simulated
// tablets, acting as DYE2 v0.1.19 does with the steps recorded from it
// (fixtures/decaid/dye2-v0.1.19/), on two server instances sharing one
// database, with assertions through the REST API and what each simulated
// tablet's store holds. Serials are made up, from 41001.

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

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

describe("Baskets and Tools shared through DYE2's lists", { timeout: 90_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  const tablets: SimulatedTablet[] = [];

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
  }, 60_000);
  afterAll(async () => {
    await Promise.all(tablets.map((tablet) => tablet.unload()));
    await other?.stop();
    await server?.stop();
  });

  /**
   * The tablet's Decaid: a DE1Pro with an empty library, and DYE2's keys
   * never written, as on a tablet where DYE2 was never used, unless `store`
   * gives them values.
   */
  function decaid(serial: string, store: Partial<Record<Dye2Key, unknown>> = {}): DecaidApi {
    const api: DecaidApi = { ...derivedDe1Pro({ serial }), "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [] };
    for (const key of ["recipes", "baskets", "equipment"] as const) delete api[`/store/${DYE2_NAMESPACE}/${key}`];
    for (const [key, value] of Object.entries(store)) api[`/store/${DYE2_NAMESPACE}/${key}`] = value;
    return api;
  }

  /** The built plugin on a tablet of the Machine, connected to an instance, polling every 5 s (0.1 s here). */
  function load(machine: CreatedMachine, decaidApi: DecaidApi, options: { instance?: TestServer; storage?: SimulatedTablet["storage"] } = {}): SimulatedTablet {
    const tablet = SimulatedTablet.load({
      settings: { ...settingsFor({ token: machine.token, serverUrl: (options.instance ?? server).url }), PollSeconds: 5 },
      api: decaidApi,
      storage: options.storage,
      timeScale: 50,
    });
    tablets.push(tablet);
    return tablet;
  }

  async function online(...machines: CreatedMachine[]): Promise<void> {
    for (const { machine } of machines) await api.waitForMachine(machine.name, (viewed) => viewed.online);
  }

  const list = async (kind: "baskets" | "tools") => ((await (await api.call("GET", `/${kind}`)).json()) as Record<string, EquipmentView[]>)[kind]!;
  const view = async (kind: "baskets" | "tools", id: string) =>
    ((await (await api.call("GET", `/${kind}/${id}`)).json()) as Record<string, EquipmentView>)[kind === "baskets" ? "basket" : "tool"]!;
  /** The Library's items of the kind with that name, ignoring case and spaces at either end. */
  const named = async (kind: "baskets" | "tools", name: string) =>
    (await list(kind)).filter((item) => item.name?.trim().toLowerCase() === name.trim().toLowerCase());
  /** The Locations showing the item of that name, by name, once the Library has exactly one. */
  const shownAt = async (kind: "baskets" | "tools", name: string) => {
    const items = await named(kind, name);
    return items.length === 1 ? items[0]!.shownAt.map((here) => here.location.name) : `${items.length} named so`;
  };
  /** The tablet's records in DYE2's list, as its store holds them; none for a key never written. */
  const records = (tablet: SimulatedTablet, key: Dye2Key): Record_[] => {
    const value = dye2List(tablet, key);
    return Array.isArray(value) ? (value as Record_[]) : [];
  };
  /** The tablet's record of that name in DYE2's list, if it holds one. */
  const recordNamed = (tablet: SimulatedTablet, key: Dye2Key, name: string) =>
    records(tablet, key).find((record) => String(record.name).trim().toLowerCase() === name.trim().toLowerCase());
  const show = (kind: "baskets" | "tools", id: string, location: LocationView, shown: boolean) => api.call("PUT", `/${kind}/${id}/locations/${location.id}`, { shown });

  const baskets = dye2Recording("baskets");
  const tools = dye2Recording("tools");
  /** Names each item a recorded step saves as the scenario's own, as Baskets and Tools are matched by name across scenarios. */
  const ownNames = (scenario: string) => (item: Record_) => ({ ...item, name: `${scenario} ${String(item.name)}` });

  it("writes a Basket created in DYE2 to the tablets at its Location, those whose keys were never written too, and to no other Location's", async () => {
    const lab = await api.createLocation("Created lab", "America/Chicago");
    const cafe = await api.createLocation("Created cafe", "America/Chicago");
    const machines = [await api.createMachine("Created lab 1", lab.id), await api.createMachine("Created lab 2", lab.id), await api.createMachine("Created cafe 1", cafe.id)] as const;
    const one = load(machines[0], decaid("41001"));
    const two = load(machines[1], decaid("41002"), { instance: other });
    const cafeTablet = load(machines[2], decaid("41003"));
    await online(...machines);

    await saveInDye2(one, baskets.create18gBasket);
    await expect.poll(() => shownAt("baskets", "Fixture 18g Precision"), { timeout: 15_000 }).toEqual(["Created lab"]);
    const [basket] = await named("baskets", "Fixture 18g Precision");
    expect(basket).toMatchObject({ archived: false, createdLocation: { name: "Created lab" } });
    expect((await view("baskets", basket!.id)).content).toEqual({ name: "Fixture 18g Precision", size: "double", notes: "Fixture notes", diameterMm: 58.5 });
    // The tablet that created it carries its global id in a field of its own; the other tablet there, whose key was never
    // written, holds it under an id of its own, with its global id.
    await expect.poll(() => recordNamed(one, "baskets", "Fixture 18g Precision")?.[GLOBAL_ID_KEY], { timeout: 15_000 }).toBe(basket!.id);
    await expect.poll(() => recordNamed(two, "baskets", "Fixture 18g Precision"), { timeout: 15_000 }).toMatchObject({
      name: "Fixture 18g Precision",
      size: "double",
      notes: "Fixture notes",
      diameterMm: 58.5,
      [GLOBAL_ID_KEY]: basket!.id,
    });
    const written = recordNamed(two, "baskets", "Fixture 18g Precision")!;
    expect(written.id).toEqual(expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
    expect(written.createdAt).toEqual(expect.any(String));
    // Its other lists, written nothing, stay as they were; the cafe's tablet is written nothing to DYE2's keys.
    expect(dye2List(two, "equipment")).toBeNull();
    expect(cafeTablet.storeWrites.filter((write) => write.namespace === DYE2_NAMESPACE)).toEqual([]);
    expect(dye2List(cafeTablet, "baskets")).toBeNull();

    // Shown at the cafe through the REST API, through the other instance's writer, it is written to the cafe's tablet.
    expect((await show("baskets", basket!.id, cafe, true)).status).toBe(200);
    await expect.poll(() => recordNamed(cafeTablet, "baskets", "Fixture 18g Precision")?.[GLOBAL_ID_KEY], { timeout: 15_000 }).toBe(basket!.id);
    expect(await shownAt("baskets", "Fixture 18g Precision")).toEqual(["Created cafe", "Created lab"]);
  });

  it("makes a Basket of the same name entered at two Locations one Basket, and writes it to a third Location's tablets once shown there", async () => {
    const lab = await api.createLocation("Matched lab", "America/Chicago");
    const cafe = await api.createLocation("Matched cafe", "America/Chicago");
    const roastery = await api.createLocation("Matched roastery", "America/Chicago");
    const machines = [
      await api.createMachine("Matched lab 1", lab.id),
      await api.createMachine("Matched cafe 1", cafe.id),
      await api.createMachine("Matched roastery 1", roastery.id),
    ] as const;
    const labTablet = load(machines[0], decaid("41011"));
    const cafeTablet = load(machines[1], decaid("41012"), { instance: other });
    const roasteryTablet = load(machines[2], decaid("41013"));
    await online(...machines);

    await saveInDye2(labTablet, baskets.create20gBasket);
    await expect.poll(() => shownAt("baskets", "Fixture 20g High-flow"), { timeout: 15_000 }).toEqual(["Matched lab"]);
    // The cafe enters it as its own, in other case and with spaces, under an id of its own.
    await saveInDye2(cafeTablet, baskets.create20gBasket, (item) => ({ ...item, id: "bskt-cafe-20", name: "  fixture 20G HIGH-FLOW " }));
    await expect.poll(() => shownAt("baskets", "Fixture 20g High-flow"), { timeout: 15_000 }).toEqual(["Matched cafe", "Matched lab"]);
    const [basket] = await named("baskets", "Fixture 20g High-flow");
    // The cafe's record is that Basket, and takes its name.
    await expect.poll(() => records(cafeTablet, "baskets"), { timeout: 15_000 }).toEqual([
      expect.objectContaining({ id: "bskt-cafe-20", name: "Fixture 20g High-flow", [GLOBAL_ID_KEY]: basket!.id }),
    ]);
    expect(roasteryTablet.storeWrites.filter((write) => write.namespace === DYE2_NAMESPACE)).toEqual([]);

    expect((await show("baskets", basket!.id, roastery, true)).status).toBe(200);
    await expect.poll(() => recordNamed(roasteryTablet, "baskets", "Fixture 20g High-flow")?.[GLOBAL_ID_KEY], { timeout: 15_000 }).toBe(basket!.id);
    expect(await named("baskets", "Fixture 20g High-flow")).toHaveLength(1);
  });

  it("writes an edit of a Tool's attributes on one tablet to every tablet that holds it, and keeps two edits made without seeing each other as a Conflict", async () => {
    const lab = await api.createLocation("Edited lab", "America/Chicago");
    const cafe = await api.createLocation("Edited cafe", "America/Chicago");
    const machines = [await api.createMachine("Edited lab 1", lab.id), await api.createMachine("Edited lab 2", lab.id), await api.createMachine("Edited cafe 1", cafe.id)] as const;
    const one = load(machines[0], decaid("41021"));
    const two = load(machines[1], decaid("41022"), { instance: other });
    const cafeTablet = load(machines[2], decaid("41023"));
    await online(...machines);

    await saveInDye2(one, tools.createWdtTool);
    await expect.poll(() => shownAt("tools", "Fixture WDT Tool"), { timeout: 15_000 }).toEqual(["Edited lab"]);
    const [tool] = await named("tools", "Fixture WDT Tool");
    expect((await show("tools", tool!.id, cafe, true)).status).toBe(200);
    await expect.poll(() => recordNamed(cafeTablet, "equipment", "Fixture WDT Tool"), { timeout: 15_000 }).toBeDefined();
    await expect.poll(() => recordNamed(two, "equipment", "Fixture WDT Tool"), { timeout: 15_000 }).toBeDefined();

    // DYE2's equipment page on the first tablet changes the needles from 8 to 10: every tablet holding it, at both Locations, gets it.
    await saveInDye2(one, tools.editWdtTool);
    const needles = (tablet: SimulatedTablet) => (recordNamed(tablet, "equipment", "Fixture WDT Tool")?.custom as Record_[] | undefined)?.[0]?.value;
    for (const tablet of [two, cafeTablet]) await expect.poll(() => needles(tablet), { timeout: 15_000 }).toBe("10");
    expect((await view("tools", tool!.id)).content.custom).toEqual([
      { key: "Needles", value: "10" },
      { key: "Needle size", value: "0.3 mm" },
    ]);

    // Offline, the cafe's tablet sets 12; meanwhile the lab sets 14. Neither saw the other's.
    cafeTablet.loseNetwork();
    await api.waitForMachine("Edited cafe 1", (viewed) => !viewed.online, 15_000);
    const setNeedles = async (tablet: SimulatedTablet, value: string) => {
      const list = records(tablet, "equipment").map((record) =>
        record.name === "Fixture WDT Tool" ? { ...record, custom: [{ key: "Needles", value }, { key: "Needle size", value: "0.3 mm" }] } : record,
      );
      expect((await tablet.callApi("POST", `/store/${DYE2_NAMESPACE}/equipment`, list)).status).toBe(200);
    };
    await setNeedles(cafeTablet, "12");
    await setNeedles(one, "14");
    await expect.poll(() => needles(two), { timeout: 15_000 }).toBe("14");
    // Back online, the cafe's edit, read after the lab's, wins, and the lab's value is kept as a Conflict.
    cafeTablet.restoreNetwork();
    for (const tablet of [one, two]) await expect.poll(() => needles(tablet), { timeout: 15_000 }).toBe("12");
    const conflicts = ((await (await api.call("GET", `/tools/${tool!.id}/conflicts`)).json()) as { conflicts: { field: string; value: unknown }[] }).conflicts;
    expect(conflicts).toEqual([
      expect.objectContaining({
        field: "custom",
        value: [
          { key: "Needles", value: "14" },
          { key: "Needle size", value: "0.3 mm" },
        ],
      }),
    ]);
  });

  it("hides a Tool deleted in DYE2 at that Location only, removing it from that Location's tablets while another Location keeps it", async () => {
    const lab = await api.createLocation("Deleted lab", "America/Chicago");
    const cafe = await api.createLocation("Deleted cafe", "America/Chicago");
    const machines = [await api.createMachine("Deleted lab 1", lab.id), await api.createMachine("Deleted lab 2", lab.id), await api.createMachine("Deleted cafe 1", cafe.id)] as const;
    const one = load(machines[0], decaid("41031"));
    const two = load(machines[1], decaid("41032"), { instance: other });
    const cafeTablet = load(machines[2], decaid("41033"));
    await online(...machines);

    await saveInDye2(one, tools.createSpareTamper, ownNames("Deleted"));
    await expect.poll(() => shownAt("tools", "Deleted Fixture Spare Tamper"), { timeout: 15_000 }).toEqual(["Deleted lab"]);
    const [tool] = await named("tools", "Deleted Fixture Spare Tamper");
    await show("tools", tool!.id, cafe, true);
    for (const tablet of [two, cafeTablet]) await expect.poll(() => recordNamed(tablet, "equipment", "Deleted Fixture Spare Tamper"), { timeout: 15_000 }).toBeDefined();

    // DYE2's equipment page deletes it on the second tablet, under that tablet's id for it.
    const localId = recordNamed(two, "equipment", "Deleted Fixture Spare Tamper")!.id;
    await saveInDye2(two, tools.deleteSpareTamper, (item) => ({ ...ownNames("Deleted")(item), id: localId }));
    await expect.poll(() => shownAt("tools", "Deleted Fixture Spare Tamper"), { timeout: 15_000 }).toEqual(["Deleted cafe"]);
    await expect.poll(() => recordNamed(one, "equipment", "Deleted Fixture Spare Tamper"), { timeout: 15_000 }).toBeUndefined();
    expect(recordNamed(cafeTablet, "equipment", "Deleted Fixture Spare Tamper")).toBeDefined();
    // Still in the Library, it is hidden at the lab, and its hiding there was the second tablet's.
    expect((await view("tools", tool!.id)).locations.map(({ location, shown }) => [location.name, shown])).toEqual([
      ["Deleted cafe", true],
      ["Deleted lab", false],
    ]);

    // Hidden at the cafe through the REST API, it is removed from the cafe's tablet, and nothing is written to the lab's.
    expect((await show("tools", tool!.id, cafe, false)).status).toBe(200);
    await expect.poll(() => recordNamed(cafeTablet, "equipment", "Deleted Fixture Spare Tamper"), { timeout: 15_000 }).toBeUndefined();
    expect(await shownAt("tools", "Deleted Fixture Spare Tamper")).toEqual([]);
    // The tablet's answer, which its sharing status shows, follows its removal from the list.
    const lastApplied = async () =>
      ((await (await api.call("GET", `/machines/${machines[2].machine.id}/sharing-status`)).json()) as { status: { lastApplied: Record_ } }).status.lastApplied;
    await expect
      .poll(lastApplied, { timeout: 15_000 })
      .toMatchObject({ change: "remove", kind: "tool", item: { kind: "tool", id: tool!.id, name: "Deleted Fixture Spare Tamper" } });
  });

  it("writes nothing to a list in a shape it does not recognise, showing it in the sharing status, while the tablet's other lists keep syncing", async () => {
    const lab = await api.createLocation("Unrecognised lab", "America/Chicago");
    const machines = [await api.createMachine("Unrecognised lab 1", lab.id), await api.createMachine("Unrecognised lab 2", lab.id)] as const;
    const one = load(machines[0], decaid("41041"));
    const broken = { baskets: { "1": { name: "A basket in a shape DYE2 never saved" } } };
    const two = load(machines[1], decaid("41042", { baskets: broken }), { instance: other });
    await online(...machines);
    const status = async () =>
      ((await (await api.call("GET", `/machines/${machines[1].machine.id}/sharing-status`)).json()) as { status: { unrecognisedLists: { list: string }[] } }).status;
    await expect.poll(async () => (await status()).unrecognisedLists.map(({ list }) => list), { timeout: 15_000 }).toEqual(["dye2Baskets"]);

    await saveInDye2(one, baskets.create18gBasket, ownNames("Unrecognised"));
    await saveInDye2(one, tools.createPuckScreen, ownNames("Unrecognised"));
    const bean = await one.addBean({ roaster: "Unrecognised Roaster", name: "Still Syncing" });
    // Its tools and beans are written, as is its other tablet's; its baskets are not.
    await expect.poll(() => recordNamed(two, "equipment", "Unrecognised Fixture Puck Screen"), { timeout: 15_000 }).toBeDefined();
    await expect.poll(() => two.beans().map((record) => record.name), { timeout: 15_000 }).toContain(bean.name);
    expect(dye2List(two, "baskets")).toEqual(broken);
    expect(two.storeWrites.filter((write) => write.key === "baskets")).toEqual([]);
    expect(await shownAt("baskets", "Unrecognised Fixture 18g Precision")).toEqual(["Unrecognised lab"]);

    // Saved again as a list DYE2 keeps, it is written again.
    expect((await two.callApi("POST", `/store/${DYE2_NAMESPACE}/baskets`, [])).status).toBe(200);
    await expect.poll(() => recordNamed(two, "baskets", "Unrecognised Fixture 18g Precision"), { timeout: 15_000 }).toBeDefined();
    expect((await status()).unrecognisedLists).toEqual([]);
  });

  it("writes again what another app's rewrite of the list lost as the plugin wrote it", async () => {
    const lab = await api.createLocation("Lost lab", "America/Chicago");
    const machines = [await api.createMachine("Lost lab 1", lab.id), await api.createMachine("Lost lab 2", lab.id)] as const;
    const one = load(machines[0], decaid("41051"));
    const two = load(machines[1], decaid("41052"), { instance: other });
    await online(...machines);
    /** Has DYE2, which read the list just before, post it back just after the plugin's next write of the key, losing that write. */
    const loseNextWrite = (tablet: SimulatedTablet, key: Dye2Key) => {
      const before = structuredClone(dye2List(tablet, key) ?? []);
      let lost = false;
      tablet.refuseWrites = ({ method, route }) => {
        if (!lost && method === "POST" && route === `/store/${DYE2_NAMESPACE}/${key}`) {
          lost = true;
          setImmediate(() => void tablet.callApi("POST", `/store/${DYE2_NAMESPACE}/${key}`, before));
        }
        return undefined;
      };
      return () => lost;
    };

    // A create lost.
    const createLost = loseNextWrite(two, "baskets");
    await saveInDye2(one, baskets.create18gBasket, ownNames("Lost"));
    await expect.poll(createLost, { timeout: 15_000 }).toBe(true);
    await expect.poll(() => recordNamed(two, "baskets", "Lost Fixture 18g Precision"), { timeout: 15_000 }).toBeDefined();
    expect(two.storeWrites.filter((write) => write.key === "baskets").length).toBeGreaterThanOrEqual(2);
    expect(await shownAt("baskets", "Lost Fixture 18g Precision")).toEqual(["Lost lab"]);

    // An edit lost: the record comes back as it was before the plugin's write, which is no edit of the tablet's.
    await expect.poll(() => records(two, "baskets").length, { timeout: 15_000 }).toBe(1);
    const editLost = loseNextWrite(two, "baskets");
    await saveInDye2(one, baskets.edit18gBasket, ownNames("Lost"));
    await expect.poll(editLost, { timeout: 15_000 }).toBe(true);
    await expect.poll(() => recordNamed(two, "baskets", "Lost Fixture 18g Precision")?.notes, { timeout: 15_000 }).toBe("Fixture notes, edited");
    const [basket] = await named("baskets", "Lost Fixture 18g Precision");
    expect((await view("baskets", basket!.id)).content).toMatchObject({ notes: "Fixture notes, edited", diameterMm: 58.4 });
    await expect.poll(() => recordNamed(one, "baskets", "Lost Fixture 18g Precision")?.notes, { timeout: 15_000 }).toBe("Fixture notes, edited");

    // A barista on that tablet sets the notes to a value of their own, then back to what the tablet held before the
    // server's write: no stale save now, but their edit, which reaches the other tablet.
    const setNotes = async (notes: string) => {
      const list = records(two, "baskets").map((record) => (record.name === "Lost Fixture 18g Precision" ? { ...record, notes } : record));
      expect((await two.callApi("POST", `/store/${DYE2_NAMESPACE}/baskets`, list)).status).toBe(200);
    };
    await setNotes("Measured again");
    await expect.poll(() => recordNamed(one, "baskets", "Lost Fixture 18g Precision")?.notes, { timeout: 15_000 }).toBe("Measured again");
    await setNotes("Fixture notes");
    await expect.poll(() => recordNamed(one, "baskets", "Lost Fixture 18g Precision")?.notes, { timeout: 15_000 }).toBe("Fixture notes");
    expect((await view("baskets", basket!.id)).content).toMatchObject({ notes: "Fixture notes" });
  });

  it("keeps a restored tablet's Baskets and Tools linked by its tablet id, writing back a global id its record lost", async () => {
    const lab = await api.createLocation("Restored lab", "America/Chicago");
    const machines = [await api.createMachine("Restored lab 1", lab.id), await api.createMachine("Restored lab 2", lab.id)] as const;
    const one = load(machines[0], decaid("41061"));
    const two = load(machines[1], decaid("41062"), { instance: other });
    await online(...machines);
    await saveInDye2(one, baskets.create18gBasket, ownNames("Restored"));
    await saveInDye2(one, tools.createWdtTool, ownNames("Restored"));
    await expect.poll(() => recordNamed(two, "baskets", "Restored Fixture 18g Precision")?.[GLOBAL_ID_KEY], { timeout: 15_000 }).toBeDefined();
    await expect.poll(() => recordNamed(two, "equipment", "Restored Fixture WDT Tool")?.[GLOBAL_ID_KEY], { timeout: 15_000 }).toBeDefined();

    // The second tablet's Decaid data restored from a backup, its plugin storage with its tablet id included, but its basket's global id lost.
    const restoredBaskets = records(two, "baskets").map(({ [GLOBAL_ID_KEY]: _, ...record }) => record);
    const restoredTools = records(two, "equipment");
    const storage = two.storage;
    await two.unload();
    await api.waitForMachine("Restored lab 2", (viewed) => !viewed.online, 15_000);
    const restored = load(machines[1], decaid("41062", { baskets: restoredBaskets, equipment: restoredTools }), { instance: other, storage });
    const [basket] = await named("baskets", "Restored Fixture 18g Precision");
    await expect.poll(() => recordNamed(restored, "baskets", "Restored Fixture 18g Precision")?.[GLOBAL_ID_KEY], { timeout: 15_000 }).toBe(basket!.id);
    // Under the same id, and no item was made of either.
    expect(records(restored, "baskets").map((record) => record.id)).toEqual(restoredBaskets.map((record) => record.id));
    expect(records(restored, "equipment")).toEqual(restoredTools);
    expect(await named("baskets", "Restored Fixture 18g Precision")).toHaveLength(1);
    expect(await named("tools", "Restored Fixture WDT Tool")).toHaveLength(1);
  });

  it("takes nothing in from a Capture-only Machine's DYE2 lists, and writes nothing to them", async () => {
    const lab = await api.createLocation("Capture-only lab", "America/Chicago");
    const machines = [await api.createMachine("Capture-only lab 1", lab.id), await api.createMachine("Capture-only unplaced")] as const;
    const sharingOff = await api.createMachine("Capture-only lab 2", lab.id);
    expect((await api.call("PUT", `/machines/${sharingOff.machine.id}/sharing`, { sharing: false })).status).toBe(200);
    const one = load(machines[0], decaid("41071"));
    const unplaced = load(machines[1], decaid("41072"));
    const off = load(sharingOff, decaid("41073"), { instance: other });
    await online(...machines, sharingOff);

    await saveInDye2(unplaced, baskets.create20gBasket, ownNames("Capture-only"));
    await saveInDye2(off, tools.createSpareTamper, ownNames("Capture-only"));
    await saveInDye2(one, baskets.create18gBasket, ownNames("Capture-only"));
    await expect.poll(() => shownAt("baskets", "Capture-only Fixture 18g Precision"), { timeout: 15_000 }).toEqual(["Capture-only lab"]);
    // Reported, captured, and taken into nothing: one written later to the sharing tablet would have got there by now.
    await saveInDye2(one, tools.createPuckScreen, ownNames("Capture-only"));
    await expect.poll(() => shownAt("tools", "Capture-only Fixture Puck Screen"), { timeout: 15_000 }).toEqual(["Capture-only lab"]);
    const collection = async (machine: CreatedMachine) =>
      ((await (await api.call("GET", `/machines/${machine.machine.id}/collections/dye2Equipment`)).json()) as { collection: { items: number } | null }).collection;
    await expect.poll(async () => (await collection(sharingOff))?.items, { timeout: 15_000 }).toBe(1);
    expect(await named("baskets", "Capture-only Fixture 20g High-flow")).toEqual([]);
    expect(await named("tools", "Capture-only Fixture Spare Tamper")).toEqual([]);
    for (const tablet of [unplaced, off]) {
      expect(tablet.storeWrites.filter((write) => write.namespace === DYE2_NAMESPACE)).toEqual([]);
      expect(recordNamed(tablet, "baskets", "Capture-only Fixture 18g Precision")).toBeUndefined();
    }
  });
});
