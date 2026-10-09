import { Controller, Get } from "@nestjs/common";
import { AllowStaff } from "../accounts/guards.js";
import { type ConflictView, HistoryService } from "./history.service.js";

/** The Library's open Conflicts (ADR-0020). Read-only for now; using a value and dismissing one come with ticket #85. Staff read them too. */
@AllowStaff()
@Controller("api/conflicts")
export class ConflictsController {
  constructor(private readonly history: HistoryService) {}

  @Get()
  async list(): Promise<{ conflicts: ConflictView[] }> {
    return { conflicts: await this.history.openConflicts() };
  }
}
