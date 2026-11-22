import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { shotFigures, shotFitStop, simulateProfile, simulationShotOf, standardPuck } from "@decent-sync/protocol";
import { PROFILE_KINDS, corpusRecord, formatScorecard, formatSetPairs, metNoCoffee, profileKind, readShots, scoreShot, scorecard, shotEntry, spread } from "../simulation/scorecard.mjs";
import { corpusProblems, inferSets, scrubShot } from "../simulation/scrub.mjs";
import { spreadOut } from "../simulation/pull.mjs";

// The simulation's scorecard and the corpus of real Shots it runs on (#599).
// The corpus test holds the simulation at the share of corpus Shots within
// the margin recorded in corpus/levels.json; the rest check the scripts on
// Shots Decaid v0.9.2's simulated machine recorded.

type Fields = Record<string, unknown>;

const CORPUS = new URL("../simulation/corpus/", import.meta.url).pathname;
const SHOTS = path.join(CORPUS, "shots");
const LEVELS = JSON.parse(fs.readFileSync(path.join(CORPUS, "levels.json"), "utf8")) as Record<"DE1" | "Bengle", { within: number; of: number }> & { differentSteps: { durationError: number }; soaks: { within: number; of: number } };
const FIXTURES = new URL("../../server/test/fixtures/decaid/simulated-shots-v0.9.2/", import.meta.url).pathname;

/** A fixture Shot as the REST API gives one: `{ shot, measurements }`, the record under `shot` with the measurements taken out. */
function pulled(name: string, fields: Fields = {}): { shot: Fields & { record: Fields }; measurements: unknown[] } {
  const { measurements, ...record } = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8")) as Fields & { measurements: unknown[] };
  return { shot: { id: `fixture-${name}`, profileTitle: (record.workflow as { profile: { title: string } }).profile.title, pulledAt: "2026-11-18T21:40:00.000Z", record, ...fields }, measurements };
}

describe("the corpus", () => {
  const card = scorecard(readShots(SHOTS));

  it("holds the simulation at the share of Shots within the margin recorded for each model", () => {
    for (const model of ["DE1", "Bengle"] as const) {
      const level = LEVELS[model];
      const now = card.models[model]!.all;
      expect(now.within / now.shots, `${model}: ${now.within} of ${now.shots} within the margin, recorded ${level.within} of ${level.of}`).toBeGreaterThanOrEqual(level.within / level.of);
    }
  });

  it("holds one Shot's puck, run with another Profile's steps on the same coffee, at the median duration error recorded (#602)", () => {
    const { pairs, duration } = card.sets.different;
    expect(pairs).toBeGreaterThanOrEqual(80);
    expect(duration.median!, `a median ${(duration.median! * 100).toFixed(1)}% off, recorded ${LEVELS.differentSteps.durationError * 100}%`).toBeLessThanOrEqual(LEVELS.differentSteps.durationError);
    // The designed session's, where a bloom's puck ran 32 to 57% short of every other Profile before the puck opened and tightened.
    expect(card.sets.bySet.s14!.different.duration.median!).toBeLessThanOrEqual(0.085);
    expect(card.sets.bySet.s14!.different.duration.worstTenth!).toBeLessThanOrEqual(0.2);
  });

  it("holds its pump-off soaks that end as pressure falls within a second of their Shots', as many as recorded (#602)", () => {
    expect(card.soaks.steps).toBe(LEVELS.soaks.of);
    expect(card.soaks.within, `${card.soaks.within} of ${card.soaks.steps} within a second, recorded ${LEVELS.soaks.within}`).toBeGreaterThanOrEqual(LEVELS.soaks.within);
    expect(card.soaks.error.median!).toBeLessThan(0.75);
    expect(formatScorecard(card)).toContain(`Pump-off soaks that end as pressure falls: ${card.soaks.steps}, ${card.soaks.within} within 1 s`);
  });

  it("is what the standard puck is taken from: its middle a flat 9 bar Profile's typical puck, its ends past the coarsest and finest (#602)", () => {
    const fitted = card.shots.filter((shot) => shot.errors !== null && shot.within && !shot.tea && shot.puck !== null);
    const at18 = (shot: (typeof fitted)[number]) => (shot.puck!.resistance * 18) / shot.puck!.dose;
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]!;
    // The water before the first drip: the median of the corpus's pucks.
    expect(Math.abs(median(fitted.map((shot) => shot.puck!.holds)) - standardPuck(0).holds)).toBeLessThan(2);
    // Its steps, run on the standard puck at the Shot's own dose and to its own weight, last what the Shot lasted, at the median of the corpus's flat 9 bar Shots.
    const entries = new Map(readShots(SHOTS).map((entry) => [entry.name, entry]));
    // The Slayer-style session's (#624) were ground for a long low-flow pre-brew, three to twelve times
    // the resistance of a flat 9 bar Profile's usual grind, its control's too, so they are no part of the typical puck.
    const slayerSession = (name: string) => /^de1pro-0(39|4\d)$/.test(name);
    const flat = fitted.filter((shot) => {
      if (slayerSession(shot.name)) return false;
      const { profile } = simulationShotOf(entries.get(shot.name)!.record, entries.get(shot.name)!.measurements);
      return shot.kind === "pressure" && profile!.steps.every((step) => step.pump === "flow" || step.pressure < 4.5 || Math.abs(step.pressure - 9) < 0.6);
    });
    expect(flat.length).toBeGreaterThanOrEqual(4);
    const off = flat.map((scored) => {
      const shot = simulationShotOf(entries.get(scored.name)!.record, entries.get(scored.name)!.measurements);
      const stop = shotFitStop(shot.samples, shot.stopReason, shot.model!, shot.profile!)!;
      const run = simulateProfile({ profile: shot.profile!, puck: standardPuck(0), dose: shot.dose, stopAt: stop.stopAt, stopOn: "reached", model: shot.model! });
      return run.duration / shotFigures(shot.samples).duration - 1;
    });
    expect(Math.abs(median(off))).toBeLessThan(0.1);
    expect(Math.abs(Math.log(median(flat.map(at18)) / standardPuck(0).resistance))).toBeLessThan(Math.log(1.25));
    // The control's ends pass every puck recorded, the corpus's turbo Shots sitting about halfway to the coarse end.
    const all = fitted.map(at18);
    expect(Math.min(...all)).toBeGreaterThan(standardPuck(1).resistance * 1.5);
    expect(Math.max(...all)).toBeLessThan(standardPuck(-1).resistance / 1.5);
    const turbo = median(fitted.filter((shot) => shot.kind === "fast flow").map(at18));
    expect(turbo).toBeLessThan(standardPuck(0.4).resistance);
    expect(turbo).toBeGreaterThan(standardPuck(0.7).resistance);
  });

  it("holds each file in the scrubbed shape and nothing else", () => {
    for (const file of fs.readdirSync(SHOTS)) {
      expect(file).toMatch(/^[a-z0-9]+-\d{3}\.json$/);
      expect(corpusProblems(JSON.parse(fs.readFileSync(path.join(SHOTS, file), "utf8"))), file).toEqual([]);
    }
  });

  it("covers each kind of Profile for each model, with a few tea Shots and sets, the designed sessions' among them, in no more than 180 Shots", () => {
    expect(card.shots.length).toBeLessThanOrEqual(180);
    for (const model of ["DE1", "Bengle"] as const) expect(Object.keys(card.models[model]!.kinds).sort()).toEqual([...PROFILE_KINDS].sort());
    expect(card.tea.shots).toBeGreaterThanOrEqual(2);
    expect(card.sets.same.pairs).toBeGreaterThan(0);
    expect(card.sets.different.pairs).toBeGreaterThan(0);
    // The designed session (#600): one coffee, two Shots each of five Profiles, so each Shot's puck on its twin's steps and on eight others'.
    expect(card.sets.bySet.s14).toMatchObject({ model: "DE1", shots: 10, same: { pairs: 10 }, different: { pairs: 80 } });
    // The Slayer-style session (#624): at the middle grind, its first Shot (whose last step's time limit differs), three
    // others' pre-brews at 1.5, 1.0 and 2.0 ml/s and the control twice; then two Shots each a step finer and a step coarser.
    expect(card.sets.bySet.s15).toMatchObject({ model: "DE1", shots: 6, same: { pairs: 2 }, different: { pairs: 28 } });
    expect(card.sets.bySet.s16).toMatchObject({ model: "DE1", shots: 2, same: { pairs: 2 } });
    expect(card.sets.bySet.s17).toMatchObject({ model: "DE1", shots: 2, same: { pairs: 2 } });
    expect(card.unreadable).toBe(0);
  });
});

describe("the scrubbed shape", () => {
  const scrubbed = scrubShot(pulled("classic-italian"), "s4");

  it("keeps what the simulation reads and drops every name, id, serial, firmware, time and note", () => {
    if (typeof scrubbed === "string") throw new Error(scrubbed);
    expect(corpusProblems(scrubbed)).toEqual([]);
    expect(scrubbed).toMatchObject({ model: "DE1Pro", dose: 18, stopReason: "targetWeight", set: "s4" });
    expect(scrubbed.profile.steps.map((step) => step.name)).toEqual(["1", "2", "3", "4"]);
    const text = JSON.stringify(scrubbed);
    for (const leaked of ["fixture-", "mock-de1", "1337", "2026-", "Classic", "Decent", "notes", "title", "author", "id"]) expect(text).not.toContain(`"${leaked}`);
    expect(scrubbed.samples.seconds[0]).toBe(0);
  });

  it("is scored as the Shot it came from", () => {
    if (typeof scrubbed === "string") throw new Error(scrubbed);
    const from = scorecard([shotEntry("pulled", pulled("classic-italian"))]).shots[0]!;
    const corpus = scorecard([shotEntry("scrubbed", JSON.parse(JSON.stringify(scrubbed)))]).shots[0]!;
    expect(corpus).toMatchObject({ model: from.model, kind: from.kind, within: from.within, noFit: null });
    // Its puck is sought by running its steps, so the rounding of a scrubbed Shot's samples moves where the search lands a little.
    expect(Math.abs(corpus.errors!.duration - from.errors!.duration)).toBeLessThan(0.5);
    expect(Math.abs(corpus.errors!.peakPressure - from.errors!.peakPressure)).toBeLessThan(0.5);
    expect(Math.abs(Math.log(corpus.puck!.resistance / from.puck!.resistance))).toBeLessThan(Math.log(1.5));
    expect(corpusRecord(scrubbed).measurements.length).toBe(scrubbed.samples.seconds.length);
  });

  it("is refused for a field outside it, a named step, or text that is not Decaid's", () => {
    if (typeof scrubbed === "string") throw new Error(scrubbed);
    expect(corpusProblems({ ...scrubbed, id: "abc" })).toEqual(["shot.id is outside the scrubbed shape"]);
    expect(corpusProblems({ ...scrubbed, profile: { ...scrubbed.profile, title: "Classic" } })).toEqual(["profile.title is outside the scrubbed shape"]);
    const named = { ...scrubbed, profile: { ...scrubbed.profile, steps: scrubbed.profile.steps.map((step, n) => (n === 0 ? { ...step, name: "Fill" } : step)) } };
    expect(corpusProblems(named)).toEqual(["profile.steps[0].name must be its number, 1"]);
    expect(corpusProblems({ ...scrubbed, model: "Belmont" })[0]).toMatch(/^model must be one of/);
    expect(corpusProblems({ ...scrubbed, set: "monday" })).toEqual(["set must be s and a number"]);
    expect(corpusProblems({ ...scrubbed, samples: { ...scrubbed.samples, note: [] } })).toContain("samples.note is outside the scrubbed shape");
    const idle = { ...scrubbed, profile: { ...scrubbed.profile, steps: scrubbed.profile.steps.map((step, n) => (n === 0 ? { ...step, [step.pump === "pressure" ? "flow" : "pressure"]: "a note" } : step)) } };
    expect(corpusProblems(idle)).toEqual([`profile.steps[0].${scrubbed.profile.steps[0]!.pump === "pressure" ? "flow" : "pressure"} is outside the scrubbed shape for a ${scrubbed.profile.steps[0]!.pump} step`]);
  });

  it("is none for a record naming no Machine model, as Decaid's before v0.9.2", () => {
    const shot = pulled("default");
    const { workflow } = shot.shot.record as { workflow: Fields };
    expect(scrubShot({ ...shot, shot: { ...shot.shot, record: { ...shot.shot.record, workflow: { ...workflow, machine: { flowCalibration: 1 } } } } })).toBe("its record names no Machine model");
  });
});

describe("the scorecard", () => {
  it("scores Shots as the REST API gives them, by model and kind of Profile, those of Decaid's simulated machine that hold it within the margin", () => {
    const card = scorecard(["classic-italian", "blooming", "default", "gentle-and-sweet"].map((name) => shotEntry(name, pulled(name))));
    // The mock's blooming fill passes 4 bar sooner than a puck of the simulation's kind lets it (WITHIN_MARGIN in protocol/test/simulation.test.ts).
    expect(card.models.DE1!.all).toMatchObject({ shots: 4, fitted: 4, within: 3, share: 0.75 });
    expect(card.shots.filter((shot) => shot.within).map((shot) => shot.name)).toEqual(["classic-italian", "default", "gentle-and-sweet"]);
    expect(card.soaks).toMatchObject({ steps: 0, within: 0 });
    expect(card.models.Bengle).toBeUndefined();
    expect(card.shots.map((shot) => shot.kind)).toEqual(["pressure", "bloom", "declining", "low pressure"]);
    expect(formatScorecard(card)).toContain("DE1");
  });

  it("counts tea, manual control, a record naming no model, a pour that met no coffee and an unreadable profile toward no share", () => {
    const tea = pulled("default", { profileTitle: "Tea portafilter/Sencha" });
    const steered = pulled("classic-italian");
    steered.measurements = steered.measurements.map((measurement) => {
      const machine = (measurement as { machine: Fields }).machine;
      return (machine.profileFrame as number) >= 2 ? { ...(measurement as Fields), machine: { ...machine, targetPressure: 2.5 } } : measurement;
    });
    const unnamed = pulled("blooming");
    unnamed.shot.record = { ...unnamed.shot.record, workflow: { ...(unnamed.shot.record.workflow as Fields), machine: { provenanceStatus: "unavailable" } } };
    // Water through an empty portafilter: never 1.5 bar, nothing on the scale.
    const dry = pulled("default");
    dry.measurements = dry.measurements.map((measurement) => {
      const { machine, scale } = measurement as { machine: Fields; scale?: Fields };
      return { ...(measurement as Fields), machine: { ...machine, pressure: Math.min(1.4, Number(machine.pressure ?? 0)) }, ...(scale ? { scale: { ...scale, weight: Math.min(4.9, Number(scale.weight ?? 0)) } } : {}) };
    });
    const stepless = pulled("default");
    stepless.shot.record = { ...stepless.shot.record, workflow: { ...(stepless.shot.record.workflow as Fields), profile: { ...((stepless.shot.record.workflow as Fields).profile as Fields), steps: [] } } };
    const entries = [shotEntry("tea", tea), shotEntry("steered", steered), shotEntry("unnamed", unnamed), shotEntry("dry", dry), shotEntry("stepless", stepless), shotEntry("default", pulled("default"))];
    const card = scorecard(entries);
    expect(card.models.DE1!.all.shots).toBe(1);
    expect(card.tea.shots).toBe(1);
    expect(card.manual).toBe(1);
    expect(card.noModel).toBe(1);
    expect(card.noCoffee).toBe(1);
    expect(card.unreadable).toBe(1);
    expect(formatScorecard(card)).toContain("1 with a profile that can't be read, 1 naming no model, 1 that met no coffee");
    // With no scale reading, or no samples, a pour shows nothing of what it met.
    const unweighed = { ...dry, measurements: dry.measurements.map((measurement) => ({ ...(measurement as Fields), scale: undefined })) };
    expect(scoreShot(shotEntry("unweighed", unweighed)).noCoffee).toBe(false);
    expect(metNoCoffee([])).toBe(false);
    expect(card.shots.find((shot) => shot.name === "steered")!.noFit).toBe("manual control");
  });

  it("reads a Profile's kind from its steps and the step the Shot spent longest in", () => {
    const step = (pump: "pressure" | "flow", value: number, fields: Fields = {}) => ({ name: "", pump, [pump]: value, transition: "fast", exit: null, volume: 0, seconds: 30, weight: null, temperature: 93, sensor: "coffee", limiter: null, ...fields });
    const kind = (steps: Fields[]) => profileKind({ steps }, []);
    expect(kind([step("flow", 8, { seconds: 5 }), step("pressure", 9)])).toBe("pressure");
    expect(kind([step("flow", 8, { seconds: 5 }), step("pressure", 6)])).toBe("low pressure");
    expect(kind([step("pressure", 9, { seconds: 5 }), step("pressure", 6, { transition: "smooth" })])).toBe("declining");
    expect(kind([step("flow", 8, { seconds: 5 }), step("flow", 2.5)])).toBe("flow");
    expect(kind([step("flow", 8, { seconds: 5 }), step("flow", 6)])).toBe("fast flow");
    expect(kind([step("flow", 8, { seconds: 5 }), step("flow", 0, { seconds: 20 }), step("pressure", 9)])).toBe("bloom");
  });

  it("gives each set's figures apart, and a set's table of each Shot's puck against each other Shot", () => {
    // A designed session in small: one set, two Shots of one Profile and one each of two others.
    const entries = [
      shotEntry("a", { ...pulled("classic-italian"), set: "s2" }),
      shotEntry("b", { ...pulled("classic-italian"), set: "s2" }),
      shotEntry("c", { ...pulled("blooming"), set: "s2" }),
      shotEntry("d", { ...pulled("gentle-and-sweet"), set: "s2" }),
      shotEntry("alone", pulled("default")),
    ];
    const card = scorecard(entries);
    expect(card.sets.bySet).toEqual({ s2: { model: "DE1", shots: 4, same: expect.objectContaining({ pairs: 2 }), different: expect.objectContaining({ pairs: 10 }) } });
    expect(card.sets.same.pairs + card.sets.different.pairs).toBe(card.sets.pairs.length);
    // One recording twice: each one's puck on the other's steps runs as its own puck does on its own.
    const twin = card.sets.pairs.find((pair) => pair.from === "a" && pair.to === "b")!;
    const own = card.shots.find((shot) => shot.name === "b")!;
    expect(twin.same).toBe(true);
    expect(twin.errors.durationShare).toBeCloseTo(own.errors!.durationShare!, 3);
    expect(twin.errors.peakPressure).toBeCloseTo(own.errors!.peakPressure, 2);
    expect(card.sets.bySet.s2!.different.within).toBe(card.sets.pairs.filter((pair) => !pair.same && pair.within).length);
    expect(formatScorecard(card)).toMatch(/s2, 4 DE1 Shots: same steps 2 pairs, \d+ within, .*; different steps 10 pairs, \d+ within/);

    const table = formatSetPairs(card, "s2")!.split("\n");
    expect(table).toHaveLength(6);
    // A row for each Shot's puck, lettered by the steps it ran: the two Classic Italian Shots share one.
    expect(table.slice(2).map((row) => row.split(/\s{2,}/)[0])).toEqual(["1 A a", "2 A b", "3 B c", "4 C d"]);
    const cells = (row: string) => row.split(/\s{2,}/).slice(1);
    expect(cells(table[2]!)[0]).toBe("-");
    expect(cells(table[2]!)[1]).toBe(`${twin.errors.durationShare! >= 0 ? "+" : ""}${(twin.errors.durationShare! * 100).toFixed(1)}%${twin.within ? "*" : ""}`);
    // A pair within the margin is starred.
    const within = card.sets.pairs.find((pair) => pair.within)!;
    expect(cells(table[2 + ["a", "b", "c", "d"].indexOf(within.from)]!)[["a", "b", "c", "d"].indexOf(within.to)]).toMatch(/\*$/);
    expect(formatSetPairs(card, "s9")).toBeNull();
  });

  it("gives the median and the 90th percentile", () => {
    expect(spread([5, 1, 3, 2, 4, 6, 7, 8, 9, 10])).toEqual({ median: 5.5, worstTenth: 9 });
    expect(spread([])).toEqual({ median: null, worstTenth: null });
  });
});

describe("pulling and sets", () => {
  it("spreads each Machine's Shots of each profile evenly over time, fewer of tea", () => {
    const listed = Array.from({ length: 10 }, (_, n) => ({ id: `a${n}`, pulledAt: `2026-11-${String(n + 10)}T08:00:00Z`, profileTitle: "Adaptive", machine: { id: "m1" } }));
    const tea = Array.from({ length: 5 }, (_, n) => ({ id: `t${n}`, pulledAt: `2026-11-${String(n + 10)}T09:00:00Z`, profileTitle: "Tea portafilter/Sencha", machine: { id: "m1" } }));
    expect(spreadOut([...listed, ...tea], 3, 1).map((shot) => shot.id)).toEqual(["a0", "a5", "a9", "t0"]);
  });

  it("infers a set from one Machine's Shots of a coffee, grind, dose and Basket pulled within hours of each other", () => {
    const shot = (id: string, pulledAt: string, grinderSetting = "9") => {
      const { shot } = pulled("default");
      const record = shot.record as { workflow: Fields & { context: Fields } };
      return { shot: { ...shot, id, pulledAt, machineId: "m1", machine: { id: "m1", name: "Left" }, record: { ...record, workflow: { ...record.workflow, context: { ...record.workflow.context, coffeeRoaster: "R", coffeeName: "C", grinderSetting } } } } };
    };
    const files = [shot("a", "2026-11-09T08:00:00Z"), shot("b", "2026-11-09T09:00:00Z"), shot("c", "2026-11-09T20:00:00Z"), shot("d", "2026-11-09T09:30:00Z", "10")];
    expect(inferSets(files)).toEqual([["a", "b"]]);
    expect(inferSets(files, ["Right"])).toEqual([["a", "b"]]);
    expect(inferSets(files, ["Left"])).toEqual([]);
    // Two Pending Machines' Shots are of two Machines; a Shot naming neither joins no set.
    const pending = (file: (typeof files)[number], id: string | null) => ({ shot: { ...file.shot, machineId: null, pendingMachine: id ? { id, model: "DE1", serial: "57890" } : null } });
    expect(inferSets([pending(files[0]!, "p1"), pending(files[1]!, "p2")])).toEqual([]);
    expect(inferSets([pending(files[0]!, "p1"), pending(files[1]!, "p1")])).toEqual([["a", "b"]]);
    expect(inferSets([pending(files[0]!, null), pending(files[1]!, null)])).toEqual([]);
  });
});
