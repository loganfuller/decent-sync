import { Controller, Get, Param, Query } from "@nestjs/common";
import { AllowStaff } from "../accounts/guards.js";
import { readMachineId } from "../machines/input.js";
import { readPage } from "../pagination.js";
import { MachineEventsService, type WorkflowEventView, type WorkflowSummaryView, summarised } from "./machine-events.service.js";
import { type MachineUse, readUseRequest } from "./machine-use.js";

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

  /**
   * The Machine's current Workflow summarised, as an assistant reads it: the
   * parts the management interface shows, and its Basket and Recipe, with the
   * Library's ids of what it names (workflow-summary.ts); or null until its
   * tablet reports one.
   */
  @Get(":id/workflow-summary")
  async workflowSummary(@Param("id") id: string): Promise<{ workflow: WorkflowSummaryView | null }> {
    const current = await this.events.currentLinkedWorkflow(readMachineId(id));
    return { workflow: current && summarised(current) };
  }

  /** Every Workflow recorded for the Machine, latest first. */
  @Get(":id/workflow-events")
  workflowEvents(@Param("id") id: string, @Query("limit") limit?: string, @Query("offset") offset?: string) {
    const machineId = readMachineId(id);
    return this.events.workflowEvents(machineId, readPage(limit, offset));
  }

  /** The Machine's Loaded Recipes, latest first: its current one, if any, then each it had before, with when it was loaded and unloaded. */
  @Get(":id/loaded-recipes")
  loadedRecipes(@Param("id") id: string, @Query("limit") limit?: string, @Query("offset") offset?: string) {
    const machineId = readMachineId(id);
    return this.events.loadedRecipes(machineId, readPage(limit, offset));
  }

  /** Every machine state transition recorded for the Machine, latest first. */
  @Get(":id/machine-state-events")
  machineStateEvents(@Param("id") id: string, @Query("limit") limit?: string, @Query("offset") offset?: string) {
    const machineId = readMachineId(id);
    return this.events.machineStateEvents(machineId, readPage(limit, offset));
  }

  /**
   * How much the Machine was used over a range (`from`, `to`), by day or,
   * with `by=hour`, by hour of a range of at most a day: its Shots, Steam
   * Records, flushes and hot water pours, and its time in each Machine State,
   * in each day or hour of the Location it was at then (machine-use.ts).
   */
  @Get(":id/use")
  use(@Param("id") id: string, @Query() query: Record<string, unknown>): Promise<MachineUse> {
    return this.events.use(readMachineId(id), readUseRequest(query));
  }
}
