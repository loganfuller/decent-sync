import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Put, Query } from "@nestjs/common";
import { AllowStaff, CurrentScope, CurrentSession } from "../accounts/guards.js";
import type { Scope } from "../accounts/scope.js";
import type { SignedIn } from "../accounts/sessions.service.js";
import { readLocationId } from "../locations/input.js";
import { PrismaService } from "../prisma.service.js";
import { hardDelete } from "./hard-deletes.js";
import { type ConflictView, HistoryService, type VersionView, readHistoryField } from "./history.service.js";
import { managementEditor } from "./history.js";
import { readArchived, readContentEdit, readShown } from "./item-input.js";
import { LibraryEditsService } from "./library-edits.service.js";
import { type ProfileSimulation, ProfileSimulationService, readSimulationAsk } from "./profile-simulation.service.js";
import { type RecipeOnProfileView, RecipesService } from "./recipes.service.js";
import { type ProfileSummary, type ProfileVersionView, type ProfileView, ProfilesService, readProfileId } from "./profiles.service.js";

/**
 * The Library's Profiles, and the Locations showing each. Staff read them,
 * edit their title, author and notes, and Archive and restore them, as
 * Admins do, but show and hide them only at their own Locations; only an
 * Admin hard-deletes one. Their steps change only on tablets so far: Decaid
 * computes a Profile's id from what the machine executes (ADR-0032). Each
 * can be simulated on a puck (#577), which Viewers may too.
 */
@Controller("api/profiles")
export class ProfilesController {
  constructor(
    private readonly profiles: ProfilesService,
    private readonly history: HistoryService,
    private readonly edits: LibraryEditsService,
    private readonly prisma: PrismaService,
    private readonly simulation: ProfileSimulationService,
    private readonly recipes: RecipesService,
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

  /**
   * Its Profile Versions (ADR-0032), the chain of `parentId` links through
   * it, forks and all, the latest saved first, each with who saved it and
   * how many Shots are on it (`ProfilesService.versions`).
   */
  @AllowStaff()
  @Get(":id/versions")
  async profileVersions(@Param("id") id: string, @CurrentScope() scope: Scope): Promise<{ versions: ProfileVersionView[] }> {
    return { versions: await this.profiles.versions(readProfileId(id), scope) };
  }

  /** The Recipes, not Archived, that name it, each with the Machines that have it loaded now. 404 for no such Profile. */
  @AllowStaff()
  @Get(":id/recipes")
  async namingRecipes(@Param("id") id: string): Promise<{ recipes: RecipeOnProfileView[] }> {
    const profileId = readProfileId(id);
    if (!(await this.prisma.profile.count({ where: { id: profileId } }))) throw new NotFoundException("No such Profile");
    return { recipes: await this.recipes.namingProfile(profileId) };
  }

  /**
   * Simulates it on a puck (`ProfileSimulationService.simulate`): the
   * standard puck at `grind`, from -1 to 1, or the puck of the Shot
   * `shotId`, with `dose` in grams, stopping at `stopAt` grams, 0 to run its
   * steps out, on a Machine of `model`, DE1 or Bengle, else of the model it
   * is simulated as where it is shown (`ProfileView.machineModel`).
   */
  @AllowStaff()
  @Get(":id/simulation")
  async simulate(@Param("id") id: string, @Query() query: Record<string, unknown>): Promise<{ simulation: ProfileSimulation }> {
    return { simulation: await this.simulation.simulate(readProfileId(id), readSimulationAsk(query)) };
  }

  /**
   * Edits its title, author and notes: `{ content }`, each to change, an
   * empty author or notes for none; a title cannot be cleared. 409 for one
   * of Decaid's bundled Profiles.
   */
  @AllowStaff()
  @Patch(":id")
  async edit(@Param("id") id: string, @Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ profile: ProfileView }> {
    const profileId = readProfileId(id);
    await this.edits.editProfile(profileId, readContentEdit("profile", body), managementEditor(session.account.id));
    return { profile: await this.profiles.get(profileId) };
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
    await this.edits.showProfile(profileId, readLocationId(locationId).toLowerCase(), readShown(body), managementEditor(session.account.id), session.scope);
    return { profile: await this.profiles.get(profileId) };
  }

  /** Archives it or restores it: `{ archived }`. */
  @AllowStaff()
  @Put(":id/archived")
  async archive(@Param("id") id: string, @Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ profile: ProfileView }> {
    const profileId = readProfileId(id);
    await this.edits.archiveProfile(profileId, readArchived(body), managementEditor(session.account.id));
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
  async versions(@Param("id") id: string, @Query() query: Record<string, unknown>, @CurrentScope() scope: Scope): Promise<{ versions: VersionView[] }> {
    return { versions: await this.history.versions({ kind: "profile", id: readProfileId(id) }, scope, readHistoryField(query)) };
  }

  /** Its open Conflicts, the latest first (ADR-0020). */
  @AllowStaff()
  @Get(":id/conflicts")
  async conflicts(@Param("id") id: string, @CurrentScope() scope: Scope): Promise<{ conflicts: ConflictView[] }> {
    return { conflicts: await this.history.openConflicts(scope, { kind: "profile", id: readProfileId(id) }) };
  }
}
