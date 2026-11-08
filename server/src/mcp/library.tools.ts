import { Injectable } from "@nestjs/common";
import { type McpContext, Tool } from "@nestjs/mcp";
import type { LibraryKind } from "@decent-sync/protocol";
import * as z from "zod";
import { READ } from "../connected-apps/oauth.js";
import { type BeanBatchSummary, type BeanBatchView, BeanBatchesService, readBeanBatchId } from "../library/bean-batches.service.js";
import { type BeanSummary, type BeanView, BeansService, readBeanId } from "../library/beans.service.js";
import { type EquipmentSummary, type EquipmentView, EquipmentService, readEquipmentId } from "../library/equipment.service.js";
import { type GrinderSummary, type GrinderView, GrindersService, readGrinderId } from "../library/grinders.service.js";
import { type ConflictView, HistoryService, type SourceView, type VersionView } from "../library/history.service.js";
import { type ProfileSummary, type ProfileView, ProfilesService, readProfileId } from "../library/profiles.service.js";
import { type RecipeView, RecipesService, readRecipeId } from "../library/recipes.service.js";
import { locationNotFound, readLocationId } from "../locations/input.js";
import { type LocationView, LocationsService, viewLocation } from "../locations/locations.service.js";
import { PrismaService } from "../prisma.service.js";
import { page, pageOf, pageOutput } from "./paging.js";
import { zonedTime } from "./times.js";
import { callerOf } from "./token-verifier.js";

// The Library, read through an assistant as the REST API reads it, calling
// the same services (#409, ADR-0026): its items of each kind, each one with
// its history and Conflicts, and the open Conflicts. Every account reads
// every item, as through the REST API; who made an edit or a Conflict is
// named as the REST API names it to the account.

const id = z.string();

/** Each Library kind by its glossary name, so a kind added to the Library is added to these tools, whose switches then fail to compile until they read it. */
export const KIND_NAMES: Readonly<Record<LibraryKind, string>> = {
  bean: "a Bean",
  beanBatch: "a Bean Batch",
  profile: "a Profile",
  grinder: "a Grinder",
  basket: "a Basket",
  tool: "a Tool",
  recipe: "a Recipe",
};
export const kind = z
  .enum(Object.keys(KIND_NAMES) as [LibraryKind, ...LibraryKind[]])
  .describe(`The kind of Library item: ${Object.entries(KIND_NAMES).map(([key, name]) => `${key} (${name})`).join(", ")}.`);

const location = z.object({ id, name: z.string(), timeZone: z.string().describe("Its IANA time zone. A day at the Location is a day in this zone.") });
const content = (what: string) => z.record(z.string(), z.unknown()).describe(what);
const RECORD_FIELDS = "Decaid's record fields, as the tablet that created it sent them and as edited since, those Decent Sync doesn't know included.";

/** Each time's offset, which every tool's description states. */
export const TIMES =
  "Times are ISO 8601 with a Location's offset: an item's createdAt with that of the Location it joined the Library at; a time of its state at a Location, such as a Bean Batch added there, and each edit and Conflict of that state, with that Location's; and a Grinder's or Recipe's other times, edits and Conflicts with that of the Location it belongs to. Others, such as a Bean's content edits, are in UTC.";

const time = (what: string) => z.string().describe(what);
const joinedAt = time("When it joined the Library.");
const createdLocation = location.nullable().describe("The Location it joined the Library at, as a tablet there reported it or as it was created for; null for none, such as a Bean created in the management interface.");
const shownAt = z
  .array(z.object({ location, since: time("When the Location last decided to show it.") }))
  .describe("The Locations showing it, by name. None while it is Archived.");
const decidedAt = z
  .array(z.object({ location, shown: z.boolean(), since: time("When that was last decided.") }))
  .describe("Each Location that has decided whether it shows it, by name, kept while it is Archived, so restoring it shows it again where it is shown. A Location not listed doesn't show it.");

const beanSummary = z.object({
  id,
  roaster: z.string().nullable(),
  name: z.string().nullable(),
  archived: z.boolean(),
  offeredAt: z
    .array(location)
    .describe("The Locations offering it, by name: each where one of its Bean Batches is, and each where it has no batch yet but a tablet there created, linked or un-archived it. None while it is Archived."),
  createdAt: joinedAt,
  createdLocation,
  likelyDuplicates: z
    .array(z.object({ id, roaster: z.string().nullable(), name: z.string().nullable() }))
    .describe("Other Beans with the same roaster and name, ignoring case: likely duplicates, never merged."),
});

const batchSummary = z.object({
  id,
  bean: z.object({ id, roaster: z.string().nullable(), name: z.string().nullable() }).describe("The Bean it is a roast of."),
  roastDate: z.string().nullable().describe("As Decaid recorded it."),
  archived: z.boolean(),
  locations: z
    .array(z.object({ location, remainingWeight: z.number().nullable().describe("Last entered there, in grams; null for none."), since: time("When it was last added there.") }))
    .describe("The Locations it is at, by name, kept while it or its Bean is Archived, though neither is offered anywhere then."),
  createdAt: joinedAt,
  createdLocation,
});

const profileSummary = z.object({
  id: id.describe("Decaid's id, the same on every tablet."),
  title: z.string().nullable(),
  author: z.string().nullable(),
  beverageType: z.string().nullable(),
  bundled: z.boolean().describe("Whether it is one of Decaid's bundled Profiles, which every tablet has already."),
  archived: z.boolean(),
  shownAt,
  createdAt: joinedAt,
  createdLocation,
});

const grinderSummary = z.object({
  id,
  model: z.string().nullable(),
  burrs: z.string().nullable(),
  burrType: z.string().nullable(),
  archived: z.boolean(),
  location: location.nullable().describe("The Location it belongs to, the only one offering it unless it is Archived."),
  createdAt: joinedAt,
});

const equipmentSummary = z.object({
  id,
  name: z.string().nullable(),
  archived: z.boolean(),
  shownAt,
  createdAt: joinedAt,
  createdLocation,
  content: content(`DYE2's record fields, as the tablet that created it sent them and as edited since, such as a Basket's size and a Tool's attributes.`),
});

const named = <T extends z.ZodRawShape>(what: T) => z.object({ id, ...what }).nullable();

const recipe = z.object({
  id,
  name: z.string().nullable(),
  location: location.nullable().describe("The Location it belongs to."),
  slot: z.number().int().nullable().describe("Its Recipe Slot at its Location, 1 to 5; null for none."),
  archived: z.boolean(),
  createdAt: joinedAt,
  content: content(
    "What it holds, in the Library's terms: name, beverage, beanId, beanBatchId, profileId, grinderId, basketId, toolIds and toolAttributes (a Tool's attributes for this Recipe, by the Tool's id), dose and yield in grams, ratio, grindSetting (a number, or text as typed), rpm, feedRate, brewTemperature in °C, and any steam, hot water and flush settings it holds (steamTemperature, steamDuration, steamFlow, steamStopTemperature, hotWaterTemperature, hotWaterDuration, hotWaterVolume, hotWaterFlow, flushTemperature, flushDuration and flushFlow, in °C, seconds, ml/s and ml), with DYE2's display modes steamMode and hotWaterMode. Each is left out where it holds none.",
  ),
  uses: z
    .object({
      bean: named({ roaster: z.string().nullable(), name: z.string().nullable() }),
      beanBatch: named({ roastDate: z.string().nullable(), atLocation: z.boolean().describe("Whether it is at the Recipe's Location now, neither it nor its Bean Archived.") }),
      profile: named({ title: z.string().nullable() }),
      grinder: named({ model: z.string().nullable() }),
      basket: named({ name: z.string().nullable() }),
      tools: z.array(z.object({ id, name: z.string().nullable() })),
    })
    .describe("The items its content names, with what names each; one the Library no longer has by its id alone."),
  batchFinished: z.boolean().describe("Whether it isn't Archived and names a Bean Batch that isn't at its Location now: a Recipe whose dial needs the next roast."),
});

const source = z
  .object({
    machine: z.object({ id, name: z.string() }).nullable().describe("The Machine whose tablet made it, if one did and it still exists."),
    tabletId: z.string().nullable().describe("The id of the tablet that made it, if one did; with no Machine, a tablet whose Machine has since been removed."),
    account: z
      .object({ id, name: z.string().nullable().describe("Shown to Admins only.") })
      .nullable()
      .describe("The account that made it, in the management interface or through a Connected App."),
    connectedApp: z
      .object({ id, name: z.string().describe("The name the app gave itself."), host: z.string().describe("The host its client id is published at, which no app chooses.") })
      .nullable()
      .describe("The Connected App, such as an assistant, the account made it through; null for the management interface."),
  })
  .describe("Where it came from: a Machine's tablet, or an account, in the management interface or through a Connected App.");

const version = z.object({
  id,
  fields: content(
    "The fields it set, each with its value: of the item's content, by Decaid's names, or of its state at its Location (atLocation, remainingWeight, shown). The first version is the item joining the Library.",
  ),
  location: location.nullable().describe("The Location whose state of the item it changed; null for its content."),
  source,
  editedAt: time("When it was made: a tablet's edit by the tablet's clock."),
  receivedAt: time("When the server took it in."),
  copiedFrom: z
    .object({ id, name: z.string().nullable(), location: location.nullable() })
    .nullable()
    .describe("For a copy, as a Recipe copied to a Location, its first version names the item it was copied from, and that item's Location then."),
});

const conflict = z.object({
  id,
  item: z.object({ kind, id, name: z.string().nullable() }).describe("The Library item it is about, by its kind, id and name."),
  field: z.string().describe("The field it is about: of the item's content, by Decaid's names, or of a Location's state of it (atLocation, remainingWeight, shown)."),
  value: z.unknown().describe("The losing value; null where the edit cleared the field."),
  location: location.nullable().describe("The Location whose state of the item the field is; null for the item's content."),
  source,
  editedAt: time("When the losing edit was made."),
  createdAt: time("When it became a Conflict."),
  state: z.enum(["open", "used", "dismissed"]),
  current: z
    .object({
      value: z.unknown().describe("Null where nothing set it, or the edit that set it last cleared it."),
      source: source.nullable().describe("Where the edit that set it came from; null if not known."),
      editedAt: time("When that edit was made.").nullable(),
      versionId: z.string().nullable().describe("That edit's version; null if not known."),
    })
    .describe("The field's value now, which the losing value lost to or was replaced by."),
  resolvable: z.boolean().describe("Whether this account may use its value or dismiss it."),
});

const findInput = z.object({
  kind,
  locationId: id
    .optional()
    .describe(
      "Those this Location offers: a Bean offered there, a Bean Batch at it, and a Profile, Basket or Tool shown there, none of them while Archived, nor a Bean Batch whose Bean is; and a Grinder or Recipe belonging to it, Archived or not.",
    ),
  name: z
    .string()
    .max(500)
    .optional()
    .describe("Those whose name has each of these words in it, ignoring case: a Bean's roaster and name, a Bean Batch's Bean's, a Profile's title, a Grinder's model, and a Basket's, Tool's or Recipe's name."),
  archived: z.boolean().optional().describe("true for those Archived alone, false for those not Archived alone; both if not given."),
  ...page,
  offset: page.offset.describe("How many to skip: the previous page's offset plus its length."),
});

const findOutput = z.object({
  beans: z.array(beanSummary).optional(),
  beanBatches: z.array(batchSummary).optional(),
  profiles: z.array(profileSummary).optional(),
  grinders: z.array(grinderSummary).optional(),
  baskets: z.array(equipmentSummary).optional(),
  tools: z.array(equipmentSummary).optional(),
  recipes: z.array(recipe).optional(),
  ...pageOutput,
});

const getInput = z.object({
  kind,
  id: id.describe("Its id, as find_library_items gives it."),
  history: z.boolean().default(false).describe("Whether to include its history: each edit accepted, the latest taken in first, with the fields it set, who or which Machine made it, and when."),
  conflicts: z.boolean().default(false).describe("Whether to include its open Conflicts, the latest first."),
  ...page,
});

const listed = <T extends z.ZodType>(entry: T, what: string) => z.object({ entries: z.array(entry), ...pageOutput }).optional().describe(what);

/** A Bean as get_library_item reads it, and as the tools changing one return it. */
export const beanItem = beanSummary.extend({ content: content(RECORD_FIELDS), batches: z.array(batchSummary).describe("Its Bean Batches, the latest roasted first.") });

/** A Bean Batch as get_library_item reads it, and as the tools changing one return it. */
export const beanBatchItem = batchSummary.extend({
  content: content(`${RECORD_FIELDS} Its remaining weight and whether it is Archived are each Location's, so left out.`),
  finished: z
    .array(z.object({ location, remainingWeight: z.number().nullable().describe("Last entered there, in grams."), finishedAt: time("When it was finished there.") }))
    .describe("The Locations it was at and has been finished at since, by name."),
});

/** One Library item, under its kind's key, as get_library_item reads it and the tools changing one return it. */
export const itemOutput = z.object({
  bean: beanItem.optional(),
  beanBatch: beanBatchItem.optional(),
  profile: profileSummary
    .extend({
      content: content(`${RECORD_FIELDS} Its visibility is each Location's, so left out.`),
      parent: z.object({ id, title: z.string().nullable() }).nullable().describe("The Profile it was saved from, as Streamline saves one whose steps changed, if the Library has it."),
      locations: decidedAt,
    })
    .optional(),
  grinder: grinderSummary.extend({ content: content(RECORD_FIELDS) }).optional(),
  basket: equipmentSummary.extend({ locations: decidedAt }).optional(),
  tool: equipmentSummary.extend({ locations: decidedAt }).optional(),
  recipe: recipe.optional(),
});

const getOutput = itemOutput.extend({
  history: listed(version, "Only when asked for: its versions, each an edit accepted, the latest taken in first. limit and offset page it."),
  conflicts: listed(conflict, "Only when asked for: its open Conflicts, the latest first. limit and offset page them."),
});

const conflictsOutput = z.object({ conflicts: z.array(conflict), ...pageOutput });

type FindInput = z.infer<typeof findInput>;
type FindOutput = z.infer<typeof findOutput>;
type GetOutput = z.infer<typeof getOutput>;
export type ItemOutput = z.infer<typeof itemOutput>;

/**
 * The Library, read through an assistant: each kind's items as the REST API
 * lists them, filtered by Location, name and whether Archived and paged, one
 * item as the REST API returns it, with its history and open Conflicts when
 * asked for, and every open Conflict. Times are given with the offset of the
 * Location they happened at (`TIMES`).
 */
@Injectable()
export class LibraryTools {
  constructor(
    private readonly beans: BeansService,
    private readonly batches: BeanBatchesService,
    private readonly profiles: ProfilesService,
    private readonly grinders: GrindersService,
    private readonly equipment: EquipmentService,
    private readonly recipes: RecipesService,
    private readonly history: HistoryService,
    private readonly locations: LocationsService,
    private readonly prisma: PrismaService,
  ) {}

  @Tool({
    name: "find_library_items",
    title: "Find Library items",
    description: `Finds the Library's items of one kind, a page at a time, as the management interface lists them, by Location, name and whether Archived: Beans, Bean Batches, Profiles, Grinders, Baskets, Tools or Recipes. Recipes come by Location, in Recipe Slot order, then those in no slot. ${TIMES}`,
    inputSchema: findInput,
    outputSchema: findOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
  })
  async findLibraryItems(input: FindInput): Promise<FindOutput> {
    const at = await this.locationOf(input.locationId);
    const paged = <T, R>(items: readonly T[], filtered: (item: T) => Filtered, view: (item: T) => R) => {
      const found = chosen(items, input, at, filtered);
      const shown = found.slice(input.offset, input.offset + input.limit);
      return { entries: shown.map(view), ...pageOf(found.length, input.offset, shown.length) };
    };
    switch (input.kind) {
      case "bean": {
        const { entries, ...rest } = paged(await this.beans.list(), (bean) => ({ archived: bean.archived, names: [bean.roaster, bean.name], at: bean.offeredAt }), beanOf);
        return { beans: entries, ...rest };
      }
      case "beanBatch": {
        // A batch keeps the Locations it is at while it or its Bean is Archived, but no Location offers it then (LIBRARY.md).
        const archivedBeans = at === undefined ? new Set<string>() : await this.archivedBeans();
        const { entries, ...rest } = paged(
          await this.batches.list(),
          (batch) => ({
            archived: batch.archived,
            names: [batch.bean.roaster, batch.bean.name],
            at: batch.archived || archivedBeans.has(batch.bean.id) ? [] : batch.locations.map((here) => here.location),
          }),
          batchOf,
        );
        return { beanBatches: entries, ...rest };
      }
      case "profile": {
        const { entries, ...rest } = paged(await this.profiles.list(), (profile) => ({ archived: profile.archived, names: [profile.title], at: shownLocations(profile) }), profileOf);
        return { profiles: entries, ...rest };
      }
      case "grinder": {
        const { entries, ...rest } = paged(await this.grinders.list(), (grinder) => ({ archived: grinder.archived, names: [grinder.model], at: grinder.location ? [grinder.location] : [] }), grinderOf);
        return { grinders: entries, ...rest };
      }
      case "basket":
      case "tool": {
        const { entries, ...rest } = paged(await this.equipment.list(input.kind), (item) => ({ archived: item.archived, names: [item.name], at: shownLocations(item) }), equipmentOf);
        return input.kind === "basket" ? { baskets: entries, ...rest } : { tools: entries, ...rest };
      }
      case "recipe": {
        // A Recipe belongs to one Location: those of each, as the REST API lists a Location's.
        const locationIds = at === undefined ? (await this.locations.list()).map((location) => location.id) : [at];
        const recipes = (await Promise.all(locationIds.map((locationId) => this.recipes.atLocation(locationId)))).flat();
        const { entries, ...rest } = paged(recipes, (item) => ({ archived: item.archived, names: [item.name], at: item.location ? [item.location] : [] }), recipeOf);
        return { recipes: entries, ...rest };
      }
    }
  }

  @Tool({
    name: "get_library_item",
    title: "Get a Library item",
    description: `Reads one Library item as the management interface shows it, by its kind and id, and when asked for, its history and open Conflicts, such as what changed on a Recipe today and who changed it. ${TIMES}`,
    inputSchema: getInput,
    outputSchema: getOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
  })
  async getLibraryItem(input: z.infer<typeof getInput>, context: McpContext): Promise<GetOutput> {
    const { item, ref, itemLocation } = await this.item(input.kind, input.id);
    const { scope } = callerOf(context);
    const [versions, conflicts] = await Promise.all([
      input.history ? this.history.versions(ref, scope) : undefined,
      input.conflicts ? this.history.openConflicts(scope, ref) : undefined,
    ]);
    const paged = <T, R>(list: readonly T[] | undefined, view: (entry: T) => R) => {
      if (list === undefined) return undefined;
      const entries = list.slice(input.offset, input.offset + input.limit);
      return { entries: entries.map(view), ...pageOf(list.length, input.offset, entries.length) };
    };
    return {
      ...item,
      history: paged(versions, (entry) => versionOf(entry, itemLocation)),
      conflicts: paged(conflicts, (entry) => conflictOf(entry, itemLocation)),
    };
  }

  @Tool({
    name: "list_conflicts",
    title: "List Conflicts",
    description: `Lists the Library's open Conflicts, the latest first, a page at a time: for each, its item and field, the losing value and the value now, where and when each came from, and whether this account may use or dismiss it. ${TIMES}`,
    inputSchema: z.object({ ...page }),
    outputSchema: conflictsOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
  })
  async listConflicts({ limit, offset }: { limit: number; offset: number }, context: McpContext): Promise<z.infer<typeof conflictsOutput>> {
    const open = await this.history.openConflicts(callerOf(context).scope);
    const shown = open.slice(offset, offset + limit);
    const itemLocations = await this.itemLocations(shown);
    return {
      conflicts: shown.map((entry) => conflictOf(entry, itemLocations.get(`${entry.item.kind}:${entry.item.id}`) ?? null)),
      ...pageOf(open.length, offset, shown.length),
    };
  }

  /** One item as get_library_item reads it, without its history or Conflicts: 404's message, as the REST API's, for none. */
  async read(kind: LibraryKind, itemId: string): Promise<ItemOutput> {
    return (await this.item(kind, itemId)).item;
  }

  /** A Location a list is filtered by, by its id in lower case, as the REST API reads one; refused as no Location if there is none. */
  private async locationOf(locationId: string | undefined): Promise<string | undefined> {
    if (locationId === undefined) return undefined;
    const id = readLocationId(locationId).toLowerCase();
    if ((await this.prisma.location.count({ where: { id } })) === 0) throw locationNotFound();
    return id;
  }

  /** The ids of the Archived Beans. */
  private async archivedBeans(): Promise<Set<string>> {
    return new Set((await this.prisma.bean.findMany({ where: { archived: true }, select: { id: true } })).map((bean) => bean.id));
  }

  /** One item as the REST API returns it, with how history and Conflicts name it and the Location it belongs to, if one. */
  private async item(kind: LibraryKind, itemId: string): Promise<{ item: ItemOutput; ref: { kind: LibraryKind; id: string }; itemLocation: LocationView | null }> {
    switch (kind) {
      case "bean": {
        const bean = await this.beans.get(readBeanId(itemId));
        return { item: { bean: { ...beanOf(bean), content: bean.content, batches: bean.batches.map(batchOf) } }, ref: { kind, id: bean.id }, itemLocation: null };
      }
      case "beanBatch": {
        const batch = await this.batches.get(readBeanBatchId(itemId));
        return { item: { beanBatch: batchViewOf(batch) }, ref: { kind, id: batch.id }, itemLocation: null };
      }
      case "profile": {
        const profile = await this.profiles.get(readProfileId(itemId));
        return { item: { profile: profileViewOf(profile) }, ref: { kind, id: profile.id }, itemLocation: null };
      }
      case "grinder": {
        const grinder = await this.grinders.get(readGrinderId(itemId));
        return { item: { grinder: { ...grinderOf(grinder), content: grinder.content } }, ref: { kind, id: grinder.id }, itemLocation: grinder.location };
      }
      case "basket":
      case "tool": {
        const item = equipmentViewOf(await this.equipment.get(kind, readEquipmentId(kind, itemId)));
        return { item: kind === "basket" ? { basket: item } : { tool: item }, ref: { kind, id: item.id }, itemLocation: null };
      }
      case "recipe": {
        const found = await this.recipes.get(readRecipeId(itemId));
        return { item: { recipe: recipeOf(found) }, ref: { kind, id: found.id }, itemLocation: found.location };
      }
    }
  }

  /** The Locations the Grinders and Recipes these Conflicts are about belong to, by `kind:id`; null for one that belongs to none now. */
  private async itemLocations(conflicts: readonly ConflictView[]): Promise<Map<string, LocationView | null>> {
    const ids = (kind: LibraryKind) => [...new Set(conflicts.flatMap((entry) => (entry.item.kind === kind ? [entry.item.id] : [])))];
    const where = (kind: LibraryKind) => ({ where: { id: { in: ids(kind) } }, select: { id: true, location: true } });
    const [grinders, recipes] = await Promise.all([this.prisma.grinder.findMany(where("grinder")), this.prisma.recipe.findMany(where("recipe"))]);
    return new Map([
      ...grinders.map((grinder) => [`grinder:${grinder.id}`, grinder.location && viewLocation(grinder.location)] as const),
      ...recipes.map((found) => [`recipe:${found.id}`, found.location && viewLocation(found.location)] as const),
    ]);
  }
}

/** What find_library_items filters an item by: whether it is Archived, its names, and the Locations it is at. */
interface Filtered {
  archived: boolean;
  names: (string | null)[];
  at: readonly LocationView[];
}

/** The items at the Location, if one is given, whose names have each word of the name given, ignoring case, and Archived or not as asked. */
function chosen<T>(items: readonly T[], input: FindInput, locationId: string | undefined, filtered: (item: T) => Filtered): T[] {
  const words = (input.name ?? "").toLowerCase().split(/\s+/).filter((word) => word !== "");
  return items.filter((item) => {
    const { archived, names, at } = filtered(item);
    const text = names.filter((name) => name !== null).join(" ").toLowerCase();
    return (
      (input.archived === undefined || archived === input.archived) &&
      (locationId === undefined || at.some((here) => here.id === locationId)) &&
      words.every((word) => text.includes(word))
    );
  });
}

function shownLocations(item: { shownAt: { location: LocationView }[] }): LocationView[] {
  return item.shownAt.map((here) => here.location);
}

/** A time the REST API gives, given again with the offset of the Location it happened at, or in UTC for none. */
function timeAt(at: string, where: LocationView | null): string {
  return zonedTime(new Date(at), where?.timeZone);
}

function locationOf({ id, name, timeZone }: LocationView): z.infer<typeof location> {
  return { id, name, timeZone };
}

function maybeLocation(where: LocationView | null): z.infer<typeof location> | null {
  return where && locationOf(where);
}

function beanOf(bean: BeanSummary | BeanView): z.infer<typeof beanSummary> {
  return {
    id: bean.id,
    roaster: bean.roaster,
    name: bean.name,
    archived: bean.archived,
    offeredAt: bean.offeredAt.map(locationOf),
    createdAt: timeAt(bean.createdAt, bean.createdLocation),
    createdLocation: maybeLocation(bean.createdLocation),
    likelyDuplicates: bean.likelyDuplicates.map(({ id, roaster, name }) => ({ id, roaster, name })),
  };
}

function batchOf(batch: BeanBatchSummary | BeanBatchView): z.infer<typeof batchSummary> {
  return {
    id: batch.id,
    bean: { id: batch.bean.id, roaster: batch.bean.roaster, name: batch.bean.name },
    roastDate: batch.roastDate,
    archived: batch.archived,
    locations: batch.locations.map((here) => ({ location: locationOf(here.location), remainingWeight: here.remainingWeight, since: timeAt(here.since, here.location) })),
    createdAt: timeAt(batch.createdAt, batch.createdLocation),
    createdLocation: maybeLocation(batch.createdLocation),
  };
}

function batchViewOf(batch: BeanBatchView): NonNullable<GetOutput["beanBatch"]> {
  return {
    ...batchOf(batch),
    content: batch.content,
    finished: batch.finished.map((here) => ({ location: locationOf(here.location), remainingWeight: here.remainingWeight, finishedAt: timeAt(here.finishedAt, here.location) })),
  };
}

function shownOf(item: { shownAt: { location: LocationView; since: string }[] }): z.infer<typeof shownAt> {
  return item.shownAt.map((here) => ({ location: locationOf(here.location), since: timeAt(here.since, here.location) }));
}

function decidedOf(item: { locations: { location: LocationView; shown: boolean; since: string }[] }): z.infer<typeof decidedAt> {
  return item.locations.map((here) => ({ location: locationOf(here.location), shown: here.shown, since: timeAt(here.since, here.location) }));
}

function profileOf(profile: ProfileSummary | ProfileView): z.infer<typeof profileSummary> {
  return {
    id: profile.id,
    title: profile.title,
    author: profile.author,
    beverageType: profile.beverageType,
    bundled: profile.bundled,
    archived: profile.archived,
    shownAt: shownOf(profile),
    createdAt: timeAt(profile.createdAt, profile.createdLocation),
    createdLocation: maybeLocation(profile.createdLocation),
  };
}

function profileViewOf(profile: ProfileView): NonNullable<GetOutput["profile"]> {
  return { ...profileOf(profile), content: profile.content, parent: profile.parent && { id: profile.parent.id, title: profile.parent.title }, locations: decidedOf(profile) };
}

function grinderOf(grinder: GrinderSummary | GrinderView): z.infer<typeof grinderSummary> {
  return {
    id: grinder.id,
    model: grinder.model,
    burrs: grinder.burrs,
    burrType: grinder.burrType,
    archived: grinder.archived,
    location: maybeLocation(grinder.location),
    createdAt: timeAt(grinder.createdAt, grinder.location),
  };
}

function equipmentOf(item: EquipmentSummary | EquipmentView): z.infer<typeof equipmentSummary> {
  return {
    id: item.id,
    name: item.name,
    archived: item.archived,
    shownAt: shownOf(item),
    createdAt: timeAt(item.createdAt, item.createdLocation),
    createdLocation: maybeLocation(item.createdLocation),
    content: item.content,
  };
}

function equipmentViewOf(item: EquipmentView): NonNullable<GetOutput["basket"]> {
  return { ...equipmentOf(item), locations: decidedOf(item) };
}

function recipeOf(found: RecipeView): z.infer<typeof recipe> {
  const { bean, beanBatch, profile, grinder, basket, tools } = found.uses;
  return {
    id: found.id,
    name: found.name,
    location: maybeLocation(found.location),
    slot: found.slot,
    archived: found.archived,
    createdAt: timeAt(found.createdAt, found.location),
    content: found.content,
    uses: {
      bean: bean && { id: bean.id, roaster: bean.roaster, name: bean.name },
      beanBatch: beanBatch && { id: beanBatch.id, roastDate: beanBatch.roastDate, atLocation: beanBatch.atLocation },
      profile: profile && { id: profile.id, title: profile.title },
      grinder: grinder && { id: grinder.id, model: grinder.model },
      basket: basket && { id: basket.id, name: basket.name },
      tools: tools.map((tool) => ({ id: tool.id, name: tool.name })),
    },
    batchFinished: found.batchFinished,
  };
}

function sourceOf({ machine, tabletId, account, connectedApp }: SourceView): z.infer<typeof source> {
  return {
    machine: machine && { id: machine.id, name: machine.name },
    tabletId,
    account: account && { id: account.id, name: account.name },
    connectedApp: connectedApp && { id: connectedApp.id, name: connectedApp.name, host: connectedApp.host },
  };
}

/** A version, its times with the offset of the Location whose state it changed, or else of the one its item belongs to. */
function versionOf(entry: VersionView, itemLocation: LocationView | null): z.infer<typeof version> {
  const where = entry.location ?? itemLocation;
  return {
    id: entry.id,
    fields: entry.fields,
    location: maybeLocation(entry.location),
    source: sourceOf(entry.source),
    editedAt: timeAt(entry.editedAt, where),
    receivedAt: timeAt(entry.receivedAt, where),
    copiedFrom: entry.copiedFrom && { id: entry.copiedFrom.id, name: entry.copiedFrom.name, location: maybeLocation(entry.copiedFrom.location) },
  };
}

/** A Conflict, its times with the offset of the Location whose state it is about, or else of the one its item belongs to. */
function conflictOf(entry: ConflictView, itemLocation: LocationView | null): z.infer<typeof conflict> {
  const where = entry.location ?? itemLocation;
  const { current } = entry;
  return {
    id: entry.id,
    item: { kind: entry.item.kind, id: entry.item.id, name: entry.item.name },
    field: entry.field,
    value: entry.value,
    location: maybeLocation(entry.location),
    source: sourceOf(entry.source),
    editedAt: timeAt(entry.editedAt, where),
    createdAt: timeAt(entry.createdAt, where),
    state: entry.state,
    current: {
      value: current.value,
      source: current.source && sourceOf(current.source),
      editedAt: current.editedAt && timeAt(current.editedAt, where),
      versionId: current.versionId,
    },
    resolvable: entry.resolvable,
  };
}
