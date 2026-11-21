// What a profile runs on, as far as running it goes: any DE1 model, or a
// Bengle. Each model's figures are held here, once, for the simulation of a
// profile (`simulateProfile`) and the checks of one (`checkProfile`), to be
// tuned from the Shots such Machines record (#577, #588).
//
// Pure: no Node or browser API, as the plugin bundles this package.

/** What the simulation and the checks need to know of a model. */
export interface ModelFigures {
  /**
   * The most flow it keeps up with, ml/s: a DE1's pump gives about 8 ml/s, and
   * a Bengle's heater keeps up with about 15 ml/s on the 250 V/15 A version,
   * though its pump is rated at 20 (#588).
   */
  maxFlow: number;
  /**
   * Where it gives less on a step whose pump controls pressure than maxFlow,
   * the most it gives there against the pressure: [bar, ml/s] points in
   * order of pressure, read along the line between two and level beyond
   * either end. A DE1's recorded Shots fill the group at about 6.5 ml/s on
   * such a step, and push ever less as pressure builds, about 3 ml/s from 6
   * bar, where a ramp to 9 bar on a coarse puck stalls short of it. Where
   * none, maxFlow.
   */
  pressureStepFlow?: ReadonlyArray<readonly [number, number]>;
  /** The most pressure it reaches, bar, as its profile's range allows. */
  maxPressure: number;
  /**
   * How far over a limiter's value it lets the flow settle on a step whose
   * pump controls pressure, as a share of the limiter's range (`limited`).
   * A DE1's recorded Shots let more through such a limiter than Decaid's
   * simulated machine eases it to, short of pushing it hard: with a limit of
   * 1.5 ml/s and a range of 2.5, a flow that would be 3.4 settles near 3,
   * where the easing gives 2.6. Where none, Decaid's easing (`eased`).
   */
  flowLimiterReach?: number;
  /**
   * How far over a limiter's value it lets the pressure settle on a step
   * whose pump controls flow, as a share of the limiter's range (`limited`):
   * 0 holds it at the value, as a Bengle's recorded Shots hold 6 bar under a
   * limiter of 6 with a range of 0.6, where Decaid's easing gives 6.5. Where
   * none, Decaid's easing (`eased`).
   */
  pressureLimiterReach?: number;
  /** How quickly its flow follows a target on a step whose pump controls flow: the time constant, s. */
  flowResponse: number;
  /** How quickly its pump brings the pressure to a target on a step whose pump controls pressure: the time constant, s. */
  pressureResponse: number;
  /**
   * The parts of a bar or ml/s Decaid sends a step's target, exit and limiter
   * in, each in one byte: sixteenths to a DE1, tenths to a Bengle
   * (`_writeSteps` in
   * decaid:lib/src/models/device/impl/de1/unified_de1/unified_de1.profile.dart,
   * v0.9.2).
   */
  wireScale: number;
}

/**
 * Each model's figures, one typical machine of each, fitted to the
 * simulation's corpus of recorded Shots (scripts/simulation, #601): each
 * figure is the one that brings the most of its Shots within the margin on
 * their own puck, and each stays only where it does so by a clear step. A
 * DE1's pump is slow to bring up its flow and slower to build pressure,
 * gives less on a step whose pump controls pressure, and lets more flow
 * past such a step's limiter than Decaid's simulated machine does; a Bengle
 * follows its targets about as fast as the machine reads them, its Shots
 * show no such step giving it less, and it holds a flow step's pressure at
 * its limiter's value. Decent Sync can't tell a Bengle's power version,
 * so one Bengle's figures stand for every Bengle, and its maxFlow is
 * Decent's, as no recorded Shot reaches it (#588).
 */
export const MODEL_FIGURES = {
  DE1: {
    maxFlow: 8,
    pressureStepFlow: [
      [2, 6.5],
      [6, 3],
    ],
    maxPressure: 12,
    flowLimiterReach: 0.7,
    flowResponse: 0.7,
    pressureResponse: 1.5,
    wireScale: 16,
  },
  Bengle: { maxFlow: 15, maxPressure: 12, pressureLimiterReach: 0, flowResponse: 0.1, pressureResponse: 0.7, wireScale: 10 },
} as const satisfies Record<string, ModelFigures>;

/** A model a profile runs on: any DE1 model, or a Bengle. */
export type MachineModel = keyof typeof MODEL_FIGURES;

/** The models, a DE1 first, as the one taken where none is named. */
export const MACHINE_MODELS = ["DE1", "Bengle"] as const satisfies readonly MachineModel[];

/**
 * The model of a Machine whose hardware Decaid names as it does
 * (`DecentMachineModel`, such as `DE1Pro` or `Bengle`), in any case: a Bengle,
 * or a DE1 for any other name, and for none.
 */
export function machineModelOf(decaidModel: unknown): MachineModel {
  return typeof decaidModel === "string" && decaidModel.trim().toLowerCase() === "bengle" ? "Bengle" : "DE1";
}
