import { Injectable } from "@nestjs/common";
import type { MachineStateDelivery, WorkflowDelivery } from "@decent-sync/protocol";
import { type MachineStateEvent, Prisma, type WorkflowEvent } from "../generated/prisma/client.js";
import { machineNotFound } from "../machines/input.js";
import { type Holder, type MachineStateView, type Reporter, reporterHolder } from "../machines/machines.service.js";
import type { Page } from "../pagination.js";
import { PrismaService } from "../prisma.service.js";

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
 * An event is stored only if it differs from the latest one stored for whoever
 * it belongs to, and only once: the plugin keeps a delivery's id when it
 * sends it again, so a resend is not stored again, even one overtaken by the
 * changes after it. Both are decided against the database while that
 * Machine's row, or a Pending Machine's hardware, is locked, so sessions on
 * any server instance decide one at a time, never by what an instance or
 * connection remembers. The latest event stored is the current one; one
 * delivered late keeps the time the plugin observed it.
 */
@Injectable()
export class MachineEventsService {
  constructor(private readonly prisma: PrismaService) {}

  async storeWorkflow(message: WorkflowDelivery, reporter: Reporter): Promise<void> {
    const workflow = JSON.stringify(message.workflow);
    await this.prisma.$transaction(async (tx) => {
      const holder = await reporterHolder(tx, reporter);
      const held = heldBy(holder);
      await tx.$executeRaw`
        INSERT INTO workflow_events (delivery_id, machine_id, pending_machine_id, observed_at, workflow)
        SELECT ${message.id}, ${holder.machineId}::uuid, ${holder.pendingMachineId}::uuid, ${message.observedAt}::timestamptz, ${workflow}::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM (SELECT workflow FROM workflow_events WHERE ${held} ORDER BY id DESC LIMIT 1) AS latest
          WHERE latest.workflow = ${workflow}::jsonb
        ) AND NOT EXISTS (SELECT 1 FROM workflow_events WHERE ${held} AND delivery_id = ${message.id})`;
    });
  }

  async storeMachineState(message: MachineStateDelivery, reporter: Reporter): Promise<void> {
    const { state, substate } = message;
    await this.prisma.$transaction(async (tx) => {
      const holder = await reporterHolder(tx, reporter);
      const held = heldBy(holder);
      await tx.$executeRaw`
        INSERT INTO machine_state_events (delivery_id, machine_id, pending_machine_id, observed_at, state, substate)
        SELECT ${message.id}, ${holder.machineId}::uuid, ${holder.pendingMachineId}::uuid, ${message.observedAt}::timestamptz, ${state}, ${substate}
        WHERE NOT EXISTS (
          SELECT 1 FROM (SELECT state, substate FROM machine_state_events WHERE ${held} ORDER BY id DESC LIMIT 1) AS latest
          WHERE latest.state = ${state} AND latest.substate = ${substate}
        ) AND NOT EXISTS (SELECT 1 FROM machine_state_events WHERE ${held} AND delivery_id = ${message.id})`;
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

/** The holder's events, as a condition on an event table. */
function heldBy(holder: Holder): Prisma.Sql {
  return holder.machineId !== null
    ? Prisma.sql`machine_id = ${holder.machineId}::uuid`
    : Prisma.sql`pending_machine_id = ${holder.pendingMachineId}::uuid`;
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
