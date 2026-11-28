import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { AllowStaff, CurrentScope, CurrentSession } from "../accounts/guards.js";
import type { Scope } from "../accounts/scope.js";
import type { SignedIn } from "../accounts/sessions.service.js";
import { readLocationId } from "../locations/input.js";
import { PrismaService } from "../prisma.service.js";
import { hardDelete } from "./hard-deletes.js";
import { type HistoryView, HistoryService, readHistoryField } from "./history.service.js";
import { managementEditor } from "./history.js";
import { readArchived, readContentEdit, readShown } from "./item-input.js";
import { LibraryEditsService } from "./library-edits.service.js";
import { type ProfileSimulation, ProfileSimulationService, readSimulationAsk } from "./profile-simulation.service.js";
import { type PublishedView, PublishingService, readReturnAsk } from "./publishing.service.js";
import { type RecipeOnProfileView, RecipesService } from "./recipes.service.js";
import { ProfilePlacing } from "./profile-placing.js";
import { type ProfileSummary, type ProfileVersionsView, type ProfileView, ProfilesService, readProfileId } from "./profiles.service.js";

/**
 * The Library's Profiles, and the Locations showing each. Staff read them,
 * edit their title, author and notes, and Archive and restore them, as
 * Admins do, but show and hide them only at their own Locations; only an
 * Admin hard-deletes one. Their steps change only on tablets so far: Decaid
 * computes a Profile's id from what the machine executes (ADR-0032). Each
 * can be simulated on a puck (#577), which Viewers may too.
 *
 * Every `:id` is a Profile's own id or Decaid's id of one of its Profile
 * Versions (ADR-0038, `ProfilesService.addressed`). A Profile's own id
 * reads its current version. Its title, author and notes, where it is shown
 * and whether it is Archived are the Profile's, so those routes act on its
 * current version whichever of its versions is named; the rest read the
 * version named.
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
    private readonly publishing: PublishingService,
    private readonly placing: ProfilePlacing,
  ) {}

  /** One row for each Profile (`ProfilesService.list`), with its own id beside its current version's Decaid id. */
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
   * The Profile's Profile Versions (ADR-0038), the latest to join first,
   * each with its number, whether it is current, who saved it and how many
   * Shots are on it, and the Machines whose Workflow holds an earlier
   * version with no Recipe loaded (`ProfilesService.versions`).
   */
  @AllowStaff()
  @Get(":id/versions")
  async profileVersions(@Param("id") id: string, @CurrentScope() scope: Scope): Promise<ProfileVersionsView> {
    return this.profiles.versions(readProfileId(id), scope);
  }

  /** The Recipes, not Archived, that name any of the Profile's versions, each with the Machines that have it loaded now. 404 for no such Profile. */
  @AllowStaff()
  @Get(":id/recipes")
  async namingRecipes(@Param("id") id: string): Promise<{ recipes: RecipeOnProfileView[] }> {
    return { recipes: await this.recipes.namingProfile(await this.profiles.versionIds(readProfileId(id))) };
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
    const { currentVersionId } = await this.profiles.addressed(readProfileId(id));
    await this.edits.editProfile(currentVersionId, readContentEdit("profile", body), managementEditor(session.account.id));
    return { profile: await this.profiles.get(currentVersionId) };
  }

  /**
   * Returns to it, an earlier version of the Profile `from`
   * (`PublishingService.returnTo`): `{ from, locations, recipes? }`, shown
   * at the Locations, the Recipes naming `from` moved to it, and `from`
   * hidden there but where a Recipe not moved names it. Creates nothing.
   * Both are named by Decaid's id.
   */
  @AllowStaff()
  @Post(":id/return")
  @HttpCode(200)
  async returnTo(@Param("id") id: string, @Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ published: PublishedView }> {
    const ask = readReturnAsk(body);
    return { published: await this.publishing.returnTo(readProfileId(id), ask.from, ask, managementEditor(session.account.id), session.scope) };
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
    const { currentVersionId } = await this.profiles.addressed(readProfileId(id));
    await this.edits.showProfile(currentVersionId, readLocationId(locationId).toLowerCase(), readShown(body), managementEditor(session.account.id), session.scope);
    return { profile: await this.profiles.get(currentVersionId) };
  }

  /** Archives it or restores it: `{ archived }`. */
  @AllowStaff()
  @Put(":id/archived")
  async archive(@Param("id") id: string, @Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ profile: ProfileView }> {
    const { currentVersionId } = await this.profiles.addressed(readProfileId(id));
    await this.edits.archiveProfile(currentVersionId, readArchived(body), managementEditor(session.account.id));
    return { profile: await this.profiles.get(currentVersionId) };
  }

  /**
   * Deletes the version named, a Profile's own id naming its current one,
   * from the Library and every tablet that holds it, unless a Shot names it
   * or it is bundled with Decaid. A Profile left with other versions then
   * has the latest of them as its current one, and one left with none is
   * gone. Admins only.
   */
  @Delete(":id")
  @HttpCode(204)
  async remove(@Param("id") id: string): Promise<void> {
    const { versionId } = await this.profiles.addressed(readProfileId(id));
    await hardDelete(this.prisma, "profile", versionId);
    await this.placing.run();
  }

  /** Its history (ADR-0020, ADR-0033): its versions, the latest taken in first, and its Lost Edits, the latest lost first, or those of the field its query names. */
  @AllowStaff()
  @Get(":id/history")
  async versions(@Param("id") id: string, @Query() query: Record<string, unknown>, @CurrentScope() scope: Scope): Promise<HistoryView> {
    const { versionId } = await this.profiles.addressed(readProfileId(id));
    return this.history.history({ kind: "profile", id: versionId }, scope, readHistoryField(query));
  }
}
