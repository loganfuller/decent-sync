import { Body, Controller, Get, Inject, Post } from "@nestjs/common";
import { CONFIG } from "../config.module.js";
import type { Config } from "../config.js";
import { readNewMachine } from "./input.js";
import { type MachineView, MachinesService } from "./machines.service.js";

/** Machine entries: the Machines an Admin has adopted, and their status. */
@Controller("api/machines")
export class MachinesController {
  constructor(
    private readonly machines: MachinesService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Get()
  async list(): Promise<{ machines: MachineView[] }> {
    return { machines: (await this.machines.list()).map((machine) => this.machines.view(machine)) };
  }

  /**
   * Creates a machine entry. The response is the only time its token is
   * shown, together with the server URL to enter beside it in the plugin.
   */
  @Post()
  async create(@Body() body: unknown): Promise<{ machine: MachineView; token: string; serverUrl: string }> {
    const { machine, token } = await this.machines.create(readNewMachine(body));
    return { machine: this.machines.view(machine), token, serverUrl: this.config.publicUrl.origin };
  }
}
