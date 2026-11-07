import * as z from "zod";

// A Workflow as an assistant reads it among a Machine's activity: the parts
// the management interface shows of one (web/src/components/workflow.tsx),
// rather than the whole of Decaid's, whose Profile alone runs to kilobytes.
// Any part may be missing, or sent differently by another supported Decaid
// version, and is then null.

const amount = (unit: string) => z.number().nullable().describe(unit);

export const workflowSummaryOutput = z
  .object({
    profile: z.string().nullable().describe("The Profile's title."),
    brewTemperature: amount("°C: the Profile's first step's, which Streamline shows as the brew temperature."),
    dose: amount("g"),
    yield: amount("g"),
    bean: z.string().nullable().describe("The coffee's name, as the Workflow names it."),
    roaster: z.string().nullable(),
    grinder: z.string().nullable().describe("The Grinder's model."),
    burrs: z.string().nullable(),
    grindSetting: z.string().nullable(),
    basket: z.string().nullable(),
    barista: z.string().nullable(),
    steam: z.object({ temperature: amount("°C"), duration: amount("s"), flow: amount("ml/s") }).nullable(),
    hotWater: z.object({ temperature: amount("°C"), volume: amount("ml") }).nullable(),
    flush: z.object({ temperature: amount("°C"), duration: amount("s") }).nullable(),
  })
  .describe("The parts of the Workflow the management interface shows, each null where it has none.");

export type WorkflowSummary = z.infer<typeof workflowSummaryOutput>;

/** The parts of a Workflow, as Decaid sent it, that the management interface shows. */
export function workflowSummary(workflow: Record<string, unknown>): WorkflowSummary {
  const profile = record(workflow.profile);
  const context = record(workflow.context);
  const extras = record(context?.extras);
  const steam = record(workflow.steamSettings);
  const hotWater = record(workflow.hotWaterData);
  const flush = record(workflow.rinseData);
  // Decaid's Workflow has no brew temperature: Streamline's Brew tile shows and sets the profile's first step's.
  const firstStep = Array.isArray(profile?.steps) ? record(profile.steps[0]) : undefined;
  return {
    profile: text(profile?.title),
    brewTemperature: number(firstStep?.temperature),
    dose: number(context?.targetDoseWeight),
    yield: number(context?.targetYield),
    bean: text(context?.coffeeName),
    roaster: text(context?.coffeeRoaster),
    grinder: text(context?.grinderModel),
    burrs: text(context?.grinderBurrs),
    grindSetting: text(context?.grinderSetting),
    basket: text(extras?.basketName),
    barista: text(context?.baristaName),
    steam: steam ? { temperature: number(steam.targetTemperature), duration: number(steam.duration), flow: number(steam.flow) } : null,
    hotWater: hotWater ? { temperature: number(hotWater.targetTemperature), volume: number(hotWater.volume) } : null,
    flush: flush ? { temperature: number(flush.targetTemperature), duration: number(flush.duration) } : null,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** To two decimal places at most, as the management interface shows it: Decaid sends 2.500000000000001 for 2.5. */
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}
