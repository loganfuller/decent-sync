import { Controller, Get, Param } from "@nestjs/common";
import { AllowStaff, CurrentScope } from "../accounts/guards.js";
import type { Scope } from "../accounts/scope.js";
import { type ConflictView, HistoryService, type VersionView } from "./history.service.js";
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
  async versions(@Param("id") id: string, @CurrentScope() scope: Scope): Promise<{ versions: VersionView[] }> {
    return { versions: await this.history.versions({ kind: "grinder", id: readGrinderId(id) }, scope) };
  }

  /** Its open Conflicts, the latest first (ADR-0020). */
  @Get(":id/conflicts")
  async conflicts(@Param("id") id: string, @CurrentScope() scope: Scope): Promise<{ conflicts: ConflictView[] }> {
    return { conflicts: await this.history.openConflicts(scope, { kind: "grinder", id: readGrinderId(id) }) };
  }
}
