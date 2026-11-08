import * as z from "zod";

// A Workflow as an assistant reads it, in get_machine and among a Machine's
// activity: its summary (machine-events/workflow-summary.ts), whose meanings
// each tool's description gives too (`WORKFLOW_SUMMARY`), as most clients
// show a model no output schema (ADR-0028).

const amount = (unit: string) => z.number().nullable().describe(unit);

/** The Library's id of an item of the kind a Workflow names, as get_library_item finds it. */
const libraryId = (kind: string, name: string) =>
  z
    .string()
    .nullable()
    .describe(`The Library's id of the ${name} it names, which get_library_item finds as ${kind}; null where the Library holds none for it, or it names none.`);

export const workflowSummaryOutput = z
  .object({
    profile: z.string().nullable().describe("The Profile's title, as the Workflow names it."),
    profileId: libraryId("profile", "Profile"),
    brewTemperature: amount("°C: the Profile's first step's, which Streamline shows as the brew temperature."),
    dose: amount("g"),
    yield: amount("g"),
    bean: z.string().nullable().describe("The coffee's name, as the Workflow names it."),
    roaster: z.string().nullable(),
    beanBatchId: libraryId("beanBatch", "Bean Batch"),
    grinder: z.string().nullable().describe("The Grinder's model, as the Workflow names it."),
    burrs: z.string().nullable(),
    grindSetting: z.string().nullable(),
    grinderId: libraryId("grinder", "Grinder"),
    basket: z.string().nullable().describe("The Basket's name, as the Workflow names it."),
    basketId: libraryId("basket", "Basket"),
    recipe: z.string().nullable().describe("The name of the Recipe the Workflow names, as the Library names it; null where recipeId is."),
    recipeId: libraryId("recipe", "Recipe"),
    barista: z.string().nullable(),
    steam: z.object({ temperature: amount("°C"), duration: amount("s"), flow: amount("ml/s") }).nullable(),
    hotWater: z.object({ temperature: amount("°C"), volume: amount("ml") }).nullable(),
    flush: z.object({ temperature: amount("°C"), duration: amount("s") }).nullable(),
  })
  .describe("The parts of the Workflow the management interface shows, and its Basket and Recipe, with the Library's ids of what it names, each null where it has none.");

/** The summary's meanings, for the description of each tool that gives one. */
export const WORKFLOW_SUMMARY =
  "A Workflow is given as the management interface shows it: profile, the Profile's title; brewTemperature in °C, its Profile's first step's; dose and yield in grams; bean and roaster, the coffee's; grinder, the Grinder's model, with burrs and grindSetting; basket; recipe, the Recipe its context names, as DYE2 and Streamline name the one applied, by the Library's name; barista; steam (temperature °C, duration s, flow ml/s), hotWater (temperature °C, volume ml) and flush (temperature °C, duration s). profileId, beanBatchId, grinderId, basketId and recipeId are the Library's ids of what it names, which get_library_item finds as profile, beanBatch, grinder, basket and recipe; each null where the Library holds none for it, as for a batch made on the tablet not yet in the Library, its name as the Workflow recorded it kept. Any part it has none of is null.";
