import { Controller, Get, Param } from "@nestjs/common";
import { AllowStaff } from "../accounts/guards.js";
import { type GrinderSummary, type GrinderView, GrindersService, readGrinderId } from "./grinders.service.js";

/** The Library's Grinders, and the Location each belongs to. Read-only for now; Staff read them too. */
@AllowStaff()
@Controller("api/grinders")
export class GrindersController {
  constructor(private readonly grinders: GrindersService) {}

  @Get()
  async list(): Promise<{ grinders: GrinderSummary[] }> {
    return { grinders: await this.grinders.list() };
  }

  @Get(":id")
  async get(@Param("id") id: string): Promise<{ grinder: GrinderView }> {
    return { grinder: await this.grinders.get(readGrinderId(id)) };
  }
}
