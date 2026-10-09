import { Body, Controller, Delete, Get, HttpCode, Param, Put } from "@nestjs/common";
import { AllowStaff, CurrentScope, CurrentSession } from "../accounts/guards.js";
import type { Scope } from "../accounts/scope.js";
import type { SignedIn } from "../accounts/sessions.service.js";
import { readLocationId } from "../locations/input.js";
import { PrismaService } from "../prisma.service.js";
import { hardDelete } from "./hard-deletes.js";
import { type ConflictView, HistoryService, type VersionView } from "./history.service.js";
import { readArchived, readShown } from "./item-input.js";
import { LibraryEditsService } from "./library-edits.service.js";
import { type ProfileSummary, type ProfileView, ProfilesService, readProfileId } from "./profiles.service.js";

/**
 * The Library's Profiles, and the Locations showing each. Staff read them,
 * and Archive and restore them, as Admins do, but show and hide them only at
 * their own Locations; only an Admin hard-deletes one. No Profile is created
 * or edited here: Decaid computes a Profile's id from what the machine
 * executes, so Profiles join the Library from tablets.
 */
@Controller("api/profiles")
export class ProfilesController {
  constructor(
    private readonly profiles: ProfilesService,
    private readonly history: HistoryService,
    private readonly edits: LibraryEditsService,
    private readonly prisma: PrismaService,
  ) {}

  @AllowStaff()
  @Get()
  async list(): Promise<{ profiles: ProfileSummary[] }> {
    return { profiles: await this.profiles.list() };
  }

  @AllowStaff()
  @Get(":id")
  async get(@Param("id") id: string): Promise<{ profile: ProfileView }> {
    return { profile: await this.profiles.get(readProfileId(id)) };
  }

  /** Shows it at the Location or hides it there: `{ shown }`. */
  @AllowStaff()
  @Put(":id/locations/:locationId")
  async show(
    @Param("id") id: string,
    @Param("locationId") locationId: string,
    @Body() body: unknown,
    @CurrentSession() session: SignedIn,
  ): Promise<{ profile: ProfileView }> {
    const profileId = readProfileId(id);
    await this.edits.showProfile(profileId, readLocationId(locationId).toLowerCase(), readShown(body), session.account.id, session.scope);
    return { profile: await this.profiles.get(profileId) };
  }

  /** Archives it or restores it: `{ archived }`. */
  @AllowStaff()
  @Put(":id/archived")
  async archive(@Param("id") id: string, @Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ profile: ProfileView }> {
    const profileId = readProfileId(id);
    await this.edits.archiveProfile(profileId, readArchived(body), session.account.id);
    return { profile: await this.profiles.get(profileId) };
  }

  /** Deletes it from the Library and every tablet that holds it, unless a Shot names it or it is bundled with Decaid. Admins only. */
  @Delete(":id")
  @HttpCode(204)
  async remove(@Param("id") id: string): Promise<void> {
    await hardDelete(this.prisma, "profile", readProfileId(id));
  }

  /** Its versions, the latest taken in first (ADR-0020). */
  @AllowStaff()
  @Get(":id/history")
  async versions(@Param("id") id: string, @CurrentScope() scope: Scope): Promise<{ versions: VersionView[] }> {
    return { versions: await this.history.versions({ kind: "profile", id: readProfileId(id) }, scope) };
  }

  /** Its open Conflicts, the latest first (ADR-0020). */
  @AllowStaff()
  @Get(":id/conflicts")
  async conflicts(@Param("id") id: string, @CurrentScope() scope: Scope): Promise<{ conflicts: ConflictView[] }> {
    return { conflicts: await this.history.openConflicts(scope, { kind: "profile", id: readProfileId(id) }) };
  }
}
