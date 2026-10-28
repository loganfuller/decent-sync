import { GLOBAL_ID_KEY } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { syncingTablet } from "./support/loaded-tablets.js";
import { type Dye2Exchange, type Dye2Key, DYE2_NAMESPACE, dye2List, dye2NeverUsed, dye2PagesRecording, saveInDye2 } from "./support/simulated-dye2.js";
import type { DecaidApi, SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #138: Baskets and Tools, which DYE2 keeps in lists in
// Decaid's store, shared through the Library (ADR-0005). One created in DYE2
// on a tablet joins the Library, shown at that tablet's Location only, and is
// written to the Location's other tablets; one of the same name entered at
// another Location is the same item (ADR-0018); edits reach every tablet that
// holds it, merged per field (ADR-0020); deleting a Tool on a tablet hides it
// at its Location only (ADR-0019), and what a Location does not show is
// removed from its tablets' lists. And for ticket #142, a save from a DYE2
// page opened before another tablet's change keeps that change (ADR-0005).
// Through the built plugin in simulated tablets, acting as DYE2's equipment and
// baskets pages do with the steps recorded from them at 2cf631c, which
// v0.1.26's pages save as (fixtures/decaid/dye2-2cf631c/), on two
// server instances sharing one database, with assertions through the REST
// API and what each simulated tablet's store holds. Serials are made up, from 41001.

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

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => {
    await server?.stop();
  });

  /**
   * The tablet's Decaid: a DE1Pro with an empty library, and DYE2's keys
   * never written, as on a tablet where DYE2 was never used, unless `store`
   * gives them values.
   */
  function decaid(serial: string, store: Partial<Record<Dye2Key, unknown>> = {}): DecaidApi {
    const api = dye2NeverUsed(serial);
    for (const [key, value] of Object.entries(store)) api[`/store/${DYE2_NAMESPACE}/${key}`] = value;
    return api;
  }

  /** The built plugin on a tablet of the Machine, connected to an instance, polling every 5 s (0.1 s here) unless `pollSeconds` says otherwise. */
  function load(
    machine: CreatedMachine,
    decaidApi: DecaidApi,
    { instance = server, ...options }: { instance?: TestServer; storage?: SimulatedTablet["storage"]; pollSeconds?: number } = {},
  ): SimulatedTablet {
    return syncingTablet(machine, instance, { api: decaidApi, ...options });
  }

  const list = async (kind: "baskets" | "tools") => (await api.get<Record<string, EquipmentView[]>>(`/${kind}`))[kind]!;
  const view = async (kind: "baskets" | "tools", id: string) =>
    (await api.get<Record<string, EquipmentView>>(`/${kind}/${id}`))[kind === "baskets" ? "basket" : "tool"]!;
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

  /** The kind of the Library's items each of DYE2's lists holds, as the server's writes name it. */
  const KIND_OF: Record<Dye2Key, string> = { baskets: "basket", equipment: "tool", recipes: "recipe" };

  /**
   * Has DYE2, which read the list just before, post it back just after the
   * plugin's next write of the key, losing that write. `taken()` waits until
   * DYE2's post has landed and the server has acknowledged the plugin's
   * answer to the write: until then, the list may still show the write, and
   * the server, still awaiting the answer, plans from the tablet's record as
   * it was before the write, so a sharing status of nothing waiting says
   * nothing of it. Should that not come, it fails naming the furthest stage
   * the write reached (`stage`), and only then prints what the tablet and
   * both instances sent and logged since the loss was set up, as asking the
   * server for its state while the write is due could change its timing
   * (#163).
   */
  const loseNextWrite = (tablet: SimulatedTablet, key: Dye2Key) => {
    const before = structuredClone(dye2List(tablet, key) ?? []);
    const from = { received: tablet.received.length, sent: tablet.sent.length, requests: tablet.requests.length, logs: tablet.logs.length };
    const outputFrom = [server, other].map((instance) => instance.output().length);
    /** Where in what the plugin sent its answer to the write lost comes, the next answer it sends, as it writes one item at a time. */
    let answerFrom: number | undefined;
    let posted = false;
    tablet.refuseWrites = ({ method, route }) => {
      if (answerFrom === undefined && method === "POST" && route === `/store/${DYE2_NAMESPACE}/${key}`) {
        answerFrom = tablet.sent.length;
        setImmediate(() => {
          void tablet.callApi("POST", `/store/${DYE2_NAMESPACE}/${key}`, before).then(() => {
            posted = true;
          });
        });
      }
      return undefined;
    };
    const frames = (list: unknown[]) => list as { type?: unknown; id?: unknown; kind?: unknown }[];
    /** The furthest the write lost has got, from the server's sending it to its acknowledging the answer. */
    const stage = () => {
      if (answerFrom === undefined) {
        const sent = frames(tablet.received.slice(from.received)).some(
          (frame) => (frame.type === "write" || frame.type === "remove") && frame.kind === KIND_OF[key],
        );
        return sent ? "write not carried out" : "no write sent";
      }
      if (!posted) return "rewrite not posted";
      const answer = frames(tablet.sent.slice(answerFrom)).find((frame) => frame.type === "written" || frame.type === "removed");
      if (answer === undefined) return "no answer sent";
      return tablet.acks(answer.id) > 0 ? "answer acknowledged" : "answer not acknowledged";
    };
    /** The frames, but heartbeats, one to a line, each cut to 400 characters, with a hello's token left out (AGENTS.md). */
    const shown = (list: unknown[]) => {
      const beats = frames(list).filter((frame) => frame.type === "heartbeat").length;
      const lines = frames(list)
        .filter((frame) => frame.type !== "heartbeat")
        .map((frame) => {
          const text = JSON.stringify(frame, (field, value: unknown) => (field === "token" ? "(left out)" : value)) ?? String(frame);
          return `  ${text.length > 400 ? `${text.slice(0, 400)}...` : text}`;
        });
      return [...lines, `  and ${beats} heartbeats`];
    };
    const since = () =>
      [
        `The tablet received:`,
        ...shown(tablet.received.slice(from.received)),
        `The tablet sent:`,
        ...shown(tablet.sent.slice(from.sent)),
        `The plugin requested of Decaid: ${tablet.requests.slice(from.requests).join(", ")}`,
        `The plugin logged:`,
        ...tablet.logs.slice(from.logs).map((line) => `  ${line}`),
        ...[server, other].flatMap((instance, index) => [`The ${index === 0 ? "first" : "second"} instance logged:`, instance.output().slice(outputFrom[index])]),
      ].join("\n");
    return {
      async taken() {
        try {
          await expect.poll(stage).toBe("answer acknowledged");
        } catch (error) {
          console.error(`The write of ${key} lost reached no further than "${stage()}". Since its loss was set up:\n${since()}`);
          throw error;
        }
      },
    };
  };

  const baskets = dye2PagesRecording("baskets") as Record<"create18gBasket" | "create20gBasket" | "edit18gBasket", Dye2Exchange[]>;
  const tools = dye2PagesRecording("tools") as Record<"createWdtTool" | "createPuckScreen" | "createSpareTamper" | "editWdtTool" | "deleteSpareTamper", Dye2Exchange[]>;
  /** Names each item a recorded step saves as the scenario's own, as Baskets and Tools are matched by name across scenarios. */
  const ownNames = (scenario: string) => (item: Record_) => ({ ...item, name: `${scenario} ${String(item.name)}` });

  it("writes a Basket created in DYE2 to the tablets at its Location, those whose keys were never written too, and to no other Location's", async () => {
    const lab = await api.createLocation("Created lab", "America/Chicago");
    const cafe = await api.createLocation("Created cafe", "America/Chicago");
    const machines = [await api.createMachine("Created lab 1", lab.id), await api.createMachine("Created lab 2", lab.id), await api.createMachine("Created cafe 1", cafe.id)] as const;
    const one = load(machines[0], decaid("41001"));
    const two = load(machines[1], decaid("41002"), { instance: other });
    const cafeTablet = load(machines[2], decaid("41003"));
    await api.waitForOnline(...machines);

    await saveInDye2(one, baskets.create18gBasket);
    await expect.poll(() => shownAt("baskets", "Fixture 18g Precision")).toEqual(["Created lab"]);
    const [basket] = await named("baskets", "Fixture 18g Precision");
    expect(basket).toMatchObject({ archived: false, createdLocation: { name: "Created lab" } });
    expect((await view("baskets", basket!.id)).content).toEqual({ name: "Fixture 18g Precision", size: "double", notes: "Fixture notes", diameterMm: 58.5 });
    // The tablet that created it carries its global id in a field of its own; the other tablet there, whose key was never
    // written, holds it under an id of its own, with its global id.
    await expect.poll(() => recordNamed(one, "baskets", "Fixture 18g Precision")?.[GLOBAL_ID_KEY]).toBe(basket!.id);
    await expect.poll(() => recordNamed(two, "baskets", "Fixture 18g Precision")).toMatchObject({
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
    await expect.poll(() => recordNamed(cafeTablet, "baskets", "Fixture 18g Precision")?.[GLOBAL_ID_KEY]).toBe(basket!.id);
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
    await api.waitForOnline(...machines);

    await saveInDye2(labTablet, baskets.create20gBasket);
    await expect.poll(() => shownAt("baskets", "Fixture 20g High-flow")).toEqual(["Matched lab"]);
    // The cafe enters it as its own, in other case and with spaces, under an id of its own.
    await saveInDye2(cafeTablet, baskets.create20gBasket, (item) => ({ ...item, id: "bskt-cafe-20", name: "  fixture 20G HIGH-FLOW " }));
    await expect.poll(() => shownAt("baskets", "Fixture 20g High-flow")).toEqual(["Matched cafe", "Matched lab"]);
    const [basket] = await named("baskets", "Fixture 20g High-flow");
    // The cafe's record is that Basket, and takes its name.
    await expect.poll(() => records(cafeTablet, "baskets")).toEqual([
      expect.objectContaining({ id: "bskt-cafe-20", name: "Fixture 20g High-flow", [GLOBAL_ID_KEY]: basket!.id }),
    ]);
    expect(roasteryTablet.storeWrites.filter((write) => write.namespace === DYE2_NAMESPACE)).toEqual([]);

    expect((await show("baskets", basket!.id, roastery, true)).status).toBe(200);
    await expect.poll(() => recordNamed(roasteryTablet, "baskets", "Fixture 20g High-flow")?.[GLOBAL_ID_KEY]).toBe(basket!.id);
    expect(await named("baskets", "Fixture 20g High-flow")).toHaveLength(1);
  });

  it("writes an edit of a Tool's attributes on one tablet to every tablet that holds it, and keeps two edits made without seeing each other as a Conflict", async () => {
    const lab = await api.createLocation("Edited lab", "America/Chicago");
    const cafe = await api.createLocation("Edited cafe", "America/Chicago");
    const machines = [await api.createMachine("Edited lab 1", lab.id), await api.createMachine("Edited lab 2", lab.id), await api.createMachine("Edited cafe 1", cafe.id)] as const;
    const one = load(machines[0], decaid("41021"));
    const two = load(machines[1], decaid("41022"), { instance: other });
    const cafeTablet = load(machines[2], decaid("41023"));
    await api.waitForOnline(...machines);

    // The other tablets' equipment keys were never written: each gets the Tool all the same.
    for (const tablet of [two, cafeTablet]) expect(dye2List(tablet, "equipment")).toBeNull();
    await saveInDye2(one, tools.createWdtTool);
    await expect.poll(() => shownAt("tools", "Fixture WDT Tool")).toEqual(["Edited lab"]);
    const [tool] = await named("tools", "Fixture WDT Tool");
    expect((await show("tools", tool!.id, cafe, true)).status).toBe(200);
    await expect.poll(() => recordNamed(cafeTablet, "equipment", "Fixture WDT Tool")).toBeDefined();
    await expect.poll(() => recordNamed(two, "equipment", "Fixture WDT Tool")).toBeDefined();
    // Not while the global id written back to the first tablet's record could still lose an edit there (ADR-0005).
    await expect.poll(() => recordNamed(one, "equipment", "Fixture WDT Tool")?.[GLOBAL_ID_KEY]).toBe(tool!.id);

    // DYE2's equipment page on the first tablet changes the needles from 8 to 10: every tablet holding it, at both Locations, gets it.
    await saveInDye2(one, tools.editWdtTool);
    const needles = (tablet: SimulatedTablet) => (recordNamed(tablet, "equipment", "Fixture WDT Tool")?.custom as Record_[] | undefined)?.[0]?.value;
    for (const tablet of [two, cafeTablet]) await expect.poll(() => needles(tablet)).toBe("10");
    expect((await view("tools", tool!.id)).content.custom).toEqual([
      { key: "Needles", value: "10" },
      { key: "Needle size", value: "0.3 mm" },
    ]);

    // Offline, the cafe's tablet misses the lab setting 14, then sets 12. Neither saw the other's.
    cafeTablet.loseNetwork();
    await api.waitForMachine("Edited cafe 1", (viewed) => !viewed.online, 15_000);
    const setNeedles = async (tablet: SimulatedTablet, value: string) => {
      const list = records(tablet, "equipment").map((record) =>
        record.name === "Fixture WDT Tool" ? { ...record, custom: [{ key: "Needles", value }, { key: "Needle size", value: "0.3 mm" }] } : record,
      );
      expect((await tablet.callApi("POST", `/store/${DYE2_NAMESPACE}/equipment`, list)).status).toBe(200);
    };
    await setNeedles(one, "14");
    await expect.poll(() => needles(two)).toBe("14");
    await setNeedles(cafeTablet, "12");
    // Back online, the cafe's edit, made and read after the lab's, wins, and the lab's value is kept as a Conflict.
    cafeTablet.restoreNetwork();
    for (const tablet of [one, two]) await expect.poll(() => needles(tablet)).toBe("12");
    const conflicts = (await api.get<{ conflicts: { field: string; value: unknown }[] }>(`/tools/${tool!.id}/conflicts`)).conflicts;
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
    await api.waitForOnline(...machines);

    await saveInDye2(one, tools.createSpareTamper, ownNames("Deleted"));
    await expect.poll(() => shownAt("tools", "Deleted Fixture Spare Tamper")).toEqual(["Deleted lab"]);
    const [tool] = await named("tools", "Deleted Fixture Spare Tamper");
    await show("tools", tool!.id, cafe, true);
    for (const tablet of [two, cafeTablet]) await expect.poll(() => recordNamed(tablet, "equipment", "Deleted Fixture Spare Tamper")).toBeDefined();

    // DYE2's equipment page deletes it on the second tablet, under that tablet's id for it, once a report has listed it there:
    // one gone before that was lost to another app's rewrite, and is written again.
    const localId = recordNamed(two, "equipment", "Deleted Fixture Spare Tamper")!.id;
    const reported = async () =>
      (await api.get<{ collection: { value: Record_[] } | null }>(`/machines/${machines[1].machine.id}/collections/dye2Equipment`)).collection?.value ?? [];
    await expect.poll(async () => (await reported()).map((record) => record.id)).toContain(localId);
    await saveInDye2(two, tools.deleteSpareTamper, (item) => ({ ...ownNames("Deleted")(item), id: localId }));
    await expect.poll(() => shownAt("tools", "Deleted Fixture Spare Tamper")).toEqual(["Deleted cafe"]);
    await expect.poll(() => recordNamed(one, "equipment", "Deleted Fixture Spare Tamper")).toBeUndefined();
    expect(recordNamed(cafeTablet, "equipment", "Deleted Fixture Spare Tamper")).toBeDefined();
    // Still in the Library, it is hidden at the lab, and its hiding there was the second tablet's.
    expect((await view("tools", tool!.id)).locations.map(({ location, shown }) => [location.name, shown])).toEqual([
      ["Deleted cafe", true],
      ["Deleted lab", false],
    ]);

    // Hidden at the cafe through the REST API, it is removed from the cafe's tablet, and nothing is written to the lab's.
    // Its removal lost to DYE2 posting the list back at once, the record comes back, and is removed again.
    const removalLost = loseNextWrite(cafeTablet, "equipment");
    const cafeWrites = cafeTablet.storeWrites.filter((write) => write.key === "equipment").length;
    expect((await show("tools", tool!.id, cafe, false)).status).toBe(200);
    await removalLost.taken();
    await expect.poll(() => recordNamed(cafeTablet, "equipment", "Deleted Fixture Spare Tamper")).toBeUndefined();
    expect(cafeTablet.storeWrites.filter((write) => write.key === "equipment").length).toBeGreaterThanOrEqual(cafeWrites + 2);
    expect(await shownAt("tools", "Deleted Fixture Spare Tamper")).toEqual([]);
    // The tablet's answer, which its sharing status shows, follows its removal from the list.
    const lastApplied = async () =>
      (await api.get<{ status: { lastApplied: Record_ } }>(`/machines/${machines[2].machine.id}/sharing-status`)).status.lastApplied;
    await expect
      .poll(lastApplied)
      .toMatchObject({ change: "remove", kind: "tool", item: { kind: "tool", id: tool!.id, name: "Deleted Fixture Spare Tamper" } });
  });

  it("writes nothing to a list in a shape it does not recognise, showing it in the sharing status, while the tablet's other lists keep syncing", async () => {
    const lab = await api.createLocation("Unrecognised lab", "America/Chicago");
    const machines = [await api.createMachine("Unrecognised lab 1", lab.id), await api.createMachine("Unrecognised lab 2", lab.id)] as const;
    const one = load(machines[0], decaid("41041"));
    const broken = { baskets: { "1": { name: "A basket in a shape DYE2 never saved" } } };
    const two = load(machines[1], decaid("41042", { baskets: broken }), { instance: other });
    await api.waitForOnline(...machines);
    const status = async () =>
      (await api.get<{ status: { unrecognisedLists: { list: string }[] } }>(`/machines/${machines[1].machine.id}/sharing-status`)).status;
    await expect.poll(async () => (await status()).unrecognisedLists.map(({ list }) => list)).toEqual(["dye2Baskets"]);

    await saveInDye2(one, baskets.create18gBasket, ownNames("Unrecognised"));
    await saveInDye2(one, tools.createPuckScreen, ownNames("Unrecognised"));
    const bean = await one.addBean({ roaster: "Unrecognised Roaster", name: "Still Syncing" });
    // Its tools and beans are written, as is its other tablet's; its baskets are not.
    await expect.poll(() => recordNamed(two, "equipment", "Unrecognised Fixture Puck Screen")).toBeDefined();
    await expect.poll(() => two.beans().map((record) => record.name)).toContain(bean.name);
    expect(dye2List(two, "baskets")).toEqual(broken);
    expect(two.storeWrites.filter((write) => write.key === "baskets")).toEqual([]);
    expect(await shownAt("baskets", "Unrecognised Fixture 18g Precision")).toEqual(["Unrecognised lab"]);

    // Saved again as a list DYE2 keeps, it is written again.
    expect((await two.callApi("POST", `/store/${DYE2_NAMESPACE}/baskets`, [])).status).toBe(200);
    await expect.poll(() => recordNamed(two, "baskets", "Unrecognised Fixture 18g Precision")).toBeDefined();
    expect((await status()).unrecognisedLists).toEqual([]);
  });

  it("writes nothing to a list the plugin finds in a shape it does not recognise only as it writes, showing it in the sharing status", async () => {
    const lab = await api.createLocation("Unrecognised late lab", "America/Chicago");
    const machines = [await api.createMachine("Unrecognised late lab 1", lab.id), await api.createMachine("Unrecognised late lab 2", lab.id)] as const;
    const one = load(machines[0], decaid("41081"));
    // The second tablet reads its lists once an hour (72 s here), so it reports them once in this test, as it connects.
    const two = load(machines[1], decaid("41082", { baskets: [], equipment: [] }), { instance: other, pollSeconds: 3600 });
    await api.waitForOnline(...machines);
    const reported = async () =>
      (await api.get<{ collection: { value: unknown } | null }>(`/machines/${machines[1].machine.id}/collections/dye2Baskets`)).collection;
    await expect.poll(async () => (await reported())?.value).toEqual([]);
    // Another app then saves its baskets in a shape DYE2 never saves, unread by the plugin until it writes there.
    const broken = { baskets: [] };
    expect((await two.callApi("POST", `/store/${DYE2_NAMESPACE}/baskets`, broken)).status).toBe(200);

    await saveInDye2(one, baskets.create18gBasket, ownNames("Unrecognised late"));
    await saveInDye2(one, tools.createPuckScreen, ownNames("Unrecognised late"));
    const status = async () =>
      (await api.get<{ status: { unrecognisedLists: { list: string }[] } }>(`/machines/${machines[1].machine.id}/sharing-status`)).status;
    await expect.poll(async () => (await status()).unrecognisedLists.map(({ list }) => list)).toEqual(["dye2Baskets"]);
    // Its tools are written; its baskets are left as they were, and its report of them is as it was.
    await expect.poll(() => recordNamed(two, "equipment", "Unrecognised late Fixture Puck Screen")).toBeDefined();
    expect(dye2List(two, "baskets")).toEqual(broken);
    expect(two.storeWrites.filter((write) => write.key === "baskets")).toEqual([]);
    expect((await reported())?.value).toEqual([]);
  });

  it("lets Staff show and hide a Basket or Tool only at their own Locations, and answers 404 for one or a Location there is none of", async () => {
    const home = await api.createLocation("Equipment staff home", "America/Chicago");
    const elsewhere = await api.createLocation("Equipment staff elsewhere", "America/Chicago");
    const machine = await api.createMachine("Equipment staff elsewhere 1", elsewhere.id);
    const tablet = load(machine, decaid("41091"));
    await api.waitForOnline(machine);
    await saveInDye2(tablet, tools.createSpareTamper, ownNames("Equipment staff"));
    await expect.poll(() => shownAt("tools", "Equipment staff Fixture Spare Tamper")).toEqual(["Equipment staff elsewhere"]);
    const [tool] = await named("tools", "Equipment staff Fixture Spare Tamper");
    const staff = await api.staffAt("staff-138@example.com", home);
    const showAs = (who: AdminApi, kind: "baskets" | "tools", id: string, location: string, shown: boolean) =>
      who.call("PUT", `/${kind}/${id}/locations/${location}`, { shown });

    expect((await showAs(staff, "tools", tool!.id, home.id, true)).status).toBe(200);
    expect((await showAs(staff, "tools", tool!.id, home.id, false)).status).toBe(200);
    expect((await showAs(staff, "tools", tool!.id, elsewhere.id, false)).status).toBe(403);
    expect((await staff.call("GET", `/tools/${tool!.id}`)).status).toBe(200);
    expect(await shownAt("tools", "Equipment staff Fixture Spare Tamper")).toEqual(["Equipment staff elsewhere"]);
    const none = "00000000-0000-4000-8000-000000000138";
    expect((await showAs(api, "tools", none, home.id, true)).status).toBe(404);
    expect((await showAs(api, "baskets", tool!.id, home.id, true)).status).toBe(404);
    expect((await showAs(api, "tools", tool!.id, none, true)).status).toBe(404);
    expect((await api.call("GET", `/baskets/${none}`)).status).toBe(404);
  });

  it("writes again what another app's rewrite of the list lost as the plugin wrote it", async () => {
    const lab = await api.createLocation("Lost lab", "America/Chicago");
    const machines = [await api.createMachine("Lost lab 1", lab.id), await api.createMachine("Lost lab 2", lab.id)] as const;
    const one = load(machines[0], decaid("41051"));
    const two = load(machines[1], decaid("41052"), { instance: other });
    await api.waitForOnline(...machines);
    // A create lost.
    const createLost = loseNextWrite(two, "baskets");
    await saveInDye2(one, baskets.create18gBasket, ownNames("Lost"));
    await createLost.taken();
    await expect.poll(() => recordNamed(two, "baskets", "Lost Fixture 18g Precision")).toBeDefined();
    expect(two.storeWrites.filter((write) => write.key === "baskets").length).toBeGreaterThanOrEqual(2);
    expect(await shownAt("baskets", "Lost Fixture 18g Precision")).toEqual(["Lost lab"]);

    // An edit lost: the record comes back as it was before the plugin's write, which is no edit of the tablet's. The
    // first tablet edits it once its record carries the global id written back to it, as an edit while that write reads
    // and posts the list would be lost to it (ADR-0005).
    await expect.poll(() => records(two, "baskets").length).toBe(1);
    await expect.poll(() => recordNamed(one, "baskets", "Lost Fixture 18g Precision")?.[GLOBAL_ID_KEY]).toBeDefined();
    const editLost = loseNextWrite(two, "baskets");
    await saveInDye2(one, baskets.edit18gBasket, ownNames("Lost"));
    await editLost.taken();
    await expect.poll(() => recordNamed(two, "baskets", "Lost Fixture 18g Precision")?.notes).toBe("Fixture notes, edited");
    const [basket] = await named("baskets", "Lost Fixture 18g Precision");
    expect((await view("baskets", basket!.id)).content).toMatchObject({ notes: "Fixture notes, edited", diameterMm: 58.4 });
    await expect.poll(() => recordNamed(one, "baskets", "Lost Fixture 18g Precision")?.notes).toBe("Fixture notes, edited");

    // The first tablet edits the notes, which the second is written. A barista there then sets them back to what it held
    // before that write: taken as a stale save, the Basket's notes are written back. Set again, it is their edit.
    const setNotes = async (tablet: SimulatedTablet, notes: string) => {
      const list = records(tablet, "baskets").map((record) => (record.name === "Lost Fixture 18g Precision" ? { ...record, notes } : record));
      expect((await tablet.callApi("POST", `/store/${DYE2_NAMESPACE}/baskets`, list)).status).toBe(200);
    };
    const notesOn = (tablet: SimulatedTablet) => () => recordNamed(tablet, "baskets", "Lost Fixture 18g Precision")?.notes;
    await setNotes(one, "Re-measured");
    await expect.poll(notesOn(two)).toBe("Re-measured");
    const writesOfBaskets = two.storeWrites.filter((write) => write.key === "baskets").length;
    await setNotes(two, "Fixture notes, edited");
    await expect.poll(() => two.storeWrites.filter((write) => write.key === "baskets").length).toBeGreaterThan(writesOfBaskets);
    await expect.poll(notesOn(two)).toBe("Re-measured");
    await setNotes(two, "Fixture notes, edited");
    await expect.poll(notesOn(one)).toBe("Fixture notes, edited");
    expect((await view("baskets", basket!.id)).content).toMatchObject({ notes: "Fixture notes, edited" });
  });

  it("keeps another tablet's change of a Basket and a Tool saved from DYE2 pages opened before it, and spreads what the saves changed", async () => {
    const lab = await api.createLocation("Stale lab", "America/Chicago");
    const machines = [await api.createMachine("Stale lab 1", lab.id), await api.createMachine("Stale lab 2", lab.id)] as const;
    const one = load(machines[0], decaid("41111"));
    const two = load(machines[1], decaid("41112"), { instance: other });
    await api.waitForOnline(...machines);
    // The first tablet's baskets and equipment pages open on them as created: the values the recorded edits were made from.
    await saveInDye2(one, baskets.create18gBasket, ownNames("Stale"));
    await saveInDye2(one, tools.createWdtTool, ownNames("Stale"));
    await expect.poll(() => recordNamed(two, "baskets", "Stale Fixture 18g Precision")?.[GLOBAL_ID_KEY]).toBeDefined();
    await expect.poll(() => recordNamed(two, "equipment", "Stale Fixture WDT Tool")?.[GLOBAL_ID_KEY]).toBeDefined();
    const [basket] = await named("baskets", "Stale Fixture 18g Precision");
    const [tool] = await named("tools", "Stale Fixture WDT Tool");
    /** The tablet's record of the item in DYE2's list, by the global id it carries. */
    const held = (tablet: SimulatedTablet, key: Dye2Key, id: string) => records(tablet, key).find((record) => record[GLOBAL_ID_KEY] === id);
    await expect.poll(() => held(one, "baskets", basket!.id)).toBeDefined();
    await expect.poll(() => held(one, "equipment", tool!.id)).toBeDefined();
    const set = async (tablet: SimulatedTablet, key: Dye2Key, id: string, fields: Record_) => {
      const list = records(tablet, key).map((record) => (record[GLOBAL_ID_KEY] === id ? { ...record, ...fields } : record));
      expect((await tablet.callApi("POST", `/store/${DYE2_NAMESPACE}/${key}`, list)).status).toBe(200);
    };

    // The second tablet changes the Basket's diameter from 58.5 to 58.7 mm and renames the Tool, which the first is written.
    await set(two, "baskets", basket!.id, { diameterMm: 58.7 });
    await set(two, "equipment", tool!.id, { name: "Stale Fixture WDT" });
    await expect.poll(() => held(one, "baskets", basket!.id)?.diameterMm).toBe(58.7);
    await expect.poll(() => held(one, "equipment", tool!.id)?.name).toBe("Stale Fixture WDT");

    // The first tablet's pages, loaded before that, save the recorded edits: the Basket's notes, with the diameter its page
    // loaded rather than the one the recording changed, and the Tool's needles, with the name its page loaded.
    const fromPage = (diameterMm: number) => (item: Record_) => ({ ...ownNames("Stale")(item), diameterMm });
    await saveInDye2(one, baskets.edit18gBasket, fromPage(58.5));
    await saveInDye2(one, tools.editWdtTool, ownNames("Stale"));
    // What they set back is no edit: the second tablet's diameter and name are kept, and written to the first again. The
    // notes and needles reach every tablet.
    const needles = [
      { key: "Needles", value: "10" },
      { key: "Needle size", value: "0.3 mm" },
    ];
    await expect.poll(async () => (await view("baskets", basket!.id)).content.notes).toBe("Fixture notes, edited");
    await expect.poll(async () => (await view("tools", tool!.id)).content.custom).toEqual(needles);
    for (const tablet of [one, two]) {
      await expect.poll(() => held(tablet, "baskets", basket!.id)).toMatchObject({ notes: "Fixture notes, edited", diameterMm: 58.7 });
      await expect.poll(() => held(tablet, "equipment", tool!.id)).toMatchObject({ name: "Stale Fixture WDT", custom: needles });
    }
    expect((await view("baskets", basket!.id)).content).toMatchObject({ notes: "Fixture notes, edited", diameterMm: 58.7 });
    expect((await view("tools", tool!.id)).content).toMatchObject({ name: "Stale Fixture WDT", custom: needles });
    for (const [kind, id] of [["baskets", basket!.id], ["tools", tool!.id]] as const) {
      expect((await api.get<{ conflicts: unknown[] }>(`/${kind}/${id}/conflicts`)).conflicts).toEqual([]);
    }

    // The second tablet changes the diameter again, to 58.9 mm, so the first held 58.7 just before the server's latest write
    // of it. Saved again from the basket page with 58.3 mm, another value than that, it is an edit as usual.
    await set(two, "baskets", basket!.id, { diameterMm: 58.9 });
    await expect.poll(() => held(one, "baskets", basket!.id)?.diameterMm).toBe(58.9);
    await saveInDye2(one, baskets.edit18gBasket, fromPage(58.3));
    for (const tablet of [one, two]) await expect.poll(() => held(tablet, "baskets", basket!.id)?.diameterMm).toBe(58.3);
    expect((await view("baskets", basket!.id)).content).toMatchObject({ notes: "Fixture notes, edited", diameterMm: 58.3 });
  });

  it("writes again a write lost to another app's rewrite that the next write to the record shows before any report does", async () => {
    const lab = await api.createLocation("Lost twice lab", "America/Chicago");
    const machines = [await api.createMachine("Lost twice lab 1", lab.id), await api.createMachine("Lost twice lab 2", lab.id)] as const;
    const one = load(machines[0], decaid("41101"));
    // The second tablet reads its lists once an hour (72 s here): no report comes between the two writes.
    const two = load(machines[1], decaid("41102"), { instance: other, pollSeconds: 3600 });
    await api.waitForOnline(...machines);
    await saveInDye2(one, baskets.create18gBasket, ownNames("Lost twice"));
    const name = "Lost twice Fixture 18g Precision";
    // The first tablet's record too carries its global id, written back to it: an edit there while that write reads and
    // posts the list would be lost to it, as ADR-0005 says, and leave the second tablet nothing to be written (#163).
    for (const tablet of [one, two]) await expect.poll(() => recordNamed(tablet, "baskets", name)?.[GLOBAL_ID_KEY]).toBeDefined();
    const set = async (tablet: SimulatedTablet, field: string, value: unknown) => {
      const list = records(tablet, "baskets").map((record) => (record.name === name ? { ...record, [field]: value } : record));
      expect((await tablet.callApi("POST", `/store/${DYE2_NAMESPACE}/baskets`, list)).status).toBe(200);
    };

    // The second tablet's write of the first's notes is lost; the first then edits the diameter, which the second is written
    // into the list holding its old notes.
    const lost = loseNextWrite(two, "baskets");
    await set(one, "notes", "Edited on one");
    await lost.taken();
    await expect.poll(() => recordNamed(two, "baskets", name)?.notes).toBe("Fixture notes");
    await set(one, "diameterMm", 58.7);
    // Its old notes are no edit: the first tablet's are written to it again, and kept everywhere.
    await expect.poll(() => recordNamed(two, "baskets", name)).toMatchObject({ notes: "Edited on one", diameterMm: 58.7 });
    const [basket] = await named("baskets", name);
    expect((await view("baskets", basket!.id)).content).toMatchObject({ notes: "Edited on one", diameterMm: 58.7 });
    expect(recordNamed(one, "baskets", name)?.notes).toBe("Edited on one");

    // Lost again, the write is then undone on the first tablet, so the second holds the Basket's notes, as its answer to the
    // write putting them back shows: it has seen them, and its barista's edit of them, taken in from the answer to a
    // write of the diameter, is no Conflict.
    const lostAgain = loseNextWrite(two, "baskets");
    await set(one, "notes", "Edited twice on one");
    await lostAgain.taken();
    await set(one, "notes", "Edited on one");
    await expect.poll(async () => (await view("baskets", basket!.id)).content.notes).toBe("Edited on one");
    const waiting = async () => (await api.get<{ status: { waiting: number } }>(`/machines/${machines[1].machine.id}/sharing-status`)).status.waiting;
    await expect.poll(waiting).toBe(0);
    await set(two, "notes", "Edited on two");
    await set(one, "diameterMm", 58.9);
    await expect.poll(() => recordNamed(one, "baskets", name)?.notes).toBe("Edited on two");
    expect((await view("baskets", basket!.id)).content).toMatchObject({ notes: "Edited on two", diameterMm: 58.9 });
    expect((await api.get<{ conflicts: unknown[] }>(`/baskets/${basket!.id}/conflicts`)).conflicts).toEqual([]);
  });

  it("keeps a restored tablet's Baskets and Tools linked by its tablet id, writing back a global id its record lost", async () => {
    const lab = await api.createLocation("Restored lab", "America/Chicago");
    const machines = [await api.createMachine("Restored lab 1", lab.id), await api.createMachine("Restored lab 2", lab.id)] as const;
    const one = load(machines[0], decaid("41061"));
    const two = load(machines[1], decaid("41062"), { instance: other });
    await api.waitForOnline(...machines);
    await saveInDye2(one, baskets.create18gBasket, ownNames("Restored"));
    await saveInDye2(one, tools.createWdtTool, ownNames("Restored"));
    await expect.poll(() => recordNamed(two, "baskets", "Restored Fixture 18g Precision")?.[GLOBAL_ID_KEY]).toBeDefined();
    await expect.poll(() => recordNamed(two, "equipment", "Restored Fixture WDT Tool")?.[GLOBAL_ID_KEY]).toBeDefined();

    // The second tablet's Decaid data restored from a backup, its plugin storage with its tablet id included, but its basket's global id lost.
    const restoredBaskets = records(two, "baskets").map(({ [GLOBAL_ID_KEY]: _, ...record }) => record);
    const restoredTools = records(two, "equipment");
    const storage = two.storage;
    await two.unload();
    await api.waitForMachine("Restored lab 2", (viewed) => !viewed.online, 15_000);
    const restored = load(machines[1], decaid("41062", { baskets: restoredBaskets, equipment: restoredTools }), { instance: other, storage });
    const [basket] = await named("baskets", "Restored Fixture 18g Precision");
    await expect.poll(() => recordNamed(restored, "baskets", "Restored Fixture 18g Precision")?.[GLOBAL_ID_KEY]).toBe(basket!.id);
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
    await api.waitForOnline(...machines, sharingOff);

    await saveInDye2(unplaced, baskets.create20gBasket, ownNames("Capture-only"));
    await saveInDye2(off, tools.createSpareTamper, ownNames("Capture-only"));
    await saveInDye2(one, baskets.create18gBasket, ownNames("Capture-only"));
    await expect.poll(() => shownAt("baskets", "Capture-only Fixture 18g Precision")).toEqual(["Capture-only lab"]);
    // Reported, captured, and taken into nothing: one written later to the sharing tablet would have got there by now.
    await saveInDye2(one, tools.createPuckScreen, ownNames("Capture-only"));
    await expect.poll(() => shownAt("tools", "Capture-only Fixture Puck Screen")).toEqual(["Capture-only lab"]);
    const collection = async (machine: CreatedMachine) =>
      (await api.get<{ collection: { items: number } | null }>(`/machines/${machine.machine.id}/collections/dye2Equipment`)).collection;
    await expect.poll(async () => (await collection(sharingOff))?.items).toBe(1);
    expect(await named("baskets", "Capture-only Fixture 20g High-flow")).toEqual([]);
    expect(await named("tools", "Capture-only Fixture Spare Tamper")).toEqual([]);
    for (const tablet of [unplaced, off]) {
      expect(tablet.storeWrites.filter((write) => write.namespace === DYE2_NAMESPACE)).toEqual([]);
      expect(recordNamed(tablet, "baskets", "Capture-only Fixture 18g Precision")).toBeUndefined();
    }
  });
});
