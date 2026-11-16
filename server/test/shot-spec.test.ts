import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, type TestApp, asTools, serveTestApp, toolSummary } from "./support/assistants.js";
import { LoadedTablets, emptyLibrary } from "./support/loaded-tablets.js";
import { shotFixture, withShots } from "./support/shot-fixtures.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1: what is out of spec (#543; GLOSSARY.md), through the REST API: a
// Shot Summary's stopped at target and each group's judgement against the
// margins, a Recipe between its Machines, one Shot's judgement in its read
// and its list row, and a Machine's last Shot; and each of those through
// an assistant, as its REST read gives it.
//
// One Shot is stored through a simulated tablet running the built plugin
// (shot-espresso.json), and every other Shot is a copy of its row made in
// PostgreSQL, as assistant-budget.test.ts makes its own, changing only its
// id, Machine, time, Recipe and what the tables below name, so that each
// margin's edge is exact: a duration is the Shot's `duration` with a Preheat
// of 0, a yield its `actual_yield` against a target of 36 g, and what
// stopped it its record's `stopReason`. Each Machine's Loaded Recipes are
// set there too, as shot-summary-groups.test.ts sets them. Hardware ids are
// made up, from 47901.
//
// Timed's Reference Shot is timed-ref, of 30 s: 10% of it is 3 s.
//
// | Recipe | Machine | Durations (s) | Median | Against the reference |
// |---|---|---|---|---|
// | Timed | A | 26.5, 27, 27.5 | 27 | -3, at the margin: within spec |
// | Timed | B | 20, 33.001, 33.001 | 33.001 | +3.001: out of spec |
// | Timed | C | 30, the Reference Shot itself | 30 | 0, of one Shot: not judged |
//
// A also pulled an Unfinished Shot and a cleaning Shot with Timed, which no
// number counts. Between Machines Timed is 6.001 s apart, A to B, of B's
// 33.001: out of spec, C's one Shot left out.
//
// Spread, Wide and Few have no Reference Shot. A yield of 37.8 g is 5% over
// 36, and 34.2 g 5% under.
//
// | Recipe | Machine | Durations (s) | Yields (g) | Median yield's share | Yield |
// |---|---|---|---|---|---|
// | Spread | A | 27, 27, 27 | 37.8 x 3 | +0.05 | at the margin: within spec |
// | Spread | B | 30, 30, 30 | 30, 37.81, 37.81 | +0.050278 | out of spec |
// | Spread | C | 50, 50 | 30, 30 | -0.166667 | two Shots: not judged, beyond the margin |
// | Wide | A | 26.999 x 3 | 34.2 x 3 | -0.05 | at the margin: within spec |
// | Wide | B | 30 x 3 | 34.19 x 3 | -0.050278 | out of spec |
// | Few | A | 20 | 36 | 0 | one Shot: not judged |
// | Few | B | 30 x 3 | 36 x 3 | 0 | within spec |
//
// Between Machines: Spread's A and B are 3 s apart, 10% of B's 30 s, at the
// margin and within spec, with C's two Shots left out, which are 23 s from
// A's; Wide's are 3.001 s apart, out of spec; and Few has one Machine with
// three Shots, so its two are 10 s apart and not judged.
//
// Stops has no Reference Shot. Every Shot of it ran 30 s and weighed 36 g.
//
// | Machine | Stopped by | At target |
// |---|---|---|
// | A | targetWeight x 8, targetVolume, appStop | 9 of 10, at the margin: within spec |
// | B | targetWeight x 3, apiStop, machineEnded, error, disconnected, noScale, profileSkip, and one that recorded none | 3 of 9: out of spec |
// | C | machineEnded x 2 | 0 of 2: not judged, beyond the margin |

type Fields = Record<string, unknown>;

interface Judgement {
  judgement: "withinSpec" | "outOfSpec" | "notJudged";
  beyondMargin: boolean | null;
}

interface Group {
  by: { recipe?: { id: string; name: string } | null; machine?: { id: string; name: string } | null };
  counts: { shots: number; unfinished: number; cleaningAndCalibration: number; awaitingValues: number };
  numbers: Fields;
  spec: { duration?: Judgement & { difference: number | null }; yield: Judgement; stoppedAtTarget: Judgement; betweenMachines?: Judgement & { apart: number | null } };
  reference?: { id: string; numbers: Fields };
}

interface Summary {
  groups: Group[];
  total: number;
}

interface ShotSpec {
  unfinished: boolean;
  cleaningOrCalibration: boolean;
  duration: { difference: number; outOfSpec: boolean } | null;
  yield: { againstTarget: number; outOfSpec: boolean } | null;
  stopped: string | null;
}

/** What a copy changes of the Shot copied. */
interface Copy {
  machine: "A" | "B" | "C";
  recipe: "Timed" | "Spread" | "Wide" | "Few" | "Stops";
  duration?: number;
  yield?: number;
  /** The stop reason recorded; null for none. */
  stop?: string | null;
  unfinished?: true;
  cleaning?: true;
}

const SERIAL = "47901";
const WITHIN: Judgement = { judgement: "withinSpec", beyondMargin: false };
const OUT: Judgement = { judgement: "outOfSpec", beyondMargin: true };
/** Not judged for want of Shots, which are within the margin, or beyond it. */
const FEW_WITHIN: Judgement = { judgement: "notJudged", beyondMargin: false };
const FEW_BEYOND: Judgement = { judgement: "notJudged", beyondMargin: true };
const NOTHING: Judgement = { judgement: "notJudged", beyondMargin: null };

/** `count` copies of one Shot. */
const times = (count: number, copy: Copy): Copy[] => Array.from({ length: count }, () => copy);

/** Every Shot but the one a tablet stored, by its id: each Recipe and Machine's in the order pulled. */
const COPIES: Record<string, Copy> = Object.fromEntries(
  [
    ["timed-a", [26.5, 27, 27.5].map((duration): Copy => ({ machine: "A", recipe: "Timed", duration }))],
    ["timed-a-unfinished", [{ machine: "A", recipe: "Timed", duration: 2, unfinished: true }]],
    ["timed-a-cleaning", [{ machine: "A", recipe: "Timed", duration: 60, cleaning: true }]],
    ["timed-b", [20, 33.001, 33.001].map((duration): Copy => ({ machine: "B", recipe: "Timed", duration }))],
    ["timed-ref", [{ machine: "C", recipe: "Timed", duration: 30 }]],
    ["spread-a", times(3, { machine: "A", recipe: "Spread", duration: 27, yield: 37.8 })],
    ["spread-b", [30, 37.81, 37.81].map((weighed): Copy => ({ machine: "B", recipe: "Spread", duration: 30, yield: weighed }))],
    ["spread-c", times(2, { machine: "C", recipe: "Spread", duration: 50, yield: 30 })],
    ["wide-a", times(3, { machine: "A", recipe: "Wide", duration: 26.999, yield: 34.2 })],
    ["wide-b", times(3, { machine: "B", recipe: "Wide", duration: 30, yield: 34.19 })],
    ["few-a", [{ machine: "A", recipe: "Few", duration: 20 }]],
    ["few-b", times(3, { machine: "B", recipe: "Few", duration: 30 })],
    ["stops-a", [...times(8, { machine: "A", recipe: "Stops" }), { machine: "A", recipe: "Stops", stop: "targetVolume" }, { machine: "A", recipe: "Stops", stop: "appStop" }]],
    [
      "stops-b",
      ["targetWeight", "targetWeight", "targetWeight", "apiStop", "machineEnded", "error", "disconnected", "noScale", "profileSkip", null].map((stop): Copy => ({ machine: "B", recipe: "Stops", stop })),
    ],
    ["stops-c", times(2, { machine: "C", recipe: "Stops", stop: "machineEnded" })],
  ].flatMap(([name, copies]) => (copies as Copy[]).map((copy, index) => [(copies as Copy[]).length === 1 ? name : `${name as string}-${index + 1}`, copy])),
);

describe("Out of spec", () => {
  let server: TestServer;
  let api: AdminApi;
  let lab: LocationView;
  let machines: Record<Copy["machine"], CreatedMachine>;
  let recipes: Record<Copy["recipe"], { id: string; name: string }>;
  let app: TestApp;
  let assistant: Assistant;
  const tablets = new LoadedTablets();

  beforeAll(async () => {
    server = await startTestServer({ env: { ...ASSISTANT_ENV, SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" } });
    api = await AdminApi.setUp(server.url);
    app = await serveTestApp();
    assistant = await Assistant.connect(server.url, app, await signIn(server.url, admin), { allowed: ["read"] });
    lab = await api.createLocation("Lab", "America/Denver");
    machines = { A: await api.createMachine("Spec A"), B: await api.createMachine("Spec B"), C: await api.createMachine("Spec C") };
    for (const { machine } of Object.values(machines)) {
      await api.send("POST", `/machines/${machine.id}/location-history`, { locationId: lab.id, effectiveFrom: "2025-01-01T00:00:00Z" }, 201);
    }
    // The one Shot a tablet stores, which the rest are copies of: on a fourth Machine, at no Location, so no summary of the Lab's counts it.
    const seeder = await api.createMachine("Spec seed");
    const fixture = shotFixture();
    const recorded = fixture.workflow as Record<string, Fields>;
    const seed = { ...fixture, id: "seed", timestamp: "2026-03-01T12:00:00Z", workflow: { ...recorded, machine: { ...recorded.machine, model: "DE1Pro", serialNumber: SERIAL } } };
    tablets.syncing(seeder, server, { api: withShots(emptyLibrary(SERIAL), [seed]) });
    const deadline = Date.now() + 60_000;
    while ((await api.get<{ total: number }>("/shots?limit=1")).total < 1) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for the seed Shot");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await tablets.unloadAll();

    const made = async (name: Copy["recipe"]) => ({ id: (await api.send<{ recipe: { id: string } }>("POST", "/recipes", { locationId: lab.id, content: { name } }, 201)).recipe.id, name });
    recipes = { Timed: await made("Timed"), Spread: await made("Spread"), Wide: await made("Wide"), Few: await made("Few"), Stops: await made("Stops") };

    const database = await server.connectDatabase();
    try {
      const { rows } = await database.query<{ record: Fields }>("SELECT record FROM shots WHERE id = 'seed'");
      const { stopReason: _recorded, ...record } = rows[0]!.record;
      const workflow = record.workflow as Record<string, Fields>;
      for (const [index, [id, copy]] of Object.entries(COPIES).entries()) {
        const changes = {
          id,
          machine_id: machines[copy.machine].machine.id,
          location_id: lab.id,
          tablet_id: null,
          recipe_id: recipes[copy.recipe].id,
          // A minute apart on 2 March, in the order of the table, so each Machine's last Shot is its last there.
          pulled_at: new Date(Date.parse("2026-03-02T15:00:00Z") + index * 60_000).toISOString(),
          duration: copy.duration ?? 30,
          preheat: 0,
          actual_yield: copy.yield ?? 36,
          target_yield: 36,
          // An Unfinished Shot never reported pouring, and its scale never read a gram.
          ...(copy.unfinished && { poured: false, time_to_first_drip: null }),
          record: {
            ...record,
            ...(copy.stop !== null && { stopReason: copy.stop ?? "targetWeight" }),
            ...(copy.cleaning && { workflow: { ...workflow, profile: { ...workflow.profile, beverage_type: "cleaning" } } }),
          },
        };
        await database.query("INSERT INTO shots SELECT (jsonb_populate_record(NULL::shots, to_jsonb(s) || $1::jsonb)).* FROM shots AS s WHERE s.id = 'seed'", [JSON.stringify(changes)]);
      }
      // Each Machine had each Recipe loaded all of that day, one after another as far as the rows say, which is all a Shot's Recipe reads.
      for (const { machine } of Object.values(machines)) {
        for (const recipe of Object.values(recipes)) {
          await database.query("INSERT INTO loaded_recipes (machine_id, recipe_id, loaded_at, unloaded_at) VALUES ($1, $2, '2026-03-02T00:00:00Z', '2026-03-03T00:00:00Z')", [machine.id, recipe.id]);
        }
      }
    } finally {
      await database.end();
    }
    await api.send("PUT", `/recipes/${recipes.Timed.id}/reference-shot`, { shotId: "timed-ref" });
  });
  afterAll(async () => {
    await assistant?.close();
    await tablets.unloadAll();
    await app?.close();
    await server?.stop();
  });

  /** The Lab's summary by Recipe and then Machine, with the query given. */
  const summary = (query: Record<string, string> = {}) => api.get<Summary>(`/shots/summary?${new URLSearchParams({ locationId: lab.id, groupBy: "recipe,machine", limit: "100", ...query })}`);
  /** The group of a Recipe on a Machine. */
  const groupOf = (groups: Group[], recipe: Copy["recipe"], machine: Copy["machine"]) =>
    groups.find(({ by }) => by.recipe?.id === recipes[recipe].id && by.machine?.id === machines[machine].machine.id)!;
  const shot = async (id: string) => (await api.get<{ shot: { spec: ShotSpec; stopReason: string | null; duration: number | null } }>(`/shots/${id}`)).shot;

  it("judges a group's median duration against its Recipe's Reference Shot's: within spec at exactly 10%, out of spec beyond it, and not judged with fewer than 3 Shots", async () => {
    const { groups, total } = await summary();
    // Five Recipes, each on two or three Machines.
    expect(total).toBe(13);
    const a = groupOf(groups, "Timed", "A");
    // The Unfinished Shot and the cleaning Shot are counted apart, and no number or judgement is of them.
    expect(a.counts).toEqual({ shots: 3, unfinished: 1, cleaningAndCalibration: 1, awaitingValues: 0 });
    expect(a.numbers.duration).toEqual({ shots: 3, median: 27, p25: 26.75, p75: 27.25 });
    expect(a.reference).toMatchObject({ id: "timed-ref", numbers: { duration: 30 } });
    expect(a.spec.duration).toEqual({ ...WITHIN, difference: -3 });
    expect(groupOf(groups, "Timed", "B").spec.duration).toEqual({ ...OUT, difference: 3.001 });
    // The Reference Shot itself, the one Shot its Machine pulled.
    expect(groupOf(groups, "Timed", "C").spec.duration).toEqual({ ...FEW_WITHIN, difference: 0 });
  });

  it("judges a Recipe with no Reference Shot for its yield and its stopping only", async () => {
    const { groups } = await summary();
    for (const recipe of ["Spread", "Wide", "Few", "Stops"] as const) {
      for (const group of groups.filter(({ by }) => by.recipe?.id === recipes[recipe].id)) {
        expect(group.reference, recipe).toBeUndefined();
        expect(Object.keys(group.spec), recipe).toEqual(["yield", "stoppedAtTarget", "betweenMachines"]);
      }
    }
    // And so is a group of a summary not grouped by Recipe, its Shots being several Recipes'.
    const { groups: byMachine } = await api.get<Summary>(`/shots/summary?${new URLSearchParams({ locationId: lab.id, groupBy: "machine" })}`);
    expect(byMachine).toHaveLength(3);
    for (const group of byMachine) expect(Object.keys(group.spec)).toEqual(["yield", "stoppedAtTarget"]);
  });

  it("judges a group's yield by the median of each Shot's yield against its target, as a share of it: within spec at exactly 5% either way, and not judged with fewer than 3 Shots", async () => {
    const { groups } = await summary();
    expect(groupOf(groups, "Spread", "A").numbers.yieldAgainstTarget).toMatchObject({ shots: 3, median: 1.8 });
    expect(groupOf(groups, "Spread", "A").spec.yield).toEqual(WITHIN);
    expect(groupOf(groups, "Spread", "B").numbers.yieldAgainstTarget).toMatchObject({ shots: 3, median: 1.81 });
    expect(groupOf(groups, "Spread", "B").spec.yield).toEqual(OUT);
    // Two Shots 6 g under are beyond the margin, and too few to judge.
    expect(groupOf(groups, "Spread", "C").spec.yield).toEqual(FEW_BEYOND);
    expect(groupOf(groups, "Wide", "A").numbers.yieldAgainstTarget).toMatchObject({ shots: 3, median: -1.8 });
    expect(groupOf(groups, "Wide", "A").spec.yield).toEqual(WITHIN);
    expect(groupOf(groups, "Wide", "B").spec.yield).toEqual(OUT);
    expect(groupOf(groups, "Few", "A").spec.yield).toEqual(FEW_WITHIN);
  });

  it("counts a volume stop as stopped at target and each other reason under its kind, and judges a group within spec at exactly 90%", async () => {
    const { groups } = await summary();
    const a = groupOf(groups, "Stops", "A");
    expect(a.numbers.stoppedAtTarget).toEqual({ shots: 10, share: 0.9, atTarget: 9, byHand: 1, machineEnded: 0, error: 0, other: 0 });
    // The number the latest release's pages read counts the weight stops alone, as it did.
    expect(a.numbers.stoppedOnWeight).toEqual({ shots: 10, share: 0.8 });
    expect(a.spec.stoppedAtTarget).toEqual(WITHIN);
    const b = groupOf(groups, "Stops", "B");
    // Ten Shots, of which one recorded nothing: an API stop is by hand, a dropped connection an error, and Decaid's other reasons anything else.
    expect(b.counts.shots).toBe(10);
    expect(b.numbers.stoppedAtTarget).toEqual({ shots: 9, share: 3 / 9, atTarget: 3, byHand: 1, machineEnded: 1, error: 2, other: 2 });
    expect(b.spec.stoppedAtTarget).toEqual(OUT);
    const c = groupOf(groups, "Stops", "C");
    expect(c.numbers.stoppedAtTarget).toEqual({ shots: 2, share: 0, atTarget: 0, byHand: 0, machineEnded: 2, error: 0, other: 0 });
    expect(c.spec.stoppedAtTarget).toEqual(FEW_BEYOND);
  });

  it("gives stopped at target where no numbers are named and when asked for alone, and judges a group whichever numbers are named", async () => {
    const { groups } = await summary();
    expect(Object.keys(groups[0]!.numbers)).toEqual(["yieldAgainstTarget", "duration", "stoppedOnWeight", "stoppedAtTarget"]);
    const named = await summary({ numbers: "stoppedAtTarget" });
    expect(Object.keys(named.groups[0]!.numbers)).toEqual(["stoppedAtTarget"]);
    expect(groupOf(named.groups, "Timed", "A").reference).toEqual({ id: "timed-ref", numbers: { stoppedAtTarget: true } });
    const rated = await summary({ numbers: "rating" });
    expect(rated.groups.map((group) => group.spec)).toEqual(groups.map((group) => group.spec));
    // The Shots that recorded no reason judge nothing: the seed Shot's Machine is at no Location, and its one Shot stopped on weight.
    const { groups: none } = await api.get<Summary>(`/shots/summary?${new URLSearchParams({ locationId: lab.id, from: "2020-01-01", to: "2020-01-02" })}`);
    expect(none).toHaveLength(1);
    expect(none[0]!.spec).toEqual({ yield: NOTHING, stoppedAtTarget: NOTHING });
  });

  it("carries no judgement in a bucketed summary", async () => {
    const { groups } = await api.get<{ groups: Fields[] }>(`/shots/summary?${new URLSearchParams({ locationId: lab.id, groupBy: "recipe,machine", bucket: "day", limit: "100" })}`);
    expect(groups).toHaveLength(13);
    for (const group of groups) {
      expect(group).not.toHaveProperty("spec");
      for (const bucket of group.buckets as Fields[]) expect(bucket).not.toHaveProperty("spec");
    }
  });

  it("judges a Recipe between its Machines: within spec at exactly 10% of the slower one's, a Machine of fewer than 3 Shots left out, the same on every page", async () => {
    const { groups } = await summary();
    // A's 27 s and B's 30 s, C's two Shots at 50 s left out of both.
    for (const machine of ["A", "B", "C"] as const) expect(groupOf(groups, "Spread", machine).spec.betweenMachines, machine).toEqual({ ...WITHIN, apart: 3 });
    for (const machine of ["A", "B"] as const) expect(groupOf(groups, "Wide", machine).spec.betweenMachines, machine).toEqual({ ...OUT, apart: 3.001 });
    // One Machine with three Shots is nothing to judge by, so its two Machines' difference is given, not judged.
    for (const machine of ["A", "B"] as const) expect(groupOf(groups, "Few", machine).spec.betweenMachines, machine).toEqual({ ...FEW_BEYOND, apart: 10 });
    for (const machine of ["A", "B", "C"] as const) expect(groupOf(groups, "Timed", machine).spec.betweenMachines, machine).toEqual({ ...OUT, apart: 6.001 });
    // Every Shot of Stops ran 30 s.
    expect(groupOf(groups, "Stops", "A").spec.betweenMachines).toEqual({ ...WITHIN, apart: 0 });

    // A group at a time, so each Recipe's groups fall on two or three pages: each gives what the whole summary gave.
    const paged: Group[] = [];
    for (let offset = 0; offset < groups.length; offset += 1) paged.push(...(await summary({ limit: "1", offset: String(offset) })).groups);
    expect(paged).toEqual(groups);
    // Filtered to one Machine, a Recipe has no other to be apart from.
    const alone = await summary({ machineId: machines.A.machine.id });
    for (const group of alone.groups) expect(group.spec.betweenMachines).toEqual({ ...NOTHING, apart: null });
    // The same whichever grouping comes first, and none without both.
    const turned = await summary({ groupBy: "machine,recipe" });
    expect(groupOf(turned.groups, "Wide", "A").spec.betweenMachines).toEqual({ ...OUT, apart: 3.001 });
    expect((await summary({ groupBy: "recipe" })).groups.every((group) => group.spec.betweenMachines === undefined)).toBe(true);
  });

  it("judges one Shot by the same margins, in its read and in its row of the list", async () => {
    const judged = (spec: Partial<ShotSpec>): ShotSpec => ({ unfinished: false, cleaningOrCalibration: false, duration: null, yield: { againstTarget: 0, outOfSpec: false }, stopped: "targetWeight", ...spec });
    // Exactly 10% under the Reference Shot's 30 s, and just over 10% over it.
    expect((await shot("timed-a-2")).spec).toEqual(judged({ duration: { difference: -3, outOfSpec: false } }));
    expect((await shot("timed-b-2")).spec).toEqual(judged({ duration: { difference: 3.001, outOfSpec: true } }));
    // The Reference Shot itself is at no difference from itself.
    expect((await shot("timed-ref")).spec).toEqual(judged({ duration: { difference: 0, outOfSpec: false } }));
    // A Recipe with no Reference Shot gives no difference; a yield is within spec at exactly 5% of its target.
    expect((await shot("spread-a-1")).spec).toEqual(judged({ yield: { againstTarget: 1.8, outOfSpec: false } }));
    expect((await shot("spread-b-2")).spec).toEqual(judged({ yield: { againstTarget: 1.81, outOfSpec: true } }));
    expect((await shot("wide-a-1")).spec).toEqual(judged({ yield: { againstTarget: -1.8, outOfSpec: false } }));
    expect((await shot("wide-b-1")).spec).toEqual(judged({ yield: { againstTarget: -1.81, outOfSpec: true } }));
    // An Unfinished Shot and a cleaning Shot say which they are, and are not judged, though Timed has a Reference Shot.
    expect((await shot("timed-a-unfinished")).spec).toEqual(judged({ unfinished: true, yield: null }));
    expect((await shot("timed-a-cleaning")).spec).toEqual(judged({ cleaningOrCalibration: true, yield: null }));
    // The seed Shot was pulled with no Recipe: 35.9 g of its own target of 36.
    expect((await shot("seed")).spec).toEqual(judged({ yield: { againstTarget: -0.1, outOfSpec: false } }));

    // How each stopped, with the reason as recorded for what is none of Decaid's five kinds.
    const stopped = async (id: string) => {
      const read = await shot(id);
      return [read.spec.stopped, read.stopReason];
    };
    expect(await stopped("stops-a-1")).toEqual(["targetWeight", "targetWeight"]);
    expect(await stopped("stops-a-9")).toEqual(["targetVolume", "targetVolume"]);
    expect(await stopped("stops-a-10")).toEqual(["byHand", "appStop"]);
    expect(await stopped("stops-b-4")).toEqual(["byHand", "apiStop"]);
    expect(await stopped("stops-b-5")).toEqual(["machineEnded", "machineEnded"]);
    expect(await stopped("stops-b-6")).toEqual(["error", "error"]);
    expect(await stopped("stops-b-7")).toEqual(["error", "disconnected"]);
    expect(await stopped("stops-b-8")).toEqual(["other", "noScale"]);
    expect(await stopped("stops-b-10")).toEqual([null, null]);

    // Each row of the list gives what the Shot's read does.
    const { shots, total } = await api.get<{ shots: { id: string; spec: ShotSpec }[]; total: number }>("/shots?limit=100");
    expect(total).toBe(Object.keys(COPIES).length + 1);
    expect(shots).toHaveLength(total);
    for (const row of shots) expect(row.spec, row.id).toEqual((await shot(row.id)).spec);
  });

  it("gives a Machine's last Shot with its Recipe, its duration and its judgement", async () => {
    // B's last is the last of its Shots of Stops, which recorded no stop reason; C's the second of its two there.
    const { machines: listed } = await api.get<{ machines: { id: string; lastShot: Fields | null }[] }>("/machines");
    const last = (machine: Copy["machine"]) => listed.find(({ id }) => id === machines[machine].machine.id)!.lastShot;
    expect(last("B")).toEqual({
      id: "stops-b-10",
      pulledAt: expect.any(String),
      recipe: recipes.Stops,
      duration: 30,
      spec: { unfinished: false, cleaningOrCalibration: false, duration: null, yield: { againstTarget: 0, outOfSpec: false }, stopped: null },
    });
    expect(last("C")).toMatchObject({ id: "stops-c-2", recipe: recipes.Stops, duration: 30, spec: (await shot("stops-c-2")).spec });
    // One Machine's read gives the same.
    expect((await api.get<{ machine: { lastShot: Fields } }>(`/machines/${machines.B.machine.id}`)).machine.lastShot).toEqual(last("B"));

    // A last Shot against its Recipe's Reference Shot: Wide's becomes a Shot of 30 s, which A's 26.999 s are over 10% from.
    await api.send("PUT", `/recipes/${recipes.Wide.id}/reference-shot`, { shotId: "wide-b-1" });
    try {
      expect((await shot("wide-a-3")).spec.duration).toEqual({ difference: -3.001, outOfSpec: true });
    } finally {
      await api.send("PUT", `/recipes/${recipes.Wide.id}/reference-shot`, { shotId: null });
    }
  });

  it("gives the same through an assistant: a summary's judgements and stopped at target, a Shot's in find_shots and get_shot, and a Machine's last Shot", async () => {
    // Every group of the summary by Recipe and Machine, as the REST API gives it, its numbers to hundredths.
    const rest = await summary({ match: "words" });
    const summarised = await assistant.call<{ groups: Group[] }>("summarise_shots", { locationId: lab.id, groupBy: ["recipe", "machine"], limit: 50 });
    expect(summarised).toEqual(toolSummary({ ...rest, offset: 0 }));
    // The margins' edges hold through the rounding: a difference of 3.001 s reads as 3, and is still out of spec.
    expect(groupOf(summarised.groups, "Timed", "A").spec.duration).toEqual({ ...WITHIN, difference: -3 });
    expect(groupOf(summarised.groups, "Timed", "B").spec.duration).toEqual({ ...OUT, difference: 3 });
    expect(groupOf(summarised.groups, "Wide", "A").spec.betweenMachines).toEqual({ ...OUT, apart: 3 });
    expect(groupOf(summarised.groups, "Stops", "B").numbers.stoppedAtTarget).toEqual({ shots: 9, share: 0.33, atTarget: 3, byHand: 1, machineEnded: 1, error: 2, other: 2 });
    // A bucketed summary carries none.
    const bucketed = await assistant.call<{ groups: Fields[] }>("summarise_shots", { locationId: lab.id, groupBy: ["recipe"], bucket: "day" });
    for (const group of bucketed.groups) expect(group).not.toHaveProperty("spec");

    // Each row of find_shots gives each part of the Shot's judgement that has a value, and its flags only when true.
    const { shots } = await assistant.call<{ shots: { id: string; spec: Fields }[] }>("find_shots", { locationId: lab.id, limit: 50 });
    expect(shots).toHaveLength(Object.keys(COPIES).length);
    for (const row of shots) {
      const { unfinished, cleaningOrCalibration, ...parts } = (await shot(row.id)).spec;
      const given = Object.fromEntries(Object.entries({ ...(unfinished && { unfinished }), ...(cleaningOrCalibration && { cleaningOrCalibration }), ...parts }).filter(([, part]) => part !== null));
      expect(row.spec, row.id).toEqual(asTools(given));
    }
    expect(shots.find(({ id }) => id === "timed-b-2")!.spec).toEqual({ duration: { difference: 3, outOfSpec: true }, yield: { againstTarget: 0, outOfSpec: false }, stopped: "targetWeight" });
    expect(shots.find(({ id }) => id === "timed-a-unfinished")!.spec).toEqual({ unfinished: true, stopped: "targetWeight" });
    expect(shots.find(({ id }) => id === "stops-b-10")!.spec).toEqual({ yield: { againstTarget: 0, outOfSpec: false } });

    // get_shot gives it whole.
    for (const id of ["timed-a-2", "timed-b-2", "timed-ref", "spread-b-2", "timed-a-cleaning", "stops-b-8", "stops-b-10"]) {
      expect((await assistant.call<{ spec: ShotSpec }>("get_shot", { id })).spec, id).toEqual(asTools((await shot(id)).spec));
    }

    // A Machine's last Shot, from list_machines and get_machine alike, its time with the Lab's offset.
    const { machines: restMachines } = await api.get<{ machines: { id: string; lastShot: (Fields & { pulledAt: string }) | null }[] }>("/machines");
    const { machines: listed } = await assistant.call<{ machines: { id: string; lastShot: (Fields & { pulledAt: string }) | null }[] }>("list_machines");
    for (const { machine } of Object.values(machines)) {
      const last = restMachines.find(({ id }) => id === machine.id)!.lastShot!;
      const given = listed.find(({ id }) => id === machine.id)!.lastShot!;
      expect({ ...given, pulledAt: Date.parse(given.pulledAt) }, machine.name).toEqual(asTools({ ...last, pulledAt: Date.parse(last.pulledAt) }));
      expect(given.pulledAt).toMatch(/-0[67]:00$/);
      expect((await assistant.call<{ machine: { lastShot: Fields } }>("get_machine", { machineId: machine.id })).machine.lastShot).toEqual(given);
    }
  });
});
