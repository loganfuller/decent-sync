import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite } from "./support/admin-api.js";
import { LoadedTablets, emptyLibrary } from "./support/loaded-tablets.js";
import { burrsShotFixture, preheatShotFixture, shotFixture, withShots } from "./support/shot-fixtures.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1: the Shot Summary of the Shots a filter finds (#466), through the
// REST API. Shots are stored through simulated tablets running the built
// plugin, each derived from one of three Shots Decaid recorded, changing
// only its id, time, recorded hardware and what a test names. Hardware ids
// are made up.
//
// What each of the three shows, worked out by hand from its record: the
// yield it weighed less its target, and its duration, from its first sample
// after its Preheat to its last.
//
// | Fixture | Yield weighed − target | First sample after Preheat | Last sample | Duration |
// |---|---|---|---|---|
// | shot-espresso.json | 35.9 − 36 = −0.1 g | 14:14:15.068 | 14:14:38.617 | 23.549 s |
// | shot-preheat.json | 34.7 − 36 = −1.3 g | 15:53:24.816 | 15:53:50.649 | 25.833 s |
// | shot-grinder-burrs.json | 30 − 36 = −6 g | 07:55:32.723 | 07:55:36.818 | 4.095 s |
//
// Each recorded `targetWeight` as its stop reason, and `espresso` as its
// profile's type. A percentile is interpolated between the two Shots
// nearest it: of n values in order, counted from 0, the one at p × (n − 1).

interface SummaryNumber {
  shots: number;
  median: number | null;
  p25: number | null;
  p75: number | null;
}

interface Group {
  counts: { shots: number; unfinished: number; cleaningAndCalibration: number; awaitingValues: number };
  numbers: { yieldAgainstTarget: SummaryNumber; duration: SummaryNumber; stoppedOnWeight: { shots: number; share: number | null } };
}

type Fields = Record<string, unknown>;

/** What a test changes of a fixture's record. */
interface Changes {
  /** Recorded on this hardware rather than its tablet's Machine's. */
  serial?: string;
  actualYield?: number;
  targetYield?: number;
  /** What stopped it; null for a Shot that recorded none. */
  stopReason?: string | null;
  /** Its profile's type; null for a profile that recorded none. */
  type?: string | null;
}

const LAB_SERIAL = "46601";
const HARBOR_SERIAL = "46602";
const UNKNOWN_SERIAL = "46609";

/** No number: what a summary gives where no Shot had a value. */
const NONE = { shots: 0, median: null, p25: null, p75: null };

/** Resolves once `holds` does, as expect.poll, which a hook can't call, waits. */
async function until(holds: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await holds())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("Shot Summaries", () => {
  let server: TestServer;
  let api: AdminApi;
  let lab: LocationView;
  let harbor: LocationView;
  let lab1: CreatedMachine;
  let harbor1: CreatedMachine;
  let labTablet: SimulatedTablet;
  let harborTablet: SimulatedTablet;
  const tablets = new LoadedTablets();

  // Denver is 7 hours behind UTC in February, and Tokyo 9 ahead.
  const labShots = [
    shotOf("lab-espresso", "2026-02-10T15:00:00Z", LAB_SERIAL),
    shotOf("lab-preheat", "2026-02-10T16:00:00Z", LAB_SERIAL, {}, preheatShotFixture()),
    shotOf("lab-burrs", "2026-02-10T17:00:00Z", LAB_SERIAL, {}, burrsShotFixture()),
    // 2.4 g over its target, and ended by the Machine as its profile finished.
    shotOf("lab-over", "2026-02-10T18:00:00Z", LAB_SERIAL, { actualYield: 38.4, stopReason: "machineEnded" }),
    // A target of 0 is no target, and it recorded no stop reason.
    shotOf("lab-no-target", "2026-02-10T19:00:00Z", LAB_SERIAL, { targetYield: 0, stopReason: null }),
    // 13:00 and 14:00 at the Lab.
    shotOf("lab-cleaning", "2026-02-10T20:00:00Z", LAB_SERIAL, { type: "cleaning" }),
    shotOf("lab-calibrate", "2026-02-10T21:00:00Z", LAB_SERIAL, { type: "Calibrate" }, preheatShotFixture()),
    // 22:00 on the 10th at the Lab, the 11th in UTC; its profile recorded no type.
    shotOf("lab-evening", "2026-02-11T05:00:00Z", LAB_SERIAL, { actualYield: 36.5, type: null }),
    // Recorded on hardware no Machine has, which a Pending Machine holds, at no Location.
    shotOf("pending-shot", "2026-02-12T12:00:00Z", UNKNOWN_SERIAL),
  ];
  const harborShots = [
    // 23:30 on the 10th at the Harbor; another type than cleaning or calibration.
    shotOf("harbor-late", "2026-02-10T14:30:00Z", HARBOR_SERIAL, { actualYield: 35, type: "pourover" }),
    // 08:30 on the 11th at the Harbor, the 10th in UTC.
    shotOf("harbor-morning", "2026-02-10T23:30:00Z", HARBOR_SERIAL, {}, preheatShotFixture()),
  ];

  beforeAll(async () => {
    server = await startTestServer({ env: { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" } });
    api = await AdminApi.setUp(server.url);
    lab = await api.createLocation("Lab", "America/Denver");
    harbor = await api.createLocation("Harbor", "Asia/Tokyo");
    lab1 = await api.createMachine("Lab 1");
    harbor1 = await api.createMachine("Harbor 1");
    // Each was at its Location long before its Shots were pulled.
    for (const [machine, location] of [[lab1, lab], [harbor1, harbor]] as const) {
      await api.send("POST", `/machines/${machine.machine.id}/location-history`, { locationId: location.id, effectiveFrom: "2025-01-01T00:00:00Z" }, 201);
    }
    labTablet = tablets.syncing(lab1, server, { api: withShots(emptyLibrary(LAB_SERIAL), labShots) });
    harborTablet = tablets.syncing(harbor1, server, { api: withShots(emptyLibrary(HARBOR_SERIAL), harborShots) });
    // Each tablet's plugin indexes its Shots and sends those the server asks for, one at a time.
    await until(async () => (await listTotal()) === labShots.length + harborShots.length);
  });
  afterAll(async () => {
    await tablets.unloadAll();
    await server?.stop();
  });

  /** A Shot pulled at a UTC time on the hardware given, derived from `fixture` with the changes given. */
  function shotOf(id: string, pulledAt: string, serial: string, changes: Changes = {}, fixture = shotFixture()): Fields {
    const { stopReason: recordedStop, ...record } = fixture;
    const workflow = fixture.workflow as Record<string, Fields>;
    const { beverage_type: recordedType, ...profile } = workflow.profile!;
    const stopReason = changes.stopReason === undefined ? recordedStop : changes.stopReason;
    const type = changes.type === undefined ? recordedType : changes.type;
    return {
      ...record,
      id,
      timestamp: pulledAt,
      ...(stopReason !== null && { stopReason }),
      workflow: {
        ...workflow,
        context: { ...workflow.context, ...(changes.targetYield !== undefined && { targetYield: changes.targetYield }) },
        profile: { ...profile, ...(type !== null && { beverage_type: type }) },
        machine: { ...workflow.machine, model: "DE1Pro", serialNumber: serial },
      },
      annotations: { ...(fixture.annotations as Fields), ...(changes.actualYield !== undefined && { actualYield: changes.actualYield }) },
    };
  }

  /** How many Shots the list lists for the filters. */
  async function listTotal(query: Record<string, string> = {}): Promise<number> {
    return (await api.get<{ total: number }>(`/shots?${new URLSearchParams({ limit: "1", ...query })}`)).total;
  }

  /** The summary of the Shots the filters find: its one group, each number to the microgram or microsecond, clear of the last bit of its arithmetic. */
  async function summary(query: Record<string, string> = {}, at = api): Promise<Group> {
    const { groups } = await at.get<{ groups: Group[] }>(`/shots/summary?${new URLSearchParams(query)}`);
    expect(groups).toHaveLength(1);
    const exact = (value: number | null) => (value === null ? null : Math.round(value * 1e6) / 1e6);
    const number = ({ shots, median, p25, p75 }: SummaryNumber) => ({ shots, median: exact(median), p25: exact(p25), p75: exact(p75) });
    const { counts, numbers } = groups[0]!;
    return {
      counts,
      numbers: {
        yieldAgainstTarget: number(numbers.yieldAgainstTarget),
        duration: number(numbers.duration),
        stoppedOnWeight: { shots: numbers.stoppedOnWeight.shots, share: exact(numbers.stoppedOnWeight.share) },
      },
    };
  }

  it("counts the Shots its numbers cover and the cleaning and calibration Shots left out, and gives yield against target and duration as a median with its quartiles, and the share stopped on weight, each with the Shots it rests on", async () => {
    expect(await summary()).toEqual({
      // Every Shot but the cleaning and the calibration one, whose type is matched ignoring case. One that recorded no
      // type counts, as does a pourover.
      counts: { shots: 9, unfinished: 0, cleaningAndCalibration: 2, awaitingValues: 0 },
      numbers: {
        // All but the Shot whose target is 0: −6, −1.3, −1.3, −1, −0.1, −0.1, 0.5 and 2.4. The median is halfway from −1 to
        // −0.1, the 25th percentile between the two at −1.3, and the 75th a quarter of the way from −0.1 to 0.5.
        yieldAgainstTarget: { shots: 8, median: -0.55, p25: -1.3, p75: 0.05 },
        // 4.095, six of 23.549 and two of 25.833.
        duration: { shots: 9, median: 23.549, p25: 23.549, p75: 23.549 },
        // Of the eight that recorded a stop reason, all but the one its Machine ended.
        stoppedOnWeight: { shots: 8, share: 0.875 },
      },
    });
    expect(await listTotal()).toBe(11);

    // A group of two Shots gives the same, each number saying how little it rests on: −1.3 and −1, and 23.549 and 25.833.
    expect(await summary({ locationId: harbor.id })).toEqual({
      counts: { shots: 2, unfinished: 0, cleaningAndCalibration: 0, awaitingValues: 0 },
      numbers: {
        yieldAgainstTarget: { shots: 2, median: -1.15, p25: -1.225, p75: -1.075 },
        duration: { shots: 2, median: 24.691, p25: 24.12, p75: 25.262 },
        stoppedOnWeight: { shots: 2, share: 1 },
      },
    });
  });

  it("reads a date in each Shot's own Location's time zone, as the list does", async () => {
    // The 10th at the Lab runs to 07:00 UTC on the 11th, so it holds the Lab's evening Shot; at the Harbor it ended at
    // 15:00 UTC on the 10th, so it holds the late Shot there and not the next morning's, pulled earlier than the Lab's
    // evening one. The Pending Machine's Shot, read in UTC, is on the 12th. A UTC day would hold the Harbor's morning
    // Shot and not the Lab's evening one.
    const day = { from: "2026-02-10", to: "2026-02-10" };
    expect(await summary(day)).toEqual({
      counts: { shots: 7, unfinished: 0, cleaningAndCalibration: 2, awaitingValues: 0 },
      numbers: {
        // −6, −1.3, −1, −0.1, 0.5 and 2.4.
        yieldAgainstTarget: { shots: 6, median: -0.55, p25: -1.225, p75: 0.35 },
        // 4.095, five of 23.549 and 25.833.
        duration: { shots: 7, median: 23.549, p25: 23.549, p75: 23.549 },
        stoppedOnWeight: { shots: 6, share: 0.833333 },
      },
    });
    expect(await listTotal(day)).toBe(9);
    expect(await summary({ ...day, locationId: harbor.id })).toMatchObject({ counts: { shots: 1, unfinished: 0, cleaningAndCalibration: 0, awaitingValues: 0 }, numbers: { yieldAgainstTarget: { shots: 1, median: -1, p25: -1, p75: -1 } } });
    // Times too: 13:00 to 15:00 at the Lab holds only its cleaning and calibration Shots, so there is no number.
    expect(await summary({ from: "2026-02-10T13:00", to: "2026-02-10T15:00" })).toEqual({
      counts: { shots: 0, unfinished: 0, cleaningAndCalibration: 2, awaitingValues: 0 },
      numbers: { yieldAgainstTarget: NONE, duration: NONE, stoppedOnWeight: { shots: 0, share: null } },
    });
  });

  it("covers the Shots the list lists for the same filters, whichever filter", async () => {
    const pendingMachineId = (await api.pendingMachines()).find((pending) => pending.serial === UNKNOWN_SERIAL)!.id;
    const filters: Record<string, string>[] = [
      {},
      { machineId: lab1.machine.id },
      { machineId: harbor1.machine.id },
      { pendingMachineId },
      { locationId: lab.id },
      { locationId: "none" },
      { from: "2026-02-11" },
      { to: "2026-02-10T12:00" },
      { coffeeRoaster: "Roux Bakehouse", coffeeName: "Ethiopia Generic 100g Sample" },
      { coffeeRoaster: "", coffeeName: "" },
      { barista: "Fixture Barista" },
      { barista: "" },
      { profileTitle: "Londonium" },
      { profileTitle: "adaptive", match: "words" },
      { beanBatchId: "none" },
      { grinderId: "none" },
      { basketId: "none" },
      { recipeId: "none" },
      { beanBatchId: randomUUID() },
      { grinderId: randomUUID() },
      { basketId: randomUUID() },
      { recipeId: randomUUID() },
      { beanId: randomUUID() },
      { profileId: "profile:no-such-profile" },
      { machineId: lab1.machine.id, profileTitle: "Londonium", from: "2026-02-10", to: "2026-02-10" },
    ];
    const found: Record<string, number> = {};
    for (const filter of filters) {
      const name = JSON.stringify(filter);
      const { counts, numbers } = await summary(filter);
      expect(counts.shots + counts.unfinished + counts.cleaningAndCalibration, name).toBe(await listTotal(filter));
      for (const number of Object.values(numbers)) expect(number.shots, name).toBeLessThanOrEqual(counts.shots);
      found[name] = counts.shots + counts.unfinished + counts.cleaningAndCalibration;
    }
    // Each filter narrows the Shots: none finds them all, and a few find some, one or none.
    expect(found[JSON.stringify({})]).toBe(11);
    expect(found[JSON.stringify({ pendingMachineId })]).toBe(1);
    expect(found[JSON.stringify({ profileTitle: "adaptive", match: "words" })]).toBe(3);
    expect(found[JSON.stringify({ barista: "Fixture Barista" })]).toBe(7);
    expect(found[JSON.stringify({ recipeId: "none" })]).toBe(11);
    expect(found[JSON.stringify({ profileId: "profile:no-such-profile" })]).toBe(0);

    expect(await summary({ barista: "Nobody" })).toEqual({
      counts: { shots: 0, unfinished: 0, cleaningAndCalibration: 0, awaitingValues: 0 },
      numbers: { yieldAgainstTarget: NONE, duration: NONE, stoppedOnWeight: { shots: 0, share: null } },
    });
  });

  it("refuses what the list refuses, and is read by Staff and Viewers, never signed out", async () => {
    const refusal = async (path: string) => {
      const response = await api.call("GET", path);
      return { status: response.status, message: ((await response.json()) as { message: unknown }).message };
    };
    for (const query of ["from=2026-02-30", "barista=Ann&barista=Ben", "match=loose", "machineId=lab-1", "locationId=elsewhere"]) {
      expect(await refusal(`/shots/summary?${query}`), query).toEqual(await refusal(`/shots?${query}`));
    }
    expect(await refusal("/shots/summary?from=2026-02-30")).toMatchObject({ status: 400 });
    expect(await refusal("/shots/summary?machineId=lab-1")).toMatchObject({ status: 404 });

    const staff = await api.staffAt("sam@example.com", harbor);
    const { link } = await api.invite("val@example.com", "viewer");
    const viewer = AdminApi.signedInAs(server.url, await acceptInvite(server.url, link, { name: "Val Viewer", password: "val's password" }));
    // Staff read every Location's, as they read every Shot.
    for (const reader of [staff, viewer]) {
      expect(await summary({}, reader)).toEqual(await summary());
      expect(await summary({ locationId: lab.id }, reader)).toEqual(await summary({ locationId: lab.id }));
    }
    expect((await api.call("GET", "/shots/summary", undefined, {})).status).toBe(401);
  });

  it("shows a Shot's edit in the next summary", async () => {
    const before = await summary({ locationId: harbor.id });
    expect(before.numbers.yieldAgainstTarget).toEqual({ shots: 2, median: -1.15, p25: -1.225, p75: -1.075 });
    // Its yield weighed corrected on the tablet from 35 g to 37 g, 1 g over its target: Decaid reports the Shot's metadata.
    const { measurements, ...metadata } = harborShots[0]!;
    harborTablet.fire("shotUpdated", { id: metadata.id, shot: { ...metadata, updatedAt: "2026-11-01T12:00:00Z", annotations: { ...(metadata.annotations as Fields), actualYield: 37 } } });
    // −1.3 and 1.
    await expect.poll(async () => (await summary({ locationId: harbor.id })).numbers.yieldAgainstTarget).toEqual({ shots: 2, median: -0.15, p25: -0.725, p75: 0.425 });
    // What its measurements show is as it was.
    expect(await summary({ locationId: harbor.id })).toEqual({ ...before, numbers: { ...before.numbers, yieldAgainstTarget: { shots: 2, median: -0.15, p25: -0.725, p75: 0.425 } } });
  });

  it("still answers where a Shot's record holds a yield and a target beyond any weight, and a stop reason of white space alone", async () => {
    const atLab = { locationId: lab.id };
    const before = await summary(atLab);
    // −6, −1.3, −0.1, 0.5 and 2.4; and of the five that recorded a stop reason, all but the one its Machine ended.
    expect(before).toMatchObject({
      counts: { shots: 6, unfinished: 0, cleaningAndCalibration: 2, awaitingValues: 0 },
      numbers: { yieldAgainstTarget: { shots: 5, median: -0.1, p25: -1.3, p75: 0.5 }, stoppedOnWeight: { shots: 5, share: 0.8 } },
    });
    // A record may hold any number: these two are stored, and their difference fits no float8. One is a cleaning Shot.
    labTablet.pullShot(shotOf("lab-beyond", "2026-02-12T15:00:00Z", LAB_SERIAL, { actualYield: 1e308, targetYield: -1e308, stopReason: "\t\n" }));
    labTablet.pullShot(shotOf("lab-beyond-cleaning", "2026-02-12T16:00:00Z", LAB_SERIAL, { actualYield: -1e308, targetYield: 1e308, type: "cleaning" }));
    await expect.poll(() => listTotal(atLab)).toBe(10);
    // Each is counted, the first with a duration, 23.549 s as four others; it has no yield against target, and recorded no stop reason.
    expect(await summary(atLab)).toEqual({
      counts: { shots: 7, unfinished: 0, cleaningAndCalibration: 3, awaitingValues: 0 },
      numbers: { ...before.numbers, duration: { shots: 7, median: 23.549, p25: 23.549, p75: 23.549 } },
    });
  });

  it("leaves out a dismissed Pending Machine's Shots, as the list does", async () => {
    const pendingMachineId = (await api.pendingMachines()).find((pending) => pending.serial === UNKNOWN_SERIAL)!.id;
    await api.send("POST", `/pending-machines/${pendingMachineId}/dismiss`);
    expect((await summary()).counts).toEqual({ shots: 9, unfinished: 0, cleaningAndCalibration: 3, awaitingValues: 0 });
    expect(await listTotal()).toBe(12);
    expect((await summary({ pendingMachineId })).counts).toEqual({ shots: 0, unfinished: 0, cleaningAndCalibration: 0, awaitingValues: 0 });
  });
});
