import { Controller, Get, Param } from "@nestjs/common";
import { AllowStaff, CurrentScope } from "../accounts/guards.js";
import type { Scope } from "../accounts/scope.js";
import { readLocationId } from "../locations/input.js";
import { type ConflictView, HistoryService, type VersionView } from "./history.service.js";
import { type RecipeView, RecipesService, readRecipeId } from "./recipes.service.js";

/**
 * Each Location's Recipes, slotted and unslotted, and each Recipe's history
 * and Conflicts (ADR-0005, ADR-0020), which Staff read as Admins do. They
 * join the Library from tablets; the management interface manages them in a
 * later ticket (#143).
 */
@AllowStaff()
@Controller("api")
export class RecipesController {
  constructor(
    private readonly recipes: RecipesService,
    private readonly history: HistoryService,
  ) {}

  /** The Location's Recipes: those in its slots, in slot order, then the rest. */
  @Get("locations/:id/recipes")
  async atLocation(@Param("id") id: string): Promise<{ recipes: RecipeView[] }> {
    return { recipes: await this.recipes.atLocation(readLocationId(id).toLowerCase()) };
  }

  @Get("recipes/:id")
  async get(@Param("id") id: string): Promise<{ recipe: RecipeView }> {
    return { recipe: await this.recipes.get(readRecipeId(id)) };
  }

  /** Its versions, the latest taken in first (ADR-0020). */
  @Get("recipes/:id/history")
  async versions(@Param("id") id: string, @CurrentScope() scope: Scope): Promise<{ versions: VersionView[] }> {
    return { versions: await this.history.versions({ kind: "recipe", id: readRecipeId(id) }, scope) };
  }

  /** Its open Conflicts, the latest first (ADR-0020). */
  @Get("recipes/:id/conflicts")
  async conflicts(@Param("id") id: string, @CurrentScope() scope: Scope): Promise<{ conflicts: ConflictView[] }> {
    return { conflicts: await this.history.openConflicts(scope, { kind: "recipe", id: readRecipeId(id) }) };
  }
}
