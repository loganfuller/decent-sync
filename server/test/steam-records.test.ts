import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, type MachineView } from "./support/admin-api.js";
import { derivedSteam, longSteam, milkProbeSteamFixture, steamFixture, withSteams } from "./support/steam-fixtures.js";
import { RawConnection, SimulatedTablet, derivedDe1Pro, helloWith, settingsFor } from "./support/simulated-tablet.js";
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

describe("Steam Record capture", () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  let lab: LocationView;
  let uptown: LocationView;
  let timeZone: string | undefined;
  const tablets: SimulatedTablet[] = [];
  const raws: RawConnection[] = [];
  const timers: NodeJS.Timeout[] = [];
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
    timers.splice(0).forEach(clearInterval);
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
    const raw = await RawConnection.open(url);
    raws.push(raw);
    raw.send(helloWith(machine.token, hardware ? { machine: hardware } : {}));
    expect(await raw.message(0)).toMatchObject({ type: "welcome" });
    timers.push(setInterval(() => raw.send({ type: "heartbeat" }), 300));
    return raw;
  }
  function sendSteam(raw: RawConnection, record: Record<string, unknown>, steamedAt: string, id = randomUUID()) {
    raw.send({ type: "steam", id, steamId: String(record.id), steamedAt, steam: record });
    return id;
  }
  async function acknowledged(raw: RawConnection, id: string) {
    await expect.poll(() => raw.messages.some((message) => (message as Sent).type === "ack" && (message as Sent).id === id)).toBe(true);
  }
  async function moved(response: Response): Promise<MachineView> {
    const body = (await response.json()) as { machine: MachineView; message?: unknown };
    expect(response.status, JSON.stringify(body.message)).toBeLessThan(300);
    return body.machine;
  }
  /** Waits until a query on the test database waits for a lock, such as one the test holds. */
  async function someoneWaits(database: { query<T>(text: string): Promise<{ rows: T[] }> }) {
    const waiting = "SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())";
    await expect.poll(async () => (await database.query<{ waiting: number }>(waiting)).rows[0]!.waiting).toBeGreaterThan(0);
  }
  /** The record without its measurements, as Steam Record detail returns it. */
  function withoutMeasurements(record: Record<string, unknown>) {
    const { measurements: omitted, ...rest } = record;
    return rest;
  }

  it("requires a session for all Steam Record reads, and validates pagination and Machine ids", async () => {
    for (const path of ["/steam-records", "/steam-records/missing", "/steam-records/missing/measurements"]) {
      expect((await api.call("GET", path, undefined, {})).status).toBe(401);
    }
    for (const query of ["limit=0", "limit=101", "offset=-1", "limit=1.2"]) expect((await api.call("GET", `/steam-records?${query}`)).status).toBe(400);
    expect((await api.call("GET", "/steam-records?machineId=not-a-machine")).status).toBe(404);
    await absent("missing");
  });

  it("backfills an adopted tablet's whole history, indexing it in pages of at most 100, including after a mid-backfill disconnect", async () => {
    const machine = await api.createMachine("Steam history");
    const history = Array.from({ length: 205 }, (_, n) =>
      derivedSteam(`history-${String(n).padStart(3, "0")}`, { timestamp: new Date(Date.UTC(2026, 0, 1, 8, n)).toISOString().replace("Z", "001") }),
    );
    const tablet = load(machine, history, { apiDelayMs: 500 });
    await expect.poll(async () => (await list(machine.machine.id)).total, { timeout: 10_000 }).toBeGreaterThan(0);
    expect((await list(machine.machine.id)).total).toBeLessThan(history.length);
    tablet.dropConnections();
    await tablet.waitForLogs(/^Connected to /, 2);
    await expect.poll(async () => (await list(machine.machine.id)).total, { timeout: 20_000 }).toBe(205);

    // Every welcome sent every id, in pages of at most 100.
    const pages = sent(tablet, "steamIndex").map((page) => page.steams!.map((steam) => steam.id));
    expect(pages.slice(0, 3).map((page) => page.length)).toEqual([100, 100, 5]);
    expect(new Set(pages.slice(0, 3).flat())).toEqual(new Set(history.map((steam) => steam.id)));
    expect(pages.length).toBeGreaterThan(3);
    expect(pages.every((page) => page.length <= 100)).toBe(true);
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

  it("sends a new Steam Record by the next poll, with its measurements and milk temperature, credited to the reporting Machine", async () => {
    const machine = await api.createMachine("Live steam");
    // Polls every two minutes of the tablet's time: 2.4 s of real time.
    const tablet = load(machine, [], { settings: { ...settingsFor(machine), PollSeconds: 120 } });
    await tablet.waitForLog(/^Connected to /);
    await expect.poll(() => idReads(tablet)).toBeGreaterThan(0);

    const record = milkProbeSteamFixture();
    tablet.serve(tabletApi(machine, [record]));
    const readsBefore = idReads(tablet);
    // Stored once the first read of the ids after it appeared found it, before the next read.
    await expect.poll(async () => (await api.call("GET", `/steam-records/${record.id}`)).status, { timeout: 10_000, interval: 20 }).toBe(200);
    expect(idReads(tablet)).toBe(readsBefore + 1);

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
      await someoneWaits(database);
      moving = api.call("POST", `/machines/${created.machine.id}/location-history`, { locationId: uptown.id, effectiveFrom: "2026-03-01T00:00:00Z" });
      // The move waits for the Steam Record's storage, which holds the Machine.
      const settled = await Promise.race([moving.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500))]);
      expect(settled).toBe(false);
      await database.query("ROLLBACK");
      await acknowledged(raw, delivery);
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
    await acknowledged(raw, delivery);
    const stored = await detail("replayed-steam");

    // The same delivery again, carrying other content, is acknowledged and changes nothing.
    raw.send({ type: "steam", id: delivery, steamId: record.id, steamedAt: "2026-10-06T00:00:00.000Z", steam: { ...record, futureField: true } });
    await expect.poll(() => raw.messages.filter((message) => (message as Sent).type === "ack" && (message as Sent).id === delivery).length).toBe(2);
    // So does the record in another delivery, through another instance, and through another Machine's tablet.
    const replacement = await connect(machine, other.url);
    await acknowledged(replacement, sendSteam(replacement, { ...record, futureField: true }, "2026-10-06T00:00:00.000Z"));
    const elsewhere = await api.createMachine("Steam replays elsewhere");
    const elsewhereRaw = await connect(elsewhere, other.url);
    await acknowledged(elsewhereRaw, sendSteam(elsewhereRaw, record, "2026-10-06T00:00:00.000Z"));

    expect(await detail("replayed-steam")).toEqual(stored);
    expect(stored).toMatchObject({ machineId: machine.machine.id, steamedAt: "2026-10-05T14:07:03.341Z", record: withoutMeasurements(record) });
    expect(await measurements("replayed-steam")).toEqual(record.measurements);
    expect((await list(machine.machine.id)).total).toBe(1);
    expect((await list(elsewhere.machine.id)).total).toBe(0);

    // An index asks only for what is not stored, each once.
    elsewhereRaw.send({ type: "steamIndex", id: "replay-index", steams: [{ id: "replayed-steam" }, { id: "missing-steam" }, { id: "missing-steam" }] });
    await acknowledged(elsewhereRaw, "replay-index");
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
      await expect.poll(async () => (await database.query<{ waiting: number }>(
        "SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted AND relation = 'steam_records'::regclass",
      )).rows[0]!.waiting).toBe(2);
      await database.query("ROLLBACK");
    } finally {
      await database.query("ROLLBACK").catch(() => undefined);
      await database.end();
    }
    await acknowledged(rawA, deliveries![0]);
    await acknowledged(rawB, deliveries![1]);
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
      const response = await Promise.race([
        api.call("GET", "/steam-records"),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("The Steam Records list waited on measurements")), 1_000);
          timer.unref();
        }),
      ]);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { total: number }).total).toBeGreaterThan(0);
    } finally {
      await database.query("ROLLBACK");
      await database.end();
    }
  });

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
    await acknowledged(borrowerRaw, sendSteam(borrowerRaw, derivedSteam("steam-on-owner"), "2026-10-05T14:07:03.341Z"));
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
    await acknowledged(raw, sendSteam(raw, derivedSteam("curveless-steam", { measurements: undefined }), "2026-10-05T14:07:03.341Z"));
    await absent("curveless-steam");
  });
});
