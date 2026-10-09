import { Controller, Get, Param } from "@nestjs/common";
import { AllowStaff } from "../accounts/guards.js";
import { HistoryService, type VersionView } from "./history.service.js";
import { type GrinderSummary, type GrinderView, GrindersService, readGrinderId } from "./grinders.service.js";

/** The Library's Grinders, and the Location each belongs to. Read-only for now; Staff read them too. */
@AllowStaff()
@Controller("api/grinders")
export class GrindersController {
  constructor(
    private readonly grinders: GrindersService,
    private readonly history: HistoryService,
  ) {}

  @Get()
  async list(): Promise<{ grinders: GrinderSummary[] }> {
    return { grinders: await this.grinders.list() };
  }

  @Get(":id")
  async get(@Param("id") id: string): Promise<{ grinder: GrinderView }> {
    return { grinder: await this.grinders.get(readGrinderId(id)) };
  }

  /** Its versions, the latest taken in first (ADR-0020). */
  @Get(":id/history")
  async versions(@Param("id") id: string): Promise<{ versions: VersionView[] }> {
    return { versions: await this.history.versions({ kind: "grinder", id: readGrinderId(id) }) };
  }
}
