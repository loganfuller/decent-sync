import { Controller, Get, Param, Query } from "@nestjs/common";
import { AllowStaff, CurrentScope } from "../accounts/guards.js";
import type { Scope } from "../accounts/scope.js";
import { readMachineId } from "../machines/input.js";
import { readPage } from "../pagination.js";
import { MachineEventsService, type WorkflowEventView } from "./machine-events.service.js";

/**
 * What a Machine is set up to do next and what it has been doing, as its
 * tablet reported them. Staff see the current Workflow of the Machines at
 * their Locations; the histories span wherever a Machine has been, so they
 * are for Admins.
 */
@Controller("api/machines")
export class MachineEventsController {
  constructor(private readonly events: MachineEventsService) {}

  /** The Machine's current Workflow, or null until its tablet reports one. */
  @AllowStaff()
  @Get(":id/workflow")
  async workflow(@Param("id") id: string, @CurrentScope() scope: Scope): Promise<{ workflow: WorkflowEventView | null }> {
    return { workflow: await this.events.currentWorkflow(readMachineId(id), scope) };
  }

  /** Every Workflow recorded for the Machine, latest first. */
  @Get(":id/workflow-events")
  workflowEvents(@Param("id") id: string, @Query("limit") limit?: string, @Query("offset") offset?: string) {
    const machineId = readMachineId(id);
    return this.events.workflowEvents(machineId, readPage(limit, offset));
  }

  /** Every machine state transition recorded for the Machine, latest first. */
  @Get(":id/machine-state-events")
  machineStateEvents(@Param("id") id: string, @Query("limit") limit?: string, @Query("offset") offset?: string) {
    const machineId = readMachineId(id);
    return this.events.machineStateEvents(machineId, readPage(limit, offset));
  }
}
