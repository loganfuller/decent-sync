import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type Profile,
  type ProfileStep,
  type SimulatedRun,
  MACHINE_MODELS,
  MODEL_FIGURES,
  PUMP_MAX_FLOW,
  SIMULATION_TICK,
  eased,
  fitToShot,
  machineModelOf,
  profileOf,
  shotPuck,
  shotSamples,
  shotStopAt,
  simulateProfile,
  standardPuck,
  stepSeconds,
  stepSpans,
  timeToFirstDrip,
} from "../src/index.js";

// The simulation of a profile on a puck (#577): driven through what the
// management interface and the server call, and judged by the run it returns.

type StepFor<P extends ProfileStep["pump"]> = Partial<Omit<Extract<ProfileStep, { pump: P }>, "pump">>;

const base = { transition: "fast", exit: null, volume: 0, seconds: 30, weight: null, temperature: 93, sensor: "coffee", limiter: null } as const;

function flow(name: string, target: number, fields: StepFor<"flow"> = {}): ProfileStep {
  return { ...base, name, pump: "flow", flow: target, ...fields };
}

function pressure(name: string, target: number, fields: StepFor<"pressure"> = {}): ProfileStep {
  return { ...base, name, pump: "pressure", pressure: target, ...fields };
}

function profile(steps: ProfileStep[], fields: Partial<Profile> = {}): Profile {
  return {
    version: "2",
    title: "Test",
    notes: "",
    author: "",
    beverage_type: "espresso",
    steps,
    target_volume: null,
    target_weight: null,
    target_volume_count_start: 0,
    tank_temperature: 0,
    ...fields,
  };
}

function run(steps: ProfileStep[], options: { grind?: number; stopAt?: number | null; model?: "DE1" | "Bengle"; dose?: number } = {}): SimulatedRun {
  return simulateProfile({ profile: profile(steps), puck: standardPuck(options.grind ?? 0), stopAt: options.stopAt ?? null, model: options.model ?? "DE1", dose: options.dose ?? null });
}

/** The samples a run took during one of its steps, by index. */
function during(result: SimulatedRun, index: number) {
  return result.samples.filter((sample) => sample.step?.frame === index && sample.seconds > result.steps[index]!.start!);
}

describe("a run", () => {
  const classic = [flow("Fill", 6, { seconds: 8, exit: { type: "pressure", condition: "over", value: 3 } }), pressure("Extract", 9, { seconds: 40, temperature: 92 })];
  const result = run(classic, { stopAt: 36 });

  it("holds pressure, flow and the weight in the cup over time, one sample each tick from 0 s", () => {
    expect(result.samples[0]).toMatchObject({ seconds: 0, values: { pressure: 0, flow: 0, weight: 0 } });
    result.samples.forEach((sample, n) => {
      expect(sample.seconds).toBeCloseTo(n * SIMULATION_TICK, 6);
      expect(sample.shade).toBeNull();
      expect(sample.values.temperature).toBeNull();
    });
    expect(result.samples[result.samples.length - 1]!.seconds).toBe(result.duration);
    const weights = result.samples.map((sample) => sample.values.weight!);
    expect(weights.every((weight, n) => n === 0 || weight >= weights[n - 1]!)).toBe(true);
    expect(result.weight).toBe(weights[weights.length - 1]);
  });

  it("holds the plan's targets: the pressure or flow each step asks for, and its temperature", () => {
    for (const sample of during(result, 0)) expect(sample.targets).toMatchObject({ flow: 6, pressure: null, temperature: 93 });
    for (const sample of during(result, 1)) expect(sample.targets).toMatchObject({ pressure: 9, flow: null, temperature: 92 });
  });

  it("holds each step's start, end and reason for ending, and the stop and its reason", () => {
    const [fill, extract] = result.steps;
    expect(fill).toMatchObject({ index: 0, name: "Fill", start: 0, reason: "exit" });
    expect(extract).toMatchObject({ index: 1, name: "Extract", start: fill!.end, end: result.duration, reason: "stop" });
    expect(result.stop).toEqual({ seconds: result.duration, reason: "weight" });
    expect(result.weight).toBeGreaterThanOrEqual(36);
    // The samples name the steps as a Shot's do, each from the moment it begins, so a Shot's helpers read a run.
    expect(stepSpans(result.samples).map(({ frame, from, until }) => [frame, from, until])).toEqual(result.steps.map((step) => [step.index, step.start, step.end]));
  });

  it("names a step of one tick in its samples, as its own span", () => {
    const short = run([flow("A", 4, { seconds: 0.1 }), flow("B", 2, { seconds: 0.1 }), flow("C", 3, { seconds: 1 })]);
    expect(short.steps.map((step) => [step.start, step.end])).toEqual([
      [0, 0.1],
      [0.1, 0.2],
      [0.2, 1.2],
    ]);
    expect(stepSpans(short.samples).map(({ frame, from, until }) => [frame, from, until])).toEqual(short.steps.map((step) => [step.index, step.start, step.end]));
  });

  it("holds the time to first drip and the peaks", () => {
    expect(result.timeToFirstDrip).toBe(timeToFirstDrip(result.samples));
    expect(result.timeToFirstDrip).toBeGreaterThan(fill(result));
    expect(result.peakPressure).toBe(Math.max(...result.samples.map((sample) => sample.values.pressure!)));
    expect(result.peakFlow).toBe(Math.max(...result.samples.map((sample) => sample.values.flow!)));
    expect(result.peakPressure).toBeGreaterThan(8);
    expect(result.peakPressure).toBeLessThanOrEqual(MODEL_FIGURES.DE1.maxPressure);
  });

  it("of a profile with no steps runs for none", () => {
    const empty = run([]);
    expect(empty.stop).toEqual({ seconds: 0, reason: "lastStep" });
    expect(empty.samples).toHaveLength(1);
    expect(empty.steps).toEqual([]);
  });
});

function fill(result: SimulatedRun): number {
  return result.steps[0]!.end!;
}

describe("a step ends at its time, its exit, its water pumped or its weight, whichever comes first", () => {
  const after = flow("After", 2, { seconds: 5 });

  it("at its time", () => {
    const result = run([flow("Timed", 2, { seconds: 3 }), after]);
    expect(result.steps[0]).toMatchObject({ end: 3, reason: "time" });
  });

  it("at its exit, read from what the machine measures", () => {
    const result = run([flow("Exits", 4, { seconds: 20, exit: { type: "pressure", condition: "over", value: 2 } }), after]);
    const step = result.steps[0]!;
    expect(step.reason).toBe("exit");
    expect(step.end).toBeLessThan(20);
    const at = result.samples.find((sample) => sample.seconds === step.end)!;
    expect(at.values.pressure).toBeGreaterThanOrEqual(2);
    expect(result.samples.filter((sample) => sample.seconds < step.end!).every((sample) => sample.values.pressure! < 2)).toBe(true);
  });

  it("at an exit under a value, on flow", () => {
    const result = run([pressure("Holds", 9, { seconds: 30, exit: { type: "flow", condition: "under", value: 2.5 } }), after]);
    const step = result.steps[0]!;
    expect(step.reason).toBe("exit");
    expect(result.samples.find((sample) => sample.seconds === step.end)!.values.flow).toBeLessThanOrEqual(2.5);
  });

  it("at its water pumped", () => {
    const result = run([flow("Pumps", 4, { seconds: 20, volume: 10 }), after]);
    const step = result.steps[0]!;
    expect(step.reason).toBe("water");
    const pumped = result.samples.filter((sample) => sample.seconds > 0 && sample.seconds <= step.end!).reduce((sum, sample) => sum + sample.values.flow! * SIMULATION_TICK, 0);
    expect(pumped).toBeGreaterThanOrEqual(10);
    expect(pumped).toBeLessThan(10 + 4 * SIMULATION_TICK + 1e-9);
  });

  it("at its weight", () => {
    const result = run([flow("Weighs", 4, { seconds: 60, weight: 5 }), after]);
    const step = result.steps[0]!;
    expect(step.reason).toBe("weight");
    expect(result.samples.find((sample) => sample.seconds === step.end)!.values.weight).toBeGreaterThanOrEqual(5);
  });

  it("whichever comes first", () => {
    const exitFirst = run([flow("Both", 4, { seconds: 30, volume: 100, exit: { type: "pressure", condition: "over", value: 2 } }), after]);
    expect(exitFirst.steps[0]!.reason).toBe("exit");
    const timeFirst = run([flow("Both", 4, { seconds: 1, volume: 100, exit: { type: "pressure", condition: "over", value: 2 } }), after]);
    expect(timeFirst.steps[0]).toMatchObject({ end: 1, reason: "time" });
  });

  it("and the Shot ends at the stop-at weight, the step it was in ending with it", () => {
    const result = run([flow("Pours", 4, { seconds: 60 }), after], { stopAt: 20 });
    expect(result.stop.reason).toBe("weight");
    expect(result.steps[0]).toMatchObject({ end: result.stop.seconds, reason: "stop" });
    expect(result.steps[1]).toMatchObject({ start: null, end: null, reason: null });
    expect(result.weight).toBeGreaterThanOrEqual(20);
    expect(result.weight).toBeLessThan(20 + 4 * SIMULATION_TICK + 0.5);
  });

  it("or with its last step, where the weight is never reached or none is given", () => {
    const short = run([flow("Short", 4, { seconds: 4 }), flow("Shorter", 2, { seconds: 3 })], { stopAt: 200 });
    expect(short.stop).toEqual({ seconds: 7, reason: "lastStep" });
    expect(short.steps.map((step) => step.reason)).toEqual(["time", "time"]);
    const none = run([flow("Short", 4, { seconds: 4 }), flow("Shorter", 2, { seconds: 3 })], { stopAt: null });
    expect(none.stop).toEqual({ seconds: 7, reason: "lastStep" });
    expect(none.stopAt).toBeNull();
  });
});

describe("a step of no length", () => {
  it("is passed through at once, exit or not", () => {
    for (const exit of [null, { type: "pressure", condition: "under", value: 0.01 } as const, { type: "flow", condition: "over", value: 0.01 } as const]) {
      for (const seconds of [0, 0.04]) {
        const result = run([flow("Fill", 4, { seconds: 6 }), flow("Nothing", 1.5, { seconds, exit }), pressure("Extract", 6, { seconds: 10 })]);
        const [fillStep, nothing, extract] = result.steps;
        expect(nothing).toMatchObject({ start: fillStep!.end, end: fillStep!.end, reason: "time" });
        expect(extract!.start).toBe(fillStep!.end);
        expect(result.samples.some((sample) => sample.step?.frame === 1)).toBe(false);
      }
    }
  });

  it("as the first step, leaves the run's first sample to the step it begins with", () => {
    const result = run([pressure("Nothing", 9, { seconds: 0 }), flow("Fill", 4, { seconds: 6 })]);
    expect(result.steps.map((step) => step.start)).toEqual([0, 0]);
    expect(result.samples[0]!.step).toEqual({ frame: 1, name: "Fill" });
    expect(result.samples[0]!.targets).toMatchObject({ pressure: null, flow: 4 });
    expect(result.samples.some((sample) => sample.step?.frame === 0)).toBe(false);
    const nothing = run([pressure("Nothing", 9, { seconds: 0 })]);
    expect(nothing.samples).toHaveLength(1);
    expect(nothing.samples[0]!.step).toBeNull();
  });

  it("a step of 0.05 s or more runs a tick", () => {
    const result = run([flow("Fill", 4, { seconds: 6 }), flow("Tick", 1.5, { seconds: 0.05 }), pressure("Extract", 6, { seconds: 10 })]);
    expect(result.steps[1]!.end! - result.steps[1]!.start!).toBeCloseTo(SIMULATION_TICK, 6);
  });
});

describe("a step's time", () => {
  it("is what Decaid sends the machine: tenths of a second below 12.75 s, whole seconds from there", () => {
    const cases: Array<[number, number]> = [
      [0, 0],
      [0.04, 0],
      [0.05, 0.1],
      [0.11, 0.1],
      [0.15, 0.2],
      [12.7, 12.7],
      [12.74, 12.7],
      [12.75, 13],
      [20.4, 20],
      [20.5, 21],
      [126.6, 127],
      [500, 127],
    ];
    for (const [seconds, runs] of cases) expect([seconds, stepSeconds(flow("Step", 2, { seconds }))]).toEqual([seconds, runs]);
    const result = run([flow("Fill", 2, { seconds: 20.4 }), flow("Rest", 0, { seconds: 1 })]);
    expect(result.steps[0]).toMatchObject({ end: 20, reason: "time" });
    expect(run([flow("Tick", 2, { seconds: 0.11 })]).steps[0]).toMatchObject({ end: 0.1, reason: "time" });
  });
});

describe("a step longer than the machine runs one", () => {
  it("runs 127 s, as the machine's wire format holds no more", () => {
    const result = run([flow("Endless", 0.2, { seconds: 12_700 })]);
    expect(result.steps[0]).toMatchObject({ start: 0, end: 127, reason: "time" });
    expect(result.duration).toBe(127);
    expect(result.samples).toHaveLength(1271);
    expect(result.peakFlow).toBeCloseTo(Math.max(...result.samples.map((sample) => sample.values.flow!)), 9);
    expect(result.peakPressure).toBeCloseTo(Math.max(...result.samples.map((sample) => sample.values.pressure!)), 9);
  });
});

describe("a step that gets to its target over the whole step", () => {
  it("ramps from the simulated value as it begins, not from the target of the step before", () => {
    // The fill asks for 8 ml/s but a limit of 1 bar holds the flow far below it.
    const result = run([flow("Held", 8, { seconds: 8, limiter: { value: 1, range: 0 } }), flow("Ramp", 1, { seconds: 10, transition: "smooth" })]);
    const start = result.steps[1]!.start!;
    const measured = result.samples.find((sample) => sample.seconds === start)!.values.flow!;
    expect(measured).toBeLessThan(6);
    const first = during(result, 1)[0]!;
    expect(first.targets.flow).toBeCloseTo(measured + (1 - measured) * (SIMULATION_TICK / 10), 6);
    const targets = during(result, 1).map((sample) => sample.targets.flow!);
    expect(targets.every((target, n) => n === 0 || target <= targets[n - 1]!)).toBe(true);
    expect(targets[targets.length - 1]).toBeCloseTo(1, 6);
  });

  it("a pressure ramp starts from the pressure measured, after a step that controlled flow", () => {
    const result = run([flow("Fill", 3, { seconds: 10 }), pressure("Rise", 9, { seconds: 6, transition: "smooth" })]);
    const start = result.steps[1]!.start!;
    const measured = result.samples.find((sample) => sample.seconds === start)!.values.pressure!;
    expect(measured).toBeGreaterThan(0.5);
    expect(during(result, 1)[0]!.targets.pressure).toBeCloseTo(measured + (9 - measured) * (SIMULATION_TICK / 6), 6);
  });

  it("a step that gets there at once asks for its target from its first tick", () => {
    const result = run([flow("Fill", 3, { seconds: 10 }), pressure("Jump", 9, { seconds: 6 })]);
    expect(during(result, 1).every((sample) => sample.targets.pressure === 9)).toBe(true);
  });
});

describe("a limit", () => {
  const fill = (limiter: { value: number; range: number } | null) => run([pressure("Fill", 9, { seconds: 8, limiter })]);

  it("caps the flow of a step whose pump controls pressure, easing over its range", () => {
    const free = fill(null);
    expect(free.peakFlow).toBeCloseTo(MODEL_FIGURES.DE1.pressureStepMaxFlow, 1);
    const hard = fill({ value: 2, range: 0 });
    expect(hard.peakFlow).toBeLessThanOrEqual(2 + 1e-9);
    expect(hard.peakFlow).toBeGreaterThan(1.9);
    const soft = fill({ value: 2, range: 1 });
    expect(soft.peakFlow).toBeGreaterThan(2.2);
    expect(soft.peakFlow).toBeLessThan(3);
  });

  it("caps the pressure of a step whose pump controls flow, easing over its range", () => {
    const steps = (limiter: { value: number; range: number } | null) => run([flow("Push", 6, { seconds: 25, limiter })], { grind: -0.5 });
    expect(steps(null).peakPressure).toBeGreaterThan(8);
    const hard = steps({ value: 3, range: 0 });
    expect(hard.peakPressure).toBeLessThan(3.2);
    expect(hard.peakPressure).toBeGreaterThan(2.8);
    const soft = steps({ value: 3, range: 1 });
    expect(soft.peakPressure).toBeGreaterThan(3.3);
    expect(soft.peakPressure).toBeLessThan(4.2);
    // With the pressure held, the flow falls as the puck's resistance rises.
    const flows = during(hard, 0).map((sample) => sample.values.flow!);
    expect(Math.min(...flows.slice(flows.length - 20))).toBeLessThan(5);
  });

  it("of 0 is none, and eases as Decaid's simulated machine eases it", () => {
    expect(eased(5, { value: 0, range: 1 })).toBe(5);
    expect(eased(1.5, { value: 2, range: 1 })).toBe(1.5);
    expect(eased(5, { value: 2, range: 0 })).toBe(2);
    expect(eased(3, { value: 2, range: 1 })).toBeCloseTo(2.5, 9);
    expect(eased(1000, { value: 2, range: 1 })).toBeLessThan(3);
  });
});

describe("the standard puck", () => {
  it("takes one value from finer to coarser, its resistance falling as it goes coarser, and held to -1 and 1", () => {
    const at = (grind: number) => Math.max(...standardPuck(grind).resistance.map(([, resistance]) => resistance));
    expect(at(-1)).toBeGreaterThan(at(-0.5));
    expect(at(-0.5)).toBeGreaterThan(at(0));
    expect(at(0)).toBeGreaterThan(at(0.5));
    expect(at(0.5)).toBeGreaterThan(at(1));
    expect(at(-1) / at(0)).toBeCloseTo(4, 6);
    expect(standardPuck(3)).toEqual(standardPuck(1));
    expect(standardPuck(-3)).toEqual(standardPuck(-1));
  });

  it("moved changes which exits fire, on a profile built to show it", () => {
    // A preinfusion that moves on once pressure builds, and an extraction that moves on once the flow slows.
    const shows = [
      flow("Preinfuse", 3, { seconds: 15, exit: { type: "pressure", condition: "over", value: 4 } }),
      pressure("Extract", 9, { seconds: 20, exit: { type: "flow", condition: "under", value: 1.5 } }),
      flow("Finish", 2, { seconds: 10 }),
    ];
    const finer = run(shows, { grind: -1 });
    const middle = run(shows, { grind: 0 });
    const coarser = run(shows, { grind: 1 });
    expect(finer.steps.map((step) => step.reason)).toEqual(["exit", "exit", "time"]);
    expect(coarser.steps.map((step) => step.reason)).toEqual(["time", "time", "time"]);
    expect(middle.steps.map((step) => step.reason)).not.toEqual(finer.steps.map((step) => step.reason));
    expect(coarser.weight).toBeGreaterThan(finer.weight);
  });

  it("runs slower with a larger dose, which soaks up more and resists more", () => {
    const steps = [pressure("Extract", 9, { seconds: 60 })];
    const small = run(steps, { stopAt: 36, dose: 15 });
    const large = run(steps, { stopAt: 36, dose: 21 });
    expect(large.timeToFirstDrip!).toBeGreaterThan(small.timeToFirstDrip!);
    expect(large.duration).toBeGreaterThan(small.duration);
    expect(large.dose).toBe(21);
  });
});

describe("a machine of a model", () => {
  it("keeps each model's figures in one place, a DE1's pump giving about 8 ml/s and a 250 V/15 A Bengle about 15", () => {
    expect(MACHINE_MODELS).toEqual(["DE1", "Bengle"]);
    expect(MODEL_FIGURES.DE1.maxFlow).toBe(8);
    expect(MODEL_FIGURES.Bengle.maxFlow).toBe(15);
    expect(PUMP_MAX_FLOW).toBe(MODEL_FIGURES.DE1.maxFlow);
  });

  it("runs a step that asks for more flow than a DE1 gives, a Bengle keeping up", () => {
    const steps = [flow("Fast", 12, { seconds: 4 })];
    const de1 = run(steps, { model: "DE1" });
    const bengle = run(steps, { model: "Bengle" });
    expect(de1.model).toBe("DE1");
    expect(de1.peakFlow).toBeLessThanOrEqual(MODEL_FIGURES.DE1.maxFlow);
    expect(de1.peakFlow).toBeGreaterThan(7.9);
    expect(bengle.peakFlow).toBeGreaterThan(11.9);
    expect(bengle.water).toBeGreaterThan(de1.water);
  });

  it("is a DE1 where none is given", () => {
    expect(simulateProfile({ profile: profile([flow("Fill", 4, { seconds: 2 })]), puck: standardPuck(), stopAt: null }).model).toBe("DE1");
  });

  it("is read from Decaid's name for a Machine's hardware", () => {
    expect(machineModelOf("Bengle")).toBe("Bengle");
    expect(machineModelOf("bengle")).toBe("Bengle");
    expect(machineModelOf("DE1Pro")).toBe("DE1");
    expect(machineModelOf("DE1XXL")).toBe("DE1");
    expect(machineModelOf(null)).toBe("DE1");
  });
});

// Shots Decaid v0.9.2's simulated machine recorded (server/test/fixtures/decaid/simulated-shots-v0.9.2/README.md).
const SHOT_FIXTURES = ["classic-italian", "blooming", "default", "gentle-and-sweet"];

/**
 * How close a Shot's own steps on its own puck land to the Shot: its
 * duration, time to first drip and each step's end within 5% of the Shot's
 * duration or 1 s, whichever is more, and its peak pressure within 0.5 bar.
 */
const MARGIN_SHARE = 0.05;
const MARGIN_SECONDS = 1;
const MARGIN_BAR = 0.5;

describe("a Shot's puck", () => {
  for (const name of SHOT_FIXTURES) {
    it(`is worked out from its samples, its own steps on it landing near it: ${name}`, () => {
      const record = JSON.parse(fs.readFileSync(new URL(`../../server/test/fixtures/decaid/simulated-shots-v0.9.2/${name}.json`, import.meta.url), "utf8")) as {
        workflow: { profile: unknown; context: { targetDoseWeight: number } };
        measurements: unknown;
        stopReason: string;
      };
      const shotProfile = profileOf(record.workflow.profile)!;
      const samples = shotSamples(record.measurements, shotProfile);
      const puck = shotPuck(samples, record.workflow.context.targetDoseWeight)!;
      expect(puck.dose).toBe(18);
      expect(puck.resistance.length).toBeGreaterThan(10);
      const { run: fitted, fit } = fitToShot({ samples, profile: shotProfile, puck, stopAt: shotStopAt(samples, record.stopReason) });
      const margin = Math.max(MARGIN_SECONDS, MARGIN_SHARE * fit.shot.duration);
      expect(fitted.stop.reason).toBe("weight");
      expect(Math.abs(fit.simulated.duration - fit.shot.duration)).toBeLessThanOrEqual(margin);
      expect(Math.abs(fit.simulated.timeToFirstDrip! - fit.shot.timeToFirstDrip!)).toBeLessThanOrEqual(margin);
      expect(Math.abs(fit.simulated.peakPressure - fit.shot.peakPressure)).toBeLessThanOrEqual(MARGIN_BAR);
      expect(fit.simulated.steps.map((step) => step.index)).toEqual(fit.shot.steps.map((step) => step.index));
      fit.shot.steps.forEach((step, n) => expect(Math.abs(fit.simulated.steps[n]!.end - step.end)).toBeLessThanOrEqual(margin));
    });
  }

  it("of a Shot with no scale holds what the standard puck holds", () => {
    const record = JSON.parse(fs.readFileSync(new URL("../../server/test/fixtures/decaid/simulated-shots-v0.9.2/default.json", import.meta.url), "utf8")) as { workflow: { profile: unknown }; measurements: Array<Record<string, unknown>> };
    const unweighed = record.measurements.map(({ scale: _, ...rest }) => rest);
    const samples = shotSamples(unweighed, profileOf(record.workflow.profile));
    expect(shotPuck(samples, 18)).toMatchObject({ holds: standardPuck().holds, yieldPerMl: 1 });
    expect(shotStopAt(samples, "targetWeight")).toBeNull();
  });

  it("is none where no sample shows its resistance: no flow recorded, or the pump never running against pressure", () => {
    const record = JSON.parse(fs.readFileSync(new URL("../../server/test/fixtures/decaid/simulated-shots-v0.9.2/default.json", import.meta.url), "utf8")) as { workflow: { profile: unknown }; measurements: Array<{ machine: Record<string, unknown> }> };
    const shotProfile = profileOf(record.workflow.profile);
    const without = (field: string) => shotSamples(record.measurements.map((measurement) => ({ ...measurement, machine: { ...measurement.machine, [field]: undefined } })), shotProfile);
    expect(shotPuck(shotSamples(record.measurements, shotProfile), 18)).not.toBeNull();
    expect(shotPuck(without("flow"), 18)).toBeNull();
    expect(shotPuck(without("pressure"), 18)).toBeNull();
    expect(shotPuck([], 18)).toBeNull();
  });

  it("stops a run as the Shot stopped: at its last weight, or with its steps where its machine ended it", () => {
    const record = JSON.parse(fs.readFileSync(new URL("../../server/test/fixtures/decaid/simulated-shots-v0.9.2/default.json", import.meta.url), "utf8")) as { workflow: { profile: unknown }; measurements: unknown };
    const samples = shotSamples(record.measurements, profileOf(record.workflow.profile));
    const last = samples.filter((sample) => sample.values.weight !== null).pop()!.values.weight;
    expect(shotStopAt(samples, "targetWeight")).toBe(last);
    expect(shotStopAt(samples, "appStop")).toBe(last);
    expect(shotStopAt(samples, "machineEnded")).toBeNull();
  });
});
