import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { AllowStaff, CurrentSession } from "../accounts/guards.js";
import type { SignedIn } from "../accounts/sessions.service.js";
import { ConflictsService, readSeen } from "./conflicts.service.js";
import { type ConflictView, HistoryService } from "./history.service.js";

/**
 * The Library's Conflicts (ADR-0020). Staff read them as Admins do, and use
 * or dismiss those about items they can edit (`mayResolve`).
 */
@AllowStaff()
@Controller("api/conflicts")
export class ConflictsController {
  constructor(
    private readonly history: HistoryService,
    private readonly conflicts: ConflictsService,
  ) {}

  /** The open Conflicts, the latest first. */
  @Get()
  async list(@CurrentSession() session: SignedIn): Promise<{ conflicts: ConflictView[] }> {
    return { conflicts: await this.history.openConflicts(session.scope) };
  }

  /**
   * Uses its value, which becomes a new edit by the account, written to every tablet that holds the item, and closes
   * it. The body names the version of the field's value now that the account was shown: `{ seen }`, its
   * `current.versionId`.
   */
  @Post(":id/use")
  @HttpCode(200)
  async use(@Param("id") id: string, @Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ conflict: ConflictView }> {
    return { conflict: await this.conflicts.use(id, readSeen(body), session.account.id, session.scope) };
  }

  /** Closes it, changing nothing else. */
  @Post(":id/dismiss")
  @HttpCode(200)
  async dismiss(@Param("id") id: string, @CurrentSession() session: SignedIn): Promise<{ conflict: ConflictView }> {
    return { conflict: await this.conflicts.dismiss(id, session.scope) };
  }
}
