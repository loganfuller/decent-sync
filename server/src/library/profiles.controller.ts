import { Controller, Get, Param } from "@nestjs/common";
import { AllowStaff, CurrentScope } from "../accounts/guards.js";
import type { Scope } from "../accounts/scope.js";
import { type ConflictView, HistoryService, type VersionView } from "./history.service.js";
import { type ProfileSummary, type ProfileView, ProfilesService, readProfileId } from "./profiles.service.js";

/** The Library's Profiles, and the Locations showing each. Read-only for now; Staff read them too. */
@AllowStaff()
@Controller("api/profiles")
export class ProfilesController {
  constructor(
    private readonly profiles: ProfilesService,
    private readonly history: HistoryService,
  ) {}

  @Get()
  async list(): Promise<{ profiles: ProfileSummary[] }> {
    return { profiles: await this.profiles.list() };
  }

  @Get(":id")
  async get(@Param("id") id: string): Promise<{ profile: ProfileView }> {
    return { profile: await this.profiles.get(readProfileId(id)) };
  }

  /** Its versions, the latest taken in first (ADR-0020). */
  @Get(":id/history")
  async versions(@Param("id") id: string): Promise<{ versions: VersionView[] }> {
    return { versions: await this.history.versions({ kind: "profile", id: readProfileId(id) }) };
  }

  /** Its open Conflicts, the latest first (ADR-0020). */
  @Get(":id/conflicts")
  async conflicts(@Param("id") id: string, @CurrentScope() scope: Scope): Promise<{ conflicts: ConflictView[] }> {
    return { conflicts: await this.history.openConflicts(scope, { kind: "profile", id: readProfileId(id) }) };
  }
}
