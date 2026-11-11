import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi } from "./support/admin-api.js";
import { LoadedTablets } from "./support/loaded-tablets.js";
import { burrsShotFixture, preheatShotFixture, shotFixture, withShots } from "./support/shot-fixtures.js";
import { type SimulatedTablet, derivedDe1Pro } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1: what a Shot's measurements show of how it went, worked out once as
// its full record is stored, and kept on the Shot (#467): its time to first
// drip, the step it ended in, whether it poured, the scale's last weight and
// the flow at the stop. A simulated tablet running the built plugin stores
// three Shots Decaid recorded, and six derived from the one with a long
// Preheat (de1pro-v0.9.0/shot-preheat.json) by ending its samples early,
// taking its scale away, or changing a frame. Of its 168 samples, 43 are its
// Preheat, 29 its preinfusion, which its profile counts its first three steps
// as, and 96 pouring. The hardware id is the fixtures' made-up one.
//
// Worked out by hand from each record, in seconds from its profile's first
// sample:
//
// | Shot | Scale's first reading of 1 g or more | Ended in | Poured | Last weight | Weight flow there |
// |---|---|---|---|---|---|
// | shot-preheat.json | exactly 1 g, at 7.945 s | 6, Extraction | yes | 32.4 g at 25.833 s | 2.819 g/s |
// | its first 120 samples | the same | 4, Pressurize | yes | 4.6 g at 15.841 s | 0.975 g/s |
// | its first 81 | none: 0.6 g at most | 3, Dripping | yes | 0.6 g at 7.7 s | 0.328 g/s |
// | its first 72, to the end of its preinfusion | none | 2, Compressing | no | 0 g at 5.845 s | 0 g/s |
// | its first 43, its Preheat | none | none | no | none | none |
// | with no scale | none | 6, Extraction | yes | none | none |
// | shot-espresso.json | 25.8 g, at 21.45 s | 4, Pressure Decline | yes | 32.5 g at 23.549 s | 3.216 g/s |
// | shot-grinder-burrs.json | 1.75 g, at 0.594 s | 0, Free flow | yes | 27.59 g at 4.095 s | 7.928 g/s |

type Fields = Record<string, unknown>;

/** What a Shot's read gives of what its measurements show. */
interface Measured {
  timeToFirstDrip: number | null;
  lastStep: { frame: number; name: string } | null;
  lastRecordedWeight: { weight: number; seconds: number } | null;
  flowAtStop: number | null;
}

/** What a Shot keeps of them in its columns, as a later Shot Summary reads them. */
interface Stored {
  id: string;
  time_to_first_drip: number | null;
  last_step_frame: number | null;
  last_step_name: string | null;
  poured: boolean | null;
  last_weight: number | null;
  last_weight_seconds: number | null;
  flow_at_stop: number | null;
  curves_revision: number;
}

const preheat = preheatShotFixture();
const samples = preheat.measurements as { machine: Fields; scale: Fields | null }[];
const derived = (id: string, measurements: unknown[]): Fields => ({ ...preheat, id, measurements });

const shots: Fields[] = [
  derived("measured-whole", samples),
  derived("measured-stopped-early", samples.slice(0, 120)),
  derived("measured-under-a-gram", samples.slice(0, 81)),
  derived("measured-in-preinfusion", samples.slice(0, 72)),
  derived("measured-in-preheat", samples.slice(0, 43)),
  derived("measured-no-scale", samples.map((sample) => ({ ...sample, scale: null }))),
  // A frame no profile has, which a record may still hold.
  derived("measured-frame-beyond", samples.map((sample, n) => (n < 127 ? sample : { ...sample, machine: { ...sample.machine, profileFrame: 3e10 } }))),
  { ...shotFixture(), id: "measured-espresso" },
  { ...burrsShotFixture(), id: "measured-simulated" },
];

/** Each Shot's values, as its read gives them, and whether it poured. */
const expected: Record<string, Measured & { poured: boolean }> = {
  "measured-whole": {
    timeToFirstDrip: 7.945,
    lastStep: { frame: 6, name: "Extraction" },
    lastRecordedWeight: { weight: 32.4, seconds: 25.833 },
    flowAtStop: 2.8189155419461156,
    poured: true,
  },
  "measured-stopped-early": {
    timeToFirstDrip: 7.945,
    lastStep: { frame: 4, name: "Pressurize" },
    lastRecordedWeight: { weight: 4.6, seconds: 15.841 },
    flowAtStop: 0.975336540336653,
    poured: true,
  },
  "measured-under-a-gram": {
    timeToFirstDrip: null,
    lastStep: { frame: 3, name: "Dripping" },
    lastRecordedWeight: { weight: 0.6, seconds: 7.7 },
    flowAtStop: 0.32806863040905176,
    poured: true,
  },
  "measured-in-preinfusion": {
    timeToFirstDrip: null,
    lastStep: { frame: 2, name: "Compressing" },
    lastRecordedWeight: { weight: 0, seconds: 5.845 },
    flowAtStop: 0,
    poured: false,
  },
  "measured-in-preheat": { timeToFirstDrip: null, lastStep: null, lastRecordedWeight: null, flowAtStop: null, poured: false },
  "measured-no-scale": { timeToFirstDrip: null, lastStep: { frame: 6, name: "Extraction" }, lastRecordedWeight: null, flowAtStop: null, poured: true },
  "measured-frame-beyond": {
    timeToFirstDrip: 7.945,
    lastStep: { frame: 3e10, name: "Step 30000000001" },
    lastRecordedWeight: { weight: 32.4, seconds: 25.833 },
    flowAtStop: 2.8189155419461156,
    poured: true,
  },
  "measured-espresso": {
    timeToFirstDrip: 21.45,
    lastStep: { frame: 4, name: "Pressure Decline" },
    lastRecordedWeight: { weight: 32.5, seconds: 23.549 },
    flowAtStop: 3.21596222288838,
    poured: true,
  },
  "measured-simulated": {
    timeToFirstDrip: 0.594,
    lastStep: { frame: 0, name: "Free flow" },
    lastRecordedWeight: { weight: 27.590909100856365, seconds: 4.095 },
    flowAtStop: 7.927902245118086,
    poured: true,
  },
};

describe("What a Shot's measurements show of how it went", () => {
  let server: TestServer;
  let api: AdminApi;
  let tablet: SimulatedTablet;
  const tablets = new LoadedTablets();

  beforeAll(async () => {
    server = await startTestServer({ env: { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" } });
    api = await AdminApi.setUp(server.url);
    const machine = await api.createMachine("Measured");
    tablet = tablets.syncing(machine, server, { api: withShots(derivedDe1Pro({ serial: "10001" }), shots) });
    // The tablet's plugin indexes its Shots and sends those the server asks for, one at a time.
    const deadline = Date.now() + 60_000;
    while ((await api.get<{ total: number }>("/shots")).total < shots.length) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for the tablet's Shots");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
  afterAll(async () => {
    await tablets.unloadAll();
    await server?.stop();
  });

  const read = async (id: string) => (await api.get<{ shot: Measured & Fields }>(`/shots/${id}`)).shot;
  const rows = async () => (await api.get<{ shots: (Pick<Measured, "timeToFirstDrip" | "lastStep"> & Fields & { id: string })[] }>("/shots?limit=100")).shots;
  /** The Shots' columns, which no read gives whole. */
  async function stored(): Promise<Map<string, Stored>> {
    const database = await server.connectDatabase();
    try {
      const { rows: found } = await database.query<Stored>(
        "SELECT id, time_to_first_drip, last_step_frame, last_step_name, poured, last_weight, last_weight_seconds, flow_at_stop, curves_revision FROM shots",
      );
      return new Map(found.map((row) => [row.id, row]));
    } finally {
      await database.end();
    }
  }

  it("gives each Shot's time to first drip, the step it ended in, the scale's last weight and the flow at the stop, as a full record stores them", async () => {
    for (const [id, { poured: _, ...measured }] of Object.entries(expected)) {
      const shot = await read(id);
      expect({ timeToFirstDrip: shot.timeToFirstDrip, lastStep: shot.lastStep, lastRecordedWeight: shot.lastRecordedWeight, flowAtStop: shot.flowAtStop }, id).toEqual(measured);
      // The scale's last weight and the step it ended in are given as one value each, and whether it poured by no read.
      for (const column of ["lastStepFrame", "lastStepName", "lastWeight", "lastWeightSeconds", "poured", "curvesRevision"]) expect(shot, id).not.toHaveProperty(column);
    }
  });

  it("lists each Shot with its time to first drip and the step it ended in, and nothing else of them", async () => {
    const listed = await rows();
    expect(listed.map((row) => row.id).sort()).toEqual(Object.keys(expected).sort());
    for (const row of listed) {
      const { timeToFirstDrip, lastStep } = expected[row.id]!;
      expect({ timeToFirstDrip: row.timeToFirstDrip, lastStep: row.lastStep }, row.id).toEqual({ timeToFirstDrip, lastStep });
      for (const left of ["flowAtStop", "lastRecordedWeight", "lastStepFrame", "lastStepName", "lastWeight", "lastWeightSeconds", "poured", "curvesRevision"]) {
        expect(row, row.id).not.toHaveProperty(left);
      }
    }
  });

  // Whether a Shot poured is given by no read until a Shot Summary counts Unfinished Shots (#469), so it is read from its
  // column, with the scale's last weight as stored for the calibration milestone, which a read gives from the samples.
  it("stores whether each Shot poured, and the scale's last weight with its seconds, at the current curves revision", async () => {
    const columns = await stored();
    for (const [id, { timeToFirstDrip, lastStep, lastRecordedWeight, flowAtStop, poured }] of Object.entries(expected)) {
      expect(columns.get(id), id).toEqual({
        id,
        time_to_first_drip: timeToFirstDrip,
        last_step_frame: lastStep?.frame ?? null,
        last_step_name: lastStep?.name ?? null,
        poured,
        last_weight: lastRecordedWeight?.weight ?? null,
        last_weight_seconds: lastRecordedWeight?.seconds ?? null,
        flow_at_stop: flowAtStop,
        curves_revision: 2,
      });
    }
    // The Unfinished Shots: the one stopped in its Preheat, and the one stopped in its preinfusion.
    expect([...columns.values()].filter((shot) => shot.poured === false).map((shot) => shot.id).sort()).toEqual(["measured-in-preheat", "measured-in-preinfusion"]);
  });

  it("leaves them as they are when the Shot is edited on its tablet", async () => {
    const id = "measured-stopped-early";
    const database = await server.connectDatabase();
    try {
      // Values no revision works out, so a change would show.
      await database.query(
        `UPDATE shots SET time_to_first_drip = 91, last_step_frame = 92, last_step_name = 'Edited', poured = false, last_weight = 93,
           last_weight_seconds = 94, flow_at_stop = 95 WHERE id = $1`,
        [id],
      );
    } finally {
      await database.end();
    }
    const before = (await stored()).get(id)!;
    expect(before).toMatchObject({ time_to_first_drip: 91, poured: false, flow_at_stop: 95 });

    // An edit carries the Shot's metadata whole, without its measurements.
    const { measurements: _, ...metadata } = shots.find((shot) => shot.id === id)!;
    tablet.fire("shotUpdated", { id, shot: { ...metadata, updatedAt: "2026-11-01T12:00:00Z", annotations: { ...(metadata.annotations as Fields), actualYield: 37, enjoyment: 80 } } });
    await expect.poll(async () => (await read(id)).actualYield).toBe(37);

    expect((await stored()).get(id)).toEqual(before);
    expect(await read(id)).toMatchObject({ enjoyment: 80, timeToFirstDrip: 91, flowAtStop: 95 });
    expect((await rows()).find((row) => row.id === id)).toMatchObject({ actualYield: 37, timeToFirstDrip: 91, lastStep: { frame: 92, name: "Edited" } });
    // Its read still gives the step it ended in and the scale's last weight from its samples, which an edit never changes.
    expect(await read(id)).toMatchObject({ lastStep: { frame: 4, name: "Pressurize" }, lastRecordedWeight: { weight: 4.6, seconds: 15.841 } });
  });
});
