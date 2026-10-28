import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from "@nestjs/common";
import { AllowStaff, CurrentScope, CurrentSession } from "../accounts/guards.js";
import type { Scope } from "../accounts/scope.js";
import type { SignedIn } from "../accounts/sessions.service.js";
import { readLocationId } from "../locations/input.js";
import { PrismaService } from "../prisma.service.js";
import { hardDelete } from "./hard-deletes.js";
import { type ConflictView, HistoryService, type VersionView } from "./history.service.js";
import { readArchived, readContentEdit, readNewRecipe, readRecipeCopy, readSlot } from "./item-input.js";
import { RecipeEditsService } from "./recipe-edits.service.js";
import { type RecipeView, RecipesService, readRecipeId } from "./recipes.service.js";

/**
 * Each Location's Recipes, slotted and unslotted, and each Recipe's history
 * and Conflicts (ADR-0005, ADR-0020), which Staff read as Admins do. They
 * join the Library from tablets, or are created or copied here; Staff create,
 * edit, slot, take out of their slots, Archive and restore them, and copy
 * one to a Location, only at the Locations they work at, as a Recipe belongs
 * to one. Only an Admin hard-deletes one, which no Shot is linked to.
 */
@Controller("api")
export class RecipesController {
  constructor(
    private readonly recipes: RecipesService,
    private readonly edits: RecipeEditsService,
    private readonly history: HistoryService,
    private readonly prisma: PrismaService,
  ) {}

  /** The Location's Recipes: those in its slots, in slot order, then the rest. */
  @AllowStaff()
  @Get("locations/:id/recipes")
  async atLocation(@Param("id") id: string): Promise<{ recipes: RecipeView[] }> {
    return { recipes: await this.recipes.atLocation(readLocationId(id).toLowerCase()) };
  }

  /** Creates one at a Location: `{ locationId, slot, content }`, `slot` a number, `next` or null (the default) for none. */
  @AllowStaff()
  @Post("recipes")
  async create(@Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ recipe: RecipeView }> {
    const { locationId, slot, content } = readNewRecipe(body);
    return { recipe: await this.recipes.get(await this.edits.create(locationId, content, slot, session.account.id, session.scope)) };
  }

  @AllowStaff()
  @Get("recipes/:id")
  async get(@Param("id") id: string): Promise<{ recipe: RecipeView }> {
    return { recipe: await this.recipes.get(readRecipeId(id)) };
  }

  /** Edits its content: `{ content }`, each field to change, null to clear it. */
  @AllowStaff()
  @Patch("recipes/:id")
  async edit(@Param("id") id: string, @Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ recipe: RecipeView }> {
    const recipeId = readRecipeId(id);
    await this.edits.edit(recipeId, readContentEdit("recipe", body), session.account.id, session.scope);
    return { recipe: await this.recipes.get(recipeId) };
  }

  /** Moves it to a slot, swapping with the Recipe there, or to the lowest free one, or takes it out of its slot: `{ slot }`, a number, `next` or null. */
  @AllowStaff()
  @Put("recipes/:id/slot")
  async place(@Param("id") id: string, @Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ recipe: RecipeView }> {
    const recipeId = readRecipeId(id);
    await this.edits.place(recipeId, readSlot(body), session.account.id, session.scope);
    return { recipe: await this.recipes.get(recipeId) };
  }

  /**
   * Copies it to a Location as a new Recipe there, naming it in its history:
   * `{ locationId, slot, grinderId, beanBatchId }`, `slot` a number, `next` or
   * null (the default) for none, `grinderId` one of the Location's Grinders
   * or null, and `beanBatchId`, if given, the batch it uses instead of this
   * one's, or null for none.
   */
  @AllowStaff()
  @Post("recipes/:id/copies")
  async copy(@Param("id") id: string, @Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ recipe: RecipeView }> {
    const copied = await this.edits.copy(readRecipeId(id), readRecipeCopy(body), session.account.id, session.scope);
    return { recipe: await this.recipes.get(copied) };
  }

  /** Archives it, which takes it out of its slot, or restores it, in no slot: `{ archived }`. */
  @AllowStaff()
  @Put("recipes/:id/archived")
  async archive(@Param("id") id: string, @Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ recipe: RecipeView }> {
    const recipeId = readRecipeId(id);
    await this.edits.archive(recipeId, readArchived(body), session.account.id, session.scope);
    return { recipe: await this.recipes.get(recipeId) };
  }

  /**
   * Deletes it from the Library and from every tablet that holds it, unless
   * a Shot is linked to it, pulled while a Machine had it loaded. Admins
   * only.
   */
  @Delete("recipes/:id")
  @HttpCode(204)
  async remove(@Param("id") id: string): Promise<void> {
    await hardDelete(this.prisma, "recipe", readRecipeId(id));
  }

  /** Its versions, the latest taken in first (ADR-0020). */
  @AllowStaff()
  @Get("recipes/:id/history")
  async versions(@Param("id") id: string, @CurrentScope() scope: Scope): Promise<{ versions: VersionView[] }> {
    return { versions: await this.history.versions({ kind: "recipe", id: readRecipeId(id) }, scope) };
  }

  /** Its open Conflicts, the latest first (ADR-0020). */
  @AllowStaff()
  @Get("recipes/:id/conflicts")
  async conflicts(@Param("id") id: string, @CurrentScope() scope: Scope): Promise<{ conflicts: ConflictView[] }> {
    return { conflicts: await this.history.openConflicts(scope, { kind: "recipe", id: readRecipeId(id) }) };
  }
}
