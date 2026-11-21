import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROFILE_KINDS, corpusRecord, formatScorecard, metNoCoffee, profileKind, readShots, scoreShot, scorecard, shotEntry, spread } from "../simulation/scorecard.mjs";
import { corpusProblems, inferSets, scrubShot } from "../simulation/scrub.mjs";
import { spreadOut } from "../simulation/pull.mjs";

// The simulation's scorecard and the corpus of real Shots it runs on (#599).
// The corpus test holds the simulation at the share of corpus Shots within
// the margin recorded in corpus/levels.json; the rest check the scripts on
// Shots Decaid v0.9.2's simulated machine recorded.

type Fields = Record<string, unknown>;

const CORPUS = new URL("../simulation/corpus/", import.meta.url).pathname;
const SHOTS = path.join(CORPUS, "shots");
const LEVELS = JSON.parse(fs.readFileSync(path.join(CORPUS, "levels.json"), "utf8")) as Record<"DE1" | "Bengle", { within: number; of: number }>;
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

  it("holds each file in the scrubbed shape and nothing else", () => {
    for (const file of fs.readdirSync(SHOTS)) {
      expect(file).toMatch(/^[a-z0-9]+-\d{3}\.json$/);
      expect(corpusProblems(JSON.parse(fs.readFileSync(path.join(SHOTS, file), "utf8"))), file).toEqual([]);
    }
  });

  it("covers each kind of Profile for each model, with a few tea Shots and sets, in no more than about 150 Shots", () => {
    expect(card.shots.length).toBeLessThanOrEqual(160);
    for (const model of ["DE1", "Bengle"] as const) expect(Object.keys(card.models[model]!.kinds).sort()).toEqual([...PROFILE_KINDS].sort());
    expect(card.tea.shots).toBeGreaterThanOrEqual(2);
    expect(card.sets.same.pairs).toBeGreaterThan(0);
    expect(card.sets.different.pairs).toBeGreaterThan(0);
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
    expect(corpus).toMatchObject({ model: from.model, kind: from.kind, within: true, noFit: null });
    expect(corpus.errors!.duration).toBeCloseTo(from.errors!.duration, 1);
    expect(corpus.errors!.peakPressure).toBeCloseTo(from.errors!.peakPressure, 2);
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
  it("scores Shots as the REST API gives them, by model and kind of Profile, each within the margin", () => {
    const card = scorecard(["classic-italian", "blooming", "default", "gentle-and-sweet"].map((name) => shotEntry(name, pulled(name))));
    expect(card.models.DE1!.all).toMatchObject({ shots: 4, fitted: 4, within: 4, share: 1 });
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
