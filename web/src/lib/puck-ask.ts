import { type MachineModel, type SimulationShot, lastRecordedWeight, shotGrind } from "@decent-sync/protocol";

// What a Profile's standard-puck simulation is asked for and the limits of
// its dose and stop-at fields (#578), and what a Shot laid over its graph
// sets them and the rest to (#622).

/** What a standard puck's simulation is asked for. */
export interface PuckAsk {
  /** -1, the finest, to 1, the coarsest. */
  grind: number;
  /** g. */
  dose: number;
  /** g, 0 to run until the last step ends. */
  stopAt: number;
  model: MachineModel;
}

/** The most coffee a dose may be, g, as the REST API takes one. */
export const MAX_DOSE = 50;
/** The most a stop-at weight may be, g. */
export const MAX_STOP_AT = 500;

/**
 * What a Shot laid over the run sets the simulation to: its dose, as weighed
 * or else as set; the weight it stopped at; its Machine's model; and the
 * grind of the standard puck that best imitates it (`shotGrind`), so that
 * moving the control from there says how the Shot would likely shift. Each
 * it can't give is left out, and stays as it was: no dose recorded, or one
 * past what the dose field takes; no weight, or one past the stop-at field's
 * limit; no model; or no puck that can be read from its pressure and flow.
 */
export function askOf(simulation: SimulationShot): Partial<PuckAsk> {
  const stopped = lastRecordedWeight(simulation.samples)?.weight;
  const stopAt = stopped === undefined ? 0 : Math.round(stopped * 10) / 10;
  const grind = shotGrind(simulation);
  return {
    ...(simulation.dose !== null && simulation.dose <= MAX_DOSE && { dose: simulation.dose }),
    ...(stopAt > 0 && stopAt <= MAX_STOP_AT && { stopAt }),
    ...(simulation.model !== null && { model: simulation.model }),
    ...(grind !== null && { grind }),
  };
}
