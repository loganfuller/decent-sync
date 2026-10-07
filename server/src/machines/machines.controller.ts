import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put } from "@nestjs/common";
import { AllowStaff, CurrentScope } from "../accounts/guards.js";
import type { Scope } from "../accounts/scope.js";
import { CONFIG } from "../config.module.js";
import type { Config } from "../config.js";
import {
  MACHINE_MODELS,
  readCorrection,
  readHardware,
  readLocationHistoryEntryId,
  readMachineId,
  readMove,
  readNewMachine,
  readPendingMachineId,
} from "./input.js";
import { LocationHistoryService } from "./location-history.service.js";
import { type MachineView, MachinesService } from "./machines.service.js";
import { type PendingMachineView, PendingMachinesService } from "./pending-machines.service.js";

/**
 * Machine entries: the Machines an Admin has adopted, their identity, tokens
 * and status. Machine information is not private, so Staff read all of it;
 * what they may change is limited to moving Machines between the Locations
 * they work at. Every other change is for Admins.
 */
@Controller("api/machines")
export class MachinesController {
  constructor(
    private readonly machines: MachinesService,
    private readonly locationHistory: LocationHistoryService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @AllowStaff()
  @Get()
  async list(): Promise<{ machines: MachineView[] }> {
    return { machines: await this.machines.list() };
  }

  /** The models an Admin may enter for an Unidentified Machine, as Decaid names them. */
  @AllowStaff()
  @Get("models")
  models(): { models: readonly string[] } {
    return { models: MACHINE_MODELS };
  }

  @AllowStaff()
  @Get(":id")
  async get(@Param("id") id: string): Promise<{ machine: MachineView }> {
    return { machine: await this.machines.get(readMachineId(id)) };
  }

  /**
   * Creates a machine entry, optionally at a Location from now. The response
   * is the only time its token is shown, together with the server URL to
   * enter beside it in the plugin.
   */
  @Post()
  async create(@Body() body: unknown): Promise<{ machine: MachineView; token: string; serverUrl: string }> {
    return { ...(await this.machines.create(readNewMachine(body))), serverUrl: this.config.publicUrl.origin };
  }

  /**
   * Issues a new token and revokes the old one, which closes any connection
   * using it. The response is the only time the new token is shown.
   */
  @Post(":id/token")
  async reissueToken(@Param("id") id: string): Promise<{ machine: MachineView; token: string; serverUrl: string }> {
    return { ...(await this.machines.reissueToken(readMachineId(id))), serverUrl: this.config.publicUrl.origin };
  }

  /** Enters an Unidentified Machine's model and serial, which makes it identified. */
  @Put(":id/hardware")
  async identify(@Param("id") id: string, @Body() body: unknown): Promise<{ machine: MachineView }> {
    const machineId = readMachineId(id);
    return { machine: await this.machines.identify(machineId, readHardware(body)) };
  }

  /**
   * Moves the Machine to another Location: adds an entry to its Location
   * History, from now or from `effectiveFrom`, which must come after its
   * latest entry and not be in the future. Staff move Machines from now,
   * only between Locations they work at.
   */
  @AllowStaff()
  @Post(":id/location-history")
  async move(@Param("id") id: string, @Body() body: unknown, @CurrentScope() scope: Scope): Promise<{ machine: MachineView }> {
    const machineId = readMachineId(id);
    return { machine: await this.locationHistory.move(machineId, readMove(body), scope) };
  }

  /**
   * Corrects an entry's Location, when the Machine arrived there, or both,
   * which credits again the records whose time the change spans.
   */
  @Patch(":id/location-history/:entryId")
  async correctEntry(@Param("id") id: string, @Param("entryId") entryId: string, @Body() body: unknown): Promise<{ machine: MachineView }> {
    const machineId = readMachineId(id);
    const entry = readLocationHistoryEntryId(entryId);
    return { machine: await this.locationHistory.correct(machineId, entry, readCorrection(body)) };
  }

  /**
   * Removes an entry recorded by mistake, and the next one too when it names
   * the Location the Machine stayed at, which credits again the records
   * whose time the change spans.
   */
  @Delete(":id/location-history/:entryId")
  async removeEntry(@Param("id") id: string, @Param("entryId") entryId: string): Promise<{ machine: MachineView }> {
    const machineId = readMachineId(id);
    return { machine: await this.locationHistory.remove(machineId, readLocationHistoryEntryId(entryId)) };
  }
}

/** Hardware the server has seen that no Machine has, for an Admin to adopt or dismiss. Staff see it too. */
@Controller("api/pending-machines")
export class PendingMachinesController {
  constructor(
    private readonly pending: PendingMachinesService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @AllowStaff()
  @Get()
  async list(): Promise<{ pendingMachines: PendingMachineView[] }> {
    return { pendingMachines: await this.pending.list() };
  }

  /** One Pending Machine, as the list shows it. */
  @AllowStaff()
  @Get(":id")
  async get(@Param("id") id: string): Promise<{ pendingMachine: PendingMachineView }> {
    return { pendingMachine: await this.pending.get(readPendingMachineId(id)) };
  }

  /** Creates a machine entry for the hardware. The response is the only time its token is shown. */
  @Post(":id/machine")
  async createMachine(@Param("id") id: string, @Body() body: unknown): Promise<{ machine: MachineView; token: string; serverUrl: string }> {
    const pendingId = readPendingMachineId(id);
    return { ...(await this.pending.createMachine(pendingId, readNewMachine(body))), serverUrl: this.config.publicUrl.origin };
  }

  /** Dismisses the hardware, refusing it to the tokens it was reported with. */
  @Post(":id/dismiss")
  @HttpCode(200)
  async dismiss(@Param("id") id: string): Promise<{ pendingMachine: PendingMachineView }> {
    return { pendingMachine: await this.pending.dismiss(readPendingMachineId(id)) };
  }
}
