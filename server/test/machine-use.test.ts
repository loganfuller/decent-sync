import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite } from "./support/admin-api.js";
import { LoadedTablets, emptyLibrary } from "./support/loaded-tablets.js";
import { shotFixture, withShots } from "./support/shot-fixtures.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { derivedSteam, steamFixture, withSteams } from "./support/steam-fixtures.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1: a Machine's use by day and by hour (#475), through the REST API.
// Shots, Steam Records and Machine State changes are stored through
// simulated tablets running the built plugin: the Shots and Steam Records
// derived from ones Decaid recorded, changing only their ids, times and
// recorded hardware, and each Machine State change reported with the
// plugin's clock set to the time given, which the plugin observes it at
// within a few milliseconds. So each time in a state is compared to the
// second, and none of these changes is at the edge of an hour. Hardware ids
// are made up.
//
// The Lab is in Denver, 7 hours behind UTC in February, and the Harbor in
// Tokyo, 9 hours ahead.

type Fields = Record<string, unknown>;

interface StateTime {
  state: string;
  name: string;
  seconds: number;
}

interface Bucket {
  date: string;
  hour?: number;
  shots: number;
  steamRecords: number;
  flushes: number;
  hotWaterPours: number;
  states: StateTime[];
}

interface Use {
  by: "day" | "hour";
  from: string;
  to: string;
  buckets: Bucket[];
}

const LAB_SERIAL = "47501";
const MOVER_SERIAL = "47502";

/** A Machine State change: Decaid's state and substate, and when the plugin observes it. */
type Change = readonly [state: string, substate: string, at: string];

/**
 * Tuesday 10 February 2026 on the Lab's Machine, in the Lab's time, each
 * with its time in UTC: asleep since 22:00 the night before and woken at
 * 06:20; a Shot of 30 s at 08:00; a flush of 7 s at 08:10, heating up before
 * it pours, so two stored changes; a hot water pour of 10 s from 09:59:55,
 * across the hour's edge; steaming for 45 s at 12:00, its last 5 s the
 * purge; and a flush of 20 s from 23:59:50, across the day's edge. On the
 * 11th it idles until it is put to sleep at 20:00.
 */
const LAB_DAY: Change[] = [
  ["sleeping", "idle", "2026-02-10T05:00:00Z"],
  ["idle", "idle", "2026-02-10T13:20:00Z"],
  ["espresso", "preinfusion", "2026-02-10T15:00:00Z"],
  ["espresso", "pouring", "2026-02-10T15:00:10Z"],
  ["idle", "idle", "2026-02-10T15:00:30Z"],
  ["flush", "preparingForShot", "2026-02-10T15:10:00Z"],
  ["flush", "pouring", "2026-02-10T15:10:02Z"],
  ["idle", "idle", "2026-02-10T15:10:07Z"],
  ["hotWater", "pouring", "2026-02-10T16:59:55Z"],
  ["idle", "idle", "2026-02-10T17:00:05Z"],
  ["steam", "pouring", "2026-02-10T19:00:00Z"],
  ["steam", "pouringDone", "2026-02-10T19:00:40Z"],
  ["idle", "idle", "2026-02-10T19:00:45Z"],
  ["flush", "pouring", "2026-02-11T06:59:50Z"],
  ["idle", "idle", "2026-02-11T07:00:10Z"],
  ["sleeping", "idle", "2026-02-12T03:00:00Z"],
];

/**
 * The Machine that moved: idle from 30 December 2024, before it was at any
 * Location, asleep from 05:00 on 9 February 2026 at the Lab, woken there at
 * 11:00 on the 10th, moved to the Harbor at 13:00 that day, which is 05:00
 * on the 11th there, where it flushes for 10 s at 06:00 and is put to sleep
 * at 21:00.
 */
const MOVER_DAYS: Change[] = [
  ["idle", "idle", "2024-12-30T12:00:00Z"],
  ["sleeping", "idle", "2026-02-09T12:00:00Z"],
  ["idle", "idle", "2026-02-10T18:00:00Z"],
  ["flush", "pouring", "2026-02-10T21:00:00Z"],
  ["idle", "idle", "2026-02-10T21:00:10Z"],
  ["sleeping", "idle", "2026-02-11T12:00:00Z"],
];
const MOVED_AT = "2026-02-10T20:00:00Z";

/** Resolves once `holds` does, as expect.poll, which a hook can't call, waits. */
async function until(holds: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await holds())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** A time in a state, by Decaid's state, as the route names it. */
const NAMES: Record<string, string> = { sleeping: "Asleep", idle: "Idle", espresso: "Pulling a shot", flush: "Flushing", hotWater: "Pouring hot water", steam: "Steaming" };
const time = (state: string, seconds: number): StateTime => ({ state, name: NAMES[state]!, seconds });

/** A day or hour in which nothing was counted, but for what is given. */
const bucket = (date: string, counted: Partial<Bucket> = {}): Bucket => ({ date, shots: 0, steamRecords: 0, flushes: 0, hotWaterPours: 0, states: [], ...counted });

describe("a Machine's use", { timeout: 120_000 }, () => {
  let server: TestServer;
  let api: AdminApi;
  let lab: LocationView;
  let harbor: LocationView;
  let lab1: CreatedMachine;
  let mover: CreatedMachine;
  let timeZone: string | undefined;
  const tablets = new LoadedTablets();

  beforeAll(async () => {
    // The tablets are in UTC, which the plugin reads a Steam Record's local time in.
    timeZone = process.env.TZ;
    process.env.TZ = "UTC";
    server = await startTestServer({ env: { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" } });
    api = await AdminApi.setUp(server.url);
    lab = await api.createLocation("Lab", "America/Denver");
    harbor = await api.createLocation("Harbor", "Asia/Tokyo");
    lab1 = await api.createMachine("Lab 1");
    mover = await api.createMachine("Mover");
    for (const machine of [lab1, mover]) {
      await api.send("POST", `/machines/${machine.machine.id}/location-history`, { locationId: lab.id, effectiveFrom: "2025-01-01T00:00:00Z" }, 201);
    }
    await api.send("POST", `/machines/${mover.machine.id}/location-history`, { locationId: harbor.id, effectiveFrom: MOVED_AT }, 201);

    const labShots = [
      // During the 08:00 Shot, then a cleaning Shot at 14:00, and one at 09:00 the next day.
      shotOf("lab-morning", "2026-02-10T15:00:05Z", LAB_SERIAL),
      shotOf("lab-cleaning", "2026-02-10T21:00:00Z", LAB_SERIAL, "cleaning"),
      shotOf("lab-next-day", "2026-02-11T16:00:00Z", LAB_SERIAL),
    ];
    // While it steamed at 12:00.
    const labSteams = [derivedSteam("lab-steam", { timestamp: "2026-02-10T19:00:10.000001" }, steamFixture())];
    // At 12:00 on the 10th at the Lab, and at 07:00 on the 11th at the Harbor.
    const moverShots = [shotOf("mover-lab", "2026-02-10T19:00:00Z", MOVER_SERIAL), shotOf("mover-harbor", "2026-02-10T22:00:00Z", MOVER_SERIAL)];
    const labTablet = tablets.syncing(lab1, server, { api: withSteams(withShots(emptyLibrary(LAB_SERIAL), labShots), labSteams) });
    const moverTablet = tablets.syncing(mover, server, { api: withShots(emptyLibrary(MOVER_SERIAL), moverShots) });
    await api.waitForOnline(lab1, mover);
    await Promise.all([report(lab1, labTablet, LAB_DAY), report(mover, moverTablet, MOVER_DAYS)]);
    // Since then the Lab's tablet reported nothing, until now: idle, by its plugin's own clock.
    labTablet.reportState("idle", "idle");
    await until(async () => (await api.get<{ total: number }>(`/machines/${lab1.machine.id}/machine-state-events?limit=1`)).total === LAB_DAY.length + 1);
    await until(async () => (await api.get<{ total: number }>("/shots?limit=1")).total === labShots.length + moverShots.length);
    await until(async () => (await api.get<{ total: number }>("/steam-records?limit=1")).total === labSteams.length);
  });
  afterAll(async () => {
    await tablets.unloadAll();
    await server?.stop();
    if (timeZone === undefined) delete process.env.TZ;
    else process.env.TZ = timeZone;
  });

  /** A Shot pulled at a UTC time on the hardware given, derived from the fixture, of its profile's type or the one given. */
  function shotOf(id: string, pulledAt: string, serial: string, type?: string): Fields {
    const fixture = shotFixture();
    const workflow = fixture.workflow as Record<string, Fields>;
    return {
      ...fixture,
      id,
      timestamp: pulledAt,
      workflow: { ...workflow, profile: { ...workflow.profile, ...(type !== undefined && { beverage_type: type }) }, machine: { ...workflow.machine, model: "DE1Pro", serialNumber: serial } },
    };
  }

  /**
   * Has a Machine's tablet report each change with its plugin's clock set to
   * the change's time, and waits until every one is stored, each observed
   * within a second after its time.
   */
  async function report(machine: CreatedMachine, tablet: SimulatedTablet, changes: readonly Change[]): Promise<void> {
    type Stored = { events: { state: string; substate: string; observedAt: string }[]; total: number };
    const stored = () => api.get<Stored>(`/machines/${machine.machine.id}/machine-state-events?limit=100`);
    for (const [state, substate, at] of changes) {
      tablet.setPluginClockOffset(Date.parse(at) - Date.now());
      tablet.reportState(state, substate);
    }
    tablet.setPluginClockOffset(0);
    await until(async () => (await stored()).total === changes.length);
    const events = (await stored()).events.reverse();
    expect(events.map(({ state, substate }) => [state, substate])).toEqual(changes.map(([state, substate]) => [state, substate]));
    events.forEach((event, n) => {
      const late = Date.parse(event.observedAt) - Date.parse(changes[n]![2]);
      expect(late, changes[n]![2]).toBeGreaterThanOrEqual(0);
      expect(late, changes[n]![2]).toBeLessThan(1_000);
    });
  }

  /** A Machine's use, each time in a state to the second. */
  async function use(machine: CreatedMachine, query: Record<string, string> = {}, at = api): Promise<Use> {
    const read = await at.get<Use>(`/machines/${machine.machine.id}/use?${new URLSearchParams(query)}`);
    return { ...read, buckets: read.buckets.map((entry) => ({ ...entry, states: entry.states.map((state) => ({ ...state, seconds: Math.round(state.seconds) })) })) };
  }

  const refusal = async (path: string) => {
    const response = await api.call("GET", path);
    return { status: response.status, message: ((await response.json()) as { message: unknown }).message };
  };

  it("counts each day's Shots, Steam Records, flushes and hot water pours, a cleaning Shot included, and the time in each Machine State, the longest first, by the Location's days", async () => {
    expect(await use(lab1, { from: "2026-02-10", to: "2026-02-11" })).toEqual({
      by: "day",
      // The 10th and the 11th in Denver.
      from: "2026-02-10T07:00:00.000Z",
      to: "2026-02-12T07:00:00.000Z",
      buckets: [
        bucket("2026-02-10", {
          // The morning's Shot and the cleaning Shot.
          shots: 2,
          steamRecords: 1,
          // The flush at 08:10, two stored changes, once; and the one that began at 23:59:50.
          flushes: 2,
          hotWaterPours: 1,
          states: [
            // The rest of the day: 86,400 s less those below.
            time("idle", 63_498),
            // Asleep since the night before: from midnight to 06:20.
            time("sleeping", 22_800),
            // The purge counts with it.
            time("steam", 45),
            time("espresso", 30),
            // 7 s at 08:10, and the 10 s to midnight of the one across it.
            time("flush", 17),
            time("hotWater", 10),
          ],
        }),
        bucket("2026-02-11", {
          shots: 1,
          // Idle from 00:00:10 to 20:00, asleep to midnight, and the 10 s left of the flush that began the day before,
          // which is counted there.
          states: [time("idle", 71_990), time("sleeping", 14_400), time("flush", 10)],
        }),
      ],
    });
  });

  it("counts by hour for a range of one day, a state across an hour's edge split between the hours and a pour that crosses one counted where it began", async () => {
    const day = await use(lab1, { from: "2026-02-10", to: "2026-02-10", by: "hour" });
    expect(day).toMatchObject({ by: "hour", from: "2026-02-10T07:00:00.000Z", to: "2026-02-11T07:00:00.000Z" });
    expect(day.buckets.map((entry) => [entry.date, entry.hour])).toEqual(Array.from({ length: 24 }, (_, hour) => ["2026-02-10", hour]));
    const hour = (n: number, counted: Partial<Bucket>) => ({ ...bucket("2026-02-10", counted), hour: n });
    const hours = Object.fromEntries(day.buckets.map((entry) => [entry.hour, entry]));
    expect(hours[5]).toEqual(hour(5, { states: [time("sleeping", 3600)] }));
    expect(hours[6]).toEqual(hour(6, { states: [time("idle", 2400), time("sleeping", 1200)] }));
    expect(hours[8]).toEqual(hour(8, { shots: 1, flushes: 1, states: [time("idle", 3563), time("espresso", 30), time("flush", 7)] }));
    // The pour's first 5 s, and the pour, in the hour it began in; its last 5 s in the next.
    expect(hours[9]).toEqual(hour(9, { hotWaterPours: 1, states: [time("idle", 3595), time("hotWater", 5)] }));
    expect(hours[10]).toEqual(hour(10, { states: [time("idle", 3595), time("hotWater", 5)] }));
    expect(hours[12]).toEqual(hour(12, { steamRecords: 1, states: [time("idle", 3555), time("steam", 45)] }));
    expect(hours[14]).toEqual(hour(14, { shots: 1, states: [time("idle", 3600)] }));
    expect(hours[23]).toEqual(hour(23, { flushes: 1, states: [time("idle", 3590), time("flush", 10)] }));
    // The hours add up to the day.
    const total = (pick: (entry: Bucket) => number) => day.buckets.reduce((sum, entry) => sum + pick(entry), 0);
    expect([total((entry) => entry.shots), total((entry) => entry.steamRecords), total((entry) => entry.flushes), total((entry) => entry.hotWaterPours)]).toEqual([2, 1, 2, 1]);
    expect(total((entry) => entry.states.reduce((sum, state) => sum + state.seconds, 0))).toBe(86_400);
  });

  it("takes each bound as a time with its offset too, cutting the first and last hour at it, and counts no pour that began before the range", async () => {
    // From 3 s into the hot water pour to 10:30.
    const part = await use(lab1, { from: "2026-02-10T09:59:58-07:00", to: "2026-02-10T17:30:00Z", by: "hour" });
    expect(part).toEqual({
      by: "hour",
      from: "2026-02-10T16:59:58.000Z",
      to: "2026-02-10T17:30:00.000Z",
      buckets: [
        { ...bucket("2026-02-10", { states: [time("hotWater", 2)] }), hour: 9 },
        { ...bucket("2026-02-10", { states: [time("idle", 1795), time("hotWater", 5)] }), hour: 10 },
      ],
    });
    // By day, a range of times is cut the same way: the last 12 hours of the 10th and the first 6 of the 11th.
    expect(await use(lab1, { from: "2026-02-10T12:00:00-07:00", to: "2026-02-11T06:00:00-07:00" })).toMatchObject({
      buckets: [
        { date: "2026-02-10", shots: 1, steamRecords: 1, flushes: 1, states: [time("idle", 43_145), time("steam", 45), time("flush", 10)] },
        { date: "2026-02-11", shots: 0, flushes: 0, states: [time("idle", 21_590), time("flush", 10)] },
      ],
    });
  });

  it("counts nothing before a Machine's first Machine State, and gives each day of the range even so", async () => {
    expect(await use(lab1, { from: "2026-01-05", to: "2026-01-06" })).toEqual({
      by: "day",
      from: "2026-01-05T07:00:00.000Z",
      to: "2026-01-07T07:00:00.000Z",
      buckets: [bucket("2026-01-05"), bucket("2026-01-06")],
    });
  });

  it("goes by the Location the Machine was at then: the day of a move to another time zone in two parts, each by its own Location's clock, and UTC's days before its first Location", async () => {
    // The 10th began at the Lab, where the Machine was at noon UTC, and the 11th ends at the Harbor. It left the Lab at
    // 13:00 on the 10th, which was 05:00 on the 11th at the Harbor: 13 hours of the 10th, and 19 of the 11th.
    expect(await use(mover, { from: "2026-02-10", to: "2026-02-11" })).toEqual({
      by: "day",
      from: "2026-02-10T07:00:00.000Z",
      to: "2026-02-11T15:00:00.000Z",
      buckets: [
        // Asleep until 11:00, then idle until it left at 13:00; the Shot at 12:00.
        bucket("2026-02-10", { shots: 1, states: [time("sleeping", 39_600), time("idle", 7_200)] }),
        // At the Harbor from 05:00: a flush of 10 s at 06:00, the Shot at 07:00, and asleep from 21:00.
        bucket("2026-02-11", { shots: 1, flushes: 1, states: [time("idle", 57_590), time("sleeping", 10_800), time("flush", 10)] }),
      ],
    });
    // By hour over the move: 12:00 at the Lab, then 05:00 at the Harbor, where the hour before never was.
    const moved = await use(mover, { from: "2026-02-10T19:00:00Z", to: "2026-02-10T21:00:00Z", by: "hour" });
    expect(moved.buckets.map((entry) => [entry.date, entry.hour, entry.shots])).toEqual([["2026-02-10", 12, 1], ["2026-02-11", 5, 0]]);

    // At no Location until 2025, its days are UTC's: 31 December 2024 in UTC, and then the 7 hours left of that day
    // at the Lab, are one day of 31 hours, all idle; 1 January is the Lab's.
    expect(await use(mover, { from: "2024-12-31", to: "2025-01-01" })).toEqual({
      by: "day",
      from: "2024-12-31T00:00:00.000Z",
      to: "2025-01-02T07:00:00.000Z",
      buckets: [bucket("2024-12-31", { states: [time("idle", 111_600)] }), bucket("2025-01-01", { states: [time("idle", 86_400)] })],
    });
  });

  it("gives the last 14 days by day, or today by hour, when no range is given, a Machine whose tablet reported nothing since counted as in its last state, until now", async () => {
    const before = Date.now();
    const fortnight = await use(lab1);
    const after = Date.now();
    // Its days at the Lab, where it is now.
    const today = Temporal.Instant.fromEpochMilliseconds(Date.parse(fortnight.to)).toZonedDateTimeISO("America/Denver").toPlainDate();
    const days = Array.from({ length: 14 }, (_, n) => today.subtract({ days: 13 - n }));
    const startOf = (day: Temporal.PlainDate) => day.toZonedDateTime("America/Denver").epochMilliseconds;
    expect(fortnight.by).toBe("day");
    expect(Date.parse(fortnight.from)).toBe(startOf(days[0]!));
    // Until now, by the database's clock, which is this computer's.
    expect(Date.parse(fortnight.to)).toBeGreaterThanOrEqual(before - 5_000);
    expect(Date.parse(fortnight.to)).toBeLessThanOrEqual(after + 5_000);
    expect(fortnight.buckets.map((entry) => entry.date)).toEqual(days.map(String));
    // Asleep since 11 February, as far as its tablet said: each whole day asleep, 23 or 25 hours where the clocks changed.
    for (const [n, day] of days.slice(0, 13).entries()) {
      expect(fortnight.buckets[n], String(day)).toEqual(bucket(String(day), { states: [time("sleeping", (startOf(day.add({ days: 1 })) - startOf(day)) / 1000)] }));
    }
    // Today, asleep until its tablet reported it idle as this file began, and idle until now.
    const counted = fortnight.buckets[13]!.states.reduce((sum, state) => sum + state.seconds, 0);
    expect(fortnight.buckets[13]!.states.map((state) => state.state).sort()).toEqual(["idle", "sleeping"]);
    expect(Math.abs(counted - (Date.parse(fortnight.to) - startOf(today)) / 1000)).toBeLessThanOrEqual(1);

    const hourly = await use(lab1, { by: "hour" });
    expect(Date.parse(hourly.from)).toBe(startOf(today));
    expect(hourly.buckets.length).toBeLessThanOrEqual(25);
    expect(new Set(hourly.buckets.map((entry) => entry.date))).toEqual(new Set([String(today)]));
    // A day yet to come has nothing in it.
    const later = String(today.add({ days: 2 }));
    expect((await use(lab1, { from: later, to: later })).buckets).toEqual([]);
  });

  it("refuses a range it can't read, one that ends before it starts, and one longer than 31 days by day or a day by hour", async () => {
    const path = `/machines/${lab1.machine.id}/use`;
    const entered = (name: string) => `Enter ${name} as a date, such as 2026-11-06, or a time with its offset, such as 2026-11-06T14:30:00-05:00`;
    expect(await refusal(`${path}?from=2026-02-30`)).toEqual({ status: 400, message: [entered("from")] });
    // A time needs its offset.
    expect(await refusal(`${path}?to=2026-02-10T08:00:00`)).toEqual({ status: 400, message: [entered("to")] });
    expect(await refusal(`${path}?from=2026-02-10&from=2026-02-11&by=week`)).toEqual({ status: 400, message: ["Give from once", "Choose by as day or hour"] });
    for (const range of ["from=2026-02-11&to=2026-02-10", "from=2026-02-10T08:00:00Z&to=2026-02-10T08:00:00Z"]) {
      expect(await refusal(`${path}?${range}`), range).toEqual({ status: 400, message: "Choose an end after the start" });
    }
    expect(await refusal(`${path}?from=0000-01-01&to=0000-01-02`)).toEqual({ status: 400, message: "Times must be in the years 1 to 9999, in UTC" });

    // 31 days are read, across the day in March the clocks go forward at the Lab, and 32 are not.
    expect((await use(lab1, { from: "2026-02-10", to: "2026-03-12" })).buckets).toHaveLength(31);
    expect(await refusal(`${path}?from=2026-02-10&to=2026-03-13`)).toEqual({ status: 400, message: "Choose a range of at most 31 days" });
    expect(await refusal(`${path}?from=2026-02-10&to=2026-02-11&by=hour`)).toEqual({ status: 400, message: "Choose a range of at most a day to read by hour" });

    expect(await refusal("/machines/lab-1/use")).toMatchObject({ status: 404 });
    expect(await refusal("/machines/00000000-0000-7000-8000-000000000000/use")).toEqual({ status: 404, message: "No such Machine" });
  });

  it("is read by Staff, at whatever Location, and by Viewers, never signed out", async () => {
    const staff = await api.staffAt("sam@example.com", harbor);
    const { link } = await api.invite("val@example.com", "viewer");
    const viewer = AdminApi.signedInAs(server.url, await acceptInvite(server.url, link, { name: "Val Viewer", password: "val's password" }));
    const range = { from: "2026-02-10", to: "2026-02-11" };
    for (const reader of [staff, viewer]) {
      expect(await use(lab1, range, reader)).toEqual(await use(lab1, range));
      expect(await use(lab1, { ...range, to: "2026-02-10", by: "hour" }, reader)).toEqual(await use(lab1, { ...range, to: "2026-02-10", by: "hour" }));
    }
    expect((await api.call("GET", `/machines/${lab1.machine.id}/use`, undefined, {})).status).toBe(401);
  });
});
