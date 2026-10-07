import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, type MachineView } from "./support/admin-api.js";
import { waitForLockWaits } from "./support/lock-waits.js";
import { derivedShot, shotFixture, withShots } from "./support/shot-fixtures.js";
import { derivedSteam, longSteam, milkProbeSteamFixture, steamFixture, withSteams } from "./support/steam-fixtures.js";
import { RawConnection, SimulatedTablet, derivedDe1Pro, helloWith, settingsFor, type HeldSteamRead } from "./support/simulated-tablet.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1: Steam Record capture through the built plugin on simulated tablets,
// and raw frames, against two server instances sharing PostgreSQL, asserting
// through the REST API. Steam Records are derived from records Decaid
// produced, changing only their ids and local times. Hardware ids are made up.

/**
 * The simulated tablets' time zone, which the plugin reads Steam Records'
 * local times in: five hours behind UTC in daylight time, six in standard
 * time, and its clocks go back an hour at 02:00 on 2026-11-01.
 */
const TABLET_TIME_ZONE = "America/Chicago";

interface SteamRecordView {
  id: string;
  machineId: string | null;
  pendingMachineId: string | null;
  machine: { id: string; name: string } | null;
  pendingMachine: { id: string; model: string; serial: string } | null;
  locationId: string | null;
  location: LocationView | null;
  steamedAt: string;
  duration: number | null;
  peakMilkTemperature: number | null;
  finalMilkTemperature: number | null;
  barista: string | null;
  record?: Record<string, unknown>;
}

interface Sent {
  type: string;
  id?: string;
  steamId?: string;
  steams?: { id: string }[];
  index?: number;
}

/** A failed read of every Steam Record id, as the plugin logs it. */
const IDS_UNREADABLE = /^Could not read the Steam Record ids: /;

describe("Steam Record capture", () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  let lab: LocationView;
  let uptown: LocationView;
  let timeZone: string | undefined;
  const tablets: SimulatedTablet[] = [];
  const raws: RawConnection[] = [];
  const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

  beforeAll(async () => {
    timeZone = process.env.TZ;
    process.env.TZ = TABLET_TIME_ZONE;
    // Daylight time in July, so the tablet is not at UTC.
    expect(new Date(2026, 6, 1).getTimezoneOffset()).toBe(300);
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
    lab = await api.createLocation("Lab", "America/Denver");
    uptown = await api.createLocation("Uptown", "America/Chicago");
  }, 60_000);
  afterEach(async () => {
    const used = tablets.splice(0);
    await Promise.all(used.map((tablet) => tablet.unload()));
    await Promise.all(raws.splice(0).map((raw) => raw.terminate()));
    // Never the unpaginated list, which holds every Steam Record with its workflow.
    for (const tablet of used) expect(tablet.requests).not.toContain("/steams");
  });
  afterAll(async () => {
    await other?.stop();
    await server?.stop();
    if (timeZone === undefined) delete process.env.TZ;
    else process.env.TZ = timeZone;
  });

  /** The hardware a Machine's simulated tablet reports, unique to the Machine. */
  function hardwareOf(machine: CreatedMachine) {
    return { model: "DE1Pro", serial: machine.machine.id.replaceAll("-", "") };
  }
  function tabletApi(machine: CreatedMachine, steams: Record<string, unknown>[] = []) {
    return withSteams(derivedDe1Pro({ serial: hardwareOf(machine).serial }), steams);
  }
  function load(machine: CreatedMachine, steams: Record<string, unknown>[], options = {}) {
    const tablet = SimulatedTablet.load({ settings: settingsFor(machine), api: tabletApi(machine, steams), timeScale: 50, ...options });
    tablets.push(tablet);
    return tablet;
  }
  /** How many times the tablet has read its Steam Record ids. */
  function idReads(tablet: SimulatedTablet): number {
    return tablet.requests.filter((route) => route === "/steams/ids").length;
  }
  /** How many times the tablet has read its newest Steam Record: once a poll interval, and on every welcome, while connected. */
  function latestReads(tablet: SimulatedTablet): number {
    return tablet.requests.filter((route) => route === "/steams/latest").length;
  }
  /** Every read of Steam Records the tablet has made: of their ids, of the newest, or of one by its id. */
  function steamReads(tablet: SimulatedTablet): number {
    return tablet.requests.filter((route) => route.startsWith("/steams")).length;
  }
  /**
   * The tablet's reads of Steam Records from its `from`th request on, up to
   * and including its read of the one with this id: how it came to find it.
   */
  function steamReadsUntil(tablet: SimulatedTablet, from: number, id: string): string[] {
    const reads = tablet.requests.slice(from).filter((route) => route.startsWith("/steams"));
    const found = reads.indexOf(`/steams/${encodeURIComponent(id)}`);
    expect(found, `the tablet read Steam Record ${id}`).toBeGreaterThanOrEqual(0);
    return reads.slice(0, found + 1);
  }
  /**
   * Resolves once the tablet has read the Steam Record with this id, found by
   * the next read of `route` it made: that read is held until `appear` has
   * run, and those after it until the tablet has read the record, so however
   * long the outbox takes to read it, behind deliveries awaiting
   * acknowledgment, no other read of `route` was answered meanwhile. Reads of
   * `alsoHeld` are held throughout.
   */
  async function foundByTheNextRead(
    tablet: SimulatedTablet,
    route: HeldSteamRead,
    id: string,
    { appear, alsoHeld }: { appear?: () => void; alsoHeld?: HeldSteamRead } = {},
  ): Promise<void> {
    const releaseAlso = alsoHeld ? tablet.holdSteamReads(alsoHeld) : () => {};
    const releaseNext = tablet.holdSteamReads(route);
    try {
      const made = tablet.requests.filter((request) => request === route).length;
      await expect.poll(() => tablet.requests.filter((request) => request === route).length, { timeout: 10_000 }).toBeGreaterThan(made);
      appear?.();
      const releaseLater = tablet.holdSteamReads(route);
      try {
        releaseNext();
        await expect.poll(() => tablet.requests.includes(`/steams/${encodeURIComponent(id)}`), { timeout: 10_000 }).toBe(true);
      } finally {
        releaseLater();
      }
    } finally {
      releaseNext();
      releaseAlso();
    }
  }
  /** The deliveries the server has acknowledged to the tablet so far. */
  function acknowledged(tablet: SimulatedTablet): Set<string> {
    return new Set((tablet.received as Sent[]).flatMap((message) => (message.type === "ack" ? [String(message.id)] : [])));
  }
  function sent(tablet: SimulatedTablet, type: string): Sent[] {
    return (tablet.sent as Sent[]).filter((message) => message.type === type);
  }
  async function list(machineId?: string, at = api): Promise<{ steamRecords: SteamRecordView[]; total: number }> {
    const response = await at.call("GET", `/steam-records?limit=100${machineId ? `&machineId=${machineId}` : ""}`);
    expect(response.status).toBe(200);
    return response.json() as Promise<{ steamRecords: SteamRecordView[]; total: number }>;
  }
  async function detail(id: string, at = api): Promise<SteamRecordView> {
    const response = await at.call("GET", `/steam-records/${encodeURIComponent(id)}`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { steamRecord: SteamRecordView }).steamRecord;
  }
  async function measurements(id: string) {
    const response = await api.call("GET", `/steam-records/${encodeURIComponent(id)}/measurements`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { measurements: unknown }).measurements;
  }
  async function absent(id: string) {
    for (const path of [`/steam-records/${encodeURIComponent(id)}`, `/steam-records/${encodeURIComponent(id)}/measurements`]) {
      expect((await api.call("GET", path)).status).toBe(404);
    }
  }
  async function waitSteam(id: string, timeout = 10_000): Promise<SteamRecordView> {
    await expect.poll(async () => (await api.call("GET", `/steam-records/${encodeURIComponent(id)}`)).status, { timeout }).toBe(200);
    return detail(id);
  }
  /** Each Steam Record's Location by name, null when unknown. */
  async function locations(ids: string[]): Promise<Record<string, string | null>> {
    return Object.fromEntries(await Promise.all(ids.map(async (id) => [id, (await detail(id)).location?.name ?? null])));
  }
  async function connect(machine: CreatedMachine, url = server.url, hardware?: { model: string; serial: string }) {
    const raw = await RawConnection.welcomed(url, helloWith(machine.token, hardware ? { machine: hardware } : {}));
    raws.push(raw);
    return raw;
  }
  function sendSteam(raw: RawConnection, record: Record<string, unknown>, steamedAt: string, id = randomUUID()) {
    raw.send({ type: "steam", id, steamId: String(record.id), steamedAt, steam: record });
    return id;
  }
  async function moved(response: Response): Promise<MachineView> {
    const body = (await response.json()) as { machine: MachineView; message?: unknown };
    expect(response.status, JSON.stringify(body.message)).toBeLessThan(300);
    return body.machine;
  }
  /** The record without its measurements, as Steam Record detail returns it. */
  function withoutMeasurements(record: Record<string, unknown>) {
    const { measurements: omitted, ...rest } = record;
    return rest;
  }

  it("validates pagination and Machine ids", async () => {
    for (const query of ["limit=0", "limit=101", "offset=-1", "limit=1.2"]) expect((await api.call("GET", `/steam-records?${query}`)).status).toBe(400);
    expect((await api.call("GET", "/steam-records?machineId=not-a-machine")).status).toBe(404);
    await absent("missing");
  });

  it("backfills an adopted tablet's whole history, indexing it once in pages of at most 100, resumed after a disconnect partway through", async () => {
    const machine = await api.createMachine("Steam history");
    const history = Array.from({ length: 205 }, (_, n) =>
      derivedSteam(`history-${String(n).padStart(3, "0")}`, { timestamp: new Date(Date.UTC(2026, 0, 1, 8, n)).toISOString().replace("Z", "001") }),
    );
    // The network stalls at the index's second page, so the connection drops partway through the index.
    let stalled = true;
    const stallUpload = (frame: unknown) => stalled && (frame as Sent).type === "steamIndex" && (frame as Sent).steams?.[0]?.id === "history-100";
    const tablet = load(machine, history, { apiDelayMs: 500, stallUpload });
    await expect.poll(() => sent(tablet, "steamIndex").length, { timeout: 10_000 }).toBe(2);
    const [firstPage, cutOff] = sent(tablet, "steamIndex");
    await expect.poll(() => acknowledged(tablet).has(firstPage!.id!)).toBe(true);
    const sentBefore = tablet.sent.length;
    stalled = false;
    tablet.dropConnections();
    await tablet.waitForLogs(/^Connected to /, 2);
    await expect.poll(async () => (await list(machine.machine.id, api.at(other.url))).total, { timeout: 20_000 }).toBe(205);

    // Every id went once, in pages of at most 100, each under one delivery id. The reconnect sent the
    // page cut off before its acknowledgment again, with its id, then the last; the first never again.
    const pages = new Map(sent(tablet, "steamIndex").map((page) => [page.id!, page.steams!.map((steam) => steam.id)]));
    expect([...pages.values()].map((page) => page.length)).toEqual([100, 100, 5]);
    expect([...pages.values()].flat()).toEqual(history.map((steam) => String(steam.id)));
    const resent = (tablet.sent.slice(sentBefore) as Sent[]).filter((frame) => frame.type === "steamIndex");
    expect(resent.map((page) => page.steams![0]!.id)).toEqual(["history-100", "history-200"]);
    expect(resent[0]!.id).toBe(cutOff!.id);
    // Each fetched by its id; the one list Decaid offers of whole records never.
    expect(tablet.requests.filter((route) => route.startsWith("/steams/") && route !== "/steams/ids").length).toBeGreaterThanOrEqual(205);

    // Newest first, each once, credited to the Machine whose tablet sent it.
    const first = await list(machine.machine.id);
    expect(first.steamRecords[0]).toMatchObject({ id: "history-204", steamedAt: "2026-01-01T17:24:00.000Z", machineId: machine.machine.id });
    const lastPage = (await (await api.call("GET", `/steam-records?limit=100&offset=200&machineId=${machine.machine.id}`)).json()) as {
      steamRecords: SteamRecordView[];
    };
    expect(lastPage.steamRecords.map((steam) => steam.id)).toEqual(["history-004", "history-003", "history-002", "history-001", "history-000"]);
    expect(new Set(first.steamRecords.map((steam) => steam.id)).size).toBe(100);
  }, 40_000);

  it("sends a new Steam Record by the next poll, reading only the newest, with its measurements and milk temperature, credited to the reporting Machine", async () => {
    const machine = await api.createMachine("Live steam");
    // Polls every two minutes of the tablet's time: 2.4 s of real time.
    const tablet = load(machine, [], { settings: { ...settingsFor(machine), PollSeconds: 120 } });
    await tablet.waitForLog(/^Connected to /);
    // Every id is read once, for the index.
    await expect.poll(() => idReads(tablet)).toBe(1);

    const record = milkProbeSteamFixture();
    // Found by the next poll's read of the newest Steam Record, with no read of the ids, whose list grows with history.
    await foundByTheNextRead(tablet, "/steams/latest", String(record.id), {
      appear: () => tablet.serve(tabletApi(machine, [record])),
      alsoHeld: "/steams/ids",
    });
    await waitSteam(String(record.id));

    expect(await detail(String(record.id))).toEqual({
      id: record.id,
      machineId: machine.machine.id,
      machine: { id: machine.machine.id, name: "Live steam" },
      pendingMachineId: null,
      pendingMachine: null,
      locationId: null,
      location: null,
      // Recorded at 09:07:03.341484 on the tablet, in daylight time.
      steamedAt: "2026-10-05T14:07:03.341Z",
      duration: 11.802,
      peakMilkTemperature: 60.46000000000001,
      finalMilkTemperature: 60.46000000000001,
      barista: "Fixture Barista",
      record: withoutMeasurements(record),
    });
    expect(await measurements(String(record.id))).toEqual(record.measurements);
    expect((record.measurements as { milkTemperature: number | null }[]).filter((sample) => sample.milkTemperature !== null)).toHaveLength(20);
    // Captured without reconnecting.
    expect(tablet.logs.filter((line) => line.startsWith("Connected to "))).toHaveLength(1);
  });

  it("sends a Steam Record new on the tablet ahead of the history still being backfilled", async () => {
    const machine = await api.createMachine("Steam during backfill");
    const history = Array.from({ length: 150 }, (_, n) =>
      derivedSteam(`backfill-${String(n).padStart(3, "0")}`, { timestamp: new Date(Date.UTC(2026, 1, 1, 8, n)).toISOString().replace("Z", "001") }),
    );
    // Each read of Decaid's API takes 20 ms of real time, so the backfill takes seconds.
    const tablet = load(machine, history, { apiDelayMs: 1_000 });
    await expect.poll(async () => (await list(machine.machine.id)).total, { timeout: 10_000 }).toBeGreaterThan(0);
    tablet.serve(tabletApi(machine, [...history, derivedSteam("new-during-backfill")]));
    await waitSteam("new-during-backfill");
    expect((await list(machine.machine.id)).total).toBeLessThan(history.length + 1);
    await expect.poll(async () => (await list(machine.machine.id)).total, { timeout: 20_000 }).toBe(history.length + 1);
  }, 40_000);

  it("sends both of two Steam Records recorded in one poll interval: the newest by the next poll, the other by the next read of every id", async () => {
    const machine = await api.createMachine("Two steams in an interval");
    // Polls every 10 s of the tablet's time, 0.2 s of real time.
    const tablet = load(machine, [], { settings: { ...settingsFor(machine), PollSeconds: 10 } });
    await tablet.waitForLog(/^Connected to /);
    await expect.poll(() => idReads(tablet)).toBe(1);
    const earlier = derivedSteam("interval-earlier", { timestamp: "2026-10-05T09:00:00.000001" });
    const newest = derivedSteam("interval-newest", { timestamp: "2026-10-05T09:01:00.000001" });

    // The next poll's read of the newest finds that one, with no read of every id answered meanwhile.
    await foundByTheNextRead(tablet, "/steams/latest", "interval-newest", {
      appear: () => tablet.serve(tabletApi(machine, [earlier, newest])),
      alsoHeld: "/steams/ids",
    });
    // The next read of every id finds the other.
    const from = tablet.requests.length;
    await foundByTheNextRead(tablet, "/steams/ids", "interval-earlier");
    await waitSteam("interval-newest");
    await waitSteam("interval-earlier");
    // Every id is read once every ten poll intervals: at least nine reads of the newest come between
    // that read of every id and the next.
    await expect.poll(() => tablet.requests.slice(from).filter((route) => route === "/steams/ids").length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    const reads = tablet.requests.slice(from);
    const found = reads.indexOf("/steams/ids");
    expect(reads.slice(found, reads.indexOf("/steams/ids", found + 1)).filter((route) => route === "/steams/latest").length).toBeGreaterThanOrEqual(9);
  }, 30_000);

  it("reads every id on schedule though the connection drops more often than it polls", async () => {
    const machine = await api.createMachine("Steam on a flapping connection");
    // Polls every 5 s of the tablet's time, 0.1 s of real time.
    const tablet = load(machine, [], { settings: { ...settingsFor(machine), PollSeconds: 5 } });
    await tablet.waitForLog(/^Connected to /);
    await expect.poll(() => idReads(tablet)).toBe(1);
    tablet.serve(tabletApi(machine, [
      derivedSteam("flapping-earlier", { timestamp: "2026-10-05T09:00:00.000001" }),
      derivedSteam("flapping-newest", { timestamp: "2026-10-05T09:01:00.000001" }),
    ]));
    // A reconnect takes about a second of the tablet's time, much less than a poll interval, so
    // intervals started again on every welcome would never come round to reading every id. Each
    // welcome also queues every collection again, so nothing requested is sent meanwhile.
    for (let welcomes = 1; idReads(tablet) === 1; welcomes++) {
      expect(welcomes, "welcomes before every id was read again").toBeLessThan(200);
      tablet.dropConnections();
      await tablet.waitForLogs(/^Connected to /, welcomes + 1);
    }
    // Once the connection holds, both are sent: the other because a read of every id found it.
    await waitSteam("flapping-earlier");
    await waitSteam("flapping-newest");
  }, 60_000);

  it("goes on reading the newest Steam Record while a read of every id is slow to answer", async () => {
    const machine = await api.createMachine("Steam during a slow read");
    const before = derivedSteam("before-a-slow-read", { timestamp: "2026-10-05T08:00:00.000001" });
    // Polls every 5 s of the tablet's time, 0.1 s of real time.
    const tablet = load(machine, [before], { settings: { ...settingsFor(machine), PollSeconds: 5 } });
    await waitSteam("before-a-slow-read");
    const read = idReads(tablet);
    const release = tablet.holdSteamReads("/steams/ids");
    try {
      // The next read of every id, up to ten poll intervals on, goes unanswered.
      await expect.poll(() => idReads(tablet), { timeout: 10_000 }).toBeGreaterThan(read);
      const from = tablet.requests.length;
      tablet.serve(tabletApi(machine, [before, derivedSteam("during-a-slow-read")]));
      await waitSteam("during-a-slow-read");
      expect(steamReadsUntil(tablet, from, "during-a-slow-read")).not.toContain("/steams/ids");
    } finally {
      release();
    }
  }, 20_000);

  it("waits as long to read every id again after a read that failed slowly as after one refused at once", async () => {
    const machine = await api.createMachine("Steam after a slow failure");
    // Polls every 5 s of the tablet's time, 0.1 s of real time.
    const tablet = load(machine, [derivedSteam("before-a-slow-failure")], { settings: { ...settingsFor(machine), PollSeconds: 5 } });
    await waitSteam("before-a-slow-failure");
    const read = idReads(tablet);
    const release = tablet.holdSteamReads("/steams/ids");
    try {
      // The next read of every id, up to ten poll intervals on, goes unanswered for ten more, then
      // times out, as Decaid's fetch does after 30 s.
      await expect.poll(() => idReads(tablet), { timeout: 10_000 }).toBeGreaterThan(read);
      const held = tablet.requests.length;
      await expect.poll(() => tablet.requests.slice(held).filter((route) => route === "/steams/latest").length, { timeout: 10_000 }).toBeGreaterThanOrEqual(10);
      const failed = tablet.requests.length;
      release("timedOut");
      // Read again ten whole intervals after it failed, not at once, though ten had passed since it began.
      await expect.poll(() => tablet.requests.slice(failed).includes("/steams/ids"), { timeout: 10_000 }).toBe(true);
      const reads = tablet.requests.slice(failed);
      expect(reads.slice(0, reads.indexOf("/steams/ids")).filter((route) => route === "/steams/latest").length).toBeGreaterThanOrEqual(9);
      expect(tablet.logs.filter((line) => IDS_UNREADABLE.test(line))).toEqual([
        "Could not read the Steam Record ids: Fetch timed out. New Steam Records are still sent; reading every id is tried again less and less often until it succeeds.",
      ]);
    } finally {
      release();
    }
  }, 30_000);

  it("reads no Steam Records while the server is unreachable, and sends those recorded meanwhile once it is reachable again", async () => {
    const machine = await api.createMachine("Steam while unreachable");
    const before = derivedSteam("before-unreachable", { timestamp: "2026-10-05T08:00:00.000001" });
    // Polls every 5 s of the tablet's time, 0.1 s of real time.
    const tablet = load(machine, [before], { settings: { ...settingsFor(machine), PollSeconds: 5 } });
    await waitSteam("before-unreachable");
    tablet.loseNetwork();
    await tablet.waitForLog(/^Disconnected: could not connect/);
    const reads = steamReads(tablet);
    const meanwhile = [
      derivedSteam("unreachable-earlier", { timestamp: "2026-10-05T08:30:00.000001" }),
      derivedSteam("unreachable-newest", { timestamp: "2026-10-05T09:00:00.000001" }),
    ];
    tablet.serve(tabletApi(machine, [before, ...meanwhile]));
    // Reconnecting backs off from 1 s, doubling: by the sixth failed attempt more than a minute of the
    // tablet's time has passed, over ten poll intervals, so every id is due to be read again.
    await tablet.waitForLogs(/^Disconnected: could not connect/, 6);
    expect(steamReads(tablet)).toBe(reads);

    tablet.restoreNetwork();
    for (const record of meanwhile) await waitSteam(String(record.id));
    expect((await list(machine.machine.id, api.at(other.url))).total).toBe(3);
  });

  it("reads no Steam Records once the server refuses the plugin for good", async () => {
    const machine = await api.createMachine("Steam after a refusal");
    // Polls every 5 s of the tablet's time, 0.1 s of real time.
    const tablet = load(machine, [], { settings: { ...settingsFor(machine), PollSeconds: 5 } });
    await tablet.waitForLog(/^Connected to /);
    await expect.poll(() => steamReads(tablet)).toBeGreaterThan(2);
    // A new token closes the connection using the old one with bad_token, after which retrying cannot help.
    await api.issued(await api.call("POST", `/machines/${machine.machine.id}/token`));
    await tablet.waitForLog(/^The server refused the token\./);
    const reads = steamReads(tablet);
    // Twenty poll intervals of the tablet's time.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(steamReads(tablet)).toBe(reads);
  });

  it("sends no Shot or Steam Record index again on a reconnect after the load sent them, and goes on polling", async () => {
    const machine = await api.createMachine("Indexed before a reconnect");
    // Without the hardware it was recorded on, so it is credited to the Machine whose tablet sends it.
    const { machine: omitted, ...workflow } = shotFixture().workflow as Record<string, unknown>;
    const shots = [derivedShot("indexed-before-a-reconnect", { workflow })];
    const steams = [derivedSteam("indexed-steam", { timestamp: "2026-10-05T08:00:00.000001" })];
    // Polls every 5 s of the tablet's time, 0.1 s of real time.
    const tablet = SimulatedTablet.load({ settings: { ...settingsFor(machine), PollSeconds: 5 }, api: withShots(tabletApi(machine, steams), shots), timeScale: 50 });
    tablets.push(tablet);
    await waitSteam("indexed-steam");
    await expect.poll(async () => (await api.at(other.url).call("GET", "/shots/indexed-before-a-reconnect")).status).toBe(200);
    const indexes = (frames: unknown[]) => (frames as Sent[]).filter((frame) => frame.type === "shotIndex" || frame.type === "steamIndex");
    expect(indexes(tablet.sent).map((page) => page.type).sort()).toEqual(["shotIndex", "steamIndex"]);
    await expect.poll(() => indexes(tablet.sent).every((page) => acknowledged(tablet).has(page.id!))).toBe(true);
    const sentBefore = tablet.sent.length;
    const reads = idReads(tablet);

    tablet.dropConnections();
    await tablet.waitForLogs(/^Connected to /, 2);
    // A Steam Record recorded since is sent by the next poll, and every id is read again on schedule.
    tablet.serve(withShots(tabletApi(machine, [...steams, derivedSteam("after-a-reconnect")]), shots));
    await waitSteam("after-a-reconnect");
    await expect.poll(() => idReads(tablet), { timeout: 10_000 }).toBeGreaterThan(reads);
    expect(indexes(tablet.sent.slice(sentBefore))).toEqual([]);
  });

  it("goes on sending new Steam Records while Decaid's fetch limit refuses every id, logging that once and reading every id less and less often", async () => {
    const machine = await api.createMachine("Past the fetch limit");
    const older = derivedSteam("past-limit-older", { timestamp: "2026-10-01T08:00:00.000001" });
    const newest = derivedSteam("past-limit-newest", { timestamp: "2026-10-04T08:00:00.000001" });
    // A list of two ids passes this limit, as one of about 268,900 passes Decaid's 10 MiB.
    // Polls every 5 s of the tablet's time, 0.1 s of real time.
    const tablet = load(machine, [older, newest], { settings: { ...settingsFor(machine), PollSeconds: 5 }, steamIdsLimitBytes: 16 });
    // With no index, the newest the tablet holds is sent as new.
    await waitSteam("past-limit-newest");
    // Found by the next poll's read of the newest.
    await foundByTheNextRead(tablet, "/steams/latest", "past-limit-new", {
      appear: () => tablet.serve(tabletApi(machine, [older, newest, derivedSteam("past-limit-new", { timestamp: "2026-10-05T08:00:00.000001" })])),
      alsoHeld: "/steams/ids",
    });
    await waitSteam("past-limit-new");

    // Read on the welcome, then 1, 2, 4, 8 and 16 whole poll intervals after each failure: by the
    // welcome's poll and 31 more, at most six times, where retrying every 5 s would have read them
    // 32 times.
    await expect.poll(() => latestReads(tablet), { timeout: 20_000 }).toBeGreaterThanOrEqual(32);
    expect(idReads(tablet)).toBeGreaterThan(1);
    expect(idReads(tablet)).toBeLessThanOrEqual(6);
    expect(tablet.logs.filter((line) => IDS_UNREADABLE.test(line))).toEqual([
      "Could not read the Steam Record ids: Bad state: response exceeds maxFetchResponseBytes (16). New Steam Records are still sent; reading every id is tried again less and less often until it succeeds.",
    ]);
    // History waits until every id can be read.
    await absent("past-limit-older");
  }, 30_000);

  it("places each Steam Record's local time in UTC by the tablet's time zone, on both sides of a daylight-saving change", async () => {
    const machine = await api.createMachine("Chicago tablet");
    const times: [string, string][] = [
      // Daylight time, then standard time.
      ["2026-07-01T08:30:00.250001", "2026-07-01T13:30:00.250Z"],
      ["2026-01-15T08:30:00.250001", "2026-01-15T14:30:00.250Z"],
      // Before and after the clocks go back on 2026-11-01.
      ["2026-11-01T00:59:59.999999", "2026-11-01T05:59:59.999Z"],
      ["2026-11-01T03:00:00.000001", "2026-11-01T09:00:00.000Z"],
      // 01:30 happens twice that night, and is read as the first, still in daylight time.
      ["2026-11-01T01:30:00.000000", "2026-11-01T06:30:00.000Z"],
      // Derived: times with an offset, which Decaid does not write today, are placed by it.
      ["2026-12-01T09:00:00.000001+01:00", "2026-12-01T08:00:00.000Z"],
      ["2026-12-02T09:00:00.000001Z", "2026-12-02T09:00:00.000Z"],
    ];
    const records = times.map(([timestamp], n) => derivedSteam(`zoned-${n}`, { timestamp }));
    // Derived: times no Decaid writes, which JavaScript would otherwise roll over into others.
    const unreadable = {
      "unreadable-time": "Sunday morning",
      "no-such-day": "2026-02-30T08:30:00.250001",
      "skipped-time": "2026-03-08T02:30:00.000001",
      "no-such-offset": "2026-10-05T09:07:03.341484+99:99",
    };
    const tablet = load(machine, [...records, ...Object.entries(unreadable).map(([id, timestamp]) => derivedSteam(id, { timestamp }))]);
    for (const [n, [timestamp, utc]] of times.entries()) {
      const stored = await waitSteam(`zoned-${n}`);
      expect(stored.steamedAt).toBe(utc);
      // The record keeps the time Decaid wrote.
      expect(stored.record).toMatchObject({ timestamp });
    }
    for (const id of Object.keys(unreadable)) {
      await tablet.waitForLog(new RegExp(`^Not sending Steam Record ${id}: its time is not one Decaid writes\\.$`));
      await absent(id);
    }
    const listed = await list(machine.machine.id);
    expect(listed.steamRecords.map((steam) => steam.id)).toEqual(["zoned-6", "zoned-5", "zoned-3", "zoned-4", "zoned-2", "zoned-0", "zoned-1"]);
  });

  it("credits Steam Records to the Location their Machine was at when they were recorded, and re-credits them when its history is corrected", async () => {
    const created = await api.createMachine("Steam mover", lab.id);
    const id = created.machine.id;
    const first = created.machine.locationHistory[0]!.id;
    await moved(await api.call("PATCH", `/machines/${id}/location-history/${first}`, { effectiveFrom: "2026-01-01T00:00:00Z" }));
    const move = await moved(await api.at(other.url).call("POST", `/machines/${id}/location-history`, { locationId: uptown.id, effectiveFrom: "2026-03-01T00:00:00Z" }));
    const moveEntry = move.locationHistory[1]!.id;

    const records = [
      derivedSteam("steam-december", { timestamp: "2025-12-15T08:00:00.000001" }),
      derivedSteam("steam-february", { timestamp: "2026-02-15T08:00:00.000001" }),
      // Still the 28th of February on the tablet, but midnight on the 1st of March in UTC, when it moved.
      derivedSteam("steam-move-eve", { timestamp: "2026-02-28T18:00:00.000001" }),
      // A DE1Pro's record, in daylight time.
      derivedSteam("steam-march", { timestamp: "2026-03-15T08:00:00.000001" }, steamFixture()),
    ];
    const ids = records.map((record) => String(record.id));
    load(created, records);
    for (const steam of ids) await waitSteam(steam);
    expect(await detail("steam-move-eve")).toMatchObject({ steamedAt: "2026-03-01T00:00:00.000Z" });
    expect(await locations(ids)).toEqual({ "steam-december": null, "steam-february": "Lab", "steam-move-eve": "Uptown", "steam-march": "Uptown" });
    expect(await detail("steam-march")).toMatchObject({ machineId: id, location: uptown, locationId: uptown.id });
    expect(await detail("steam-march")).not.toHaveProperty("machineInferred");
    expect(await detail("steam-march")).not.toHaveProperty("locationInferred");
    const stored = Object.fromEntries(await Promise.all(ids.map(async (steam) => [steam, (await detail(steam)).record])));

    // It moved a moment later than recorded.
    await moved(await api.call("PATCH", `/machines/${id}/location-history/${moveEntry}`, { effectiveFrom: "2026-03-01T00:00:00.001Z" }));
    expect(await locations(ids)).toEqual({ "steam-december": null, "steam-february": "Lab", "steam-move-eve": "Lab", "steam-march": "Uptown" });
    // It never moved.
    await moved(await api.at(other.url).call("DELETE", `/machines/${id}/location-history/${moveEntry}`));
    expect(await locations(ids)).toEqual({ "steam-december": null, "steam-february": "Lab", "steam-move-eve": "Lab", "steam-march": "Lab" });
    // And it was at the Lab earlier than recorded.
    await moved(await api.call("PATCH", `/machines/${id}/location-history/${first}`, { effectiveFrom: "2025-12-01T00:00:00Z" }));
    expect(await locations(ids)).toEqual({ "steam-december": "Lab", "steam-february": "Lab", "steam-move-eve": "Lab", "steam-march": "Lab" });

    // Corrections change credit only, never the record as Decaid sent it.
    for (const steam of ids) expect((await detail(steam)).record).toEqual(stored[steam]);
  });

  it("credits a Steam Record stored during a change to its Machine's Location History, on another instance, by the changed history", async () => {
    const created = await api.createMachine("Steam during a move", lab.id);
    await moved(await api.call("PATCH", `/machines/${created.machine.id}/location-history/${created.machine.locationHistory[0]!.id}`, { effectiveFrom: "2026-01-01T00:00:00Z" }));
    const raw = await connect(created, other.url);
    const database = await server.connectDatabase();
    let moving: Promise<Response> | undefined;
    try {
      await database.query("BEGIN");
      // Holds the Steam Record's storage, once it has been credited, until the move is under way.
      await database.query("LOCK TABLE steam_measurements IN ACCESS EXCLUSIVE MODE");
      const delivery = sendSteam(raw, derivedSteam("steamed-during-a-move"), "2026-03-15T12:00:00.000Z");
      await waitForLockWaits(server, { relation: "steam_measurements" });
      moving = api.call("POST", `/machines/${created.machine.id}/location-history`, { locationId: uptown.id, effectiveFrom: "2026-03-01T00:00:00Z" });
      // The move waits for the Steam Record's storage, which holds the Machine.
      await waitForLockWaits(server, { count: 2 });
      await database.query("ROLLBACK");
      await raw.acknowledged(delivery);
    } finally {
      await database.query("ROLLBACK").catch(() => undefined);
      await database.end();
    }
    expect((await moved(await moving!)).location).toEqual(uptown);
    expect(await detail("steamed-during-a-move")).toMatchObject({ location: uptown });
  });

  it("stores each Steam Record once: repeated deliveries, through any instance or Machine, change nothing", async () => {
    const machine = await api.createMachine("Steam replays");
    const raw = await connect(machine);
    const record = derivedSteam("replayed-steam");
    const delivery = sendSteam(raw, record, "2026-10-05T14:07:03.341Z");
    await raw.acknowledged(delivery);
    const stored = await detail("replayed-steam");

    // The same delivery again, carrying other content, is acknowledged and changes nothing.
    raw.send({ type: "steam", id: delivery, steamId: record.id, steamedAt: "2026-10-06T00:00:00.000Z", steam: { ...record, futureField: true } });
    await expect.poll(() => raw.messages.filter((message) => (message as Sent).type === "ack" && (message as Sent).id === delivery).length).toBe(2);
    // So does the record in another delivery, through another instance, and through another Machine's tablet.
    const replacement = await connect(machine, other.url);
    await replacement.acknowledged(sendSteam(replacement, { ...record, futureField: true }, "2026-10-06T00:00:00.000Z"));
    const elsewhere = await api.createMachine("Steam replays elsewhere");
    const elsewhereRaw = await connect(elsewhere, other.url);
    await elsewhereRaw.acknowledged(sendSteam(elsewhereRaw, record, "2026-10-06T00:00:00.000Z"));

    expect(await detail("replayed-steam")).toEqual(stored);
    expect(stored).toMatchObject({ machineId: machine.machine.id, steamedAt: "2026-10-05T14:07:03.341Z", record: withoutMeasurements(record) });
    expect(await measurements("replayed-steam")).toEqual(record.measurements);
    expect((await list(machine.machine.id)).total).toBe(1);
    expect((await list(elsewhere.machine.id)).total).toBe(0);

    // An index asks only for what is not stored, each once.
    elsewhereRaw.send({ type: "steamIndex", id: "replay-index", steams: [{ id: "replayed-steam" }, { id: "missing-steam" }, { id: "missing-steam" }] });
    await elsewhereRaw.acknowledged("replay-index");
    expect(elsewhereRaw.messages.find((message) => (message as Sent).type === "requestSteams")).toEqual({ type: "requestSteams", steamIds: ["missing-steam"] });
  });

  it("stores a Steam Record delivered through two instances at once a single time", async () => {
    const first = await api.createMachine("Concurrent steam A");
    const second = await api.createMachine("Concurrent steam B");
    const rawA = await connect(first);
    const rawB = await connect(second, other.url);
    const record = derivedSteam("concurrent-steam");
    const database = await server.connectDatabase();
    let deliveries: [string, string] | undefined;
    try {
      await database.query("BEGIN");
      // Lets both deliveries find the record missing and credit it, then holds both before either inserts it.
      await database.query("LOCK TABLE steam_records IN SHARE MODE");
      deliveries = [sendSteam(rawA, record, "2026-10-05T14:07:03.341Z"), sendSteam(rawB, record, "2026-10-05T14:07:03.341Z")];
      await waitForLockWaits(server, { relation: "steam_records", count: 2 });
      await database.query("ROLLBACK");
    } finally {
      await database.query("ROLLBACK").catch(() => undefined);
      await database.end();
    }
    await rawA.acknowledged(deliveries![0]);
    await rawB.acknowledged(deliveries![1]);
    const both = [...(await list(first.machine.id)).steamRecords, ...(await list(second.machine.id)).steamRecords];
    expect(both.map((steam) => steam.id)).toEqual(["concurrent-steam"]);
    expect(await measurements("concurrent-steam")).toEqual(record.measurements);
  });

  it("keeps a Steam Record deleted on the tablet, and lists none with its record or measurements", async () => {
    const machine = await api.createMachine("Steam deletion");
    const record = derivedSteam("deleted-steam");
    const tablet = load(machine, [record]);
    await waitSteam("deleted-steam");
    await tablet.unload();
    const reload = load(machine, []);
    await reload.waitForLog(/^Connected to /);
    await expect.poll(() => idReads(reload)).toBeGreaterThan(0);
    const listed = (await list(machine.machine.id)).steamRecords;
    expect(listed.map((steam) => steam.id)).toEqual(["deleted-steam"]);
    expect(listed[0]).not.toHaveProperty("record");
    expect(listed[0]).not.toHaveProperty("measurements");
    expect((await detail("deleted-steam")).record).toEqual(withoutMeasurements(record));
    expect(await measurements("deleted-steam")).toEqual(record.measurements);
  });

  it("lists Steam Records while the measurements table is unavailable, without reading measurements", async () => {
    const database = await server.connectDatabase();
    try {
      await database.query("BEGIN");
      await database.query("LOCK TABLE steam_measurements IN ACCESS EXCLUSIVE MODE");
      // Reading measurements would wait for the lock until it is released, so any answer at all shows the list read none.
      const response = await Promise.race([
        api.call("GET", "/steam-records"),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("The Steam Records list waited on measurements")), 5_000);
          timer.unref();
        }),
      ]);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { total: number }).total).toBeGreaterThan(0);
    } finally {
      await database.query("ROLLBACK");
      await database.end();
    }
  }, 10_000);

  it("delivers a Steam Record larger than 1 MiB intact, in chunks, and stores it once after a reconnect partway through", async () => {
    const machine = await api.createMachine("Long steam");
    const record = longSteam("long-steam");
    expect(Buffer.byteLength(JSON.stringify(record))).toBeGreaterThan(1 << 20);
    // The network stalls once two chunks are through, so the connection drops partway through.
    let stalled = true;
    const stallUpload = (frame: unknown) => stalled && (frame as Sent).type === "chunk" && (frame as Sent).index === 2;
    const tablet = load(machine, [record], { stallUpload });
    await expect.poll(() => tablet.received.filter((message) => (message as Sent).type === "chunkReceived").length, { timeout: 10_000 }).toBe(2);
    await absent("long-steam");
    stalled = false;
    tablet.dropConnections();
    await tablet.waitForLogs(/^Connected to /, 2);
    const stored = await waitSteam("long-steam", 20_000);
    expect(stored.record).toEqual(withoutMeasurements(record));
    expect(await measurements("long-steam")).toEqual(record.measurements);
    expect((await list(machine.machine.id)).steamRecords.map((steam) => steam.id)).toEqual(["long-steam"]);
    // Sent in chunks, as one delivery, acknowledged once.
    const chunks = sent(tablet, "chunk") as (Sent & { count: number })[];
    const { id, count } = chunks.at(-1)!;
    expect(count).toBeGreaterThan(4);
    expect(chunks.slice(-count).map((chunk) => chunk.index)).toEqual(Array.from({ length: count }, (_, index) => index));
    await expect.poll(() => tablet.received.filter((message) => (message as Sent).type === "ack" && (message as Sent).id === id).length).toBe(1);
  });

  it("credits Steam Records from a mismatched connection to the reported hardware's Machine, or holds them for its Pending Machine until a machine entry takes them over", async () => {
    // Hardware another Machine has: its Steam Records are that Machine's.
    const owner = await api.createMachine("Steam hardware owner");
    const ownerRaw = await connect(owner, other.url, { model: "DE1Pro", serial: "70003" });
    const borrower = await api.createMachine("Steam borrower");
    const borrowerRaw = await connect(borrower, server.url, { model: "DE1Pro", serial: "70003" });
    await borrowerRaw.acknowledged(sendSteam(borrowerRaw, derivedSteam("steam-on-owner"), "2026-10-05T14:07:03.341Z"));
    expect(await detail("steam-on-owner")).toMatchObject({ machineId: owner.machine.id, pendingMachineId: null });
    await ownerRaw.close();

    // Hardware no Machine has: held by its Pending Machine, with no Location.
    const machine = await api.createMachine("Mismatched steamer", lab.id);
    await moved(await api.call("PATCH", `/machines/${machine.machine.id}/location-history/${machine.machine.locationHistory[0]!.id}`, { effectiveFrom: "2026-01-01T00:00:00Z" }));
    await (await connect(machine, server.url, { model: "DE1Pro", serial: "70001" })).close();
    const record = derivedSteam("mismatched-steam");
    load(machine, [record], { api: withSteams(derivedDe1Pro({ serial: "70002" }), [record]) });
    const held = await waitSteam("mismatched-steam");
    expect(held).toMatchObject({ machineId: null, machine: null, pendingMachine: { model: "DE1Pro", serial: "70002" }, location: null });
    const pending = held.pendingMachineId!;
    expect((await list(machine.machine.id)).total).toBe(0);

    // Dismissing it leaves its Steam Records out, without deleting them.
    expect((await api.call("POST", `/pending-machines/${pending}/dismiss`)).status).toBe(200);
    expect((await list()).steamRecords.map((steam) => steam.id)).not.toContain("mismatched-steam");
    await absent("mismatched-steam");

    // A machine entry for the hardware takes them over, credited by its own Location History.
    const adopted = await api.issued(await api.call("POST", `/pending-machines/${pending}/machine`, { name: "Adopted steamer", locationId: uptown.id }));
    expect(await detail("mismatched-steam")).toMatchObject({ machineId: adopted.machine.id, pendingMachineId: null, location: null });
    await moved(await api.call("PATCH", `/machines/${adopted.machine.id}/location-history/${adopted.machine.locationHistory[0]!.id}`, { effectiveFrom: "2026-01-01T00:00:00Z" }));
    expect(await detail("mismatched-steam")).toMatchObject({ location: uptown });
    expect(await measurements("mismatched-steam")).toEqual(record.measurements);
    expect((await list(adopted.machine.id)).steamRecords.map((steam) => steam.id)).toEqual(["mismatched-steam"]);
  });

  it("acknowledges and ignores a Steam Record without measurements, which Decaid v0.8.7 and later never send", async () => {
    const machine = await api.createMachine("Incompatible steam");
    const raw = await connect(machine);
    await raw.acknowledged(sendSteam(raw, derivedSteam("curveless-steam", { measurements: undefined }), "2026-10-05T14:07:03.341Z"));
    await absent("curveless-steam");
  });
});
