import { BadRequestException, Injectable } from "@nestjs/common";
import { type CurveInfo, MACHINE_MODELS, PROFILE_LIMITS, SHOT_CURVES, type ShotCurve, STANDARD_DOSE } from "@decent-sync/protocol";
import * as z from "zod";
import { READ } from "../connected-apps/oauth.js";
import { MAX_DOSE, type ProfileSimulation, ProfileSimulationService } from "../library/profile-simulation.service.js";
import { readProfileId } from "../library/profiles.service.js";
import { type Budget, BudgetedTool } from "./budget.js";
import { MAX_CURVE_POINTS, askedCurves, curveSchema, curvesOf, thinnedToSchema } from "./curves.js";

// A Library Profile simulated on a puck, through an assistant, as the REST
// API simulates it (#577, ADR-0026): the headline figures, each step's end
// and why, the Profile's checks, how close a Shot's own steps on its puck
// come to it, and the run's curves thinned as a Shot's are.

const id = z.string();

/** The curves a run has: those of a Shot but its temperature, which the simulation doesn't simulate. */
const RUN_CURVES = { pressure: SHOT_CURVES.pressure, flow: SHOT_CURVES.flow, weight: SHOT_CURVES.weight, weightFlow: SHOT_CURVES.weightFlow } as const;
type RunCurve = keyof typeof RUN_CURVES;
const runCurveNames = Object.keys(RUN_CURVES) as [RunCurve, ...RunCurve[]];

const simulateInput = z.object({
  profileId: id.describe("The Library Profile to simulate."),
  shotId: id
    .optional()
    .describe("A Shot whose puck to simulate on, worked out from its pressure and flow samples, to ask what the Profile would have done to that Shot; the standard puck where left out."),
  grind: z
    .number()
    .min(-1)
    .max(1)
    .optional()
    .describe("The standard puck's grind, from -1, the finest, to 1, the coarsest, 0 a medium grind and 0 where left out: each end takes four times the middle's resistance or a quarter of it, so about half or twice its flow at one pressure. Not with shotId."),
  dose: z.number().gt(0).max(MAX_DOSE).optional().describe(`The dose in grams; the Shot's for its puck, as weighed or else as set, and ${STANDARD_DOSE} g for the standard puck, where left out.`),
  stopAt: z
    .number()
    .min(PROFILE_LIMITS.targetWeight.min)
    .max(PROFILE_LIMITS.targetWeight.max)
    .optional()
    .describe("The weight in grams it stops at, 0 to run until its last step ends; the Profile's own stop-at weight where left out, and with none, until its last step ends."),
  model: z.enum(MACHINE_MODELS).default("DE1").describe("The Machine model it runs on: DE1, for any DE1 model, or Bengle; a DE1 where left out."),
  curves: z
    .union([z.boolean(), z.array(z.enum(runCurveNames)).min(1)])
    .default(true)
    .describe(`Its curves: true for all of them, the default, a list of those to give, of ${runCurveNames.join(", ")}, or false for none.`),
});

const stepEnd = z.enum(["time", "exit", "water", "weight", "stop"]);

const figures = z.object({
  duration: z.number(),
  timeToFirstDrip: z.number().nullable(),
  peakPressure: z.number(),
  steps: z.array(z.object({ index: z.number(), name: z.string(), end: z.number() })).describe("Each step it came to, by its index from 0 and name, and when it ended."),
});

const simulateOutput = z.object({
  profile: z.object({ id, title: z.string().nullable() }),
  model: z.enum(MACHINE_MODELS),
  puck: z
    .union([z.object({ kind: z.literal("standard"), grind: z.number() }), z.object({ kind: z.literal("shot"), shotId: id, model: z.enum(MACHINE_MODELS).describe("The model of the Machine the Shot recorded, which the fit runs on.") })])
    .describe("The puck simulated on: the standard one at its grind, or a Shot's."),
  dose: z.number(),
  stopAt: z.number().nullable().describe("The weight it stops at; null where it runs until its last step ends."),
  duration: z.number(),
  timeToFirstDrip: z.number().nullable().describe("When the cup first held 1 g; null where it never did."),
  peakPressure: z.number(),
  peakFlow: z.number(),
  weight: z.number().describe("The weight in the cup at the stop."),
  weightFlowAtStop: z.number().describe("The rate coffee was landing in the cup at the stop."),
  water: z.number().describe("The water pumped."),
  stop: z.object({ seconds: z.number(), reason: z.enum(["weight", "lastStep"]) }),
  steps: z
    .array(z.object({ index: z.number(), name: z.string(), start: z.number().nullable(), end: z.number().nullable(), reason: stepEnd.nullable() }))
    .describe("Every step of the Profile, in order: when it began and ended, and why it ended; start, end and reason null for a step the run never came to."),
  checks: z
    .object({
      blocking: z.array(z.object({ code: z.string(), step: z.number().nullable(), path: z.string().optional(), message: z.string() })),
      advice: z.array(z.object({ code: z.string(), step: z.number().nullable(), path: z.string().optional(), message: z.string() })),
    })
    .describe("The Profile's checks: blocking, what would stop it being published, and advice, what the machine accepts but may not be meant, each naming its step by index, or null for the whole Profile."),
  fit: z
    .object({ shot: figures.describe("The Shot's own, as recorded."), simulated: figures.describe("Its own steps', run on its puck, stopped as it stopped.") })
    .nullable()
    .describe("On a Shot's puck: how close the simulation comes to that Shot. Null on the standard puck, and where the Shot's own profile can't be read or has more steps than a machine takes."),
  curves: z
    .object({
      thinnedTo: thinnedToSchema,
      pressure: curveSchema("Pressure, in bar, its targets the pressure each step whose pump controls pressure asks for."),
      flow: curveSchema("The pump's flow, in ml/s, its targets the flow each step whose pump controls flow asks for."),
      weight: curveSchema("The weight in the cup, in grams."),
      weightFlow: curveSchema("The rate coffee lands in the cup, in g/s."),
    })
    .optional()
    .describe("Its curves, unless asked for none."),
});

type SimulateOutput = z.infer<typeof simulateOutput>;

const simulateBudget: Budget = { rest: "Asked for with fewer curves, it has more of its text." };

/** What a simulated run is, for the tool's description. */
const SIMULATION = `Simulates a Library Profile on a puck, as a Machine of the model with a scale under the cup would run it: the standard puck, a fixed resistance through the Shot scaled by grind, or a Shot's, worked out from its samples. Everything it gives is simulated, not measured, but fit.shot, the Shot's own recorded figures. Each step ends at its maximum time (time), its exit (exit), the water it may pump (water) or its weight in the cup (weight), whichever comes first, or with the Shot (stop); a step of no length is passed through at once, whatever its exit, and a step runs the time the machine is sent: rounded to a tenth of a second below 12.75 s and to a whole second from there, up to 127 s. The Shot stops at the stop-at weight (weight) or when its last step ends (lastStep). A step that gets to its target over the whole step ramps from the value measured as it begins. A step's limiter caps the quantity its pump doesn't control, easing over its range. A DE1's pump gives about 8 ml/s at most, and about 6 on a step whose pump controls pressure; a Bengle keeps up with about 15. Temperature is not simulated, so the run follows each step's target alone. Times are seconds from the start of the profile; the run starts with the pump at rest, with no Preheat. Pressure is in bar, flow in ml/s, weights in grams and weightFlow in g/s. On a Shot's puck, fit gives the Shot's duration, time to first drip, peak pressure and each step's end beside a run of the Shot's own steps on its puck: how far to trust the simulation on that puck. Its curves give each series as [seconds, value] points with its targets, the plan, every reading or thinned to ${MAX_CURVE_POINTS} keeping its shape and peaks, as thinnedTo says.`;

@Injectable()
export class SimulationTools {
  constructor(private readonly simulation: ProfileSimulationService) {}

  @BudgetedTool({
    name: "simulate_profile",
    title: "Simulate a Profile",
    description: SIMULATION,
    inputSchema: simulateInput,
    outputSchema: simulateOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
    budget: simulateBudget,
  })
  async simulateProfile(input: z.input<typeof simulateInput>): Promise<SimulateOutput> {
    const { curves = true, ...ask } = input;
    if (ask.shotId !== undefined && ask.grind !== undefined) throw new BadRequestException("Choose a Shot's puck or the standard puck's grind, not both");
    const simulation = await this.simulation.simulate(readProfileId(ask.profileId), {
      shotId: ask.shotId ?? null,
      grind: ask.grind ?? 0,
      dose: ask.dose ?? null,
      stopAt: ask.stopAt ?? null,
      model: ask.model ?? "DE1",
    });
    return simulationOf(simulation, askedCurves(RUN_CURVES, curves));
  }
}

/** A simulation as simulate_profile gives it, with its curves thinned as a Shot's are, those asked for. */
function simulationOf(simulation: ProfileSimulation, curves: Partial<Record<RunCurve, CurveInfo>> | undefined): SimulateOutput {
  const { run } = simulation;
  const response: SimulateOutput = {
    profile: simulation.profile,
    model: simulation.model,
    puck: simulation.puck,
    dose: simulation.dose,
    stopAt: simulation.stopAt,
    duration: run.duration,
    timeToFirstDrip: run.timeToFirstDrip,
    peakPressure: run.peakPressure,
    peakFlow: run.peakFlow,
    weight: run.weight,
    weightFlowAtStop: run.weightFlowAtStop,
    water: run.water,
    stop: run.stop,
    steps: run.steps,
    checks: simulation.checks,
    fit: simulation.fit,
  };
  if (!curves) return response;
  const { shaded: _, ...thinned } = curvesOf<ShotCurve>(run.samples, curves, { pressure: run.peakPressure, flow: run.peakFlow });
  return { ...response, curves: thinned };
}
