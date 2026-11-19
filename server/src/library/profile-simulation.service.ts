import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import {
  MACHINE_MODELS,
  MAX_PROFILE_STEPS,
  type MachineModel,
  PROFILE_LIMITS,
  type ProfileChecks,
  STANDARD_DOSE,
  type ShotFit,
  type SimulatedRun,
  checkProfile,
  fitToShot,
  isRecordId,
  shotPuck,
  shotStopAt,
  simulateProfile,
  standardPuck,
} from "@decent-sync/protocol";
import { ShotsService } from "../shots/shots.service.js";
import { ProfilesService } from "./profiles.service.js";

// The simulation of a Library Profile on a puck (#577, ADR-0032), as the
// REST API and the MCP endpoint answer it: the run of the shared module in
// protocol/ (`simulateProfile`) on the standard puck or a Shot's, with the
// Profile's checks, and, on a Shot's puck, how close a run of the Shot's own
// steps on that puck comes to the Shot.

/** What a simulation is asked for, as `readSimulationAsk` reads it. */
export interface SimulationAsk {
  /** The Shot whose puck to run on; null for the standard puck. */
  shotId: string | null;
  /** The standard puck's grind, from -1, the finest, to 1, the coarsest. */
  grind: number;
  /** The dose, g; null for the Shot's, or the standard puck's 18 g. */
  dose: number | null;
  /** The weight it stops at, g, 0 to run until its last step ends; null for the Profile's stop-at weight. */
  stopAt: number | null;
  model: MachineModel;
}

/** The most coffee a dose may be, g: more than any basket holds. */
export const MAX_DOSE = 50;

/** A simulation's puck: the standard one at a grind, or a Shot's, with the model of the Machine it was pulled on. */
export type SimulatedPuck = { kind: "standard"; grind: number } | { kind: "shot"; shotId: string; model: MachineModel };

/** A Library Profile's simulation, as the REST API returns it. */
export interface ProfileSimulation {
  profile: { id: string; title: string | null };
  model: MachineModel;
  puck: SimulatedPuck;
  /** The dose simulated, g. */
  dose: number;
  /** The weight it stops at, g, or null where it runs until its last step ends. */
  stopAt: number | null;
  run: SimulatedRun;
  /** The Profile's checks (`checkProfile`): what would stop it being published, and advice. */
  checks: ProfileChecks;
  /**
   * On a Shot's puck, the Shot's own steps run on it, stopped as it stopped,
   * beside the Shot: each's duration, time to first drip, peak pressure and
   * each step's end. Null on the standard puck, and where Decaid would not
   * read the Shot's own profile or it has more steps than a machine takes.
   */
  fit: ShotFit | null;
}

@Injectable()
export class ProfileSimulationService {
  constructor(
    private readonly profiles: ProfilesService,
    private readonly shots: ShotsService,
  ) {}

  /**
   * Simulates a Library Profile: on a Shot's puck where one is named,
   * otherwise on the standard puck at the grind asked, with the dose asked,
   * else the Shot's or 18 g, stopping at the weight asked, else the Profile's
   * stop-at weight, on a Machine of the model asked. 409 for a Profile whose
   * profile Decaid would not read or that has more steps than a machine
   * takes (MAX_PROFILE_STEPS), which bounds the run, and for a Shot whose
   * samples show nothing of its puck's resistance.
   */
  async simulate(profileId: string, ask: SimulationAsk): Promise<ProfileSimulation> {
    const item = await this.profiles.get(profileId);
    const profile = item.profile;
    if (!profile) throw new ConflictException(`Profile ${profileId}'s profile can't be read as Decaid reads one, so it can't be simulated`);
    if (profile.steps.length > MAX_PROFILE_STEPS) throw new ConflictException(`Profile ${profileId} has ${profile.steps.length} steps, more than the ${MAX_PROFILE_STEPS} a machine takes, so it can't be simulated`);
    const stopAt = ask.stopAt ?? (profile.target_weight !== null && profile.target_weight > 0 ? profile.target_weight : null);
    const checks = checkProfile(profile);
    const of = { id: item.id, title: item.title };
    if (ask.shotId === null) {
      const run = simulateProfile({ profile, puck: standardPuck(ask.grind), dose: ask.dose ?? STANDARD_DOSE, stopAt, model: ask.model });
      return { profile: of, model: ask.model, puck: { kind: "standard", grind: ask.grind }, dose: run.dose, stopAt: run.stopAt, run, checks, fit: null };
    }
    const shot = await this.shots.forSimulation(ask.shotId);
    const puck = shotPuck(shot.samples, shot.dose);
    if (!puck) throw new ConflictException(`Shot ${ask.shotId} recorded no pressure and flow to work its puck out from`);
    const run = simulateProfile({ profile, puck, dose: ask.dose ?? puck.dose, stopAt, model: ask.model });
    const fit = shot.profile && shot.profile.steps.length <= MAX_PROFILE_STEPS ? fitToShot({ samples: shot.samples, profile: shot.profile, puck, stopAt: shotStopAt(shot.samples, shot.stopReason), model: shot.model }).fit : null;
    return { profile: of, model: ask.model, puck: { kind: "shot", shotId: ask.shotId, model: shot.model }, dose: run.dose, stopAt: run.stopAt, run, checks, fit };
  }
}

/**
 * What a simulation is asked for, from the REST route's query: `shotId`, or
 * `grind` from -1 to 1, 0 where left out; `dose` above 0 and up to
 * MAX_DOSE g; `stopAt` from 0 to 500 g, 0 to run until the last step ends;
 * `model`, DE1 or Bengle, a DE1 where left out. 400 for anything else.
 */
export function readSimulationAsk(query: Record<string, unknown>): SimulationAsk {
  const problems: string[] = [];
  const numberOf = (name: string, valid: (value: number) => boolean, rule: string): number | null => {
    const raw = query[name];
    if (raw === undefined || raw === "") return null;
    const value = typeof raw === "string" ? Number(raw) : Number.NaN;
    if (!Number.isFinite(value) || !valid(value)) {
      problems.push(`${name} must be ${rule}`);
      return null;
    }
    return value;
  };
  const shotId = query.shotId === undefined || query.shotId === "" ? null : query.shotId;
  if (shotId !== null && !isRecordId(shotId)) problems.push("shotId must be a Shot's id");
  const grind = numberOf("grind", (value) => value >= -1 && value <= 1, "a number from -1, the finest, to 1, the coarsest");
  if (shotId !== null && grind !== null) problems.push("Choose a Shot's puck or the standard puck's grind, not both");
  const dose = numberOf("dose", (value) => value > 0 && value <= MAX_DOSE, `a number of grams above 0 and up to ${MAX_DOSE}`);
  const stopAt = numberOf("stopAt", (value) => value >= PROFILE_LIMITS.targetWeight.min && value <= PROFILE_LIMITS.targetWeight.max, `a number of grams from 0, to run until the last step ends, to ${PROFILE_LIMITS.targetWeight.max}`);
  const model = query.model === undefined || query.model === "" ? "DE1" : query.model;
  if (!(MACHINE_MODELS as readonly unknown[]).includes(model)) problems.push(`model must be one of ${MACHINE_MODELS.join(", ")}`);
  if (problems.length > 0) throw new BadRequestException(problems.join("; "));
  return { shotId: shotId as string | null, grind: grind ?? 0, dose, stopAt, model: model as MachineModel };
}
