import { globalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { SimulatedTablet, derivedDe1Pro, settingsFor } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #91: a write the tablet refuses doesn't stop the others,
// and each Machine's sharing status shows how its sharing is going: the
// changes waiting for its tablet, the last change applied and when, and the
// writes refused, with Decaid's answer. A refused write is tried again once
// its item changes, or the tablet reconnects. Through the built plugin in
// simulated tablets, on two server instances sharing one database, with
// assertions through the REST API and what each simulated tablet's Decaid
// holds. Serials are made up, from 26001.

type Record_ = Record<string, unknown>;

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

interface ItemView {
  kind: string;
  id: string;
  name: string | null;
}

interface ChangeView {
  change: string;
  kind: string;
  item: ItemView | null;
  localId: string | null;
}

interface SharingStatus {
  tabletId: string | null;
  waiting: number | null;
  lastApplied: (ChangeView & { appliedAt: string }) | null;
  refused: (ChangeView & { status: number | null; error: string; refusedAt: string })[];
}

/** What Decaid v0.8.7 answers a bean it cannot cast (decaid-beans.ts). */
const CAST_REFUSAL = { status: 400, body: { error: "type 'int' is not a subtype of type 'String?' in type cast" } };

describe("Each Machine's sharing status", { timeout: 60_000 }, () => {
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

  /** The built plugin on a fresh tablet of the Machine, holding no Library records, connected to an instance, polling every 5 s (0.1 s here). */
  function load(machine: CreatedMachine, serial: string, instance: TestServer = server): SimulatedTablet {
    const tablet = SimulatedTablet.load({
      settings: { ...settingsFor({ token: machine.token, serverUrl: instance.url }), PollSeconds: 5 },
      api: { ...derivedDe1Pro({ serial }), "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [] },
      timeScale: 50,
    });
    tablets.push(tablet);
    return tablet;
  }

  async function online(...machines: CreatedMachine[]): Promise<void> {
    for (const { machine } of machines) await api.waitForMachine(machine.name, (viewed) => viewed.online);
  }

  /** The Machine's sharing status, through the REST API. */
  async function statusOf({ machine }: CreatedMachine): Promise<SharingStatus> {
    const response = await api.call("GET", `/machines/${machine.id}/sharing-status`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { status: SharingStatus }).status;
  }

  /** The Library's one Bean of that name, once there is one. */
  async function libraryBean(name: string): Promise<{ id: string; roaster: string; name: string }> {
    const named = async () => ((await (await api.call("GET", "/beans")).json()) as { beans: { id: string; roaster: string; name: string }[] }).beans.filter((bean) => bean.name === name);
    await expect.poll(async () => (await named()).length, { timeout: 10_000 }).toBe(1);
    return (await named())[0]!;
  }

  /** The tablet's beans of that name, each by the global id it carries. */
  const heldAs = (tablet: SimulatedTablet, name: string) => tablet.beans().filter((bean) => bean.name === name).map(globalIdOf);

  /** Refuses the plugin's creates of beans named as given, as Decaid refuses a bean it cannot cast. */
  const refusingBeans = (...names: string[]) => (request: { method: string; route: string; body: unknown }) =>
    request.method === "POST" && request.route === "/beans" && names.includes(String((request.body as Record_).name)) ? CAST_REFUSAL : undefined;

  it("goes on writing past a Bean the tablet refuses, shows the refusal with Decaid's answer, and writes it again once the Bean is edited", async () => {
    const cafe = await api.createLocation("Refusing cafe", "UTC");
    const first = await api.createMachine("Refusing group 1", cafe.id);
    const second = await api.createMachine("Refusing group 2", cafe.id);
    const one = load(first, "26001");
    // The refusing tablet's connection is held by the other instance; its status is read through the first.
    const two = load(second, "26002", other);
    two.refuseWrites = refusingBeans("Refused Blend");
    await online(first, second);

    await one.addBean({ roaster: "Roux", name: "Refused Blend" });
    const refused = await libraryBean("Refused Blend");
    await one.addBean({ roaster: "Roux", name: "Accepted One" });
    await one.addBean({ roaster: "Roux", name: "Accepted Two" });
    const [acceptedOne, acceptedTwo] = [await libraryBean("Accepted One"), await libraryBean("Accepted Two")];

    // The other Beans reach the refusing tablet; the refused one does not.
    await expect.poll(() => [heldAs(two, "Accepted One"), heldAs(two, "Accepted Two")], { timeout: 10_000 }).toEqual([[acceptedOne.id], [acceptedTwo.id]]);
    expect(heldAs(two, "Refused Blend")).toEqual([]);
    // Once every answer is recorded, nothing is waiting: the refused Bean is refused, not waiting.
    await expect
      .poll(async () => {
        const { refused, waiting, lastApplied } = await statusOf(second);
        return { refused: refused.length, waiting, applied: lastApplied !== null };
      }, { timeout: 10_000 })
      .toEqual({ refused: 1, waiting: 0, applied: true });
    const status = await statusOf(second);
    expect(status).toMatchObject({
      tabletId: expect.any(String),
      waiting: 0,
      refused: [{ change: "write", kind: "bean", item: { kind: "bean", id: refused.id, name: "Roux Refused Blend" }, localId: null, status: 400 }],
    });
    expect(JSON.parse(status.refused[0]!.error)).toEqual(CAST_REFUSAL.body);
    expect(Date.parse(status.refused[0]!.refusedAt)).not.toBeNaN();
    // The last written of the two it took.
    const last = [acceptedOne, acceptedTwo].find((bean) => bean.id === status.lastApplied?.item?.id)!;
    expect(status.lastApplied).toMatchObject({ change: "write", kind: "bean", item: { kind: "bean", id: last.id, name: `Roux ${last.name}` } });
    expect(status.lastApplied!.localId).toBe(two.beans().find((bean) => bean.name === last.name)!.id);
    expect(Date.parse(status.lastApplied!.appliedAt)).not.toBeNaN();
    // The tablet that wrote all three refused none.
    expect((await statusOf(first)).refused).toEqual([]);

    // Decaid would take it now, but nothing changed, so it is not asked again on this connection.
    two.refuseWrites = undefined;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(heldAs(two, "Refused Blend")).toEqual([]);
    expect((await statusOf(second)).refused).toHaveLength(1);

    // Edited, the Bean is written again, and once the tablet takes it, it leaves the refused list.
    expect((await api.call("PATCH", `/beans/${refused.id}`, { content: { notes: "Now with notes" } })).status).toBe(200);
    await expect.poll(() => heldAs(two, "Refused Blend"), { timeout: 10_000 }).toEqual([refused.id]);
    expect(two.beans().find((bean) => bean.name === "Refused Blend")).toMatchObject({ notes: "Now with notes" });
    await expect.poll(async () => (await statusOf(second)).refused, { timeout: 10_000 }).toEqual([]);
    await expect.poll(async () => (await statusOf(second)).waiting, { timeout: 10_000 }).toBe(0);
    expect((await statusOf(second)).lastApplied).toMatchObject({ change: "write", item: { id: refused.id } });
  });

  it("writes a refused Bean again once the tablet reconnects", async () => {
    const cafe = await api.createLocation("Reconnecting cafe", "UTC");
    const first = await api.createMachine("Reconnecting group 1", cafe.id);
    const second = await api.createMachine("Reconnecting group 2", cafe.id);
    const one = load(first, "26011");
    const two = load(second, "26012", other);
    two.refuseWrites = refusingBeans("Refused Again");
    await online(first, second);

    await one.addBean({ roaster: "Roux", name: "Refused Again" });
    const refused = await libraryBean("Refused Again");
    await expect.poll(async () => (await statusOf(second)).refused.map((refusal) => refusal.item?.id), { timeout: 10_000 }).toEqual([refused.id]);
    // Refused again on its next connection, it stays refused, timed by the latest refusal.
    const firstRefusedAt = (await statusOf(second)).refused[0]!.refusedAt;
    two.dropConnections();
    await expect.poll(async () => (await statusOf(second)).refused[0]?.refusedAt, { timeout: 10_000 }).not.toBe(firstRefusedAt);
    expect(heldAs(two, "Refused Again")).toEqual([]);

    // Decaid takes it once the tablet reconnects.
    two.refuseWrites = undefined;
    two.dropConnections();
    await expect.poll(() => heldAs(two, "Refused Again"), { timeout: 10_000 }).toEqual([refused.id]);
    await expect.poll(async () => (await statusOf(second)).refused, { timeout: 10_000 }).toEqual([]);
    expect((await statusOf(second)).lastApplied).toMatchObject({ change: "write", kind: "bean", item: { id: refused.id, name: "Roux Refused Again" } });
  });

  it("counts the changes queued for a tablet while it is offline as waiting, down to none once it catches up", async () => {
    const cafe = await api.createLocation("Offline cafe", "UTC");
    const first = await api.createMachine("Offline group 1", cafe.id);
    const second = await api.createMachine("Offline group 2", cafe.id);
    const one = load(first, "26021");
    const two = load(second, "26022", other);
    await online(first, second);
    await one.addBean({ roaster: "Roux", name: "Before Offline" });
    const before = await libraryBean("Before Offline");
    await expect.poll(() => heldAs(two, "Before Offline"), { timeout: 10_000 }).toEqual([before.id]);
    await expect.poll(async () => (await statusOf(second)).waiting, { timeout: 10_000 }).toBe(0);

    two.loseNetwork();
    await api.waitForMachine(second.machine.name, (viewed) => !viewed.online);
    await one.addBean({ roaster: "Roux", name: "Queued One" });
    await one.addBean({ roaster: "Roux", name: "Queued Two" });
    const queued = [await libraryBean("Queued One"), await libraryBean("Queued Two")];
    // An edit of a Bean the tablet holds is a change waiting too.
    expect((await api.call("PATCH", `/beans/${before.id}`, { content: { notes: "Edited while offline" } })).status).toBe(200);
    await expect.poll(async () => (await statusOf(second)).waiting, { timeout: 10_000 }).toBe(3);
    expect((await statusOf(second)).refused).toEqual([]);

    two.restoreNetwork();
    await expect.poll(() => queued.map((bean) => heldAs(two, bean.name)), { timeout: 10_000 }).toEqual(queued.map((bean) => [bean.id]));
    await expect.poll(async () => (await statusOf(second)).waiting, { timeout: 10_000 }).toBe(0);
    expect(two.beans().find((bean) => bean.name === "Before Offline")).toMatchObject({ notes: "Edited while offline" });
  });

  it("shows nothing waiting for a Machine whose tablet is written nothing, and 404 for no Machine", async () => {
    const cafe = await api.createLocation("Unconnected cafe", "UTC");
    const unconnected = await api.createMachine("Never connected", cafe.id);
    expect(await statusOf(unconnected)).toEqual({ tabletId: null, waiting: null, lastApplied: null, refused: [] });

    const capturing = await api.createMachine("Capturing only", cafe.id);
    const tablet = load(capturing, "26031");
    await online(capturing);
    await tablet.addBean({ roaster: "Roux", name: "Before Capture-only" });
    await libraryBean("Before Capture-only");
    expect((await api.call("PUT", `/machines/${capturing.machine.id}/sharing`, { sharing: false })).status).toBe(200);
    await expect.poll(async () => (await statusOf(capturing)).waiting, { timeout: 10_000 }).toBeNull();
    expect((await statusOf(capturing)).tabletId).toEqual(expect.any(String));

    expect((await api.call("GET", "/machines/00000000-0000-4000-8000-000000000000/sharing-status")).status).toBe(404);
  });
});
