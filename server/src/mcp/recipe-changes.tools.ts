import { REQUESTABLE_RECIPE_SLOTS } from "@decent-sync/protocol";
import { Injectable } from "@nestjs/common";
import type { McpContext } from "@nestjs/mcp";
import * as z from "zod";
import { CHANGE, READ } from "../connected-apps/oauth.js";
import { readContentEdit, readNewRecipe, readRecipeCopy, readReferenceShot, readSlot } from "../library/item-input.js";
import { RecipeEditsService } from "../library/recipe-edits.service.js";
import { readRecipeId } from "../library/recipes.service.js";
import { changed, contentFields, editorOf } from "./library-changes.tools.js";
import { BudgetedTool } from "./budget.js";
import { type ItemOutput, LibraryTools, TIMES, itemOutput } from "./library.tools.js";
import { callerOf } from "./token-verifier.js";

// Recipes changed through an assistant (#412, ADR-0026): created and edited,
// put in a Recipe Slot or taken out of one, given a Reference Shot or
// cleared of it (#472, ADR-0029), and copied to another Location,
// each by the service its REST route calls (`RecipeEditsService`), so a
// change is timed and merged as the management interface's are (ADR-0020),
// is written to its Location's tablets and into the Workflow of every
// Machine that has the Recipe loaded (ADR-0022), and is refused, with the
// same message, wherever the REST API would refuse it. A Recipe belongs to
// one Location, so Staff change its Recipes, and copy one to it, only where
// they work. Each change is the account's, through its Connected App, and
// needs `change` besides `read`, as in library-changes.tools.ts.

const id = z.string();
const recipeId = id.describe("The Recipe's id, as find_library_items gives it.");

/** A Recipe Slot as the REST API takes one (`readSlot`): its number, `next` for the lowest one free, or null for none. */
const slot = z.union([z.number(), z.literal("next")]).nullable();
const SLOTS = `A Recipe Slot at its Location, 1 to ${REQUESTABLE_RECIPE_SLOTS}, each a button on its Machines' tablets; next for the lowest one free; or null for none.`;

const newRecipeInput = z.strictObject({
  locationId: id.describe("The id of the Location it belongs to, which never changes, as list_locations gives it."),
  slot: slot.optional().describe(`${SLOTS} A Recipe in that slot is taken out of it, kept at the Location. None if not given, or if next finds none free.`),
  ...contentFields("recipe", false),
});
const recipeEditInput = z.strictObject({ id: recipeId, ...contentFields("recipe", true) });
const slotInput = z.strictObject({
  id: recipeId,
  slot: slot.describe(`${SLOTS} A Recipe in that slot takes this one's place: its slot, or none.`),
});
const referenceShotInput = z.strictObject({
  id: recipeId,
  shotId: id.nullable().describe("The id of the Shot to make its Reference Shot, as find_shots gives it, from any Machine or Location, pulled with this Recipe or not; null to clear it."),
});
const copyInput = z.strictObject({
  id: recipeId,
  locationId: id.describe("The id of the Location to copy it to, another than its own, as list_locations gives it."),
  slot: slot.optional().describe(`The copy's. ${SLOTS} A Recipe in that slot is taken out of it. None if not given, or if next finds none free.`),
  grinderId: id
    .nullable()
    .describe("The copy's Grinder: the id of one of that Location's, not Archived, as find_library_items gives it, or null for none. A Grinder belongs to one Location, so the Recipe's own is never the copy's."),
  beanBatchId: id
    .nullable()
    .optional()
    .describe("The id of the Bean Batch the copy uses instead of the Recipe's, null for none, or left out to keep the Recipe's. One not at that Location is added there."),
});

const recipeOutput = z.object({ recipe: itemOutput.shape.recipe.unwrap() });
const CHANGES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const USES =
  "What it uses must be offered at its Location: its Grinder is one of the Location's, and a Bean Batch, Profile, Basket or Tool not offered there is offered there from then on. None may be Archived.";

/**
 * Recipes changed through an assistant: each tool calls the service its
 * REST route calls, as the account and through its Connected App, then reads
 * the Recipe back as get_library_item does.
 */
@Injectable()
export class RecipeChangesTools {
  constructor(
    private readonly edits: RecipeEditsService,
    private readonly library: LibraryTools,
  ) {}

  @BudgetedTool({
    name: "create_recipe",
    title: "Create a Recipe",
    description: `Creates a Recipe, a named, saved dial-in for a coffee, belonging to a Location, which never changes, and written to that Location's tablets, in the Recipe Slot chosen or none: any Machine there can load it. It holds the fields given; a steam, hot water or flush setting it holds none of is the Machine's own, which loading it leaves alone. ${USES} Staff create one only at the Locations they work at. ${TIMES}`,
    inputSchema: newRecipeInput,
    outputSchema: recipeOutput,
    annotations: CHANGES,
    scopes: [READ, CHANGE],
  })
  async createRecipe({ locationId, slot: chosen, ...fields }: z.infer<typeof newRecipeInput>, context: McpContext): Promise<ItemOutput> {
    const created = readNewRecipe({ locationId, slot: chosen, content: fields });
    const recipe = await this.edits.create(created.locationId, created.content, created.slot, editorOf(context), callerOf(context).scope);
    return this.library.read("recipe", recipe);
  }

  @BudgetedTool({
    name: "edit_recipe",
    title: "Edit a Recipe",
    description: `Edits a Recipe, given only the fields to change: its Location's tablets are written the change, and every Machine that has it loaded follows it in its Workflow, as an edit in the management interface does. A field given null is cleared: a steam, hot water or flush setting cleared is the Machine's own again. ${USES} DYE2's ratio is kept only while the yield is the dose times it. Staff edit one only at the Locations they work at. ${TIMES}`,
    inputSchema: recipeEditInput,
    outputSchema: recipeOutput,
    annotations: { ...CHANGES, idempotentHint: true },
    scopes: [READ, CHANGE],
  })
  async editRecipe({ id: given, ...fields }: z.infer<typeof recipeEditInput>, context: McpContext): Promise<ItemOutput> {
    const values = changed(fields);
    const recipe = readRecipeId(given);
    await this.edits.edit(recipe, readContentEdit("recipe", { content: values }), editorOf(context), callerOf(context).scope);
    return this.library.read("recipe", recipe);
  }

  @BudgetedTool({
    name: "set_recipe_slot",
    title: "Put a Recipe in a Recipe Slot",
    description: `Puts a Recipe in a Recipe Slot at its Location, swapping it with the Recipe there, which takes its old slot or none, or takes it out of its slot, keeping it at the Location, where any Machine can still load it. A Recipe is in at most one slot, and keeps its identity, history and any Machine that has it loaded when moved. An Archived Recipe is in no slot: restore it first (set_archived). Staff move Recipes only at the Locations they work at. ${TIMES}`,
    inputSchema: slotInput,
    outputSchema: recipeOutput,
    annotations: CHANGES,
    scopes: [READ, CHANGE],
  })
  async setRecipeSlot({ id: given, slot: chosen }: z.infer<typeof slotInput>, context: McpContext): Promise<ItemOutput> {
    const recipe = readRecipeId(given);
    await this.edits.place(recipe, readSlot({ slot: chosen }), editorOf(context), callerOf(context).scope);
    return this.library.read("recipe", recipe);
  }

  @BudgetedTool({
    name: "set_reference_shot",
    title: "Choose a Recipe's Reference Shot",
    description: `Makes a Shot a Recipe's Reference Shot, replacing any it has, or clears it: the one Shot that shows how the Recipe's Shots should go, which they are compared with, as a roaster compares each roast with a reference roast. Any Shot find_shots finds may be one, from any Machine or Location, on the Recipe's Profile or another, pulled with the Recipe or not, such as a Shot dialled in at another Location. It stays through edits to the Recipe until someone chooses another or clears it, and get_library_item gives it, saying where its Profile is another than the Recipe's. It is the server's alone: nothing is written to tablets, and it makes no Conflict, but the Recipe's history keeps each change. An Archived Recipe keeps its Reference Shot and may have it cleared, but is given none until restored (set_archived). Staff choose one only for Recipes of the Locations they work at. ${TIMES}`,
    inputSchema: referenceShotInput,
    outputSchema: recipeOutput,
    annotations: { ...CHANGES, idempotentHint: true },
    scopes: [READ, CHANGE],
  })
  async setReferenceShot({ id: given, shotId }: z.infer<typeof referenceShotInput>, context: McpContext): Promise<ItemOutput> {
    const recipe = readRecipeId(given);
    await this.edits.setReferenceShot(recipe, readReferenceShot({ shotId }), editorOf(context), callerOf(context).scope);
    return this.library.read("recipe", recipe);
  }

  @BudgetedTool({
    name: "copy_recipe",
    title: "Copy a Recipe to a Location",
    description: `Copies a Recipe to another Location as a new Recipe there, whose history names the Recipe it was copied from, which is not changed. The copy holds the Recipe's fields as they stand, its steam, hot water and flush settings included, but its Grinder, chosen from that Location's, the grind setting kept as a starting point, and its Bean Batch where another, or none, is chosen. It starts with the Recipe's Reference Shot. ${USES} Staff copy one, from any Location, only to the Locations they work at. ${TIMES}`,
    inputSchema: copyInput,
    outputSchema: recipeOutput,
    annotations: CHANGES,
    scopes: [READ, CHANGE],
  })
  async copyRecipe({ id: given, beanBatchId, ...to }: z.infer<typeof copyInput>, context: McpContext): Promise<ItemOutput> {
    const recipe = readRecipeId(given);
    // Left out, the copy keeps the Recipe's batch; null, it has none.
    const copy = readRecipeCopy({ ...to, ...(beanBatchId === undefined ? {} : { beanBatchId }) });
    const copied = await this.edits.copy(recipe, copy, editorOf(context), callerOf(context).scope);
    return this.library.read("recipe", copied);
  }
}
