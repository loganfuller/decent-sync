import { Injectable } from "@nestjs/common";
import type { MachineStateDelivery, WorkflowDelivery } from "@decent-sync/protocol";
import { type MachineStateEvent, Prisma, type WorkflowEvent } from "../generated/prisma/client.js";
import { INTAKE_TRANSACTION } from "../library/intake.js";
import { takeInWorkflow } from "../library/joining.js";
import { type Credit, creditFirstDelivery } from "../machines/credit.js";
import { machineNotFound } from "../machines/input.js";
import type { MachineStateView } from "../machines/machines.service.js";
import { PrismaService } from "../prisma.service.js";
import type { Reporter } from "../sync/identity.js";
import { type LoadedRecipeView, loadedRecipeHistory, loadedRecipesDuring, takeInLoadedRecipe } from "./loaded-recipes.js";

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

/** A Machine's activity over a time range, a page of each kind asked for. */
export interface ActivityView {
  workflowChanges?: ActivityPage<WorkflowEventView>;
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
  /** Decaid's Workflow, as sent. */
  workflow: Prisma.JsonObject;
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
 * A Workflow from a connection that is not mismatched, for its token's
 * Machine, is also taken in at its Location in the same transaction
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
      await tx.$executeRaw`
        INSERT INTO workflow_events (machine_id, pending_machine_id, observed_at, workflow)
        SELECT ${credit.machineId}::uuid, ${credit.pendingMachineId}::uuid, ${message.observedAt}::timestamptz, ${workflow}::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM (SELECT workflow FROM workflow_events WHERE ${heldBy(credit)} ORDER BY id DESC LIMIT 1) AS latest
          WHERE latest.workflow = ${workflow}::jsonb
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
   * for, each latest first, by the tablet's clock: the Workflows and Machine
   * States in effect at any time in it, those observed in it and the one in
   * effect as it began, the latest observed then or before; and the Loaded
   * Recipes loaded at any time in it.
   */
  async activity(machineId: string, range: TimeRange, page: Page, kinds: readonly ActivityKind[]): Promise<ActivityView> {
    await this.requireMachine(machineId);
    const bounds = boundsOf(range);
    const [workflowChanges, loadedRecipes, machineStates] = await Promise.all([
      kinds.includes("workflowChanges") ? this.workflowEventsDuring(machineId, bounds, page) : undefined,
      kinds.includes("loadedRecipes") ? loadedRecipesDuring(this.prisma, machineId, bounds, page) : undefined,
      kinds.includes("machineStates") ? this.machineStateEventsDuring(machineId, bounds, page) : undefined,
    ]);
    return { workflowChanges, loadedRecipes, machineStates };
  }

  private async workflowEventsDuring(machineId: string, bounds: Bounds, page: Page): Promise<ActivityPage<WorkflowEventView>> {
    const table = Prisma.sql`workflow_events`;
    const [rows, total] = await Promise.all([
      this.prisma.$queryRaw<Pick<WorkflowEvent, "id" | "observedAt" | "receivedAt" | "workflow">[]>`
        SELECT id, observed_at AS "observedAt", received_at AS "receivedAt", workflow
        FROM ${inEffectDuring(table, Prisma.sql`id, observed_at, received_at, workflow`, machineId, bounds, page)}
        ORDER BY observed_at DESC, id DESC LIMIT ${page.limit} OFFSET ${page.offset}`,
      countInEffect(this.prisma, table, machineId, bounds),
    ]);
    return { entries: rows.map(viewWorkflowEvent), total };
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

function viewWorkflowEvent(event: Pick<WorkflowEvent, "id" | "observedAt" | "receivedAt" | "workflow">): WorkflowEventView {
  return {
    id: event.id.toString(),
    observedAt: event.observedAt.toISOString(),
    receivedAt: event.receivedAt.toISOString(),
    workflow: event.workflow as Prisma.JsonObject,
  };
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
