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
   * The most flow it gives on a step whose pump controls pressure, ml/s,
   * which on a DE1 is less than its pump gives on a step that controls flow:
   * about 6 ml/s, where its recorded Shots fill the group at a low pressure.
   */
  pressureStepMaxFlow: number;
  /** The most pressure it reaches, bar, as its profile's range allows. */
  maxPressure: number;
  /** How quickly its pump's flow follows what it is asked for: the time constant, s. */
  pumpResponse: number;
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
 * Each model's figures. Decent Sync can't tell a Bengle's power version, so
 * one Bengle's figures stand for every Bengle (#588). A DE1's were tuned
 * against recorded Shots; a Bengle's are Decent's maximum flow, with its
 * flow on a pressure step taken in the DE1's proportion, not yet checked
 * against a Bengle's Shots.
 */
export const MODEL_FIGURES = {
  DE1: { maxFlow: 8, pressureStepMaxFlow: 6, maxPressure: 12, pumpResponse: 0.2, wireScale: 16 },
  Bengle: { maxFlow: 15, pressureStepMaxFlow: 11, maxPressure: 12, pumpResponse: 0.2, wireScale: 10 },
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
