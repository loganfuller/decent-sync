import { BadRequestException, Body, Controller, Get, Param, Put } from "@nestjs/common";
import { AllowStaff } from "../accounts/guards.js";
import { readMachineId } from "../machines/input.js";
import type { SharingStatusView } from "./sharing-status.js";
import { SharingService } from "./sharing.service.js";

/** Each Machine's sharing: its status, which Staff read as Admins do, and its capture-only switch, Admins only, as turning it off stops a Machine sharing. */
@Controller("api/machines")
export class SharingController {
  constructor(private readonly sharing: SharingService) {}

  /** The Machine's sharing status: the changes its tablet is due, the last it applied, and those it refused. */
  @AllowStaff()
  @Get(":id/sharing-status")
  async status(@Param("id") id: string): Promise<{ status: SharingStatusView }> {
    return { status: await this.sharing.status(readMachineId(id)) };
  }

  /** Turns the Machine's sharing on or off: `{ sharing }`. Off, it is a Capture-only Machine. */
  @Put(":id/sharing")
  async setSharing(@Param("id") id: string, @Body() body: unknown): Promise<{ sharing: boolean }> {
    const sharing = typeof body === "object" && body !== null ? (body as { sharing?: unknown }).sharing : undefined;
    if (typeof sharing !== "boolean") throw new BadRequestException("Send sharing: true or false");
    return this.sharing.setSharing(readMachineId(id), sharing);
  }
}
