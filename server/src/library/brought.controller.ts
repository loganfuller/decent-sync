import { Controller, Get, Param } from "@nestjs/common";
import { AllowStaff } from "../accounts/guards.js";
import { readMachineId } from "../machines/input.js";
import { type BroughtItemView, BroughtService } from "./brought.service.js";

/** What each Machine's tablet brought to the Library as it joined a Location. Staff read it too. */
@AllowStaff()
@Controller("api/machines")
export class BroughtController {
  constructor(private readonly brought: BroughtService) {}

  @Get(":id/brought")
  async list(@Param("id") id: string): Promise<{ brought: BroughtItemView[] }> {
    return { brought: await this.brought.brought(readMachineId(id)) };
  }
}
