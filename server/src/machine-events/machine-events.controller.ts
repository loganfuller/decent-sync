import { Controller, Get, Param, Query } from "@nestjs/common";
import { AllowStaff } from "../accounts/guards.js";
import { readMachineId } from "../machines/input.js";
import { readPage } from "../pagination.js";
import { MachineEventsService, type WorkflowEventView } from "./machine-events.service.js";

/** What a Machine is set up to do next and what it has been doing, as its tablet reported them. Staff read them too. */
@AllowStaff()
@Controller("api/machines")
export class MachineEventsController {
  constructor(private readonly events: MachineEventsService) {}

  /** The Machine's current Workflow, or null until its tablet reports one. */
  @Get(":id/workflow")
  async workflow(@Param("id") id: string): Promise<{ workflow: WorkflowEventView | null }> {
    return { workflow: await this.events.currentWorkflow(readMachineId(id)) };
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
