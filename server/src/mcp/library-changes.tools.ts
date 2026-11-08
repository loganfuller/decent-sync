import { BadRequestException, Injectable } from "@nestjs/common";
import { type McpContext, Tool } from "@nestjs/mcp";
import * as z from "zod";
import { CHANGE, READ } from "../connected-apps/oauth.js";
import { readBeanBatchId } from "../library/bean-batches.service.js";
import { readBeanId } from "../library/beans.service.js";
import { readEquipmentId } from "../library/equipment.service.js";
import { readGrinderId } from "../library/grinders.service.js";
import type { Editor } from "../library/history.js";
import type { FieldType } from "../library/item-input.js";
import { readContentEdit, readNewBatch, readNewContent, readPlacement } from "../library/item-input.js";
import { KINDS } from "../library/kinds.js";
import { LibraryEditsService } from "../library/library-edits.service.js";
import { readProfileId } from "../library/profiles.service.js";
import { RecipeEditsService } from "../library/recipe-edits.service.js";
import { readRecipeId } from "../library/recipes.service.js";
import { readLocationId } from "../locations/input.js";
import { type ItemOutput, LibraryTools, TIMES, beanBatchItem, beanItem, itemOutput, kind } from "./library.tools.js";
import { callerOf } from "./token-verifier.js";

// The Library changed through an assistant (#411, ADR-0026): Beans and Bean
// Batches created and edited, any item Archived or restored, and what a
// Location offers changed, each by the service its REST route calls, so a
// change is timed and merged as the management interface's are (ADR-0020),
// reaches tablets the same way, and is refused, with the same message,
// wherever the REST API would refuse it, Staff's limits included. Each is
// recorded as the account's, through its Connected App. Every tool needs the
// `change` scope besides `read`, so a Connected App granted only `read`, or a
// Viewer's, is refused with 403 `insufficient_scope`, and may offer to
// reconnect.

const id = z.string();

/** What each of a Bean's and a Bean Batch's fields is, as Decaid keeps it, for the tools' schemas. */
const FIELD_NOTES: Readonly<Record<"bean" | "beanBatch", Readonly<Record<string, string>>>> = {
  bean: {
    roaster: "Who roasted it, such as a company or brand.",
    name: "Its name, as its roaster sells it, such as a single origin or a blend.",
    species: "Such as Arabica, Robusta or Liberica.",
    decaf: "Whether it is decaffeinated; false if not given.",
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
    qualityScore: "Its SCA cupping score, 0 to 100.",
    price: "The price paid for it, in its currency.",
    currency: "Its ISO 4217 code, such as USD or EUR.",
    weight: "The bag's weight, in grams.",
    buyDate: "The day it was bought.",
    openDate: "The day it was first opened.",
    bestBeforeDate: "Its best before day.",
    freezeDate: "The day it was frozen.",
    unfreezeDate: "The day it was thawed.",
    frozen: "Whether it is frozen now; false if not given.",
    notes: "Notes about this roast.",
  },
};

const DAY = /^\d{4}-\d\d-\d\d$/;

/**
 * A field's schema, as the REST API reads its type (`item-input.ts`), which
 * reads the value again, so the tool refuses what the REST API would, with
 * the same message. Only the types a Bean's and a Bean Batch's fields have:
 * a kind whose fields have another is refused here as the server starts.
 */
function fieldSchema(type: FieldType): z.ZodType {
  switch (type) {
    case "name":
    case "text":
      return z.string();
    case "flag":
      return z.boolean();
    case "number":
      return z.number().min(0);
    case "date":
      return z.string().regex(DAY);
    case "texts":
      return z.array(z.string());
    case "wholeNumbers":
      return z.array(z.number().int());
    default:
      throw new Error(`No tool schema for a field of type ${JSON.stringify(type)}`);
  }
}

/**
 * A kind's content fields as a tool's input takes them, each by Decaid's
 * name, as the REST API takes them: for a new item, each optional but its
 * names (a Bean's roaster and name); for an edit, each optional, and null, or
 * empty text, clearing one that may be cleared.
 */
function contentFields(kind: "bean" | "beanBatch", edit: boolean): z.ZodRawShape {
  const fields = KINDS[kind].editable!.fields;
  return Object.fromEntries(
    Object.entries(fields).map(([field, type]) => {
      const notes = [FIELD_NOTES[kind][field], type === "date" ? "A day, such as 2026-10-01." : undefined].filter((note) => note !== undefined);
      let schema = fieldSchema(type);
      // Decaid refuses to clear a name or a flag (`readValue` in item-input.ts).
      if (edit && type !== "name" && type !== "flag") schema = schema.nullable();
      if (edit || type !== "name") schema = schema.optional();
      return [field, notes.length === 0 ? schema : schema.describe(notes.join(" "))];
    }),
  );
}

const newBeanInput = z.strictObject(contentFields("bean", false));
const beanEditInput = z.strictObject({ id: id.describe("The Bean's id, as find_library_items gives it."), ...contentFields("bean", true) });

const placeAt = z.strictObject({
  locationId: id.describe("The Location's id, as list_locations gives it."),
  remainingWeight: z.number().min(0).optional().describe("Its remaining weight there, in grams."),
});
const newBatchInput = z.strictObject({
  beanId: id.describe("The id of the Bean it is a roast of, as find_library_items gives it. The Bean may not be Archived."),
  locations: z.array(placeAt).max(100).default([]).describe("The Locations to add it at, each once, with its remaining weight there if known. Staff add it only at the Locations they work at."),
  ...contentFields("beanBatch", false),
});
const batchEditInput = z.strictObject({ id: id.describe("The Bean Batch's id, as find_library_items gives it."), ...contentFields("beanBatch", true) });

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
  remainingWeight: z.number().min(0).nullable().optional().describe("A Bean Batch's remaining weight at the Location, in grams, null to clear it: only where it is, or is being added."),
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
    description: `Edits a Bean's details, given only the fields to change: everywhere it is offered, its tablets are written the change. A field given null or empty text is cleared, but its roaster, name and decaf. ${STAFF_SHARED} ${TIMES}`,
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
    description: `Edits a Bean Batch's details, given only the fields to change, everywhere it is: not where it is or its remaining weight there, which set_location_offering changes. A field given null or empty text is cleared, but frozen. ${STAFF_SHARED} ${TIMES}`,
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
}

/** Who a tool call changes the Library as: its account, through its Connected App. */
function editorOf(context: McpContext): Editor {
  const { accountId, connectedAppId } = callerOf(context);
  return { accountId, connectedAppId };
}

/** The fields an edit gives, refused if none, as an edit changes at least one. */
function changed(fields: Record<string, unknown>): Record<string, unknown> {
  const given = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  if (Object.keys(given).length === 0) throw new BadRequestException("Give at least one field to change");
  return given;
}
