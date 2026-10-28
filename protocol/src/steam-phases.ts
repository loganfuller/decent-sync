// A Steam Record's phases (#308), defined once for the server, which counts
// its steaming time, and the management interface, which shades the rest.
//
// Decaid's `SteamSequencer` (decaid:lib/src/controllers/steam_sequencer.dart)
// records from the Machine entering `steam` to the first sample outside it,
// so a record holds the lead-in, the steaming, a pause after every stop, puffs
// after a stop on time or Two Tap Stop's first tap, the purge and one last
// `idle` sample. No substate marks the pause: firmware 1358 reports it as a
// target flow of 0 under `pouring` or `pouringDone`, and
// decentespresso/decaid#1047 asks for one. `docs/STEAM_RECORDS.md` sets out
// what each phase holds in the test tablet's records. The Machine counts the
// Workflow's steam duration from `pouring`, and only the steaming counts
// toward a Steam Record's.

/** Each phase, as the management interface names it. */
export const STEAM_PHASE_NAMES = {
  preparing: "Preparing",
  steaming: "Steaming",
  paused: "Paused",
  puffing: "Puffing",
  purge: "Purge",
} as const;

export type SteamPhase = keyof typeof STEAM_PHASE_NAMES;

/** A sample's phase and its time, in seconds from any start. */
export interface PhasedSample {
  phase: SteamPhase;
  seconds: number;
}

/** Every phase but Steaming is shaded on a Steam Record's curves and left out of its duration. */
export function isShadedPhase(phase: SteamPhase): boolean {
  return phase !== "steaming";
}

/**
 * Each sample's phase, in the order Decaid recorded them, from its machine
 * snapshot's substate and target flow:
 *
 * - `preparingForShot` is Preparing;
 * - `pouring` is Steaming at a target flow above 0, and Paused at one of 0;
 * - `pouringDone` is the Purge at a target flow above 0, and Paused at one of 0;
 * - `pausedSteam` is Paused, and `puffing` Puffing.
 *
 * A sample without a target flow is read as above 0. Any other sample, such
 * as the last `idle`, or one with no substate, takes the phase of the sample
 * before it, so a record that ends straight from steaming ends in Steaming.
 * One with no sample before it is Steaming, so nothing a firmware reports
 * otherwise is left out of the duration.
 */
export function steamPhases(measurements: unknown): SteamPhase[] {
  if (!Array.isArray(measurements)) return [];
  const phases: SteamPhase[] = [];
  let before: SteamPhase = "steaming";
  for (const measurement of measurements) {
    before = samplePhase(record(record(measurement).machine), before);
    phases.push(before);
  }
  return phases;
}

function samplePhase(machine: Record<string, unknown>, before: SteamPhase): SteamPhase {
  const targetFlow = machine.targetFlow;
  const flowing = !(typeof targetFlow === "number" && Number.isFinite(targetFlow) && targetFlow <= 0);
  switch (record(machine.state).substate) {
    case "preparingForShot":
      return "preparing";
    case "pouring":
      return flowing ? "steaming" : "paused";
    case "pouringDone":
      return flowing ? "purge" : "paused";
    case "pausedSteam":
      return "paused";
    case "puffing":
      return "puffing";
    default:
      return before;
  }
}

/**
 * How long a Steam Record steamed, in seconds to the millisecond: the time
 * from each Steaming sample to the next, added up. A last sample has no time
 * after it.
 */
export function steamingSeconds(samples: readonly PhasedSample[]): number {
  let steaming = 0;
  for (let n = 0; n + 1 < samples.length; n++) {
    if (samples[n]!.phase === "steaming") steaming += samples[n + 1]!.seconds - samples[n]!.seconds;
  }
  return Math.round(steaming * 1000) / 1000;
}

/**
 * The seconds at which one shaded phase meets another: each sample whose
 * phase is shaded and differs from that of the sample before, which is
 * shaded too. Where a shaded phase meets Steaming, the shading's edge marks
 * it.
 */
export function shadedPhaseChanges(samples: readonly PhasedSample[]): number[] {
  const changes: number[] = [];
  for (let n = 1; n < samples.length; n++) {
    const { phase, seconds } = samples[n]!;
    const before = samples[n - 1]!.phase;
    if (phase !== before && isShadedPhase(phase) && isShadedPhase(before)) changes.push(seconds);
  }
  return changes;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
