import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put } from "@nestjs/common";
import { CONFIG } from "../config.module.js";
import type { Config } from "../config.js";
import { MACHINE_MODELS, readHardware, readMachineId, readNewMachine, readPendingMachineId } from "./input.js";
import { type MachineView, MachinesService } from "./machines.service.js";
import { type PendingMachineView, PendingMachinesService } from "./pending-machines.service.js";

/** Machine entries: the Machines an Admin has adopted, their identity, tokens and status. */
@Controller("api/machines")
export class MachinesController {
  constructor(
    private readonly machines: MachinesService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Get()
  async list(): Promise<{ machines: MachineView[] }> {
    return { machines: await this.machines.list() };
  }

  /** The models an Admin may enter for an Unidentified Machine, as Decaid names them. */
  @Get("models")
  models(): { models: readonly string[] } {
    return { models: MACHINE_MODELS };
  }

  @Get(":id")
  async get(@Param("id") id: string): Promise<{ machine: MachineView }> {
    return { machine: await this.machines.get(readMachineId(id)) };
  }

  /**
   * Creates a machine entry. The response is the only time its token is
   * shown, together with the server URL to enter beside it in the plugin.
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
}

/** Hardware the server has seen that no Machine has, for an Admin to adopt or dismiss. */
@Controller("api/pending-machines")
export class PendingMachinesController {
  constructor(
    private readonly pending: PendingMachinesService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Get()
  async list(): Promise<{ pendingMachines: PendingMachineView[] }> {
    return { pendingMachines: await this.pending.list() };
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
