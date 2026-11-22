import { type SimulationShot, grindOf, lastRecordedWeight, shotPuck } from "@decent-sync/protocol";
import type { PuckAsk } from "../components/profile-simulation";

// The limits of a Profile's simulation's dose and stop-at fields (#578), and
// what a Shot laid over its graph sets them and the rest to (#622).

/** The most coffee a dose may be, g, as the REST API takes one. */
export const MAX_DOSE = 50;
/** The most a stop-at weight may be, g. */
export const MAX_STOP_AT = 500;

/**
 * What a Shot laid over the run sets the simulation to: its dose, as weighed
 * or else as set; the weight it stopped at; its Machine's model; and the
 * grind at which the standard puck has its puck's open resistance. Each it
 * can't give is left out, and stays as it was: no dose recorded, or one past
 * what the dose field takes; no weight, or one past the stop-at field's
 * limit; no model; or no puck that can be worked out from it.
 */
export function askOf(simulation: SimulationShot): Partial<PuckAsk> {
  const stopped = lastRecordedWeight(simulation.samples)?.weight;
  const stopAt = stopped === undefined ? 0 : Math.round(stopped * 10) / 10;
  const puck = shotPuck(simulation);
  return {
    ...(simulation.dose !== null && simulation.dose <= MAX_DOSE && { dose: simulation.dose }),
    ...(stopAt > 0 && stopAt <= MAX_STOP_AT && { stopAt }),
    ...(simulation.model !== null && { model: simulation.model }),
    ...(puck && { grind: grindOf(puck) }),
  };
}
