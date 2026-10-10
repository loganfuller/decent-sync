import { Injectable } from "@nestjs/common";
import type { MachineStateDelivery, WorkflowDelivery } from "@decent-sync/protocol";
import { type MachineStateEvent, Prisma, type WorkflowEvent } from "../generated/prisma/client.js";
import { INTAKE_TRANSACTION } from "../library/intake.js";
import { takeInWorkflow } from "../library/location-settings.js";
import { type Credit, creditFirstDelivery } from "../machines/credit.js";
import { machineNotFound } from "../machines/input.js";
import type { MachineStateView } from "../machines/machines.service.js";
import { PrismaService } from "../prisma.service.js";
import type { Reporter } from "../sync/identity.js";

/** A page of a history, as `readPage` reads it from a request. */
type Page = { limit: number; offset: number };

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
 * Machine, is also taken into its Location's steam, hot water and rinse
 * settings in the same transaction (`takeInWorkflow`, ADR-0014).
 */
@Injectable()
export class MachineEventsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Stores a Workflow delivery, and returns where it was taken into its
   * Location's settings (`takeInWorkflow`): a `standing`, null if nowhere, as
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
        return takeInWorkflow(tx, { machineId: reporter.machineId, tabletId: reporter.tabletId }, message.workflow, message.observedAt);
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

  private async requireMachine(id: string): Promise<void> {
    if ((await this.prisma.machine.count({ where: { id } })) === 0) throw machineNotFound();
  }
}

/** The events credited as this one is, as a condition on an event table. */
function heldBy(credit: Credit): Prisma.Sql {
  return credit.machineId !== null
    ? Prisma.sql`machine_id = ${credit.machineId}::uuid`
    : Prisma.sql`pending_machine_id = ${credit.pendingMachineId}::uuid`;
}

function viewWorkflowEvent(event: WorkflowEvent): WorkflowEventView {
  return {
    id: event.id.toString(),
    observedAt: event.observedAt.toISOString(),
    receivedAt: event.receivedAt.toISOString(),
    workflow: event.workflow as Prisma.JsonObject,
  };
}

function viewMachineStateEvent(event: MachineStateEvent): MachineStateEventView {
  return {
    id: event.id.toString(),
    state: event.state,
    substate: event.substate,
    observedAt: event.observedAt.toISOString(),
    receivedAt: event.receivedAt.toISOString(),
  };
}
