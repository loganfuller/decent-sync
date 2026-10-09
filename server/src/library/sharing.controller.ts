import { BadRequestException, Body, Controller, Param, Put } from "@nestjs/common";
import { readMachineId } from "../machines/input.js";
import { SharingService } from "./sharing.service.js";

/** The capture-only switch of each Machine: Admins only, as turning it off stops a Machine sharing. */
@Controller("api/machines")
export class SharingController {
  constructor(private readonly sharing: SharingService) {}

  /** Turns the Machine's sharing on or off: `{ sharing }`. Off, it is a Capture-only Machine. */
  @Put(":id/sharing")
  async setSharing(@Param("id") id: string, @Body() body: unknown): Promise<{ sharing: boolean }> {
    const sharing = typeof body === "object" && body !== null ? (body as { sharing?: unknown }).sharing : undefined;
    if (typeof sharing !== "boolean") throw new BadRequestException("Send sharing: true or false");
    return this.sharing.setSharing(readMachineId(id), sharing);
  }
}
