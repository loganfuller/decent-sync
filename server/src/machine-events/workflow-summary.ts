import { Prisma } from "../generated/prisma/client.js";
import { profileOfSql } from "../shots/links.js";

// A Workflow summarised, as the REST API's summary route and an assistant
// read it: the parts the management interface's Workflow card shows of one
// (web/src/components/workflow.tsx), and its Basket, which a Shot's page
// shows, rather than the whole of Decaid's, whose Profile alone runs to
// kilobytes; with the Library's ids of the Profile, Bean Batch, Grinder and
// Basket it names, and of the Recipe its context names (DYE2_RECIPE_FIELD).
// A grind setting is given as text, as the card shows it. Any part may be
// missing, or sent differently by another supported Decaid version, and is
// then null.
//
// A Workflow names its Bean Batch, Grinder, Basket and Recipe by the ids of
// their records on the tablet that reported it, which the event keeps linked
// to the Library's items as that tablet's map resolves them
// (workflow-links.ts); one never resolved, as a batch made on the tablet
// that hasn't joined the Library, is null, its name as the Workflow recorded
// it kept, and so is every one of an event stored before #434, which keeps
// no links. It names its Profile by the profile itself, which is found as a
// Shot's is (`profileOfSql`). It records no Recipe's name, so the Recipe's
// is the Library's.

/** The Library items a Workflow names, as its summary gives them: each one's id, null for none, and the Recipe's name. */
export interface WorkflowLinks {
  profileId: string | null;
  beanBatchId: string | null;
  grinderId: string | null;
  basketId: string | null;
  recipeId: string | null;
  /** The Library's name of the Recipe, which the Workflow doesn't record; null where `recipeId` is, or the Recipe has no name. */
  recipeName: string | null;
}

/**
 * The parts of a Workflow the management interface shows, and its Basket and
 * Recipe, with the Library's ids of what it names. The MCP endpoint gives it by
 * its own schema (mcp/workflow-summary.ts), which a field added here joins.
 */
export interface WorkflowSummary {
  profile: string | null;
  profileId: string | null;
  brewTemperature: number | null;
  dose: number | null;
  yield: number | null;
  bean: string | null;
  roaster: string | null;
  beanBatchId: string | null;
  grinder: string | null;
  burrs: string | null;
  grindSetting: string | null;
  grinderId: string | null;
  basket: string | null;
  basketId: string | null;
  recipe: string | null;
  recipeId: string | null;
  barista: string | null;
  steam: { temperature: number | null; duration: number | null; flow: number | null } | null;
  hotWater: { temperature: number | null; volume: number | null } | null;
  flush: { temperature: number | null; duration: number | null } | null;
}

/** The parts of a Workflow, as Decaid sent it, that the management interface shows, and its Basket and Recipe, with the Library items it names. */
export function workflowSummary(workflow: Record<string, unknown>, links: WorkflowLinks): WorkflowSummary {
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
    profileId: links.profileId,
    brewTemperature: number(firstStep?.temperature),
    dose: number(context?.targetDoseWeight),
    yield: number(context?.targetYield),
    bean: text(context?.coffeeName),
    roaster: text(context?.coffeeRoaster),
    beanBatchId: links.beanBatchId,
    grinder: text(context?.grinderModel),
    burrs: text(context?.grinderBurrs),
    grindSetting: text(context?.grinderSetting),
    grinderId: links.grinderId,
    basket: text(extras?.basketName),
    basketId: links.basketId,
    recipe: text(links.recipeName),
    recipeId: links.recipeId,
    barista: text(context?.baristaName),
    steam: steam ? { temperature: number(steam.targetTemperature), duration: number(steam.duration), flow: number(steam.flow) } : null,
    hotWater: hotWater ? { temperature: number(hotWater.targetTemperature), volume: number(hotWater.volume) } : null,
    flush: flush ? { temperature: number(flush.targetTemperature), duration: number(flush.duration) } : null,
  };
}

/**
 * The Library items the Workflow event of `workflow_events` aliased `alias`
 * names, as the columns of WorkflowLinks: its Profile by its profile
 * (`profileOfSql`), and the Bean Batch, Grinder, Basket and Recipe it keeps
 * linked, with the Recipe's name.
 */
export function workflowLinksSql(alias: string): Prisma.Sql {
  const event = Prisma.raw(alias);
  return Prisma.sql`
    ${profileOfSql(Prisma.sql`(${event}.workflow -> 'profile')`)} AS "profileId",
    ${event}.library_batch_id::text AS "beanBatchId",
    ${event}.library_grinder_id::text AS "grinderId",
    ${event}.library_basket_id::text AS "basketId",
    ${event}.recipe_id::text AS "recipeId",
    (SELECT content ->> 'name' FROM recipes WHERE id = ${event}.recipe_id) AS "recipeName"`;
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
