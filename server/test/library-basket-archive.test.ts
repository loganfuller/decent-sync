import { GLOBAL_ID_KEY } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { syncingTablet } from "./support/loaded-tablets.js";
import {
  type Dye2Exchange,
  type Dye2Key,
  archiveBasketInDye2,
  deleteBasketInDye2,
  dye2List,
  dye2NeverUsed,
  dye2PagesRecording,
  editBasketInDye2,
  saveInDye2,
} from "./support/simulated-dye2.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #618: from DYE2 v0.1.41 a barista archives, unarchives,
// edits and deletes a Basket in DYE2's Basket picker, which sets `archived`
// on its record. That is the tablet's Location's state, never the Basket's
// content: archived on a tablet, a Basket is hidden at that tablet's
// Location only, and archived on that Location's other tablets; unarchived,
// it is shown there again, at the first tap on any tablet there, the server's
// write to it notwithstanding; an edit of an archived record is an edit of its
// content as before. A Basket a Location hides is archived on its tablets'
// lists rather than removed, and unarchived once shown again; a tablet that
// lacks its record is written none; a Tool hidden there is still removed,
// as DYE2 cannot archive one. Through the built plugin in simulated tablets,
// whose Basket picker acts as DYE2 v0.1.42's was recorded doing
// (fixtures/decaid/dye2-v0.1.42/baskets.json), on two server instances
// sharing one database, with assertions through the REST API and what each
// simulated tablet's store holds. Serials are made up, from 61801.

type Record_ = Record<string, unknown>;

interface EquipmentView {
  id: string;
  name: string | null;
  archived: boolean;
  shownAt: { location: LocationView }[];
  content: Record_;
  locations: { location: LocationView; shown: boolean }[];
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

describe("A Basket archived in DYE2, and one its Location hides", { timeout: 90_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => {
    await server?.stop();
  });

  /** The built plugin on a tablet of the Machine, where DYE2 was never used, connected to an instance. */
  const load = (machine: CreatedMachine, serial: string, instance: TestServer = server): SimulatedTablet =>
    syncingTablet(machine, instance, { api: dye2NeverUsed(serial) });
  const list = async (kind: "baskets" | "tools") => (await api.get<Record<string, EquipmentView[]>>(`/${kind}`))[kind]!;
  const view = async (kind: "baskets" | "tools", id: string) =>
    (await api.get<Record<string, EquipmentView>>(`/${kind}/${id}`))[kind === "baskets" ? "basket" : "tool"]!;
  const named = async (kind: "baskets" | "tools", name: string) => (await list(kind)).filter((item) => item.name === name);
  /** The Locations showing the only item of that name, by name. */
  const shownAt = async (kind: "baskets" | "tools", name: string) => {
    const items = await named(kind, name);
    return items.length === 1 ? items[0]!.shownAt.map((here) => here.location.name) : `${items.length} named so`;
  };
  /** Whether each Location that decided it shows the Basket, by name. */
  const decided = async (id: string) => (await view("baskets", id)).locations.map(({ location, shown }) => [location.name, shown]);
  const records = (tablet: SimulatedTablet, key: Dye2Key): Record_[] => {
    const value = dye2List(tablet, key);
    return Array.isArray(value) ? (value as Record_[]) : [];
  };
  const recordNamed = (tablet: SimulatedTablet, key: Dye2Key, name: string) => records(tablet, key).find((record) => record.name === name);
  /** Whether the tablet's record of that name is archived, or undefined if it holds none. */
  const archivedOn = (tablet: SimulatedTablet, name: string) => {
    const record = recordNamed(tablet, "baskets", name);
    return record === undefined ? undefined : record.archived === true;
  };
  const show = (kind: "baskets" | "tools", id: string, location: LocationView, shown: boolean) => api.call("PUT", `/${kind}/${id}/locations/${location.id}`, { shown });
  /** Waits until a report of the tablet's baskets lists its record with that id, so one gone from it later was deleted there. */
  const listed = async (machine: CreatedMachine, localId: unknown) => {
    const reported = async () =>
      (await api.get<{ collection: { value: Record_[] } | null }>(`/machines/${machine.machine.id}/collections/dye2Baskets`)).collection?.value ?? [];
    await expect.poll(async () => (await reported()).map((record) => record.id)).toContain(localId);
  };

  const baskets = dye2PagesRecording("baskets") as Record<"create18gBasket" | "create20gBasket", Dye2Exchange[]>;
  const tools = dye2PagesRecording("tools") as Record<"createPuckScreen", Dye2Exchange[]>;
  const ownNames = (scenario: string) => (item: Record_) => ({ ...item, name: `${scenario} ${String(item.name)}` });

  it("hides a Basket archived in DYE2 at that tablet's Location only, archiving it on the other tablets there, takes an edit of it as before, and shows it there again on UNARCHIVE", async () => {
    const lab = await api.createLocation("Archived lab", "America/Chicago");
    const cafe = await api.createLocation("Archived cafe", "America/Chicago");
    const machines = [await api.createMachine("Archived lab 1", lab.id), await api.createMachine("Archived lab 2", lab.id), await api.createMachine("Archived cafe 1", cafe.id)] as const;
    const one = load(machines[0], "61801");
    const two = load(machines[1], "61802", other);
    const cafeTablet = load(machines[2], "61803");
    await api.waitForOnline(...machines);
    const name = "Archived Fixture 18g Precision";
    await saveInDye2(one, baskets.create18gBasket, ownNames("Archived"));
    await expect.poll(() => shownAt("baskets", name)).toEqual(["Archived lab"]);
    const [basket] = await named("baskets", name);
    expect((await show("baskets", basket!.id, cafe, true)).status).toBe(200);
    for (const tablet of [two, cafeTablet]) await expect.poll(() => recordNamed(tablet, "baskets", name)?.[GLOBAL_ID_KEY]).toBe(basket!.id);
    // Not while the global id written back to the first tablet's record could still lose the archive (ADR-0005).
    await expect.poll(() => recordNamed(one, "baskets", name)?.[GLOBAL_ID_KEY]).toBe(basket!.id);
    const localId = String(recordNamed(one, "baskets", name)!.id);
    const content = (await view("baskets", basket!.id)).content;

    // ARCHIVE in DYE2's Basket picker on the first tablet: hidden at the lab, shown at the cafe, not Archived, its content as it was.
    await archiveBasketInDye2(one, localId, true);
    await expect.poll(() => decided(basket!.id)).toEqual([
      ["Archived cafe", true],
      ["Archived lab", false],
    ]);
    expect(await view("baskets", basket!.id)).toMatchObject({ archived: false, content });
    expect((await view("baskets", basket!.id)).content).not.toHaveProperty("archived");
    // The lab's other tablet has its record archived, not removed; the cafe's keeps it, not archived.
    await expect.poll(() => archivedOn(two, name)).toBe(true);
    expect(archivedOn(one, name)).toBe(true);
    expect(archivedOn(cafeTablet, name)).toBe(false);

    // An edit of the archived record's notes on the first tablet, its form carrying `archived` over, is an edit of the
    // Basket's content, which reaches every tablet that holds it, and changes no Location's state.
    await editBasketInDye2(one, localId, { name, size: "double", notes: "Retired at the lab", diameterMm: 58.5 });
    for (const tablet of [two, cafeTablet]) await expect.poll(() => recordNamed(tablet, "baskets", name)?.notes).toBe("Retired at the lab");
    expect((await view("baskets", basket!.id)).content).toEqual({ ...content, notes: "Retired at the lab" });
    expect(archivedOn(two, name)).toBe(true);
    expect(archivedOn(cafeTablet, name)).toBe(false);
    expect(await decided(basket!.id)).toEqual([
      ["Archived cafe", true],
      ["Archived lab", false],
    ]);

    // UNARCHIVE at its first tap on the lab's other tablet, whose record the server archived: shown at the lab again, and
    // the first tablet has the flag cleared.
    await archiveBasketInDye2(two, String(recordNamed(two, "baskets", name)!.id), false);
    await expect.poll(() => shownAt("baskets", name)).toEqual(["Archived cafe", "Archived lab"]);
    await expect.poll(() => recordNamed(one, "baskets", name)?.archived).toBe(false);
    expect(archivedOn(two, name)).toBe(false);
    expect((await view("baskets", basket!.id)).content).toEqual({ ...content, notes: "Retired at the lab" });
  });

  it("archives a Basket hidden at a Location in the management interface on that Location's tablets, removing none, clears the flag once shown again, and still removes a Tool hidden there", async () => {
    const lab = await api.createLocation("Hidden lab", "America/Chicago");
    const machines = [await api.createMachine("Hidden lab 1", lab.id), await api.createMachine("Hidden lab 2", lab.id), await api.createMachine("Hidden lab 3", lab.id)] as const;
    const one = load(machines[0], "61811");
    const two = load(machines[1], "61812", other);
    await api.waitForOnline(machines[0], machines[1]);
    const hidden = "Hidden Fixture 20g High-flow";
    const kept = "Hidden Fixture 18g Precision";
    const toolName = "Hidden Fixture Puck Screen";
    await saveInDye2(one, baskets.create20gBasket, ownNames("Hidden"));
    await saveInDye2(one, baskets.create18gBasket, ownNames("Hidden"));
    await saveInDye2(one, tools.createPuckScreen, ownNames("Hidden"));
    for (const tablet of [one, two]) {
      for (const each of [hidden, kept]) await expect.poll(() => recordNamed(tablet, "baskets", each)?.[GLOBAL_ID_KEY]).toEqual(expect.any(String));
      await expect.poll(() => recordNamed(tablet, "equipment", toolName)?.[GLOBAL_ID_KEY]).toEqual(expect.any(String));
    }
    const [basket] = await named("baskets", hidden);
    const [tool] = await named("tools", toolName);

    expect((await show("baskets", basket!.id, lab, false)).status).toBe(200);
    expect((await show("tools", tool!.id, lab, false)).status).toBe(200);
    // The Basket's record is archived on both tablets, kept with its id and content; the Tool's leaves both lists.
    for (const tablet of [one, two]) {
      await expect.poll(() => archivedOn(tablet, hidden)).toBe(true);
      await expect.poll(() => recordNamed(tablet, "equipment", toolName)).toBeUndefined();
      expect(recordNamed(tablet, "baskets", hidden)).toMatchObject({ name: hidden, size: "double", [GLOBAL_ID_KEY]: basket!.id });
      expect(archivedOn(tablet, kept)).toBe(false);
    }
    expect(await view("baskets", basket!.id)).toMatchObject({ archived: false, shownAt: [] });

    // A tablet that joins the lab now lacks the hidden Basket's record, and is written none; it gets the one the lab shows.
    const three = load(machines[2], "61813");
    await api.waitForOnline(machines[2]);
    await expect.poll(() => recordNamed(three, "baskets", kept)?.[GLOBAL_ID_KEY]).toEqual(expect.any(String));
    expect(recordNamed(three, "baskets", hidden)).toBeUndefined();

    // Shown again, its records are unarchived, as DYE2's UNARCHIVE writes them, and the new tablet gets it.
    expect((await show("baskets", basket!.id, lab, true)).status).toBe(200);
    for (const tablet of [one, two]) await expect.poll(() => recordNamed(tablet, "baskets", hidden)?.archived).toBe(false);
    await expect.poll(() => archivedOn(three, hidden)).toBe(false);

    // ARCHIVE at its first tap on a tablet whose record the server unarchived: hidden at the lab again, and archived on its
    // other tablets.
    await archiveBasketInDye2(two, String(recordNamed(two, "baskets", hidden)!.id), true);
    await expect.poll(() => decided(basket!.id)).toEqual([["Hidden lab", false]]);
    for (const tablet of [one, three]) await expect.poll(() => archivedOn(tablet, hidden)).toBe(true);
    expect(archivedOn(two, hidden)).toBe(true);
  });

  it("hides a Basket deleted in DYE2 at that Location only, archiving it on the Location's other tablets, and writes it back to none", async () => {
    const lab = await api.createLocation("Basket deleted lab", "America/Chicago");
    const cafe = await api.createLocation("Basket deleted cafe", "America/Chicago");
    const machines = [
      await api.createMachine("Basket deleted lab 1", lab.id),
      await api.createMachine("Basket deleted lab 2", lab.id),
      await api.createMachine("Basket deleted cafe 1", cafe.id),
    ] as const;
    const one = load(machines[0], "61821");
    const two = load(machines[1], "61822", other);
    const cafeTablet = load(machines[2], "61823");
    await api.waitForOnline(...machines);
    const name = "Basket deleted Fixture 18g Precision";
    await saveInDye2(one, baskets.create18gBasket, ownNames("Basket deleted"));
    await expect.poll(() => shownAt("baskets", name)).toEqual(["Basket deleted lab"]);
    const [basket] = await named("baskets", name);
    await show("baskets", basket!.id, cafe, true);
    for (const tablet of [one, two, cafeTablet]) await expect.poll(() => recordNamed(tablet, "baskets", name)?.[GLOBAL_ID_KEY]).toBe(basket!.id);

    // DELETE in DYE2's Basket picker on the second tablet, once a report listed its record there.
    const localId = String(recordNamed(two, "baskets", name)!.id);
    await listed(machines[1], localId);
    await deleteBasketInDye2(two, localId);
    await expect.poll(() => decided(basket!.id)).toEqual([
      ["Basket deleted cafe", true],
      ["Basket deleted lab", false],
    ]);
    // The first tablet's record is archived, kept; the cafe's is untouched; the tablet that deleted it is written none.
    await expect.poll(() => archivedOn(one, name)).toBe(true);
    expect(archivedOn(cafeTablet, name)).toBe(false);
    expect(recordNamed(two, "baskets", name)).toBeUndefined();
    expect((await view("baskets", basket!.id)).archived).toBe(false);
  });
});
