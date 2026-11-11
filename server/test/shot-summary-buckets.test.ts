import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { LoadedTablets, emptyLibrary } from "./support/loaded-tablets.js";
import { burrsShotFixture, preheatShotFixture, shotFixture, withShots } from "./support/shot-fixtures.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1: a Shot Summary bucketed by day or week (#470), through the REST
// API: each group's buckets nested under it, a day or a week being each
// Shot's Location's own, or UTC's for a Shot with none, and a page a number
// of groups, each with every one of its buckets.
//
// Twelve Shots are stored through simulated tablets running the built
// plugin, each derived from one of three Shots Decaid recorded
// (shot-summary.test.ts works out what each shows), changing only its id,
// time, recorded hardware and what the table below names. The Lab is in
// Denver, seven hours behind UTC that February, the Harbor in Tokyo, nine
// ahead, and the van's Machine is at no Location, so its Shots' days are
// UTC's. 9 and 16 February 2026 are Mondays. Hardware ids are made up, from
// 47901.
//
// | Shot | Pulled, UTC | On its Location's clock | Its day | Its week | Yield − target | Duration | Stopped by |
// |---|---|---|---|---|---|---|---|
// | lab-tuesday | 10 Feb 18:00 | Tue 10 Feb 11:00 | 10 Feb | 9 Feb | −0.1 g | 23.549 s | targetWeight |
// | lab-sunday | 16 Feb 06:30 | Sun 15 Feb 23:30 | 15 Feb | 9 Feb | −0.1 g | 23.549 s | targetWeight |
// | lab-monday | 16 Feb 07:30 | Mon 16 Feb 00:30 | 16 Feb | 16 Feb | −1.3 g | 25.833 s | targetWeight |
// | lab-over | 16 Feb 20:00 | Mon 16 Feb 13:00 | 16 Feb | 16 Feb | +2.4 g | 23.549 s | machineEnded |
// | lab-cleaning | 16 Feb 21:00 | Mon 16 Feb 14:00 | 16 Feb | 16 Feb | a cleaning Shot | | |
// | lab-thursday | 19 Feb 18:00 | Thu 19 Feb 11:00 | 19 Feb | 16 Feb | +0.5 g | 23.549 s | targetWeight |
// | harbor-sunday | 15 Feb 14:30 | Sun 15 Feb 23:30 | 15 Feb | 9 Feb | −1.3 g | 25.833 s | targetWeight |
// | harbor-monday | 15 Feb 15:30 | Mon 16 Feb 00:30 | 16 Feb | 16 Feb | −0.1 g | 23.549 s | targetWeight |
// | harbor-noon | 16 Feb 03:00 | Mon 16 Feb 12:00 | 16 Feb | 16 Feb | −6 g | 4.095 s | targetWeight |
// | van-sunday | 15 Feb 23:30 | UTC's | 15 Feb | 9 Feb | −0.1 g | 23.549 s | targetWeight |
// | van-monday | 16 Feb 00:30 | UTC's | 16 Feb | 16 Feb | −1.3 g | 25.833 s | targetWeight |
// | van-untimed | unknown: a time with no offset, and no `createdAt` to work one out from | | none | none | −0.1 g | 23.549 s | targetWeight |
//
// So the Harbor's Sunday and Monday Shots, an hour apart, are both pulled on
// UTC's and the Lab's Sunday, the Lab's two both on UTC's and the Harbor's
// Monday, and the van's two on the Lab's Sunday and the Harbor's Monday:
// only each Shot's own clock puts all three pairs either side of the day's,
// and the week's, edge. A percentile is interpolated between the two Shots
// nearest it: of n values in order, counted from 0, the one at p × (n − 1).

interface SummaryNumber {
  shots: number;
  median: number | null;
  p25: number | null;
  p75: number | null;
}

interface Named {
  id: string;
  name: string | null;
}

interface By {
  location?: Named | null;
  machine?: Named | null;
  pendingMachine?: null;
  recipe?: (Named & { location: Named | null }) | null;
}

interface Figures {
  counts: { shots: number; unfinished: number; cleaningAndCalibration: number; awaitingValues: number };
  numbers: { yieldAgainstTarget: SummaryNumber; duration: SummaryNumber; stoppedOnWeight: { shots: number; share: number | null } };
}

interface Bucket extends Figures {
  start: string | null;
}

interface Group {
  by: By;
  buckets: Bucket[];
  reference?: { id: string; numbers: Fields };
}

interface Summary {
  groups: Group[];
  total: number;
  limit: number;
  offset: number;
}

type Fields = Record<string, unknown>;

const LAB_SERIAL = "47901";
const HARBOR_SERIAL = "47902";
const VAN_SERIAL = "47903";

/** A number of `shots` Shots. */
const number = (shots: number, median: number, p25 = median, p75 = median): SummaryNumber => ({ shots, median, p25, p75 });
/** The counts of `shots` Shots, each finished and with its stored values, and `cleaning` cleaning Shots left out. */
const counts = (shots: number, cleaning = 0) => ({ shots, unfinished: 0, cleaningAndCalibration: cleaning, awaitingValues: 0 });

/** One Shot of shot-espresso.json: 0.1 g under its target, 23.549 s, stopped on weight. */
const ESPRESSO: Figures = { counts: counts(1), numbers: { yieldAgainstTarget: number(1, -0.1), duration: number(1, 23.549), stoppedOnWeight: { shots: 1, share: 1 } } };
/** One of shot-preheat.json: 1.3 g under, 25.833 s. */
const PREHEAT: Figures = { counts: counts(1), numbers: { yieldAgainstTarget: number(1, -1.3), duration: number(1, 25.833), stoppedOnWeight: { shots: 1, share: 1 } } };

/** Resolves once `holds` does, as expect.poll, which a hook can't call, waits. */
async function until(holds: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await holds())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** A Shot pulled at a UTC time on the hardware given, derived from `fixture` with the changes given. */
function shotOf(id: string, pulledAt: string, serial: string, changes: { actualYield?: number; stopReason?: string; type?: string } = {}, fixture = shotFixture()): Fields {
  const workflow = fixture.workflow as Record<string, Fields>;
  return {
    ...fixture,
    id,
    timestamp: pulledAt,
    ...(changes.stopReason !== undefined && { stopReason: changes.stopReason }),
    workflow: {
      ...workflow,
      profile: { ...workflow.profile, ...(changes.type !== undefined && { beverage_type: changes.type }) },
      machine: { ...workflow.machine, model: "DE1Pro", serialNumber: serial },
    },
    annotations: { ...(fixture.annotations as Fields), ...(changes.actualYield !== undefined && { actualYield: changes.actualYield }) },
  };
}

describe("Shot Summaries by day and week", () => {
  let server: TestServer;
  let api: AdminApi;
  let lab: LocationView;
  let harbor: LocationView;
  let lab1: CreatedMachine;
  let harbor1: CreatedMachine;
  let van: CreatedMachine;
  const tablets = new LoadedTablets();

  const ALL = [
    "lab-tuesday",
    "lab-sunday",
    "lab-monday",
    "lab-over",
    "lab-cleaning",
    "lab-thursday",
    "harbor-sunday",
    "harbor-monday",
    "harbor-noon",
    "van-sunday",
    "van-monday",
    "van-untimed",
  ];

  beforeAll(async () => {
    server = await startTestServer();
    api = await AdminApi.setUp(server.url);
    lab = await api.createLocation("Lab", "America/Denver");
    harbor = await api.createLocation("Harbor", "Asia/Tokyo");
    lab1 = await api.createMachine("Lab 1");
    harbor1 = await api.createMachine("Harbor 1");
    // At no Location, then or since.
    van = await api.createMachine("Van");
    // Each was at its Location long before its Shots were pulled.
    for (const [machine, location] of [[lab1, lab], [harbor1, harbor]] as const) {
      await api.send("POST", `/machines/${machine.machine.id}/location-history`, { locationId: location.id, effectiveFrom: "2025-01-01T00:00:00Z" }, 201);
    }
    const stored = (machine: CreatedMachine, serial: string, shots: Fields[]) => tablets.syncing(machine, server, { api: withShots(emptyLibrary(serial), shots) });
    stored(lab1, LAB_SERIAL, [
      shotOf("lab-tuesday", "2026-02-10T18:00:00Z", LAB_SERIAL),
      shotOf("lab-sunday", "2026-02-16T06:30:00Z", LAB_SERIAL),
      shotOf("lab-monday", "2026-02-16T07:30:00Z", LAB_SERIAL, {}, preheatShotFixture()),
      // 2.4 g over its target, and ended by the Machine.
      shotOf("lab-over", "2026-02-16T20:00:00Z", LAB_SERIAL, { actualYield: 38.4, stopReason: "machineEnded" }),
      shotOf("lab-cleaning", "2026-02-16T21:00:00Z", LAB_SERIAL, { type: "cleaning" }),
      // 0.5 g over.
      shotOf("lab-thursday", "2026-02-19T18:00:00Z", LAB_SERIAL, { actualYield: 36.5 }),
    ]);
    stored(harbor1, HARBOR_SERIAL, [
      shotOf("harbor-sunday", "2026-02-15T14:30:00Z", HARBOR_SERIAL, {}, preheatShotFixture()),
      shotOf("harbor-monday", "2026-02-15T15:30:00Z", HARBOR_SERIAL),
      // 6 g under its target, in 4.095 s.
      shotOf("harbor-noon", "2026-02-16T03:00:00Z", HARBOR_SERIAL, {}, burrsShotFixture()),
    ]);
    // The last recorded a time with no offset, as Decaid does, and no `createdAt` to work its offset out from, so when
    // it was pulled is unknown (`pulledAt` in extraction.ts).
    const { createdAt: _, ...untimed } = shotOf("van-untimed", "2026-02-17T10:00:00", VAN_SERIAL);
    stored(van, VAN_SERIAL, [shotOf("van-sunday", "2026-02-15T23:30:00Z", VAN_SERIAL), shotOf("van-monday", "2026-02-16T00:30:00Z", VAN_SERIAL, {}, preheatShotFixture()), untimed]);
    // Each tablet's plugin indexes its Shots and sends those the server asks for, one at a time.
    await until(async () => (await api.get<{ total: number }>("/shots?limit=1")).total === ALL.length);
    await tablets.unloadAll();
  });
  afterAll(async () => {
    await tablets.unloadAll();
    await server?.stop();
  });

  /** The ids of the Shots the list lists for the filters, in id order. */
  async function listed(query: Record<string, string> = {}): Promise<string[]> {
    const { shots, total } = await api.get<{ shots: { id: string }[]; total: number }>(`/shots?${new URLSearchParams({ limit: "100", ...query })}`);
    expect(shots).toHaveLength(total);
    return shots.map((shot) => shot.id).sort();
  }

  /** The summary the REST API gives for the query, each number to the microgram or microsecond, clear of the last bit of its arithmetic. */
  async function summary(query: Record<string, string>): Promise<Summary> {
    const read = await api.get<Summary>(`/shots/summary?${new URLSearchParams(query)}`);
    const exact = (value: number | null) => (value === null ? null : Math.round(value * 1e6) / 1e6);
    const exactNumber = ({ shots, median, p25, p75 }: SummaryNumber) => ({ shots, median: exact(median), p25: exact(p25), p75: exact(p75) });
    return {
      ...read,
      groups: read.groups.map(({ buckets, ...group }) => ({
        ...group,
        // Last, as the REST API gives them.
        buckets: buckets.map(({ numbers, ...bucket }) => ({
          ...bucket,
          numbers: {
            yieldAgainstTarget: exactNumber(numbers.yieldAgainstTarget),
            duration: exactNumber(numbers.duration),
            stoppedOnWeight: { shots: numbers.stoppedOnWeight.shots, share: exact(numbers.stoppedOnWeight.share) },
          },
        })),
      })),
    };
  }

  /** The day `days` after a date, as a date. */
  const dayAfter = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

  /** Monday 16 February's Shots, of every Location: five the numbers cover, the Lab's cleaning Shot left out. */
  const MONDAY: Figures = {
    counts: counts(5, 1),
    numbers: {
      // −6, two of −1.3, −0.1 and 2.4.
      yieldAgainstTarget: number(5, -1.3, -1.3, -0.1),
      // 4.095, two of 23.549 and two of 25.833.
      duration: number(5, 23.549, 23.549, 25.833),
      // All but the one its Machine ended.
      stoppedOnWeight: { shots: 5, share: 0.8 },
    },
  };

  /** The van's Shot whose time is unknown, in no day or week: its bucket, the last. */
  const UNTIMED: Bucket = { start: null, ...ESPRESSO };

  it("buckets by day, each Shot in its own Location's day, or UTC's with no Location, oldest first, as one group without a grouping", async () => {
    expect(await summary({ bucket: "day" })).toEqual({
      groups: [
        {
          by: {},
          buckets: [
            { start: "2026-02-10", ...ESPRESSO },
            {
              // The Sunday: the Lab's, pulled on UTC's Monday morning, the Harbor's, an hour before its midnight, and the van's.
              start: "2026-02-15",
              counts: counts(3),
              // −1.3 and two of −0.1; two of 23.549 and 25.833.
              numbers: { yieldAgainstTarget: number(3, -0.1, -0.7, -0.1), duration: number(3, 23.549, 23.549, 24.691), stoppedOnWeight: { shots: 3, share: 1 } },
            },
            // The Monday: one bucket of Shots pulled from 15:30 on UTC's Sunday, the Harbor's, to 21:00 on its Monday, the Lab's.
            { start: "2026-02-16", ...MONDAY },
            { start: "2026-02-19", counts: counts(1), numbers: { yieldAgainstTarget: number(1, 0.5), duration: number(1, 23.549), stoppedOnWeight: { shots: 1, share: 1 } } },
            UNTIMED,
          ],
        },
      ],
      total: 1,
      limit: 20,
      offset: 0,
    });
  });

  it("buckets by week, from each Location's own Monday", async () => {
    expect(await summary({ bucket: "week" })).toEqual({
      groups: [
        {
          by: {},
          buckets: [
            {
              // The week of 9 February: the Lab's Tuesday, and each of the Sunday's Shots, the Lab's pulled on UTC's Monday.
              start: "2026-02-09",
              counts: counts(4),
              // −1.3 and three of −0.1: the 25th percentile three quarters of the way from −1.3 to −0.1. Three of 23.549 and
              // 25.833: the 75th a quarter of the way from 23.549 to 25.833.
              numbers: { yieldAgainstTarget: number(4, -0.1, -0.4, -0.1), duration: number(4, 23.549, 23.549, 24.12), stoppedOnWeight: { shots: 4, share: 1 } },
            },
            {
              // The week of 16 February: its Monday's and the Lab's Thursday's, the Harbor's first pulled on UTC's Sunday.
              start: "2026-02-16",
              counts: counts(6, 1),
              numbers: {
                // −6, two of −1.3, −0.1, 0.5 and 2.4: the median halfway from −1.3 to −0.1, and the 75th percentile three quarters of
                // the way from −0.1 to 0.5.
                yieldAgainstTarget: number(6, -0.7, -1.3, 0.35),
                // 4.095, three of 23.549 and two of 25.833: the 75th three quarters of the way from 23.549 to 25.833.
                duration: number(6, 23.549, 23.549, 25.262),
                stoppedOnWeight: { shots: 6, share: 0.833333 },
              },
            },
            UNTIMED,
          ],
        },
      ],
      total: 1,
      limit: 20,
      offset: 0,
    });
  });

  it("holds in each bucket the Shots the date filters find for its day or week", async () => {
    for (const [bucket, days] of [["day", 1], ["week", 7]] as const) {
      const { buckets } = (await summary({ bucket })).groups[0]!;
      const found = await Promise.all(
        buckets.map(({ start }) => (start === null ? ["van-untimed"] : listed({ from: start, to: dayAfter(start, days - 1) }))),
      );
      expect(found.flat().sort(), bucket).toEqual([...ALL].sort());
      expect(buckets.map(({ counts: { shots, unfinished, cleaningAndCalibration } }) => shots + unfinished + cleaningAndCalibration), bucket).toEqual(found.map((shots) => shots.length));
    }
    // Filtered to a day, its bucket alone, with the Shots of that day on each one's own clock.
    expect((await summary({ bucket: "day", from: "2026-02-16", to: "2026-02-16" })).groups[0]!.buckets).toEqual([{ start: "2026-02-16", ...MONDAY }]);
  });

  it("nests each group's buckets under it, a group and a bucket there only for Shots found", async () => {
    const at = (location: LocationView) => ({ location: { id: location.id, name: location.name } });
    expect(await summary({ bucket: "day", groupBy: "location" })).toEqual({
      // By name, and then the Shots at no Location.
      groups: [
        {
          by: at(harbor),
          buckets: [
            { start: "2026-02-15", ...PREHEAT },
            {
              start: "2026-02-16",
              counts: counts(2),
              // −6 and −0.1; 4.095 and 23.549.
              numbers: { yieldAgainstTarget: number(2, -3.05, -4.525, -1.575), duration: number(2, 13.822, 8.9585, 18.6855), stoppedOnWeight: { shots: 2, share: 1 } },
            },
          ],
        },
        {
          by: at(lab),
          buckets: [
            { start: "2026-02-10", ...ESPRESSO },
            { start: "2026-02-15", ...ESPRESSO },
            {
              start: "2026-02-16",
              counts: counts(2, 1),
              // −1.3 and 2.4; 23.549 and 25.833; one of the two stopped on weight.
              numbers: { yieldAgainstTarget: number(2, 0.55, -0.375, 1.475), duration: number(2, 24.691, 24.12, 25.262), stoppedOnWeight: { shots: 2, share: 0.5 } },
            },
            { start: "2026-02-19", counts: counts(1), numbers: { yieldAgainstTarget: number(1, 0.5), duration: number(1, 23.549), stoppedOnWeight: { shots: 1, share: 1 } } },
          ],
        },
        { by: { location: null }, buckets: [{ start: "2026-02-15", ...ESPRESSO }, { start: "2026-02-16", ...PREHEAT }, UNTIMED] },
      ],
      total: 3,
      limit: 20,
      offset: 0,
    });

    // Filters that find no Shot: no group with a grouping, and without one the one group, with no bucket.
    const never = { from: "2027-01-01", to: "2027-01-02" };
    expect(await summary({ bucket: "day", groupBy: "location", ...never })).toEqual({ groups: [], total: 0, limit: 20, offset: 0 });
    expect(await summary({ bucket: "week", ...never })).toEqual({ groups: [{ by: {}, buckets: [] }], total: 1, limit: 20, offset: 0 });
    expect(await summary({ bucket: "week", ...never, offset: "1" })).toEqual({ groups: [], total: 1, limit: 20, offset: 1 });
  });

  it("nests buckets under two groupings, a page a number of groups, each with every one of its buckets", async () => {
    const query = { bucket: "week", groupBy: "location,machine" };
    const whole = await summary({ ...query, limit: "100" });
    const of = (location: LocationView | null, machine: CreatedMachine) => ({
      location: location && { id: location.id, name: location.name },
      machine: { id: machine.machine.id, name: machine.machine.name },
      pendingMachine: null,
    });
    expect(whole.groups.map(({ by, buckets }) => [by, buckets.map(({ start, counts: { shots } }) => [start, shots])])).toEqual([
      [of(harbor, harbor1), [["2026-02-09", 1], ["2026-02-16", 2]]],
      [of(lab, lab1), [["2026-02-09", 2], ["2026-02-16", 3]]],
      [of(null, van), [["2026-02-09", 1], ["2026-02-16", 1], [null, 1]]],
    ]);
    expect(whole.total).toBe(3);

    // Seven buckets in three groups, two groups a page: the first page holds four buckets and the second three, not
    // two of each, and one group a page gives each group whole.
    expect(await summary({ ...query, limit: "2" })).toEqual({ groups: whole.groups.slice(0, 2), total: 3, limit: 2, offset: 0 });
    expect(await summary({ ...query, limit: "2", offset: "2" })).toEqual({ groups: whole.groups.slice(2), total: 3, limit: 2, offset: 2 });
    for (const [offset, group] of whole.groups.entries()) {
      expect(await summary({ ...query, limit: "1", offset: String(offset) })).toEqual({ groups: [group], total: 3, limit: 1, offset });
    }
    // By day too, in the other order of the two.
    const byDay = await summary({ bucket: "day", groupBy: "machine,location" });
    expect(byDay.groups.map(({ by, buckets }) => [by.machine!.name, buckets.map(({ start }) => start)])).toEqual([
      ["Harbor 1", ["2026-02-15", "2026-02-16"]],
      ["Lab 1", ["2026-02-10", "2026-02-15", "2026-02-16", "2026-02-19"]],
      ["Van", ["2026-02-15", "2026-02-16", null]],
    ]);
  });

  it("gives each bucket the numbers asked for, the steps its own Shots ended in among them", async () => {
    interface Asked {
      groups: { buckets: { start: string; counts: Figures["counts"]; numbers: { ratio?: SummaryNumber; lastStep?: { shots: number; mostCommon: Fields[] } } }[] }[];
    }
    const { groups } = await api.get<Asked>(`/shots/summary?${new URLSearchParams({ bucket: "day", locationId: lab.id, numbers: "lastStep,ratio" })}`);
    const espressoStep = { frame: 4, name: "Pressure Decline", shots: 1 };
    expect(groups[0]!.buckets.map(({ start, numbers }) => [start, Object.keys(numbers), numbers.lastStep])).toEqual([
      ["2026-02-10", ["ratio", "lastStep"], { shots: 1, mostCommon: [espressoStep] }],
      ["2026-02-15", ["ratio", "lastStep"], { shots: 1, mostCommon: [espressoStep] }],
      // One of each Shot's, the earlier step first; its cleaning Shot's is left out.
      ["2026-02-16", ["ratio", "lastStep"], { shots: 2, mostCommon: [espressoStep, { frame: 6, name: "Extraction", shots: 1 }] }],
      ["2026-02-19", ["ratio", "lastStep"], { shots: 1, mostCommon: [espressoStep] }],
    ]);
    // 35.9 g from 18 g, and on the Monday 34.7 g from 16 g and 38.4 g from 18 g.
    expect(groups[0]!.buckets.map(({ numbers }) => [numbers.ratio!.shots, Math.round(numbers.ratio!.median! * 1e6) / 1e6])).toEqual([
      [1, 1.994444],
      [1, 1.994444],
      [2, 2.151042],
      [1, 2.027778],
    ]);
    // By week, with every other number: each bucket's are of its own Shots.
    const every = "yieldAgainstTarget,duration,stoppedOnWeight,ratio,peakPressure,peakFlow,rating,grindSetting,tds,extractionYield,timeToFirstDrip,lastStep";
    const weeks = (await api.get<{ groups: { buckets: { start: string; numbers: Record<string, { shots: number }> }[] }[] }>(`/shots/summary?${new URLSearchParams({ bucket: "week", locationId: lab.id, numbers: every })}`))
      .groups[0]!.buckets;
    expect(weeks.map(({ start, numbers }) => [start, Object.keys(numbers).join(), numbers.grindSetting!.shots, numbers.timeToFirstDrip!.shots, numbers.lastStep!.shots])).toEqual([
      ["2026-02-09", every, 2, 2, 2],
      ["2026-02-16", every, 3, 3, 3],
    ]);
  });

  it("gives a Recipe's Reference Shot once, on its group, and in none of its buckets", async () => {
    // The Lab's Recipe, loaded on its Machine through its Shots, which name it, as its tablet's map would resolve them.
    const { recipe } = await api.send<{ recipe: { id: string } }>("POST", "/recipes", { locationId: lab.id, content: { name: "House" } }, 201);
    const database = await server.connectDatabase();
    try {
      await database.query("UPDATE shots SET recipe_id = $1 WHERE machine_id = $2", [recipe.id, lab1.machine.id]);
      await database.query("INSERT INTO loaded_recipes (machine_id, recipe_id, loaded_at) VALUES ($1, $2, $3)", [lab1.machine.id, recipe.id, "2026-02-01T00:00:00Z"]);
    } finally {
      await database.end();
    }
    await api.send("PUT", `/recipes/${recipe.id}/reference-shot`, { shotId: "lab-monday" });

    const { groups, total } = await summary({ bucket: "day", groupBy: "recipe" });
    expect(total).toBe(2);
    const [house, none] = groups;
    expect(house!.by).toEqual({ recipe: { id: recipe.id, name: "House", location: { id: lab.id, name: "Lab" } } });
    // Before its buckets, as the REST API gives it.
    expect(Object.keys((await api.get<{ groups: Fields[] }>("/shots/summary?bucket=day&groupBy=recipe")).groups[0]!)).toEqual(["by", "reference", "buckets"]);
    // Its own values of the numbers asked for, the default three, whichever bucket it is in.
    expect(house!.reference).toEqual({ id: "lab-monday", numbers: { yieldAgainstTarget: -1.3, duration: 25.833, stoppedOnWeight: true } });
    expect(house!.buckets.map((bucket) => Object.keys(bucket))).toEqual(Array.from({ length: 4 }, () => ["start", "counts", "numbers"]));
    expect(house!.buckets.map(({ start }) => start)).toEqual(["2026-02-10", "2026-02-15", "2026-02-16", "2026-02-19"]);
    // The Shots pulled with no Recipe have none.
    expect(none!.by).toEqual({ recipe: null });
    expect(Object.keys(none!)).toEqual(["by", "buckets"]);
    // On each page a group of the Recipe is on, with its Machine's too.
    const paged = await summary({ bucket: "week", groupBy: "recipe,machine", limit: "1" });
    expect(paged.groups.map((group) => [group.by.machine!.name, group.reference?.id, group.buckets.map(({ start }) => start)])).toEqual([["Lab 1", "lab-monday", ["2026-02-09", "2026-02-16"]]]);
  });

  it("refuses a bucket that is neither day nor week, or given twice, and gives no buckets without one", async () => {
    for (const query of ["bucket=month", "bucket=", "bucket=Day", "bucket=day,week"]) {
      expect(await api.send("GET", `/shots/summary?${query}`, undefined, 400), query).toMatchObject({ message: "Enter bucket as day or week" });
    }
    expect(await api.send("GET", "/shots/summary?bucket=day&bucket=week", undefined, 400)).toMatchObject({ message: ["Give bucket once"] });
    const [group] = (await api.get<{ groups: Fields[] }>("/shots/summary")).groups;
    expect(Object.keys(group!)).toEqual(["by", "counts", "numbers"]);
  });
});
