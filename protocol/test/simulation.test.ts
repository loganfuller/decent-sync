import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type Profile,
  type ProfileStep,
  type SimulatedRun,
  MACHINE_MODELS,
  MODEL_FIGURES,
  SIMULATION_TICK,
  eased,
  fitToShot,
  limited,
  machineModelOf,
  profileOf,
  shotPuck,
  shotSamples,
  shotFigures,
  shotFitStop,
  simulateOnShot,
  simulateProfile,
  simulationShotOf,
  sentStep,
  standardPuck,
  stepSeconds,
  stepSpans,
  timeToFirstDrip,
  underManualControl,
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
    expect(result.weight + result.weightFlowAtStop).toBeGreaterThanOrEqual(36);
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

  it("at its weight, judged a second ahead at its rate, as Decaid judges it, four tenths of a second after the cup holds that", () => {
    const result = run([flow("Weighs", 4, { seconds: 60, weight: 5 }), after]);
    const step = result.steps[0]!;
    expect(step.reason).toBe("weight");
    const ahead = (seconds: number) => {
      const at = result.samples.find((sample) => Math.abs(sample.seconds - seconds) < 1e-9)!.values;
      return at.weight! + at.weightFlow! * 1;
    };
    // The scale's reading, the rate Decaid works out from it and its skip take that long to end the step.
    expect(ahead(step.end! - 0.4)).toBeGreaterThanOrEqual(5);
    expect(ahead(step.end! - 0.5)).toBeLessThan(5);
    expect(result.samples.find((sample) => sample.seconds === step.end)!.values.weight!).toBeLessThan(5);
  });

  it("whichever comes first", () => {
    const exitFirst = run([flow("Both", 4, { seconds: 30, volume: 100, exit: { type: "pressure", condition: "over", value: 2 } }), after]);
    expect(exitFirst.steps[0]!.reason).toBe("exit");
    const timeFirst = run([flow("Both", 4, { seconds: 1, volume: 100, exit: { type: "pressure", condition: "over", value: 2 } }), after]);
    expect(timeFirst.steps[0]).toMatchObject({ end: 1, reason: "time" });
  });

  it("on one tick, by exit before time, and by the Shot's stop before the step's weight", () => {
    const both = run([flow("Tick", 4, { seconds: 0.1, exit: { type: "flow", condition: "over", value: 0.5 } }), after]);
    expect(both.steps[0]).toMatchObject({ end: 0.1, reason: "exit" });
    // A step's weight, judged ahead, that the cup first holds on the tick the stop-at weight is reached.
    const pours = run([flow("Pours", 4, { seconds: 60 }), after], { stopAt: 20 });
    const ahead = (sample: (typeof pours.samples)[number]) => sample.values.weight! + sample.values.weightFlow! * 1;
    const [before, at] = pours.samples.slice(-2) as [(typeof pours.samples)[number], (typeof pours.samples)[number]];
    const weighed = run([flow("Weighs", 4, { seconds: 60, weight: (ahead(before) + ahead(at)) / 2 }), after], { stopAt: 20 });
    expect(weighed.stop).toEqual(pours.stop);
    expect(weighed.steps[0]!.reason).toBe("stop");
  });

  it("and the Shot ends at the stop-at weight, judged a second ahead as Decaid stops one, the step it was in ending with it", () => {
    const result = run([flow("Pours", 4, { seconds: 60 }), after], { stopAt: 20 });
    expect(result.stop.reason).toBe("weight");
    expect(result.steps[0]).toMatchObject({ end: result.stop.seconds, reason: "stop" });
    expect(result.steps[1]).toMatchObject({ start: null, end: null, reason: null });
    const [before, at] = result.samples.slice(-2) as [(typeof result.samples)[number], (typeof result.samples)[number]];
    expect(before.values.weight! + before.values.weightFlow!).toBeLessThan(20);
    expect(at.values.weight! + at.values.weightFlow!).toBeGreaterThanOrEqual(20);
    expect(result.weight).toBeLessThan(20);
    // Judged as reached, as a fit stops at the weight a Shot reached.
    const reached = simulateProfile({ profile: profile([flow("Pours", 4, { seconds: 60 }), after]), puck: standardPuck(), stopAt: 20, stopOn: "reached" });
    expect(reached.weight).toBeGreaterThanOrEqual(20);
    expect(reached.weight).toBeLessThan(20 + 4 * SIMULATION_TICK + 0.5);
    expect(reached.duration).toBeGreaterThan(result.duration);
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

describe("a step's water", () => {
  it("is what Decaid sends the machine: whole ml, cut down", () => {
    const ending = (volume: number) => run([flow("Fill", 1, { seconds: 20, volume }), flow("Rest", 0, { seconds: 1 })]).steps[0]!;
    expect(ending(1.9)).toMatchObject({ reason: "water", end: ending(1).end });
    expect(ending(0.9)).toMatchObject({ reason: "time", end: 20 });
    // Ten bits: past 1023 it wraps, as Decaid writes it.
    expect([1023, 1024, 1025].map((volume) => sentStep(flow("Fill", 1, { volume })).volume)).toEqual([1023, 0, 1]);
  });
});

describe("a step's target, exit and limiter", () => {
  it("are what Decaid sends the model: sixteenths to a DE1, tenths to a Bengle", () => {
    const step = flow("Fill", 4.03, { exit: { type: "pressure", condition: "over", value: 3.02 }, limiter: { value: 1.47, range: 0.62 } });
    expect(sentStep(step, "DE1")).toMatchObject({ flow: 4, exit: { value: 3 }, limiter: { value: 1.5, range: 0.625 } });
    expect(sentStep(step, "Bengle")).toMatchObject({ flow: 4, exit: { value: 3 }, limiter: { value: 1.5, range: 0.6 } });
    expect(sentStep(pressure("Hold", 8.6), "DE1")).toMatchObject({ pressure: 8.625 });
    // Temperature goes in half degrees to either.
    for (const model of MACHINE_MODELS) expect(sentStep(flow("Fill", 4, { temperature: 92.3 }), model).temperature).toBe(92.5);
  });

  it("run as sent: a flow too small for a DE1's byte pumps nothing", () => {
    const result = run([flow("Trickle", 0.02, { seconds: 100, volume: 1 })]);
    expect(result.steps[0]).toMatchObject({ end: 100, reason: "time" });
    expect(result.water).toBe(0);
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
    expect(free.peakFlow).toBeCloseTo(MODEL_FIGURES.DE1.pressureStepFlow[0][1], 1);
    const hard = fill({ value: 2, range: 0 });
    expect(hard.peakFlow).toBeLessThanOrEqual(2 + 1e-9);
    expect(hard.peakFlow).toBeGreaterThan(1.9);
    const soft = fill({ value: 2, range: 1 });
    expect(soft.peakFlow).toBeGreaterThan(2.2);
    expect(soft.peakFlow).toBeLessThan(3);
  });

  it("on a DE1's flow lets through what recorded Shots show: pushed hard, its reach of the range over the limit, and short of that, more than Decaid's easing", () => {
    // Filling toward 9 bar, the pump would give far more than a limit of 1.5 ml/s with a range of 2.5.
    const reach = MODEL_FIGURES.DE1.flowLimiterReach;
    const wide = { value: 1.5, range: 2.5 };
    expect(fill(wide).peakFlow).toBeCloseTo(1.5 + reach * 2.5, 2);
    // Where the pump would give 3.4 ml/s, recorded Shots settle near 3: the easing gives 2.6.
    expect(limited(3.4, wide, reach)).toBeGreaterThan(eased(3.4, wide) + 0.25);
    expect(limited(3.4, wide, reach)).toBeLessThan(3.1);
    // A Bengle's Shots show no such thing, so its flow eases as Decaid's simulated machine eases it.
    const bengle = run([pressure("Fill", 9, { seconds: 8, limiter: { value: 1.5, range: 2.5 } })], { model: "Bengle" });
    expect(bengle.peakFlow).toBeCloseTo(eased(MODEL_FIGURES.Bengle.maxFlow, { value: 1.5, range: 2.5 }), 2);
  });

  it("on a Bengle's pressure holds it at the limit's value, whatever its range, where a DE1's eases over it", () => {
    const steps = (model: "DE1" | "Bengle") => run([flow("Push", 6, { seconds: 25, limiter: { value: 3, range: 1 } })], { grind: -0.5, model });
    expect(MODEL_FIGURES.Bengle.pressureLimiterReach).toBe(0);
    expect(steps("Bengle").peakPressure).toBeLessThan(3.2);
    expect(steps("Bengle").peakPressure).toBeGreaterThan(2.8);
    expect(steps("DE1").peakPressure).toBeGreaterThan(3.3);
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

  it("with a reach settles that share of its range over its value, rising smoothly to it, and with none eases as Decaid's", () => {
    const limiter = { value: 2, range: 1 };
    expect(limited(3, limiter)).toBe(eased(3, limiter));
    expect(limited(5, { value: 0, range: 1 }, 0.7)).toBe(5);
    expect(limited(1.5, limiter, 0.7)).toBe(1.5);
    // Twice its reach over or more, at its reach; below that, what it is over less a share that grows evenly.
    expect(limited(2 + 1.4, limiter, 0.7)).toBeCloseTo(2.7, 9);
    expect(limited(1000, limiter, 0.7)).toBeCloseTo(2.7, 9);
    expect(limited(2.7, limiter, 0.7)).toBeCloseTo(2 + 0.7 - (0.7 * 0.7) / (4 * 0.7), 9);
    expect(limited(2.001, limiter, 0.7)).toBeCloseTo(2.001, 3);
    // A reach of 0, or a limiter of no range, is a hard cap.
    expect(limited(5, limiter, 0)).toBe(2);
    expect(limited(5, { value: 2, range: 0 }, 0.7)).toBe(2);
    // It never falls as the reading rises.
    let last = 0;
    for (let reading = 0; reading <= 6; reading += 0.05) {
      const now = limited(reading, limiter, 0.7);
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
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
  });

  it("on a step whose pump controls pressure, gives a DE1 ever less as pressure builds, so a coarse puck stalls short of 9 bar where a Bengle reaches it", () => {
    const steps = [pressure("Nine", 9, { seconds: 30 })];
    const de1 = run(steps, { grind: 1, model: "DE1" });
    const bengle = run(steps, { grind: 1, model: "Bengle" });
    expect(de1.peakPressure).toBeLessThan(7);
    expect(de1.peakPressure).toBeGreaterThan(4.5);
    expect(bengle.peakPressure).toBeGreaterThan(8.9);
    // At its most below 2 bar, and stalled where the puck takes all it gives at that pressure, along the line to 6 bar.
    const [[low, most], [high, least]] = MODEL_FIGURES.DE1.pressureStepFlow;
    expect(de1.peakFlow).toBeCloseTo(most, 1);
    const gives = (bar: number) => most + ((least - most) * (Math.min(high, Math.max(low, bar)) - low)) / (high - low);
    const stalled = de1.samples[de1.samples.length - 1]!.values;
    expect(stalled.flow!).toBeCloseTo(gives(stalled.pressure!), 1);
    expect(stalled.flow!).toBeLessThan(most - 1);
    // On a medium puck it gets there.
    expect(run(steps, { model: "DE1" }).peakPressure).toBeGreaterThan(8.9);
  });

  it("follows a flow step's target as each model's Shots show, a DE1 over most of a second, a Bengle within a few tenths", () => {
    const steps = [flow("Fast", 8, { seconds: 4 })];
    const at = (result: SimulatedRun, seconds: number) => result.samples.find((sample) => Math.abs(sample.seconds - seconds) < 1e-9)!.values.flow!;
    const de1 = run(steps, { model: "DE1" });
    const bengle = run(steps, { model: "Bengle" });
    // Most of the way, its time constant, by MODEL_FIGURES's flowResponse.
    expect(at(de1, MODEL_FIGURES.DE1.flowResponse) / 8).toBeGreaterThan(0.55);
    expect(at(de1, MODEL_FIGURES.DE1.flowResponse) / 8).toBeLessThan(0.7);
    expect(at(de1, 0.3)).toBeLessThan(4);
    expect(at(bengle, 0.3)).toBeGreaterThan(7.5);
  });

  it("brings pressure to a pressure step's target more slowly on a DE1 than on a Bengle", () => {
    const steps = [flow("Fill", 3, { seconds: 8 }), pressure("Up", 8, { seconds: 15 })];
    const reached = (result: SimulatedRun) => result.samples.find((sample) => sample.step?.frame === 1 && sample.values.pressure! >= 7.5)!.seconds - result.steps[1]!.start!;
    expect(reached(run(steps, { model: "DE1" }))).toBeGreaterThan(reached(run(steps, { model: "Bengle" })) + 0.5);
  });

  it("holds a flow step at the most pressure it reaches, its pump easing at once", () => {
    // Asking for all its pump gives, on pucks from fine to the grind that brings that flow to about 12 bar. The pump eases
    // within a tick, so the pressure passes the most by what that tick's flow still fills the group with, a fifth of a bar
    // at most (a Bengle at 15 ml/s near grind 0.5).
    for (const model of MACHINE_MODELS) {
      const steps = [flow("Push", MODEL_FIGURES[model].maxFlow, { seconds: 30 })];
      for (const grind of [-1, -0.5, 0, 0.25, 0.5, 0.75]) expect(run(steps, { grind, model }).peakPressure).toBeLessThanOrEqual(MODEL_FIGURES[model].maxPressure + 0.25);
    }
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
// Those whose own steps on their puck still land within the margin, the corpus being the judge where Decaid's simulated
// machine differs from the DE1s it holds (#601). The mock builds pressure on a pressure step as fast as its pump gives,
// where those DE1s are held back as pressure builds, so Classic Italian's 9 bar and the default's 8.6 run long; and it
// stops its pump at once for the blooming profile's pause, where a DE1's flow takes a second or more to fall, so the
// run's first drip comes during the pause.
const WITHIN_MARGIN = ["gentle-and-sweet"];

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
    it(`is worked out from its samples, its own steps on it ${WITHIN_MARGIN.includes(name) ? "landing near it" : "coming to its steps"}: ${name}`, () => {
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
      const { run: fitted, fit } = fitToShot({ samples, profile: shotProfile, puck, stopAt: shotFitStop(samples, record.stopReason, "DE1", shotProfile)!.stopAt });
      const margin = Math.max(MARGIN_SECONDS, MARGIN_SHARE * fit.shot.duration);
      expect(fitted.stop.reason).toBe("weight");
      expect(fit.simulated.steps.map((step) => step.index)).toEqual(fit.shot.steps.map((step) => step.index));
      if (!WITHIN_MARGIN.includes(name)) return;
      expect(Math.abs(fit.simulated.duration - fit.shot.duration)).toBeLessThanOrEqual(margin);
      expect(Math.abs(fit.simulated.timeToFirstDrip! - fit.shot.timeToFirstDrip!)).toBeLessThanOrEqual(margin);
      expect(Math.abs(fit.simulated.peakPressure - fit.shot.peakPressure)).toBeLessThanOrEqual(MARGIN_BAR);
      fit.shot.steps.forEach((step, n) => expect(Math.abs(fit.simulated.steps[n]!.end - step.end)).toBeLessThanOrEqual(margin));
    });
  }

  it("of a Shot with no scale holds what the standard puck holds", () => {
    const record = JSON.parse(fs.readFileSync(new URL("../../server/test/fixtures/decaid/simulated-shots-v0.9.2/default.json", import.meta.url), "utf8")) as { workflow: { profile: unknown }; measurements: Array<Record<string, unknown>> };
    const unweighed = record.measurements.map(({ scale: _, ...rest }) => rest);
    const samples = shotSamples(unweighed, profileOf(record.workflow.profile));
    expect(shotPuck(samples, 18)).toMatchObject({ holds: standardPuck().holds, yieldPerMl: 1 });
    // Stopped on a weight it never read: no run can end as it did.
    expect(shotFitStop(samples, "targetWeight", "DE1", profileOf(record.workflow.profile)!)).toBeNull();
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

  it("leaves out a cup's weight read before Decaid's tare at the profile's start landed", () => {
    const record = JSON.parse(fs.readFileSync(new URL("../../server/test/fixtures/decaid/simulated-shots-v0.9.2/default.json", import.meta.url), "utf8")) as { workflow: { profile: unknown }; measurements: unknown };
    const samples = shotSamples(record.measurements, profileOf(record.workflow.profile));
    const first = samples.findIndex((sample) => sample.shade === null);
    expect(samples[first + 1]!.values.weight).toBeLessThan(1);
    const withCup = samples.map((sample, n) => (n === first ? { ...sample, values: { ...sample.values, weight: 120 } } : sample));
    expect(shotPuck(withCup, 18)).toEqual(shotPuck(samples, 18));
    expect(shotFigures(withCup).timeToFirstDrip).toBe(shotFigures(samples).timeToFirstDrip);
    expect(shotFigures(withCup).timeToFirstDrip).toBeGreaterThan(5);
  });

  it("of one measured sample is its resistance there, not a mean with the fill's", () => {
    const values = { pressure: 9, flow: 1, weight: null, weightFlow: null, temperature: null };
    const targets = { pressure: null, flow: null, weight: null, weightFlow: null, temperature: null };
    expect(shotPuck([{ seconds: 0, shade: null, values, targets }], 18)!.resistance).toEqual([[0, 9]]);
  });

  it("ends a run as the Shot ended: at its last weight, or with its steps where a DE1 ended it in its last step", () => {
    const record = JSON.parse(fs.readFileSync(new URL("../../server/test/fixtures/decaid/simulated-shots-v0.9.2/default.json", import.meta.url), "utf8")) as { workflow: { profile: unknown }; measurements: unknown };
    const shotProfile = profileOf(record.workflow.profile)!;
    const samples = shotSamples(record.measurements, shotProfile);
    const last = samples.filter((sample) => sample.values.weight !== null).pop()!.values.weight;
    expect(shotFitStop(samples, "targetWeight", "DE1", shotProfile)).toEqual({ stopAt: last });
    expect(shotFitStop(samples, "appStop", "DE1", shotProfile)).toEqual({ stopAt: last });
    // Ended by the Machine, as on its own button, at its yield on a Bengle, or with its last step: at its last weight too.
    expect(shotFitStop(samples, "machineEnded", "DE1", shotProfile)).toEqual({ stopAt: last });
    expect(shotFitStop(samples, "machineEnded", "Bengle", shotProfile)).toEqual({ stopAt: last });
  });

  it("where a DE1 ran its last step out, runs its steps out though its scale worked, as the weight may have all but stopped rising", () => {
    const steps = [flow("Fill", 6, { seconds: 8, exit: { type: "pressure", condition: "over", value: 4 } }), pressure("Extract", 9, { seconds: 12 }), flow("Off", 0, { seconds: 10 })];
    const shot = run(steps);
    expect(shotFitStop(shot.samples, "machineEnded", "DE1", profile(steps))).toEqual({ stopAt: null });
    const { fit } = fitToShot({ samples: shot.samples, profile: profile(steps), puck: standardPuck(), stopAt: null });
    expect(Math.abs(fit.simulated.duration - fit.shot.duration)).toBeLessThanOrEqual(Math.max(1, 0.05 * fit.shot.duration));
    // With its scale lost before the end, run out only where no step has a weight, which Decaid stops checking then.
    const lostScale = shot.samples.map((sample) => (sample.seconds >= 12 ? { ...sample, values: { ...sample.values, weight: null } } : sample));
    expect(shotFitStop(lostScale, "machineEnded", "DE1", profile(steps))).toEqual({ stopAt: null });
    const weighs = [steps[0]!, pressure("Extract", 9, { seconds: 12, weight: 20 }), steps[2]!];
    expect(shotFitStop(lostScale, "machineEnded", "DE1", profile(weighs))).toBeNull();
    // Stopped on the Machine 2 s before the end of its last step: at its last weight.
    const stopped = shot.samples.filter((sample) => sample.seconds <= shot.duration - 2);
    expect(shotFitStop(stopped, "machineEnded", "DE1", profile(steps))).toEqual({ stopAt: stopped[stopped.length - 1]!.values.weight });
  });

  it("with no scale, runs its steps out only where a DE1 ran its last step out", () => {
    const steps = [flow("Fill", 6, { seconds: 8 }), pressure("Extract", 9, { seconds: 20 })];
    const unweighed = (result: SimulatedRun) => result.samples.map((sample) => ({ ...sample, values: { ...sample.values, weight: null } }));
    const ranOut = run(steps);
    expect(shotFitStop(unweighed(ranOut), "machineEnded", "DE1", profile(steps))).toEqual({ stopAt: null });
    // Stopped on the Machine 5 s into its last step.
    const stopped = unweighed(ranOut).filter((sample) => sample.seconds <= 13);
    expect(shotFitStop(stopped, "machineEnded", "DE1", profile(steps))).toBeNull();
    // A last step with an exit could have ended it then.
    const exits = [steps[0]!, pressure("Extract", 9, { seconds: 20, exit: { type: "flow", condition: "over", value: 3 } })];
    expect(shotFitStop(stopped, "machineEnded", "DE1", profile(exits))).toEqual({ stopAt: null });
    expect(shotFitStop(stopped, "appStop", "DE1", profile(exits))).toBeNull();
  });

  it("where a DE1 ended it before its last step, as stopped on the Machine, ends at its last weight", () => {
    const record = JSON.parse(fs.readFileSync(new URL("../../server/test/fixtures/decaid/simulated-shots-v0.9.2/blooming.json", import.meta.url), "utf8")) as { workflow: { profile: unknown }; measurements: unknown };
    const shotProfile = profileOf(record.workflow.profile)!;
    const samples = shotSamples(record.measurements, shotProfile);
    expect(stepSpans(samples).pop()!.frame).toBeLessThan(shotProfile.steps.length - 1);
    const last = samples.filter((sample) => sample.values.weight !== null).pop()!.values.weight;
    expect(shotFitStop(samples, "machineEnded", "DE1", shotProfile)).toEqual({ stopAt: last });
  });

  it("of a Bengle that ended it at its yield, stops at that weight, not with the profile's last step", () => {
    const steps = [flow("Fill", 6, { seconds: 8, exit: { type: "pressure", condition: "over", value: 3 } }), pressure("Extract", 9, { seconds: 60 })];
    const shot = run(steps, { stopAt: 36, model: "Bengle" });
    expect(shot.stop.reason).toBe("weight");
    const { stopAt } = shotFitStop(shot.samples, "machineEnded", "Bengle", profile(steps))!;
    expect(stopAt).toBe(shot.weight);
    const { run: fitted } = fitToShot({ samples: shot.samples, profile: profile(steps), puck: standardPuck(), stopAt, model: "Bengle" });
    expect(fitted.stop).toEqual(shot.stop);
  });

  it("of a Shot with no scale runs its steps with no weight, as Decaid checks none without one", () => {
    const record = JSON.parse(fs.readFileSync(new URL("../../server/test/fixtures/decaid/simulated-shots-v0.9.2/default.json", import.meta.url), "utf8")) as { workflow: { profile: unknown }; measurements: Array<Record<string, unknown>> };
    const unweighed = shotSamples(record.measurements.map(({ scale: _, ...rest }) => rest), profileOf(record.workflow.profile));
    const weighs = profile([flow("Pour", 4, { seconds: 30, weight: 2 })]);
    const { run: fitted } = fitToShot({ samples: unweighed, profile: weighs, puck: shotPuck(unweighed, 18)!, stopAt: null });
    expect(fitted.steps[0]).toMatchObject({ end: 30, reason: "time" });
    expect(simulateProfile({ profile: weighs, puck: shotPuck(unweighed, 18)!, stopAt: null }).steps[0]!.reason).toBe("weight");
  });

  it("can't end a run as the Shot ended where its scale dropped out, nor where it stopped on no weight", () => {
    const record = JSON.parse(fs.readFileSync(new URL("../../server/test/fixtures/decaid/simulated-shots-v0.9.2/default.json", import.meta.url), "utf8")) as { workflow: { profile: unknown }; measurements: unknown };
    const shotProfile = profileOf(record.workflow.profile)!;
    const samples = shotSamples(record.measurements, shotProfile);
    const dropped = samples.map((sample) => (sample.shade === null && sample.seconds >= 12 ? { ...sample, values: { ...sample.values, weight: null } } : sample));
    expect(shotFitStop(dropped, "appStop", "DE1", shotProfile)).toBeNull();
    expect(shotFitStop(dropped, "targetWeight", "DE1", shotProfile)).toBeNull();
    // Run out by a DE1, its lost scale matters only where a step has a weight, which Decaid stops checking then.
    const weighs = { ...shotProfile, steps: shotProfile.steps.map((step, n) => (n === shotProfile.steps.length - 1 ? { ...step, weight: 30 } : step)) };
    // This one stopped 6 s into a last step of 32 s: not run out, so unknown with its scale lost.
    expect(shotFitStop(dropped, "machineEnded", "DE1", shotProfile)).toBeNull();
    expect(shotFitStop(dropped, "machineEnded", "DE1", weighs)).toBeNull();
    // A Bengle may have ended it at its yield, at a weight then unknown.
    expect(shotFitStop(dropped, "machineEnded", "Bengle", shotProfile)).toBeNull();
    // Stopped by hand with no scale, or before anything reached the cup.
    const unweighed = samples.map((sample) => ({ ...sample, values: { ...sample.values, weight: null } }));
    expect(shotFitStop(unweighed, "appStop", "DE1", shotProfile)).toBeNull();
    expect(shotFitStop(unweighed, "machineEnded", "DE1", shotProfile)).toBeNull();
    const dry = samples.map((sample) => ({ ...sample, values: { ...sample.values, weight: sample.values.weight === null ? null : 0 } }));
    expect(shotFitStop(dry, "appStop", "DE1", shotProfile)).toBeNull();
    // Scale noise under a gram is no weight reached.
    const noisy = samples.map((sample) => ({ ...sample, values: { ...sample.values, weight: sample.values.weight === null ? null : 0.2 } }));
    expect(shotFitStop(noisy, "appStop", "DE1", shotProfile)).toBeNull();
  });
});

describe("a Shot run under manual control (#599)", () => {
  const fixture = (name: string) =>
    JSON.parse(fs.readFileSync(new URL(`../../server/test/fixtures/decaid/simulated-shots-v0.9.2/${name}.json`, import.meta.url), "utf8")) as {
      workflow: { profile: unknown; machine: Record<string, unknown> };
      measurements: Array<{ machine: Record<string, unknown> }>;
    };
  /** A sample of a test step: its readings and the targets its Machine reported. */
  const sample = (seconds: number, frame: number, values: { pressure?: number; flow?: number }, targets: { pressure?: number; flow?: number }) => ({
    seconds,
    shade: null,
    step: { frame, name: `Step ${frame + 1}` },
    values: { pressure: values.pressure ?? 0, flow: values.flow ?? 0, weight: null, weightFlow: null, temperature: null },
    targets: { pressure: targets.pressure ?? null, flow: targets.flow ?? null, weight: null, weightFlow: null, temperature: null },
  });
  const tenSeconds = (make: (seconds: number) => ReturnType<typeof sample>) => Array.from({ length: 41 }, (_, n) => make(n / 4));

  it("is not a Shot whose Machine followed its steps: each Shot Decaid's simulated machine recorded", () => {
    for (const name of SHOT_FIXTURES) {
      const record = fixture(name);
      const shotProfile = profileOf(record.workflow.profile)!;
      expect(underManualControl(shotSamples(record.measurements, shotProfile), shotProfile, "DE1")).toBe(false);
    }
  });

  it("is one whose Machine reported, for more than half its time, targets its steps never asked for; it has a puck and no fit", () => {
    const record = fixture("classic-italian");
    // From its first pressure step on, as a Bengle under its group-head control reports what the lever asks.
    const steered = record.measurements.map((measurement) =>
      (measurement.machine.profileFrame as number) >= 2 ? { ...measurement, machine: { ...measurement.machine, targetPressure: 2.5 } } : measurement,
    );
    const shotProfile = profileOf(record.workflow.profile)!;
    expect(underManualControl(shotSamples(steered, shotProfile), shotProfile, "DE1")).toBe(true);
    const shot = simulationShotOf(record, steered);
    const onIt = simulateOnShot({ profile: shotProfile, shot, stopAt: 36, model: "DE1" })!;
    expect(onIt.puck.resistance.length).toBeGreaterThan(10);
    expect(onIt.fit).toBeNull();
    expect(simulateOnShot({ profile: shotProfile, shot: simulationShotOf(record, record.measurements), stopAt: 36, model: "DE1" })!.fit).not.toBeNull();
  });

  it("is not a smooth step's ramp from where its pump's quantity began, nor a lower target while a limiter holds the other quantity", () => {
    const ramp = profile([pressure("Ramp", 9, { transition: "smooth", seconds: 10 })]);
    expect(underManualControl(tenSeconds((t) => sample(t, 0, { pressure: 1 + 0.8 * t }, { pressure: 1 + 0.8 * t })), ramp, "DE1")).toBe(false);
    // The target at the step's own value from its start is not the ramp it asked for.
    expect(underManualControl(tenSeconds((t) => sample(t, 0, { pressure: 1 }, { pressure: 9 })), ramp, "DE1")).toBe(true);
    const limited = profile([flow("Limited", 4, { limiter: { value: 6, range: 1 } })]);
    expect(underManualControl(tenSeconds((t) => sample(t, 0, { pressure: 6.2, flow: 0.4 }, { flow: 0.5 })), limited, "Bengle")).toBe(false);
    // A target as low with the pressure far under the limiter's is none the step asked for.
    expect(underManualControl(tenSeconds((t) => sample(t, 0, { pressure: 1, flow: 0.4 }, { flow: 0.5 })), limited, "Bengle")).toBe(true);
    // However wide a limiter's range, a reading far under its value is not the limiter holding.
    const wide = profile([pressure("Wide", 9, { limiter: { value: 2.5, range: 3.5 } })]);
    expect(underManualControl(tenSeconds((t) => sample(t, 0, { pressure: 2.4, flow: 0.4 }, { pressure: 2.5 })), wide, "Bengle")).toBe(true);
    expect(underManualControl(tenSeconds((t) => sample(t, 0, { pressure: 2.4, flow: 2.3 }, { pressure: 2.5 })), wide, "Bengle")).toBe(false);
    // Nor does a limiter raise a target.
    expect(underManualControl(tenSeconds((t) => sample(t, 0, { pressure: 6.2, flow: 0.4 }, { flow: 8 })), limited, "Bengle")).toBe(true);
    // A flow step's sample with no flow target counts as following its step, as a Bengle reports a flow step's target as a pressure.
    const flowing = profile([flow("Flowing", 4, { seconds: 10 })]);
    expect(underManualControl(tenSeconds((t) => sample(t, 0, { pressure: 3, flow: 4 }, { pressure: 3.2 })), flowing, "Bengle")).toBe(false);
    // A pressure step's sample with none reported a target of 0, as with a lever held closed.
    const held = profile([pressure("Held", 9, { seconds: 10 })]);
    expect(underManualControl(tenSeconds((t) => sample(t, 0, { pressure: 0.2 }, {})), held, "Bengle")).toBe(true);
  });
});

describe("a Shot whose record names no Machine model (#599)", () => {
  it("has no model, and a puck but no fit, as from Decaid before v0.9.2 or where its capture of the Machine failed", () => {
    const record = JSON.parse(fs.readFileSync(new URL("../../server/test/fixtures/decaid/simulated-shots-v0.9.2/classic-italian.json", import.meta.url), "utf8")) as {
      workflow: Record<string, unknown> & { profile: unknown };
      measurements: unknown;
    };
    const shotProfile = profileOf(record.workflow.profile)!;
    expect(simulationShotOf(record, record.measurements).model).toBe("DE1");
    for (const machine of [{ provenanceStatus: "unavailable" }, { flowCalibration: 1.1 }, undefined]) {
      const shot = simulationShotOf({ ...record, workflow: { ...record.workflow, machine } }, record.measurements);
      expect(shot.model).toBeNull();
      const onIt = simulateOnShot({ profile: shotProfile, shot, stopAt: 36, model: "Bengle" })!;
      expect(onIt.run.model).toBe("Bengle");
      expect(onIt.fit).toBeNull();
    }
  });
});
