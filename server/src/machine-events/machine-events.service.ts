import { Injectable } from "@nestjs/common";
import { PLUGIN_WORKFLOW_WRITES, type MachineStateDelivery, type PluginWorkflowWrite, type WorkflowDelivery } from "@decent-sync/protocol";
import { type MachineStateEvent, Prisma, type WorkflowEvent } from "../generated/prisma/client.js";
import { INTAKE_TRANSACTION, lockTablet } from "../library/intake.js";
import { takeInWorkflow } from "../library/joining.js";
import { type Credit, creditFirstDelivery } from "../machines/credit.js";
import { machineNotFound } from "../machines/input.js";
import type { MachineStateView } from "../machines/machines.service.js";
import { PrismaService } from "../prisma.service.js";
import { profileOfSql } from "../shots/links.js";
import type { Reporter } from "../sync/identity.js";
import { type ChangeCause, type RecipeEvent, type TrailChange, type TrailEntry, type TrailRecipe, dialInTrail } from "./dial-in-trail.js";
import { type LoadedRecipeView, everyLoadedRecipeDuring, loadedRecipeHistory, loadedRecipesDuring, takeInLoadedRecipe } from "./loaded-recipes.js";
import { WORKFLOW_LINK_COLUMNS, resolvedLinksSql } from "./workflow-links.js";
import { type WorkflowLinks, type WorkflowSummary, workflowLinksSql, workflowSummary } from "./workflow-summary.js";

/** A page of a history, as `readPage` reads it from a request. */
type Page = { limit: number; offset: number };

/** A span of time, from `from` up to but not including `to`; null leaves that end open. */
export interface TimeRange {
  from: Date | null;
  to: Date | null;
}

/** The kinds of a Machine's activity. */
export type ActivityKind = "workflowChanges" | "loadedRecipes" | "machineStates";

/** A page of one kind of a Machine's activity, and how many there are in all. */
export interface ActivityPage<T> {
  entries: T[];
  total: number;
}

/** Which of a Machine's activity to give: its Workflow changes of one cause alone (`TrailEntry.cause`), or all of them. */
export interface ActivityFilters {
  cause?: ChangeCause;
}

/** A Machine's activity over a time range, a page of each kind asked for, its Workflow changes as a dial-in trail (dial-in-trail.ts). */
export interface ActivityView {
  workflowChanges?: ActivityPage<TrailEntry>;
  loadedRecipes?: ActivityPage<LoadedRecipeView>;
  machineStates?: ActivityPage<MachineStateEventView>;
}

/** A Workflow recorded for a Machine, as the REST API returns it. */
export interface WorkflowEventView {
  id: string;
  /** When the plugin observed it, by the tablet's clock. */
  observedAt: string;
  /** When the server stored it, by PostgreSQL's clock. */
  receivedAt: string;
  /**
   * Who changed it, as its delivery said: `plugin`, for a change the plugin
   * released at the end of one of its writes into the Workflow, which may
   * carry another writer's change made meanwhile too; `other`, for any
   * other, as a barista's on Streamline, Streamline's own or DYE2's; and
   * `unknown`, for one stored before Decent Sync recorded this, or from a
   * plugin that says nothing.
   */
  cause: "plugin" | "other" | "unknown";
  /** For a `plugin` change, the plugin's write (PLUGIN_WORKFLOW_WRITES); otherwise null. */
  pluginWrite: PluginWorkflowWrite | null;
  /** Decaid's Workflow, as sent. */
  workflow: Prisma.JsonObject;
}

/** A Workflow recorded for a Machine, with the Library items it names (workflow-summary.ts). */
export interface LinkedWorkflowEventView extends WorkflowEventView {
  links: WorkflowLinks;
}

/** A Workflow recorded for a Machine, summarised, as the REST API's summary route returns it. */
export interface WorkflowSummaryView extends Omit<WorkflowEventView, "workflow"> {
  /** Its summary, with the Library's ids of what it names (workflow-summary.ts). */
  workflow: WorkflowSummary;
}

/** A machine state transition recorded for a Machine, as the REST API returns it. */
export interface MachineStateEventView extends MachineStateView {
  id: string;
  receivedAt: string;
}

/**
 * Workflow changes and machine state transitions, appended as timed events.
 * Each belongs to the session's token's Machine, or for a mismatched session
 * to its reported hardware: the Machine that has it, or else its Pending
 * Machine, which hands them over with the hardware (ADR-0015).
 *
 * Each delivery is handled once: its id, which the plugin keeps when it
 * sends the delivery again, is recorded whether or not it changes anything,
 * so a resend changes nothing, whatever changed since, for the 90 days the
 * id is kept (`DeliveryIdCleanup`). A delivery handled for the first time is
 * stored as an event only if it differs from the latest event stored for
 * whoever it belongs to, decided against the database while that Machine's
 * row, or a Pending Machine's hardware, is locked, so sessions on any server
 * instance decide one at a time, never by what an instance or connection
 * remembers. The latest event stored is the current one; one delivered late
 * keeps the time the plugin observed it.
 *
 * A Workflow is stored with who changed it, as its delivery says, the tablet
 * that reported it, and the Library's items it names, through that tablet's
 * map (workflow-links.ts). A Workflow from a connection that is not
 * mismatched, for its token's Machine, is also taken in at its Location in
 * the same transaction
 * (`takeInWorkflow`), as its tablet joins it, and into the Machine's Loaded
 * Recipe (`takeInLoadedRecipe`, ADR-0022).
 */
@Injectable()
export class MachineEventsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Stores a Workflow delivery, and returns where it was taken in
   * (`takeInWorkflow`): a `standing`, null if nowhere, as
   * its Machine is capture-only, or undefined if it was not taken in, as a
   * delivery handled before, or a mismatched connection's.
   */
  async storeWorkflow(message: WorkflowDelivery, reporter: Reporter): Promise<string | null | undefined> {
    const workflow = JSON.stringify(message.workflow);
    return this.prisma.$transaction(async (tx) => {
      const credit = await creditFirstDelivery(tx, reporter, message.id);
      if (!credit) return undefined;
      // The tablet's map, which its ids resolve through, changes only under this lock, which takeInWorkflow takes too.
      await lockTablet(tx, reporter.tabletId);
      await tx.$executeRaw`
        WITH reported AS (SELECT ${workflow}::jsonb AS workflow)
        INSERT INTO workflow_events (machine_id, pending_machine_id, observed_at, workflow, cause, plugin_write, tablet_id, ${WORKFLOW_LINK_COLUMNS})
        SELECT ${credit.machineId}::uuid, ${credit.pendingMachineId}::uuid, ${message.observedAt}::timestamptz, reported.workflow,
          ${message.cause ?? null}::text, ${message.pluginWrite ?? null}::text, ${reporter.tabletId}::uuid,
          ${resolvedLinksSql(reporter.tabletId, Prisma.sql`reported.workflow`)}
        FROM reported
        WHERE NOT EXISTS (
          SELECT 1 FROM (SELECT workflow FROM workflow_events WHERE ${heldBy(credit)} ORDER BY id DESC LIMIT 1) AS latest
          WHERE latest.workflow = reported.workflow
        )`;
      // A mismatched connection's tablet is not its token's Machine's, so it takes no part in the Library (ADR-0004).
      if (reporter.identity.kind !== "mismatch" && credit.machineId === reporter.machineId) {
        const tablet = { machineId: reporter.machineId, tabletId: reporter.tabletId };
        return takeInWorkflow(tx, tablet, message.workflow, (entry, joining) =>
          takeInLoadedRecipe(tx, tablet, message.workflow, message.observedAt, entry, joining, { dye2Absent: message.dye2Absent, recipeNamedAt: message.recipeNamedAt }),
        );
      }
      return undefined;
    }, INTAKE_TRANSACTION);
  }

  async storeMachineState(message: MachineStateDelivery, reporter: Reporter): Promise<void> {
    const { state, substate } = message;
    await this.prisma.$transaction(async (tx) => {
      const credit = await creditFirstDelivery(tx, reporter, message.id);
      if (!credit) return;
      await tx.$executeRaw`
        INSERT INTO machine_state_events (machine_id, pending_machine_id, observed_at, state, substate)
        SELECT ${credit.machineId}::uuid, ${credit.pendingMachineId}::uuid, ${message.observedAt}::timestamptz, ${state}, ${substate}
        WHERE NOT EXISTS (
          SELECT 1 FROM (SELECT state, substate FROM machine_state_events WHERE ${heldBy(credit)} ORDER BY id DESC LIMIT 1) AS latest
          WHERE latest.state = ${state} AND latest.substate = ${substate}
        )`;
    });
  }

  /** The Machine's current Workflow: the latest stored for it, or null before any. */
  async currentWorkflow(machineId: string): Promise<WorkflowEventView | null> {
    await this.requireMachine(machineId);
    const latest = await this.prisma.workflowEvent.findFirst({ where: { machineId }, orderBy: { id: "desc" } });
    return latest ? viewWorkflowEvent(latest) : null;
  }

  /** The Machine's current Workflow, as `currentWorkflow` gives it, with the Library items it names (`workflowLinksSql`). */
  async currentLinkedWorkflow(machineId: string): Promise<LinkedWorkflowEventView | null> {
    await this.requireMachine(machineId);
    const [latest] = await this.prisma.$queryRaw<LinkedRow[]>`
      SELECT id, observed_at AS "observedAt", received_at AS "receivedAt", workflow, cause, plugin_write AS "pluginWrite", ${workflowLinksSql("latest")}
      FROM workflow_events AS latest WHERE machine_id = ${machineId}::uuid ORDER BY id DESC LIMIT 1`;
    return latest ? viewLinkedWorkflowEvent(latest) : null;
  }

  /** The Machine's Loaded Recipes, latest first: its current one, if it has one, then those it had before. */
  async loadedRecipes(machineId: string, page: Page): Promise<{ entries: LoadedRecipeView[]; total: number } & Page> {
    await this.requireMachine(machineId);
    return loadedRecipeHistory(this.prisma, machineId, page);
  }

  /** The Workflows recorded for the Machine, latest first. */
  async workflowEvents(machineId: string, page: Page) {
    await this.requireMachine(machineId);
    const [events, total] = await this.prisma.$transaction([
      this.prisma.workflowEvent.findMany({ where: { machineId }, orderBy: { id: "desc" }, take: page.limit, skip: page.offset }),
      this.prisma.workflowEvent.count({ where: { machineId } }),
    ]);
    return { events: events.map(viewWorkflowEvent), total, ...page };
  }

  /** The machine state transitions recorded for the Machine, latest first. */
  async machineStateEvents(machineId: string, page: Page) {
    await this.requireMachine(machineId);
    const [events, total] = await this.prisma.$transaction([
      this.prisma.machineStateEvent.findMany({ where: { machineId }, orderBy: { id: "desc" }, take: page.limit, skip: page.offset }),
      this.prisma.machineStateEvent.count({ where: { machineId } }),
    ]);
    return { events: events.map(viewMachineStateEvent), total, ...page };
  }

  /**
   * What the Machine was doing over a time range, a page of each kind asked
   * for, each latest first, by the tablet's clock: its Workflow changes as a
   * dial-in trail (`workflowTrail`); the Machine States in effect at any time
   * in it, those observed in it and the one in effect as it began, the
   * latest observed then or before; and the Loaded Recipes loaded at any time
   * in it.
   */
  async activity(machineId: string, range: TimeRange, page: Page, kinds: readonly ActivityKind[], filters: ActivityFilters = {}): Promise<ActivityView> {
    await this.requireMachine(machineId);
    const bounds = boundsOf(range);
    const [workflowChanges, loadedRecipes, machineStates] = await Promise.all([
      kinds.includes("workflowChanges") ? this.workflowTrail(machineId, range, bounds, page, filters.cause) : undefined,
      kinds.includes("loadedRecipes") ? loadedRecipesDuring(this.prisma, machineId, bounds, page) : undefined,
      kinds.includes("machineStates") ? this.machineStateEventsDuring(machineId, bounds, page) : undefined,
    ]);
    return { workflowChanges, loadedRecipes, machineStates };
  }

  /**
   * The Machine's Workflow changes over the range as a dial-in trail
   * (`dialInTrail`), latest first, a page of it: made from the Workflows in
   * effect at any time in it, the one in effect as it began and those
   * observed in it, each summarised (`workflowSummary`) from the parts of it
   * a summary reads, and from the loads and unloads of its Loaded Recipes in
   * it, grouped whole before the page is taken, so its total counts the
   * trail's entries, of the cause asked for, the first always given. Each
   * Profile is found once, however many changes name it, and each Workflow
   * read once: 25,000 changes, a year of a busy Machine's, take under a
   * second, and a day's a few ms.
   */
  private async workflowTrail(machineId: string, range: TimeRange, bounds: Bounds, page: Page, cause: ChangeCause | undefined): Promise<ActivityPage<TrailEntry>> {
    // Each Workflow's parts read in one pass of it (jsonb_to_record), rather than one for each part.
    const during = (where: Prisma.Sql) => Prisma.sql`
      SELECT e.id, e.observed_at, e.cause, e.plugin_write, e.library_batch_id, e.library_grinder_id, e.library_basket_id, e.recipe_id, parts.profile,
        jsonb_build_object(
          'profile', jsonb_build_object('title', parts.profile -> 'title', 'steps', jsonb_build_array(parts.profile #> '{steps,0}')),
          'context', parts.context, 'steamSettings', parts."steamSettings", 'hotWaterData', parts."hotWaterData", 'rinseData', parts."rinseData"
        ) AS summarised
      FROM workflow_events AS e
      CROSS JOIN LATERAL jsonb_to_record(e.workflow) AS parts(profile jsonb, context jsonb, "steamSettings" jsonb, "hotWaterData" jsonb, "rinseData" jsonb)
      WHERE e.machine_id = ${machineId}::uuid AND ${where} AND e.observed_at < ${bounds.to}::timestamptz`;
    const [rows, loads] = await Promise.all([
      this.prisma.$queryRaw<TrailRow[]>`
        WITH during AS NOT MATERIALIZED (
          (${during(Prisma.sql`e.observed_at <= ${bounds.from}::timestamptz`)} ORDER BY e.observed_at DESC, e.id DESC LIMIT 1)
          UNION ALL
          (${during(Prisma.sql`e.observed_at > ${bounds.from}::timestamptz`)})
        ),
        profiles AS (
          SELECT named.profile, ${profileOfSql(Prisma.sql`named.profile`)} AS "profileId"
          FROM (SELECT DISTINCT profile FROM during WHERE profile IS NOT NULL) AS named
        )
        SELECT during.id, during.observed_at AS "observedAt", during.cause, during.plugin_write AS "pluginWrite", during.summarised AS workflow,
          profiles."profileId", during.library_batch_id::text AS "beanBatchId", during.library_grinder_id::text AS "grinderId",
          during.library_basket_id::text AS "basketId", during.recipe_id::text AS "recipeId", recipes.content ->> 'name' AS "recipeName"
        FROM during
        LEFT JOIN profiles ON profiles.profile = during.profile
        LEFT JOIN recipes ON recipes.id = during.recipe_id`,
      everyLoadedRecipeDuring(this.prisma, machineId, bounds),
    ]);
    // In time order, then by stored id, sorted here rather than by PostgreSQL, which would spill a long range's to disk.
    rows.sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const [baseline, ...changes] = rows.map((row): TrailChange => {
      const { id, observedAt, workflow, profileId, beanBatchId, grinderId, basketId, recipeId, recipeName } = row;
      const { cause, pluginWrite } = causeOf(row);
      return { id, observedAt, cause, pluginWrite, summary: workflowSummary(workflow as Record<string, unknown>, { profileId, beanBatchId, grinderId, basketId, recipeId, recipeName }) };
    });
    if (!baseline) return { entries: [], total: 0 };
    // The trail begins as the range does, or with the first Workflow in it where none was in effect then.
    const start = Math.max(range.from?.getTime() ?? -Infinity, baseline.observedAt.getTime());
    const end = range.to?.getTime() ?? Infinity;
    const recipeOf = (entry: LoadedRecipeView): TrailRecipe => ({ id: entry.recipe.id, name: entry.recipe.name });
    const within = (at: string | null) => at !== null && Date.parse(at) > start && Date.parse(at) < end;
    // Oldest first, each entry's load before its unload, as dialInTrail keeps the order of those at one moment and one id.
    const recipeEvents = loads.flatMap((entry): RecipeEvent[] => [
      ...(within(entry.loadedAt) ? [{ kind: "loaded" as const, id: BigInt(entry.id), at: new Date(entry.loadedAt), recipe: recipeOf(entry) }] : []),
      ...(within(entry.unloadedAt) ? [{ kind: "unloaded" as const, id: BigInt(entry.id), at: new Date(entry.unloadedAt!), recipe: recipeOf(entry) }] : []),
    ]);
    const inEffect = loads.find((entry) => Date.parse(entry.loadedAt) <= start && (entry.unloadedAt === null || Date.parse(entry.unloadedAt) > start));
    const trail = dialInTrail({ baseline, changes, recipeEvents, loadedAtStart: inEffect ? recipeOf(inEffect) : null })
      .reverse()
      .filter((entry) => cause === undefined || entry.kind === "inEffect" || entry.cause === cause);
    return { entries: trail.slice(page.offset, page.offset + page.limit), total: trail.length };
  }

  private async machineStateEventsDuring(machineId: string, bounds: Bounds, page: Page): Promise<ActivityPage<MachineStateEventView>> {
    const table = Prisma.sql`machine_state_events`;
    const [rows, total] = await Promise.all([
      this.prisma.$queryRaw<Pick<MachineStateEvent, "id" | "observedAt" | "receivedAt" | "state" | "substate">[]>`
        SELECT id, observed_at AS "observedAt", received_at AS "receivedAt", state, substate
        FROM ${inEffectDuring(table, Prisma.sql`id, observed_at, received_at, state, substate`, machineId, bounds, page)}
        ORDER BY observed_at DESC, id DESC LIMIT ${page.limit} OFFSET ${page.offset}`,
      countInEffect(this.prisma, table, machineId, bounds),
    ]);
    return { entries: rows.map(viewMachineStateEvent), total };
  }

  private async requireMachine(id: string): Promise<void> {
    if ((await this.prisma.machine.count({ where: { id } })) === 0) throw machineNotFound();
  }
}

/** A time range's ends as PostgreSQL takes them, an open end as infinity. */
interface Bounds {
  from: string;
  to: string;
}

function boundsOf(range: TimeRange): Bounds {
  return { from: range.from?.toISOString() ?? "-infinity", to: range.to?.toISOString() ?? "infinity" };
}

/**
 * The Machine's events in effect at any time in the range, with these
 * columns of an event table, as a subquery to select from, latest first as
 * far as the page reaches: the latest observed as it began or before, which
 * lasted until the next, and each observed after its start and before its
 * end. The table's (machine_id, observed_at, id) index finds both, stopping
 * once the page is read, as each part has its limit.
 */
function inEffectDuring(table: Prisma.Sql, columns: Prisma.Sql, machineId: string, bounds: Bounds, page: Page): Prisma.Sql {
  return Prisma.sql`(
    (SELECT ${columns} FROM ${table}
      WHERE machine_id = ${machineId}::uuid AND observed_at <= ${bounds.from}::timestamptz AND observed_at < ${bounds.to}::timestamptz
      ORDER BY observed_at DESC, id DESC LIMIT 1)
    UNION ALL
    (SELECT ${columns} FROM ${table}
      WHERE machine_id = ${machineId}::uuid AND observed_at > ${bounds.from}::timestamptz AND observed_at < ${bounds.to}::timestamptz
      ORDER BY observed_at DESC, id DESC LIMIT ${page.offset + page.limit})
  ) AS during`;
}

/** How many of the Machine's events were in effect at any time in the range (`inEffectDuring`), counted from the same index alone. */
async function countInEffect(prisma: PrismaService, table: Prisma.Sql, machineId: string, bounds: Bounds): Promise<number> {
  const [{ total }] = await prisma.$queryRaw<[{ total: number }]>`
    SELECT ((SELECT count(*) FROM ${table}
        WHERE machine_id = ${machineId}::uuid AND observed_at > ${bounds.from}::timestamptz AND observed_at < ${bounds.to}::timestamptz)
      + (SELECT count(*) FROM (SELECT 1 FROM ${table}
        WHERE machine_id = ${machineId}::uuid AND observed_at <= ${bounds.from}::timestamptz AND observed_at < ${bounds.to}::timestamptz LIMIT 1) AS began))::int AS total`;
  return total;
}

/** The events credited as this one is, as a condition on an event table. */
function heldBy(credit: Credit): Prisma.Sql {
  return credit.machineId !== null
    ? Prisma.sql`machine_id = ${credit.machineId}::uuid`
    : Prisma.sql`pending_machine_id = ${credit.pendingMachineId}::uuid`;
}

/** What a Workflow event's view is made from. */
type ViewedWorkflowEvent = Pick<WorkflowEvent, "id" | "observedAt" | "receivedAt" | "workflow" | "cause" | "pluginWrite">;

function viewWorkflowEvent(event: ViewedWorkflowEvent): WorkflowEventView {
  return {
    id: event.id.toString(),
    observedAt: event.observedAt.toISOString(),
    receivedAt: event.receivedAt.toISOString(),
    ...causeOf(event),
    workflow: event.workflow as Prisma.JsonObject,
  };
}

/** Who made a Workflow change, as stored, as the REST API gives it: a cause this release doesn't know, as a later release beside it may store, as unknown. */
function causeOf(event: Pick<WorkflowEvent, "cause" | "pluginWrite">): Pick<WorkflowEventView, "cause" | "pluginWrite"> {
  const plugin = event.cause === "plugin";
  return { cause: plugin ? "plugin" : event.cause === "other" ? "other" : "unknown", pluginWrite: plugin ? pluginWriteOf(event.pluginWrite) : null };
}

/** A Workflow event as the dial-in trail reads it (`workflowTrail`): the parts of its Workflow a summary reads, and the Library items it names. */
type TrailRow = Pick<WorkflowEvent, "id" | "observedAt" | "workflow" | "cause" | "pluginWrite"> & WorkflowLinks;

/** A `plugin` change's write as stored, or null for one this release doesn't know, as a later release beside it may store. */
function pluginWriteOf(write: string | null): PluginWorkflowWrite | null {
  return (PLUGIN_WORKFLOW_WRITES as readonly (string | null)[]).includes(write) ? (write as PluginWorkflowWrite) : null;
}

/** A Workflow event as read with the Library items it names (`workflowLinksSql`). */
type LinkedRow = ViewedWorkflowEvent & WorkflowLinks;

function viewLinkedWorkflowEvent({ profileId, beanBatchId, grinderId, basketId, recipeId, recipeName, ...event }: LinkedRow): LinkedWorkflowEventView {
  return { ...viewWorkflowEvent(event), links: { profileId, beanBatchId, grinderId, basketId, recipeId, recipeName } };
}

/** A Workflow event summarised, as the REST API's summary route returns it. */
export function summarised({ workflow, links, ...event }: LinkedWorkflowEventView): WorkflowSummaryView {
  return { ...event, workflow: workflowSummary(workflow, links) };
}

function viewMachineStateEvent(event: Pick<MachineStateEvent, "id" | "observedAt" | "receivedAt" | "state" | "substate">): MachineStateEventView {
  return {
    id: event.id.toString(),
    state: event.state,
    substate: event.substate,
    observedAt: event.observedAt.toISOString(),
    receivedAt: event.receivedAt.toISOString(),
  };
}
