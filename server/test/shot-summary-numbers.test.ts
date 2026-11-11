import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { LoadedTablets, emptyLibrary } from "./support/loaded-tablets.js";
import { burrsShotFixture, preheatShotFixture, shotFixture, withShots } from "./support/shot-fixtures.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1: a Shot Summary's other numbers, and its Unfinished Shots counted
// apart (#469), through the REST API. Shots are stored through simulated
// tablets running the built plugin, each derived from one of three Shots
// Decaid recorded, changing only its id, time, recorded hardware and what a
// test names. Hardware ids are made up.
//
// What each of the three shows, worked out by hand from its record and its
// samples after its Preheat (#466, #467): its yield weighed less its target,
// its duration, its peaks, when its scale first read 1 g or more, and the
// step it ended in. Each recorded `targetWeight` as its stop reason, and
// each poured.
//
// | Fixture | Yield − target | Duration | Peak pressure | Peak flow | First drip | Last step |
// |---|---|---|---|---|---|---|
// | shot-espresso.json | 35.9 − 36 | 23.549 s | 9.004638671875 | 9.502197265625 | 21.45 s | 4, Pressure Decline |
// | shot-preheat.json | 34.7 − 36 | 25.833 s | 8.01220703125 | 8.045166015625 | 7.945 s | 6, Extraction |
// | shot-grinder-burrs.json | 30 − 36 | 4.095 s | 2.8093124168495587 | 7.999999987116978 | 0.594 s | 0, Free flow |
//
// shot-espresso.json has four samples: one in Preheat, one in preinfusion
// in its step 1, Fill, with the scale at 0 g, and two pouring in step 4 at
// 25.8 g and 32.5 g. Two Shots are derived from its samples:
//
// - Fast: its two pouring samples reported in preinfusion, as a fast Shot
//   stopped on weight in a long preinfusion step is. It never reported
//   pouring, but its scale read 25.8 g at 21.45 s: it poured. Its other
//   values are the fixture's.
// - Unfinished: its first two samples alone, as a Shot stopped in its
//   preinfusion at once. It never reported pouring and the scale never read
//   1 g. It ended in step 1 with a peak pressure of 0.449462890625.
//
// A percentile is interpolated between the two Shots nearest it: of n
// values in order, counted from 0, the one at p × (n − 1).

interface SummaryNumber {
  shots: number;
  median: number | null;
  p25: number | null;
  p75: number | null;
}

type Numbers = Record<string, unknown>;

interface Group {
  counts: { shots: number; unfinished: number; cleaningAndCalibration: number; awaitingValues: number };
  numbers: Numbers;
}

type Fields = Record<string, unknown>;

/** What a test changes of a fixture's record. */
interface Changes {
  /** What stopped it. */
  stopReason?: string;
  /** Its profile's type. */
  type?: string;
  /** Its dose weighed; null for none recorded. */
  dose?: number | null;
  /** Its enjoyment as rated on its tablet; null for none recorded. */
  enjoyment?: number | null;
  grinderSetting?: unknown;
  tds?: unknown;
  extractionYield?: unknown;
  /** What its samples become. */
  samples?: (samples: Fields[]) => Fields[];
}

const LAB_SERIAL = "46901";
const STEPS_SERIAL = "46902";
const EVERY_NUMBER = ["yieldAgainstTarget", "duration", "stoppedOnWeight", "ratio", "peakPressure", "peakFlow", "rating", "grindSetting", "tds", "extractionYield", "timeToFirstDrip", "lastStep"];

/** Its pouring samples reported in preinfusion. */
const neverReportedPouring = (samples: Fields[]) =>
  samples.map((sample) => {
    const machine = sample.machine as Fields;
    const state = machine.state as Fields;
    return state.substate === "pouring" ? { ...sample, machine: { ...machine, state: { ...state, substate: "preinfusion" } } } : sample;
  });
/** Its first two samples alone: Preheat, and preinfusion at 0 g. */
const stoppedAtOnce = (samples: Fields[]) => samples.slice(0, 2);
/** Each sample after its Preheat in the step `frame`. */
const endedIn = (frame: number) => (samples: Fields[]) => samples.map((sample, index) => (index === 0 ? sample : { ...sample, machine: { ...(sample.machine as Fields), profileFrame: frame } }));

/** Resolves once `holds` does, as expect.poll, which a hook can't call, waits. */
async function until(holds: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await holds())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** A number to the millionth, clear of the last bit of its arithmetic. */
const exact = (value: unknown) => (typeof value === "number" && !Number.isInteger(value) ? Math.round(value * 1e6) / 1e6 : value);
const number = (shots: number, median: number | null, p25 = median, p75 = median): SummaryNumber => ({ shots, median, p25, p75 });
const NONE = number(0, null);

describe("A Shot Summary's other numbers, and its Unfinished Shots", () => {
  let server: TestServer;
  let api: AdminApi;
  let lab: LocationView;
  let lab1: CreatedMachine;
  let lab2: CreatedMachine;
  let labTablet: SimulatedTablet;
  const tablets = new LoadedTablets();

  const labShots = [
    // A dose of 17.95 g: a ratio of 2. Rated 8, with a TDS and an extraction yield.
    shotOf("espresso", "2026-02-10T15:00:00Z", { dose: 17.95, enjoyment: 8, tds: 9.5, extractionYield: 19.8 }),
    // 2.5, and rated 0, which DYE2 writes for no stars: unrated. Its grind setting is recorded as "6.50".
    shotOf("preheat", "2026-02-10T16:00:00Z", { dose: 13.88, enjoyment: 0 }, preheatShotFixture()),
    // 1.5, rated 6, with a TDS and an extraction yield. Its grind setting is recorded as "12".
    shotOf("burrs", "2026-02-10T17:00:00Z", { dose: 20, enjoyment: 6, tds: 8.75, extractionYield: 18.2 }, burrsShotFixture()),
    // A dose of 0, so no ratio; rated 10; a grind setting of "2.00", a number; a TDS as text, so none.
    shotOf("dose-zero", "2026-02-10T18:00:00Z", { dose: 0, enjoyment: 10, grinderSetting: "2.00", tds: "10" }),
    // No dose and no rating recorded; a grind setting that is text; ended by the Machine, as its profile finished.
    shotOf("text-setting", "2026-02-10T19:00:00Z", { dose: null, enjoyment: null, grinderSetting: "8.8 fine", stopReason: "machineEnded" }),
    // Fast: it never reported pouring, but poured. A ratio of 2.5, rated 4, its grind setting within spaces.
    shotOf("fast", "2026-02-10T20:00:00Z", { dose: 14.36, enjoyment: 4, grinderSetting: " 9.5 ", samples: neverReportedPouring }),
    // Unfinished, with values that would move every number: a dose of 10, rated 10, a grind of "1", ended by the Machine.
    shotOf("unfinished", "2026-02-10T21:00:00Z", { dose: 10, enjoyment: 10, grinderSetting: "1", tds: 12, extractionYield: 25, stopReason: "machineEnded", samples: stoppedAtOnce }),
    // A cleaning Shot that never poured is left out as cleaning, not counted unfinished.
    shotOf("cleaning", "2026-02-10T22:00:00Z", { type: "cleaning", samples: stoppedAtOnce }),
  ];
  // On another Machine, for the steps Shots ended in: three in step 5 and one in each of steps 0 to 11 but 5.
  const stepShots = [5, 5, ...Array.from({ length: 12 }, (_, frame) => frame)].map((frame, n) =>
    shotOf(`step-${n}`, `2026-02-11T${String(10 + n).padStart(2, "0")}:00:00Z`, { samples: endedIn(frame) }, shotFixture(), STEPS_SERIAL),
  );

  beforeAll(async () => {
    server = await startTestServer({ env: { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" } });
    api = await AdminApi.setUp(server.url);
    lab = await api.createLocation("Lab", "America/Denver");
    lab1 = await api.createMachine("Lab 1");
    lab2 = await api.createMachine("Lab 2");
    for (const machine of [lab1, lab2]) {
      await api.send("POST", `/machines/${machine.machine.id}/location-history`, { locationId: lab.id, effectiveFrom: "2025-01-01T00:00:00Z" }, 201);
    }
    labTablet = tablets.syncing(lab1, server, { api: withShots(emptyLibrary(LAB_SERIAL), labShots) });
    tablets.syncing(lab2, server, { api: withShots(emptyLibrary(STEPS_SERIAL), stepShots) });
    // Each tablet's plugin indexes its Shots and sends those the server asks for, one at a time.
    await until(async () => (await listTotal()) === labShots.length + stepShots.length);
  });
  afterAll(async () => {
    await tablets.unloadAll();
    await server?.stop();
  });

  /** A Shot pulled at a UTC time, derived from `fixture` with the changes given. */
  function shotOf(id: string, pulledAt: string, changes: Changes = {}, fixture = shotFixture(), serial = LAB_SERIAL): Fields {
    const workflow = fixture.workflow as Record<string, Fields>;
    const annotations = { ...(fixture.annotations as Fields) };
    const context = { ...workflow.context };
    const set = (on: Fields, field: string, value: unknown) => {
      if (value === undefined) return;
      if (value === null) delete on[field];
      else on[field] = value;
    };
    set(annotations, "actualDoseWeight", changes.dose);
    set(annotations, "enjoyment", changes.enjoyment);
    set(annotations, "drinkTds", changes.tds);
    set(annotations, "drinkEy", changes.extractionYield);
    set(context, "grinderSetting", changes.grinderSetting);
    return {
      ...fixture,
      id,
      timestamp: pulledAt,
      ...(changes.stopReason !== undefined && { stopReason: changes.stopReason }),
      ...(changes.samples && { measurements: changes.samples(fixture.measurements as Fields[]) }),
      workflow: {
        ...workflow,
        context,
        profile: { ...workflow.profile, ...(changes.type !== undefined && { beverage_type: changes.type }) },
        machine: { ...workflow.machine, model: "DE1Pro", serialNumber: serial },
      },
      annotations,
    };
  }

  /** How many Shots the list lists for the filters. */
  async function listTotal(query: Record<string, string> = {}): Promise<number> {
    return (await api.get<{ total: number }>(`/shots?${new URLSearchParams({ limit: "1", ...query })}`)).total;
  }

  /** The summary of the Shots the filters find, with the numbers named: its one group, each number to the millionth. */
  async function summary(query: Record<string, string> = {}): Promise<Group> {
    const { groups } = await api.get<{ groups: Group[] }>(`/shots/summary?${new URLSearchParams(query)}`);
    expect(groups).toHaveLength(1);
    const { counts, numbers } = groups[0]!;
    return { counts, numbers: JSON.parse(JSON.stringify(numbers), (_key, value: unknown) => exact(value)) as Numbers };
  }

  const atLab1 = () => ({ machineId: lab1.machine.id });
  const everyNumber = () => ({ ...atLab1(), numbers: EVERY_NUMBER.join(",") });

  /** What the summary of Lab 1's Shots gives, worked out by hand: of its eight Shots, the six that poured and aren't cleaning. */
  const LAB_1 = {
    counts: { shots: 6, unfinished: 1, cleaningAndCalibration: 1, awaitingValues: 0 },
    numbers: {
      // −6, −1.3, and −0.1 four times: the 25th percentile a quarter of the way from −1.3 to −0.1.
      yieldAgainstTarget: number(6, -0.1, -1, -0.1),
      // 4.095, 23.549 four times, and 25.833.
      duration: number(6, 23.549),
      // Of the six, all but the one its Machine ended.
      stoppedOnWeight: { shots: 6, share: 0.833333 },
      // 1.5, 2, 2.5 and 2.5: none where the dose is 0 or missing.
      ratio: number(4, 2.25, 1.875, 2.5),
      // 2.8093124168495587, 8.01220703125, and 9.004638671875 four times: the 25th percentile a quarter of the way from the second to the third.
      peakPressure: number(6, 9.004639, 8.260315, 9.004639),
      // 7.999999987116978, 8.045166015625, and 9.502197265625 four times.
      peakFlow: number(6, 9.502197, 8.409424, 9.502197),
      // 4, 6, 8 and 10: the Shot rated 0 is unrated, as is the one rated nothing. Four of the six are rated.
      rating: { ...number(4, 7, 5.5, 8.5), rated: 0.666667 },
      // 2, 6.5, 8, 9.5 and 12: "8.8 fine" is text.
      grindSetting: { ...number(5, 8, 6.5, 9.5), lowest: 2, highest: 12 },
      // 8.75 and 9.5: "10" is text.
      tds: number(2, 9.125, 8.9375, 9.3125),
      // 18.2 and 19.8.
      extractionYield: number(2, 19, 18.6, 19.4),
      // 0.594, 7.945, and 21.45 four times: the 25th percentile a quarter of the way from 7.945 to 21.45.
      timeToFirstDrip: number(6, 21.45, 11.32125, 21.45),
      // Four in Pressure Decline, then one in each of the others, by frame.
      lastStep: {
        shots: 6,
        mostCommon: [
          { frame: 4, name: "Pressure Decline", shots: 4 },
          { frame: 0, name: "Free flow", shots: 1 },
          { frame: 6, name: "Extraction", shots: 1 },
        ],
      },
    },
  };

  it("gives each number asked for, against values worked out by hand, and leaves Unfinished Shots out of every one", async () => {
    expect(await summary(everyNumber())).toEqual(LAB_1);
    // The four counts add up to the list's total for the same filters.
    expect(await listTotal(atLab1())).toBe(8);
    // Asked for in any order, the numbers come in one, and only those asked for.
    expect((await summary({ ...atLab1(), numbers: "lastStep,ratio" })).numbers).toEqual({ ratio: LAB_1.numbers.ratio, lastStep: LAB_1.numbers.lastStep });
    // With none named, the default four: the count, yield against target, duration and stopped on weight.
    const { yieldAgainstTarget, duration, stoppedOnWeight } = LAB_1.numbers;
    expect(await summary(atLab1())).toEqual({ counts: LAB_1.counts, numbers: { yieldAgainstTarget, duration, stoppedOnWeight } });
  });

  it("counts an Unfinished Shot alone as unfinished, with no number, and a Shot that never reported pouring but whose scale read a gram as poured", async () => {
    const nothing = { ...everyNumber(), from: "2026-02-10T14:00", to: "2026-02-10T14:30" };
    // 14:00 to 14:30 at the Lab, in Denver, 7 hours behind UTC in February: the Unfinished Shot alone.
    expect(await summary(nothing)).toEqual({
      counts: { shots: 0, unfinished: 1, cleaningAndCalibration: 0, awaitingValues: 0 },
      numbers: {
        yieldAgainstTarget: NONE,
        duration: NONE,
        stoppedOnWeight: { shots: 0, share: null },
        ratio: NONE,
        peakPressure: NONE,
        peakFlow: NONE,
        rating: { ...NONE, rated: null },
        grindSetting: { ...NONE, lowest: null, highest: null },
        tds: NONE,
        extractionYield: NONE,
        timeToFirstDrip: NONE,
        lastStep: { shots: 0, mostCommon: [] },
      },
    });
    expect(await listTotal(nothing)).toBe(1);
    // 13:00 to 13:30: the fast Shot alone, whose numbers are the espresso's.
    expect(await summary({ ...everyNumber(), from: "2026-02-10T13:00", to: "2026-02-10T13:30" })).toMatchObject({
      counts: { shots: 1, unfinished: 0, cleaningAndCalibration: 0, awaitingValues: 0 },
      numbers: { duration: number(1, 23.549), timeToFirstDrip: number(1, 21.45), lastStep: { shots: 1, mostCommon: [{ frame: 4, name: "Pressure Decline", shots: 1 }] } },
    });
  });

  it("names the steps most Shots ended in, most first, then by frame", async () => {
    // Fourteen Shots: three in step 5, Pressure Hold, and one in each of steps 0 to 11 but 5. The ten most are named, those
    // of a count in their frames' order, and two Shots ended in steps not named: 10 and 11, past the profile's seven steps.
    const { numbers, counts } = await summary({ machineId: lab2.machine.id, numbers: "lastStep" });
    expect(counts).toEqual({ shots: 14, unfinished: 0, cleaningAndCalibration: 0, awaitingValues: 0 });
    expect(numbers).toEqual({
      lastStep: {
        shots: 14,
        mostCommon: [
          { frame: 5, name: "Pressure Hold", shots: 3 },
          { frame: 0, name: "Fill start", shots: 1 },
          { frame: 1, name: "Fill", shots: 1 },
          { frame: 2, name: "Infuse", shots: 1 },
          { frame: 3, name: "Pressure Up", shots: 1 },
          { frame: 4, name: "Pressure Decline", shots: 1 },
          { frame: 6, name: "Flow Limit", shots: 1 },
          { frame: 7, name: "Step 8", shots: 1 },
          { frame: 8, name: "Step 9", shots: 1 },
          { frame: 9, name: "Step 10", shots: 1 },
        ],
      },
    });
    // Grouped by Machine, each group names its own Shots' steps.
    const { groups } = await api.get<{ groups: (Group & { by: { machine: { id: string } } })[] }>(`/shots/summary?${new URLSearchParams({ groupBy: "machine", numbers: "lastStep" })}`);
    expect(groups.map((group) => [group.by.machine.id, group.numbers.lastStep])).toEqual([
      [lab1.machine.id, LAB_1.numbers.lastStep],
      [lab2.machine.id, numbers.lastStep],
    ]);
  });

  it("refuses numbers it doesn't give, none, one twice, or numbers given twice", async () => {
    for (const query of ["numbers=", "numbers=count", "numbers=ratio,ratio", "numbers=ratio,", "numbers=ratio&numbers=tds"]) {
      const response = await api.call("GET", `/shots/summary?${query}`);
      expect(response.status, query).toBe(400);
    }
  });

  it("counts Shots stored at the earlier revision as awaiting their values, and as poured, until the refresh works them out", async () => {
    const database = await server.connectDatabase();
    try {
      // As 1.8.2 stores them: at revision 1, with none of what their samples show.
      await database.query(
        `UPDATE shots SET curves_revision = 1, time_to_first_drip = NULL, last_step_frame = NULL, last_step_name = NULL, poured = NULL,
           last_weight = NULL, last_weight_seconds = NULL, flow_at_stop = NULL WHERE id IN ('espresso', 'unfinished')`,
      );
    } finally {
      await database.end();
    }
    // The Unfinished Shot counts as poured, and its numbers with the others': a ratio of 3.59, its peak pressure and
    // duration, a rating of 10, a grind setting of 1 and its TDS and extraction yield. The espresso has no time to first
    // drip or last step until then.
    expect(await summary(everyNumber())).toEqual({
      counts: { shots: 7, unfinished: 0, cleaningAndCalibration: 1, awaitingValues: 2 },
      numbers: {
        // −6, −1.3, and −0.1 five times: the Unfinished Shot weighed its fixture's 35.9 g.
        yieldAgainstTarget: number(7, -0.1, -0.7, -0.1),
        // 0, 4.095, 23.549 four times, and 25.833: the 25th percentile halfway from 4.095 to 23.549.
        duration: number(7, 23.549, 13.822, 23.549),
        // Of the seven, all but the two its Machine ended.
        stoppedOnWeight: { shots: 7, share: 0.714286 },
        // 1.5, 2, 2.5, 2.5 and 3.59.
        ratio: number(5, 2.5, 2, 2.5),
        // 0.449462890625, 2.8093124168495587, 8.01220703125, and 9.004638671875 four times.
        peakPressure: number(7, 9.004639, 5.41076, 9.004639),
        // 7.999999987116978, 8.045166015625, and 9.502197265625 five times: the Unfinished Shot's peak flow is the espresso's.
        peakFlow: number(7, 9.502197, 8.773682, 9.502197),
        // 4, 6, 8, 10 and 10: five of the seven.
        rating: { ...number(5, 8, 6, 10), rated: 0.714286 },
        // 1, 2, 6.5, 8, 9.5 and 12.
        grindSetting: { ...number(6, 7.25, 3.125, 9.125), lowest: 1, highest: 12 },
        // 8.75, 9.5 and 12; 18.2, 19.8 and 25.
        tds: number(3, 9.5, 9.125, 10.75),
        extractionYield: number(3, 19.8, 19, 22.4),
        // 0.594, 7.945, and 21.45 three times: neither awaiting Shot has one yet.
        timeToFirstDrip: number(5, 21.45, 7.945, 21.45),
        lastStep: {
          shots: 5,
          mostCommon: [
            { frame: 4, name: "Pressure Decline", shots: 3 },
            { frame: 0, name: "Free flow", shots: 1 },
            { frame: 6, name: "Extraction", shots: 1 },
          ],
        },
      },
    });

    // Another instance starting works them out, and the summary is as it was.
    const other = await startTestServer({ env: { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" }, sharing: server });
    try {
      await expect.poll(async () => (await summary(everyNumber())).counts.awaitingValues).toBe(0);
      expect(await summary(everyNumber())).toEqual(LAB_1);
    } finally {
      await other.stop();
    }
  });

  it("shows a Shot's rating edited on its tablet in the next summary", async () => {
    // The Shot that recorded no rating rated 2 on the tablet: Decaid reports the Shot's metadata.
    const { measurements, ...metadata } = labShots.find((shot) => shot.id === "text-setting")!;
    labTablet.fire("shotUpdated", { id: metadata.id, shot: { ...metadata, updatedAt: "2026-11-01T12:00:00Z", annotations: { ...(metadata.annotations as Fields), enjoyment: 2 } } });
    // 2, 4, 6, 8 and 10: five of the six.
    await expect.poll(async () => (await summary({ ...atLab1(), numbers: "rating" })).numbers.rating).toEqual({ ...number(5, 6, 4, 8), rated: 0.833333 });
    // What its measurements show is as it was.
    expect((await summary(everyNumber())).numbers).toEqual({ ...LAB_1.numbers, rating: { ...number(5, 6, 4, 8), rated: 0.833333 } });
  });
});
