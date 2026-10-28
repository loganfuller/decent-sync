import { COLLECTION_NAMES } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { syncingTablet } from "./support/loaded-tablets.js";
import { type DecaidApi, Refusal, type SimulatedTablet, derivedDe1Pro } from "./support/simulated-tablet.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1 for ticket #229: a Tablet's presence settings, its wake schedules
// included, reported by the built plugin in a simulated tablet, which serves
// Decaid v0.9.0's presence routes (decaid-settings.ts), with the Tablet's UTC
// offset beside them and beside its app settings, against a real server.
// Assertions are made through the REST API and the frames the plugin sent.
// Serials and schedule ids are made up.

interface Collection {
  name: string;
  available: boolean;
  value: unknown;
  utcOffsetMinutes: number | null;
}
interface Frame { type: string; name?: string; available?: boolean; value?: unknown; utcOffsetMinutes?: number }

/** Toronto's offset in summer, and in winter after the clocks go back. */
const EDT = -240;
const EST = -300;

/**
 * Derived from Decaid v0.9.0's answers to `GET /presence/settings` as its
 * wake schedules were added (settings-writes-v0.9.0/, `scheduleAddedOff`):
 * presence on, a 30 minute sleep timeout, a schedule on three weekdays that
 * keeps the Machine awake for two hours, and one every day that is off and
 * keeps it awake for no time, with the Machine kept awake until 08:30 by the
 * first.
 */
function presence(): Record<string, unknown> {
  return {
    userPresenceEnabled: true,
    sleepTimeoutMinutes: 30,
    keepAwakeUntil: "2026-10-26T08:30:00.000",
    schedules: [
      { id: "0f0e0d0c-0b0a-4908-8706-050403020100", time: "06:30", daysOfWeek: [1, 3, 5], enabled: true, keepAwakeFor: 120 },
      { id: "1f1e1d1c-1b1a-4918-9716-151413121110", time: "21:15", daysOfWeek: [], enabled: false },
    ],
  };
}

describe("Presence settings and the Tablet's UTC offset", () => {
  let server: TestServer;
  let api: AdminApi;
  let serial = 22_900;
  const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => {
    await server?.stop();
  });

  /** A Machine whose tablet, at the UTC offset given, connects to the server, its Decaid serving these presence settings. */
  async function connected(name: string, utcOffsetMinutes: number, served: Record<string, unknown> = presence()): Promise<{ machine: CreatedMachine; tablet: SimulatedTablet; api: DecaidApi }> {
    const machine = await api.createMachine(name);
    const decaid: DecaidApi = { ...derivedDe1Pro({ serial: String(serial++) }), "/presence/settings": served };
    const tablet = syncingTablet(machine, server, { api: decaid, utcOffsetMinutes });
    await expect.poll(async () => (await collection(machine, "presenceSettings"))?.available).toBe(true);
    return { machine, tablet, api: decaid };
  }
  const collection = async (machine: CreatedMachine, name: string) =>
    (await api.get<{ collection: Collection | null }>(`/machines/${machine.machine.id}/collections/${name}`)).collection;
  /** The collection deliveries the plugin sent of one collection. */
  const deliveries = (tablet: SimulatedTablet, name: string) =>
    tablet.sent.filter((frame): frame is Frame => (frame as Frame).type === "collection" && (frame as Frame).name === name);
  const sentCounts = (tablet: SimulatedTablet) => Object.fromEntries(COLLECTION_NAMES.map((name) => [name, deliveries(tablet, name).length]));
  /** Resolves once the plugin has read the sensors, which each poll reads last, at least `count` more times. */
  async function polls(tablet: SimulatedTablet, count: number) {
    const before = tablet.requests.filter((request) => request === "/sensors").length;
    await expect.poll(() => tablet.requests.filter((request) => request === "/sensors").length).toBeGreaterThanOrEqual(before + count);
  }
  const allAcknowledged = (tablet: SimulatedTablet) => expect.poll(() => tablet.acknowledgedEvery((frame) => (frame as Frame).type === "collection")).toBe(true);

  it("reports the presence settings, wake schedules included, and the app settings with the Tablet's UTC offset, which the REST API serves", async () => {
    const { machine, api: decaid } = await connected("Presence reported", EDT);
    expect(await collection(machine, "presenceSettings")).toMatchObject({ available: true, value: presence(), utcOffsetMinutes: EDT });
    expect(await collection(machine, "appSettings")).toMatchObject({ available: true, value: decaid["/settings"], utcOffsetMinutes: EDT });
    // Only those two hold times in the Tablet's own time.
    expect(await collection(machine, "machineSettings")).toMatchObject({ available: true, utcOffsetMinutes: null });
    const summaries = (await api.get<{ collections: { name: string }[] }>(`/machines/${machine.machine.id}/collections`)).collections;
    expect(summaries.map((summary) => summary.name)).toContain("presenceSettings");
  });

  it("reports a change made on the Tablet at the next poll, and an unchanged collection never again", async () => {
    const { machine, tablet } = await connected("Presence changed", EDT);
    await allAcknowledged(tablet);
    await polls(tablet, 3);
    const before = sentCounts(tablet);
    expect(before.presenceSettings).toBe(1);

    // A barista adds a wake schedule in Streamline's settings page, and turns presence off.
    const added = await tablet.callApi("POST", "/presence/schedules", { time: "05:45", daysOfWeek: [6, 7], keepAwakeFor: 60 });
    expect(added.status).toBe(201);
    expect((await tablet.callApi("POST", "/presence/settings", { userPresenceEnabled: false })).status).toBe(200);
    const expected = { ...presence(), userPresenceEnabled: false, schedules: [...(presence().schedules as unknown[]), added.body] };
    await expect.poll(async () => (await collection(machine, "presenceSettings"))?.value).toEqual(expected);
    await polls(tablet, 3);
    expect(sentCounts(tablet)).toEqual({ ...before, presenceSettings: 2 });
    expect(deliveries(tablet, "presenceSettings").at(-1)).toMatchObject({ available: true, value: expected, utcOffsetMinutes: EDT });
  });

  it("reports a daylight saving change of the Tablet's offset, with the presence and app settings unchanged, and nothing else for it", async () => {
    const { machine, tablet, api: decaid } = await connected("Clocks go back", EDT);
    await allAcknowledged(tablet);
    await polls(tablet, 3);
    const before = sentCounts(tablet);

    tablet.setPluginUtcOffset(EST);
    await expect.poll(async () => (await collection(machine, "presenceSettings"))?.utcOffsetMinutes).toBe(EST);
    await expect.poll(async () => (await collection(machine, "appSettings"))?.utcOffsetMinutes).toBe(EST);
    await polls(tablet, 3);
    expect(sentCounts(tablet)).toEqual({ ...before, appSettings: before.appSettings! + 1, presenceSettings: before.presenceSettings! + 1 });
    expect(await collection(machine, "presenceSettings")).toMatchObject({ value: presence(), utcOffsetMinutes: EST });
    expect(await collection(machine, "appSettings")).toMatchObject({ value: decaid["/settings"], utcOffsetMinutes: EST });
  });

  it("keeps the offset with the value known while the presence settings can't be read", async () => {
    const { machine, tablet, api: decaid } = await connected("Presence unavailable", EDT);
    tablet.serve({ ...decaid, "/presence/settings": new Refusal(500, { error: "Bad state: no settings" }) });
    tablet.setPluginUtcOffset(EST);
    await expect.poll(async () => (await collection(machine, "presenceSettings"))?.available).toBe(false);
    expect(await collection(machine, "presenceSettings")).toMatchObject({ value: presence(), utcOffsetMinutes: EDT });
    // The unavailable report went without an offset.
    expect(deliveries(tablet, "presenceSettings").at(-1)).toEqual(expect.not.objectContaining({ utcOffsetMinutes: expect.anything() }));
  });
});
