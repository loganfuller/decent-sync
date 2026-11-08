import { BadRequestException, Injectable } from "@nestjs/common";
import type { LibraryKind } from "@decent-sync/protocol";
import { type McpContext, Tool } from "@nestjs/mcp";
import * as z from "zod";
import { CHANGE, READ } from "../connected-apps/oauth.js";
import { readBeanBatchId } from "../library/bean-batches.service.js";
import { readBeanId } from "../library/beans.service.js";
import { ConflictsService, readSeen } from "../library/conflicts.service.js";
import type { EquipmentKind } from "../library/equipment.js";
import { readEquipmentId } from "../library/equipment.service.js";
import { readGrinderId } from "../library/grinders.service.js";
import type { Editor } from "../library/history.js";
import type { FieldType } from "../library/item-input.js";
import {
  BASKET_SIZES,
  rangeText,
  readContentEdit,
  readGrinderLocation,
  readNewBatch,
  readNewContent,
  readNewEquipment,
  readPlacement,
} from "../library/item-input.js";
import { KINDS } from "../library/kinds.js";
import { LibraryEditsService } from "../library/library-edits.service.js";
import { readProfileId } from "../library/profiles.service.js";
import { RecipeEditsService } from "../library/recipe-edits.service.js";
import { readRecipeId } from "../library/recipes.service.js";
import { readLocationId } from "../locations/input.js";
import { type ConflictOutput, type ItemOutput, LibraryTools, TIMES, beanBatchItem, beanItem, conflict, itemOutput, kind } from "./library.tools.js";
import { callerOf } from "./token-verifier.js";

// The Library changed through an assistant (#411, #412, ADR-0026): Beans,
// Bean Batches, Grinders, Baskets and Tools created and edited, any item
// Archived or restored, what a Location offers changed, and a Conflict's
// value used or dismissed, each by the service its REST route calls, so a
// change is timed and merged as the management interface's are (ADR-0020),
// reaches tablets the same way, and is refused, with the same message,
// wherever the REST API would refuse it, Staff's limits included. Each is
// recorded as the account's, through its Connected App. Every tool needs the
// `change` scope besides `read`, so a Connected App granted only `read`, or a
// Viewer's, is refused with 403 `insufficient_scope`, and may offer to
// reconnect. Recipes' own tools are in recipe-changes.tools.ts.

const id = z.string();

/** The kinds whose content the management interface sets, as an assistant does (`editable` in kinds.ts). */
export type EditableKind = Exclude<LibraryKind, "profile">;

/** What each field of each kind an assistant creates and edits is, as Decaid or DYE2 keeps it, for the tools' schemas. */
const FIELD_NOTES: Readonly<Record<EditableKind, Readonly<Record<string, string>>>> = {
  bean: {
    roaster: "Who roasted it, such as a company or brand.",
    name: "Its name, as its roaster sells it, such as a single origin or a blend.",
    species: "Such as Arabica, Robusta or Liberica.",
    decaf: "Whether it is decaffeinated; false for a new one if not given.",
    decafProcess: "How it was decaffeinated, such as Swiss Water or CO2.",
    country: "Its country of origin.",
    region: "Its region, state or province.",
    producer: "Its farm, estate or cooperative.",
    variety: "Its varieties, such as Geisha or SL28.",
    altitude: "The altitude it was grown at, in metres above sea level: one, or the lowest and highest of a range.",
    processing: "Such as Washed, Natural or Honey.",
    notes: "Notes about the coffee.",
  },
  beanBatch: {
    roastDate: "The day it was roasted.",
    roastLevel: "Such as Light, Medium or Dark.",
    harvestDate: "Its harvest season or year, as text.",
    qualityScore: "Its SCA cupping score, out of 100.",
    price: "The price paid for it, in its currency.",
    currency: "Its ISO 4217 code, such as USD or EUR.",
    weight: "The bag's weight, in grams.",
    buyDate: "The day it was bought.",
    openDate: "The day it was first opened.",
    bestBeforeDate: "Its best before day.",
    freezeDate: "The day it was frozen.",
    unfreezeDate: "The day it was thawed.",
    frozen: "Whether it is frozen now; false for a new one if not given.",
    notes: "Notes about this roast.",
  },
  grinder: {
    model: "Its make and model, such as Mahlkönig EK43.",
    burrs: "Its burrs, such as SSP High Uniformity.",
    burrSize: "Its burrs' diameter, in mm.",
    burrType: "Such as flat or conical.",
    notes: "Notes about it.",
    settingType: "How its setting is chosen: numeric, a number on its dial, or preset, one of settingValues; numeric for a new one if not given.",
    settingValues: "Its preset settings, in order, for a preset Grinder.",
    settingSmallStep: "How much a small step on the tablet changes its setting.",
    settingBigStep: "How much a big step on the tablet changes its setting.",
    rpmSmallStep: "How much a small step on the tablet changes its RPM.",
    rpmBigStep: "How much a big step on the tablet changes its RPM.",
    feedRate: "Which feed rates it takes, as text, such as manual FF/MF/SF.",
  },
  basket: {
    name: "Its name, such as VST 18g.",
    size: "Its size.",
    diameterMm: "Its diameter, in mm.",
    notes: "Notes about it.",
  },
  tool: {
    name: "Its name, such as WDT tool or puck screen.",
    custom: "Its attributes, each a key and a value, such as { key: thickness, value: 1.7 mm }. A pair whose key is empty is left out.",
  },
  recipe: {
    name: "Its name.",
    beverage: "The drink it makes, such as Espresso or Cappuccino.",
    beanBatchId: "The id of the Bean Batch it uses, as find_library_items gives it, not Archived; its Bean is the batch's. A batch not at the Recipe's Location is added there. null for none, which clears its Bean too.",
    profileId: "The id of the Profile it uses, as find_library_items gives it, not Archived. One not shown at the Recipe's Location is shown there.",
    dose: "Its dose, in grams.",
    yield: "Its yield, in grams.",
    grinderId: "The id of its Grinder, as find_library_items gives it: one of the Recipe's Location's, not Archived.",
    grindSetting: "Its Grinder's setting.",
    rpm: "Its Grinder's speed, in RPM.",
    feedRate: "Its Grinder's feed rate, as text, such as MF or 1200.",
    brewTemperature: "Its brew temperature, in °C.",
    basketId: "The id of its Basket, as find_library_items gives it, not Archived. One not shown at the Recipe's Location is shown there.",
    toolIds: "The ids of its Tools, as find_library_items gives them, none Archived. Each not shown at the Recipe's Location is shown there.",
    toolAttributes: "Each Tool's attributes for this Recipe, such as a puck screen's thickness, by the Tool's id, only for the Tools it uses: each a list of a key and a value.",
    steamTemperature: "Its steam temperature, in °C.",
    steamDuration: "Its steam time, in seconds.",
    steamFlow: "Its steam flow, in ml/s.",
    steamStopTemperature: "Its milk stop, the milk's temperature in °C at which steaming stops.",
    hotWaterTemperature: "Its hot water temperature, in °C.",
    hotWaterDuration: "Its hot water time, in seconds.",
    hotWaterVolume: "Its hot water volume, in ml.",
    hotWaterFlow: "Its hot water flow, in ml/s.",
    flushTemperature: "Its flush temperature, in °C.",
    flushDuration: "Its flush time, in seconds.",
    flushFlow: "Its flush flow, in ml/s.",
  },
};

/** A Tool's attributes, as DYE2's equipment page keeps them, and a Recipe keeps a Tool's for it. */
const attributes = z.array(z.object({ key: z.string(), value: z.string() }));

/**
 * A field's schema, by the JSON type the REST API reads it as
 * (`item-input.ts`), with what its value must be in words. The REST API's
 * reader judges the value itself, so a value it refuses, such as one out of
 * its range or a size DYE2 doesn't offer, is refused with its message.
 */
function fieldSchema(type: FieldType): { schema: z.ZodType; note?: string } {
  if (typeof type === "object") return { schema: z.number(), note: `${capitalized(rangeText(type))}.` };
  switch (type) {
    case "name":
    case "text":
      return { schema: z.string() };
    case "flag":
      return { schema: z.boolean() };
    case "number":
      return { schema: z.number(), note: "0 or more." };
    case "date":
      return { schema: z.string(), note: "A day, such as 2026-10-01." };
    case "texts":
      return { schema: z.array(z.string()) };
    case "wholeNumbers":
      return { schema: z.array(z.number()), note: "Whole numbers." };
    case "settingType":
      return { schema: z.string() };
    case "basketSize":
      return { schema: z.string(), note: `One of ${BASKET_SIZES.slice(0, -1).join(", ")} or ${BASKET_SIZES.at(-1)}.` };
    case "attributes":
      return { schema: attributes };
    case "id":
    case "profileId":
      return { schema: z.string() };
    case "ids":
      return { schema: z.array(z.string()) };
    case "toolAttributes":
      return { schema: z.record(z.string(), attributes) };
    case "grindSetting":
      return { schema: z.union([z.number(), z.string()]), note: "A number of 0 or more, or text as typed, such as 2.5 or 1.1.0." };
  }
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A kind's content fields as a tool's input takes them, each by Decaid's or
 * DYE2's name, as the REST API takes them: each optional, but a new item's
 * names (a Bean's roaster and name, a Grinder's model, a Basket's or Tool's
 * name), and null for one that may be cleared, for none in a new item and
 * clearing it in an edit, as the REST API reads null.
 */
export function contentFields(kind: EditableKind, edit: boolean): z.ZodRawShape {
  const fields = KINDS[kind].editable!.fields;
  return Object.fromEntries(
    Object.entries(fields).map(([field, type]) => {
      const read = fieldSchema(type);
      const notes = [FIELD_NOTES[kind][field], read.note].filter((note) => note !== undefined);
      let schema = read.schema;
      // Decaid refuses to clear a name or a flag (`readValue` in item-input.ts).
      if (type !== "name" && type !== "flag") schema = schema.nullable();
      if (edit || type !== "name") schema = schema.optional();
      return [field, notes.length === 0 ? schema : schema.describe(notes.join(" "))];
    }),
  );
}

const newBeanInput = z.strictObject(contentFields("bean", false));
const beanEditInput = z.strictObject({ id: id.describe("The Bean's id, as find_library_items gives it."), ...contentFields("bean", true) });

const placeAt = z.strictObject({
  locationId: id.describe("The Location's id, as list_locations gives it."),
  remainingWeight: z.number().nullable().optional().describe("Its remaining weight there, in grams, 0 or more; null or left out for none."),
});
const newBatchInput = z.strictObject({
  beanId: id.describe("The id of the Bean it is a roast of, as find_library_items gives it. The Bean may not be Archived."),
  locations: z.array(placeAt).max(100).default([]).describe("The Locations to add it at, each once, with its remaining weight there if known. Staff add it only at the Locations they work at."),
  ...contentFields("beanBatch", false),
});
const batchEditInput = z.strictObject({ id: id.describe("The Bean Batch's id, as find_library_items gives it."), ...contentFields("beanBatch", true) });

const newGrinderInput = z.strictObject({
  locationId: id.describe("The id of the Location it belongs to, which never changes, as list_locations gives it."),
  ...contentFields("grinder", false),
});
const grinderEditInput = z.strictObject({ id: id.describe("The Grinder's id, as find_library_items gives it."), ...contentFields("grinder", true) });

const newEquipmentInput = (kind: EquipmentKind) =>
  z.strictObject({ locationId: id.describe("The id of the Location it is first shown at, as list_locations gives it."), ...contentFields(kind, false) });
const equipmentEditInput = (kind: EquipmentKind) =>
  z.strictObject({ id: id.describe(`The ${KINDS[kind].name}'s id, as find_library_items gives it.`), ...contentFields(kind, true) });
const newBasketInput = newEquipmentInput("basket");
const basketEditInput = equipmentEditInput("basket");
const newToolInput = newEquipmentInput("tool");
const toolEditInput = equipmentEditInput("tool");

const archivedInput = z.strictObject({
  kind,
  id: id.describe("Its id, as find_library_items gives it."),
  archived: z.boolean().describe("true to Archive it, false to restore it."),
});

/** The kinds a Location offers by a decision of its own: Profiles, Baskets and Tools it shows, and Bean Batches added there. */
const OFFERED_KINDS = ["profile", "basket", "tool", "beanBatch"] as const;
type OfferedKind = (typeof OFFERED_KINDS)[number];

const offeringInput = z.strictObject({
  kind: z.enum(OFFERED_KINDS).describe("profile (a Profile), basket (a Basket), tool (a Tool) or beanBatch (a Bean Batch)."),
  id: id.describe("Its id, as find_library_items gives it."),
  locationId: id.describe("The Location's id, as list_locations gives it."),
  offered: z
    .boolean()
    .optional()
    .describe("true to show a Profile, Basket or Tool at the Location, or add a Bean Batch there; false to hide it there, or finish the batch there. Required but for a Bean Batch's remaining weight alone."),
  remainingWeight: z
    .number()
    .nullable()
    .optional()
    .describe("A Bean Batch's remaining weight at the Location, in grams, 0 or more, null to clear it: only where it is, or is being added."),
});

const conflictInput = z.strictObject({
  id: id.describe("The Conflict's id, as list_conflicts or get_library_item gives it."),
  resolution: z
    .enum(["use", "dismiss"])
    .describe("use to make its value the field's latest edit, written to every tablet that holds the item; dismiss to close it, changing nothing else."),
  seen: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Required to use its value: its current.versionId, as list_conflicts or get_library_item gave it with the value now that the person was shown, null where that is null. Its value is used only over that value, so one decided since is never replaced unseen.",
    ),
});

const CHANGES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const STAFF_SHARED = "Staff make it as Admins do.";

/**
 * The Library changed through an assistant: each tool calls the service its
 * REST route calls, as the account and through its Connected App, then reads
 * the item back as get_library_item does.
 */
@Injectable()
export class LibraryChangesTools {
  constructor(
    private readonly edits: LibraryEditsService,
    private readonly recipeEdits: RecipeEditsService,
    private readonly conflicts: ConflictsService,
    private readonly library: LibraryTools,
  ) {}

  @Tool({
    name: "create_bean",
    title: "Create a Bean",
    description: `Creates a Bean: a coffee as a roaster sells it, by its roaster and name, which no other Bean may share, Archived or not. It is offered nowhere until one of its Bean Batches is added at a Location (create_bean_batch). ${STAFF_SHARED} ${TIMES}`,
    inputSchema: newBeanInput,
    outputSchema: z.object({ bean: beanItem }),
    annotations: CHANGES,
    scopes: [READ, CHANGE],
  })
  async createBean(input: z.infer<typeof newBeanInput>, context: McpContext): Promise<ItemOutput> {
    const beanId = await this.edits.createBean(readNewContent("bean", { content: input }), editorOf(context));
    return this.library.read("bean", beanId);
  }

  @Tool({
    name: "edit_bean",
    title: "Edit a Bean",
    description: `Edits a Bean's details, given only the fields to change: everywhere it is offered, its tablets are written the change. A field given null is cleared, but its roaster, name and decaf, which can't be. ${STAFF_SHARED} ${TIMES}`,
    inputSchema: beanEditInput,
    outputSchema: z.object({ bean: beanItem }),
    annotations: { ...CHANGES, idempotentHint: true },
    scopes: [READ, CHANGE],
  })
  async editBean({ id: beanId, ...fields }: z.infer<typeof beanEditInput>, context: McpContext): Promise<ItemOutput> {
    const values = readContentEdit("bean", { content: changed(fields) });
    await this.edits.editBean(readBeanId(beanId), values, editorOf(context));
    return this.library.read("bean", beanId);
  }

  @Tool({
    name: "create_bean_batch",
    title: "Create a Bean Batch",
    description: `Creates a Bean Batch, one roast of a Bean, added at each of the Locations given, whose tablets are then written it. Staff add one only at the Locations they work at. ${TIMES}`,
    inputSchema: newBatchInput,
    outputSchema: z.object({ beanBatch: beanBatchItem }),
    annotations: CHANGES,
    scopes: [READ, CHANGE],
  })
  async createBeanBatch({ beanId, locations, ...fields }: z.infer<typeof newBatchInput>, context: McpContext): Promise<ItemOutput> {
    const batch = readNewBatch({ beanId, locations, content: fields });
    const { scope } = callerOf(context);
    const batchId = await this.edits.createBatch(batch.beanId, batch.content, batch.locations, editorOf(context), scope);
    return this.library.read("beanBatch", batchId);
  }

  @Tool({
    name: "edit_bean_batch",
    title: "Edit a Bean Batch",
    description: `Edits a Bean Batch's details, given only the fields to change, everywhere it is: not where it is or its remaining weight there, which set_location_offering changes. A field given null is cleared, but frozen, which can't be. ${STAFF_SHARED} ${TIMES}`,
    inputSchema: batchEditInput,
    outputSchema: z.object({ beanBatch: beanBatchItem }),
    annotations: { ...CHANGES, idempotentHint: true },
    scopes: [READ, CHANGE],
  })
  async editBeanBatch({ id: batchId, ...fields }: z.infer<typeof batchEditInput>, context: McpContext): Promise<ItemOutput> {
    const values = readContentEdit("beanBatch", { content: changed(fields) });
    await this.edits.editBatch(readBeanBatchId(batchId), values, editorOf(context));
    return this.library.read("beanBatch", batchId);
  }

  @Tool({
    name: "create_grinder",
    title: "Create a Grinder",
    description: `Creates a Grinder belonging to a Location, which never changes, and written to that Location's tablets. Staff create one only at the Locations they work at. ${TIMES}`,
    inputSchema: newGrinderInput,
    outputSchema: z.object({ grinder: itemOutput.shape.grinder.unwrap() }),
    annotations: CHANGES,
    scopes: [READ, CHANGE],
  })
  async createGrinder({ locationId, ...fields }: z.infer<typeof newGrinderInput>, context: McpContext): Promise<ItemOutput> {
    const at = readGrinderLocation({ locationId });
    const grinderId = await this.edits.createGrinder(at, readNewContent("grinder", { content: fields }), editorOf(context), callerOf(context).scope);
    return this.library.read("grinder", grinderId);
  }

  @Tool({
    name: "edit_grinder",
    title: "Edit a Grinder",
    description: `Edits a Grinder's details, given only the fields to change, and its Location's tablets are written the change. A field given null is cleared, but its model, which can't be. Staff edit one only at the Locations they work at. ${TIMES}`,
    inputSchema: grinderEditInput,
    outputSchema: z.object({ grinder: itemOutput.shape.grinder.unwrap() }),
    annotations: { ...CHANGES, idempotentHint: true },
    scopes: [READ, CHANGE],
  })
  async editGrinder({ id: given, ...fields }: z.infer<typeof grinderEditInput>, context: McpContext): Promise<ItemOutput> {
    const values = changed(fields);
    const grinderId = readGrinderId(given);
    await this.edits.editGrinder(grinderId, readContentEdit("grinder", { content: values }), editorOf(context), callerOf(context).scope);
    return this.library.read("grinder", grinderId);
  }

  @Tool({
    name: "create_basket",
    title: "Create a Basket",
    description: `Creates a Basket, a model of filter basket, shown at one Location, whose tablets are then written it; set_location_offering shows it at others. Refused if the Library has a Basket of its name, Archived or not, ignoring case: find_library_items finds it, to show or restore instead. Staff create one only at the Locations they work at. ${TIMES}`,
    inputSchema: newBasketInput,
    outputSchema: z.object({ basket: itemOutput.shape.basket.unwrap() }),
    annotations: CHANGES,
    scopes: [READ, CHANGE],
  })
  async createBasket(input: z.infer<typeof newBasketInput>, context: McpContext): Promise<ItemOutput> {
    return this.createEquipment("basket", input, context);
  }

  @Tool({
    name: "edit_basket",
    title: "Edit a Basket",
    description: `Edits a Basket's details, given only the fields to change: everywhere it is shown, its tablets are written the change. A field given null is cleared, but its name, which can't be. ${STAFF_SHARED} ${TIMES}`,
    inputSchema: basketEditInput,
    outputSchema: z.object({ basket: itemOutput.shape.basket.unwrap() }),
    annotations: { ...CHANGES, idempotentHint: true },
    scopes: [READ, CHANGE],
  })
  async editBasket(input: z.infer<typeof basketEditInput>, context: McpContext): Promise<ItemOutput> {
    return this.editEquipment("basket", input, context);
  }

  @Tool({
    name: "create_tool",
    title: "Create a Tool",
    description: `Creates a Tool, equipment other than a Grinder or Basket, such as a tamper, WDT tool or puck screen, shown at one Location, whose tablets are then written it; set_location_offering shows it at others. Refused if the Library has a Tool of its name, Archived or not, ignoring case: find_library_items finds it, to show or restore instead. Staff create one only at the Locations they work at. ${TIMES}`,
    inputSchema: newToolInput,
    outputSchema: z.object({ tool: itemOutput.shape.tool.unwrap() }),
    annotations: CHANGES,
    scopes: [READ, CHANGE],
  })
  async createTool(input: z.infer<typeof newToolInput>, context: McpContext): Promise<ItemOutput> {
    return this.createEquipment("tool", input, context);
  }

  @Tool({
    name: "edit_tool",
    title: "Edit a Tool",
    description: `Edits a Tool's details, given only the fields to change: everywhere it is shown, its tablets are written the change. A field given null is cleared, but its name, which can't be. ${STAFF_SHARED} ${TIMES}`,
    inputSchema: toolEditInput,
    outputSchema: z.object({ tool: itemOutput.shape.tool.unwrap() }),
    annotations: { ...CHANGES, idempotentHint: true },
    scopes: [READ, CHANGE],
  })
  async editTool(input: z.infer<typeof toolEditInput>, context: McpContext): Promise<ItemOutput> {
    return this.editEquipment("tool", input, context);
  }

  @Tool({
    name: "set_archived",
    title: "Archive or restore a Library item",
    description: `Archives a Library item of any kind, retiring it everywhere: it is offered nowhere and leaves every tablet's lists, but is kept, so past Shots still name it, and nothing is deleted. Or restores one, offered again where it was. An Archived Bean takes its Bean Batches with it. Staff Archive and restore any item but a Recipe, which only at the Locations they work at. ${TIMES}`,
    inputSchema: archivedInput,
    outputSchema: itemOutput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    scopes: [READ, CHANGE],
  })
  async setArchived({ kind: itemKind, id: itemId, archived }: z.infer<typeof archivedInput>, context: McpContext): Promise<ItemOutput> {
    const editor = editorOf(context);
    switch (itemKind) {
      case "bean":
        await this.edits.archiveBean(readBeanId(itemId), archived, editor);
        break;
      case "beanBatch":
        await this.edits.archiveBatch(readBeanBatchId(itemId), archived, editor);
        break;
      case "profile":
        await this.edits.archiveProfile(readProfileId(itemId), archived, editor);
        break;
      case "grinder":
        await this.edits.archiveGrinder(readGrinderId(itemId), archived, editor);
        break;
      case "basket":
      case "tool":
        await this.edits.archiveEquipment(itemKind, readEquipmentId(itemKind, itemId), archived, editor);
        break;
      case "recipe":
        await this.recipeEdits.archive(readRecipeId(itemId), archived, editor, callerOf(context).scope);
        break;
    }
    return this.library.read(itemKind, itemId);
  }

  @Tool({
    name: "set_location_offering",
    title: "Change what a Location offers",
    description: `Shows or hides a Profile, Basket or Tool at a Location, or adds a Bean Batch there or finishes it there, and sets a batch's remaining weight there; the Location's tablets are written the change. Hiding a Basket or Tool removes it from the Location's tablets. Staff change only what the Locations they work at offer. ${TIMES}`,
    inputSchema: offeringInput,
    outputSchema: itemOutput,
    annotations: { ...CHANGES, idempotentHint: true },
    scopes: [READ, CHANGE],
  })
  async setLocationOffering(input: z.infer<typeof offeringInput>, context: McpContext): Promise<ItemOutput> {
    const editor = editorOf(context);
    const { scope } = callerOf(context);
    const locationId = readLocationId(input.locationId).toLowerCase();
    const itemKind: OfferedKind = input.kind;
    if (itemKind === "beanBatch") {
      if (input.offered === undefined && input.remainingWeight === undefined) {
        throw new BadRequestException("Send offered: true to add the Bean Batch at the Location or false to finish it there, or its remainingWeight there, or both");
      }
      const placement = readPlacement({ atLocation: input.offered, remainingWeight: input.remainingWeight });
      await this.edits.placeBatch(readBeanBatchId(input.id), locationId, placement, editor, scope);
    } else {
      if (input.remainingWeight !== undefined) throw new BadRequestException("Only a Bean Batch has a remaining weight at a Location");
      if (input.offered === undefined) throw new BadRequestException(`Send offered: true to show the ${KINDS[itemKind].name} at the Location, or false to hide it there`);
      if (itemKind === "profile") await this.edits.showProfile(readProfileId(input.id), locationId, input.offered, editor, scope);
      else await this.edits.showEquipment(itemKind, readEquipmentId(itemKind, input.id), locationId, input.offered, editor, scope);
    }
    return this.library.read(itemKind, input.id);
  }

  @Tool({
    name: "resolve_conflict",
    title: "Use or dismiss a Conflict's value",
    description: `Uses an open Conflict's value, which becomes the field's latest edit, written to every tablet that holds the item, or dismisses it, changing nothing else; either closes it. Its value is used only over the value now that the person was shown (seen), and is refused if the field has changed since. Staff resolve one about what a Location offers, or about a Grinder or Recipe, only at the Locations they work at: list_conflicts says whether this account may (resolvable). ${TIMES}`,
    inputSchema: conflictInput,
    outputSchema: z.object({ conflict }),
    annotations: { ...CHANGES, idempotentHint: true },
    scopes: [READ, CHANGE],
  })
  async resolveConflict({ id: conflictId, resolution, seen }: z.infer<typeof conflictInput>, context: McpContext): Promise<{ conflict: ConflictOutput }> {
    const { scope } = callerOf(context);
    const resolved =
      resolution === "use" ? await this.conflicts.use(conflictId, readSeen({ seen }), editorOf(context), scope) : await this.conflicts.dismiss(conflictId, scope);
    return { conflict: await this.library.conflict(resolved) };
  }

  /** Creates a Basket or Tool as its REST route does, shown at the Location given. */
  private async createEquipment(kind: EquipmentKind, { locationId, ...fields }: { locationId: string } & Record<string, unknown>, context: McpContext): Promise<ItemOutput> {
    const created = readNewEquipment(kind, { locationId, content: fields });
    const itemId = await this.edits.createEquipment(kind, created.locationId, created.content, editorOf(context), callerOf(context).scope);
    return this.library.read(kind, itemId);
  }

  /** Edits a Basket's or Tool's content as its REST route does. */
  private async editEquipment(kind: EquipmentKind, { id: given, ...fields }: { id: string } & Record<string, unknown>, context: McpContext): Promise<ItemOutput> {
    const values = changed(fields);
    const itemId = readEquipmentId(kind, given);
    await this.edits.editEquipment(kind, itemId, readContentEdit(kind, { content: values }), editorOf(context));
    return this.library.read(kind, itemId);
  }
}

/** Who a tool call changes the Library as: its account, through its Connected App. */
export function editorOf(context: McpContext): Editor {
  const { accountId, connectedAppId } = callerOf(context);
  return { accountId, connectedAppId };
}

/** The fields an edit gives, refused if none, as an edit changes at least one. */
export function changed(fields: Record<string, unknown>): Record<string, unknown> {
  const given = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  if (Object.keys(given).length === 0) throw new BadRequestException("Give at least one field to change");
  return given;
}
