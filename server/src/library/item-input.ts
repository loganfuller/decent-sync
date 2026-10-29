import { type LibraryKind, RECIPE_SLOTS, grindSettingOf, isRecipeSlot } from "@decent-sync/protocol";
import { BadRequestException } from "@nestjs/common";
import { type EditableContent, KINDS } from "./kinds.js";

// What the management interface may set of a Bean's, a Bean Batch's, a
// Grinder's, a Basket's, a Tool's and a Recipe's content, as each kind's
// description lists it (`editable` in kinds.ts): Decaid's record fields, each
// of the type Decaid takes (`Bean`, `BeanBatch` and `Grinder` in
// decaid:lib/src/models/data/, v0.9.0), so a tablet never refuses a write of
// them (server/test/fixtures/decaid/*-writes-v0.8.7/, unchanged in v0.9.0), and DYE2's, each as
// its pages save it (`submitForm` in dye2:dye2-plugin/src/pages/baskets.ts
// and equipment.ts, `getCurrentRecipeData` in recipe-edit.ts, v0.1.19), a
// Recipe's in the Library's terms (`recipeContent` in recipe-intake.ts),
// naming the items it uses by their global ids. A date is written as Decaid
// returns one it is sent as a day, so the content is what every tablet's
// record then holds, and is not written to them again.

/**
 * How a field is read: its type, and whether it may be cleared, which Decaid
 * refuses for some. A Basket's size is one DYE2's page offers, and a Tool's
 * attributes are DYE2's free-form name and value pairs (`custom`). A Recipe
 * names a Library item by its global id (`id`), its Tools by theirs (`ids`),
 * its Profile by Decaid's id (`profileId`), and each Tool's attributes for it
 * by the Tool's global id (`toolAttributes`), as DYE2's `equipmentCustom`
 * holds them by its own, and its grind setting as a number or text
 * (`grindSetting`, as `grindSettingOf` keeps one). A number DYE2's recipe
 * editor takes only within a range is read against it (`NumberRange`).
 */
export type FieldType =
  | "text"
  | "name"
  | "flag"
  | "number"
  | "date"
  | "texts"
  | "wholeNumbers"
  | "settingType"
  | "basketSize"
  | "attributes"
  | "id"
  | "ids"
  | "profileId"
  | "toolAttributes"
  | "grindSetting"
  | NumberRange;

/**
 * A number taken only within a range, as DYE2's recipe editor offers it: from
 * `min`, up to `max` where there is one, a whole number where `whole`, as
 * Decaid's field is an int, and 0 besides where `offAtZero`, as DYE2's milk
 * stop is off at 0.
 */
export interface NumberRange {
  readonly min: number;
  readonly max?: number;
  readonly whole?: boolean;
  readonly offAtZero?: boolean;
}

/** The sizes DYE2's baskets page offers. */
const BASKET_SIZES: readonly string[] = ["single", "double", "triple", "bottomless", "other"];

/** What the management interface may set of a kind's content, as its description says (`editable` in kinds.ts). */
function editable(kind: LibraryKind): EditableContent {
  const content = KINDS[kind].editable;
  if (!content) throw new BadRequestException(`A ${KINDS[kind].name}'s content is not set here`);
  return content;
}

/**
 * The content fields an edit sets, from a request's `content`, each with
 * its value, null to clear it. 400 for a field that is not one of the
 * kind's, or a value Decaid would refuse.
 */
export function readContentEdit(kind: LibraryKind, body: unknown): Record<string, unknown> {
  const content = contentOf(body);
  if (Object.keys(content).length === 0) throw new BadRequestException("Send the fields to change as content, each by Decaid's name for it");
  return readFields(kind, content);
}

/**
 * A new item's content, from a request's `content`: its fields as
 * `readContentEdit` reads them, those cleared left out, and what Decaid or
 * DYE2 makes a record hold where it is not sent one. A Bean needs its roaster
 * and name, a Grinder its model, a Basket and a Tool their name.
 */
export function readNewContent(kind: LibraryKind, body: unknown): Record<string, unknown> {
  const fields = readFields(kind, contentOf(body));
  const { fields: types, defaults } = editable(kind);
  const content = { ...defaults, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null)) };
  const required = Object.entries(types).flatMap(([field, type]) => (type === "name" && !(field in content) ? [field] : []));
  if (required.length > 0) throw new BadRequestException(required.map((field) => `${field} is required`));
  return content;
}

function contentOf(body: unknown): Record<string, unknown> {
  const content = typeof body === "object" && body !== null ? (body as { content?: unknown }).content : undefined;
  if (typeof content !== "object" || content === null || Array.isArray(content)) {
    throw new BadRequestException("Send the item's fields as content, each by Decaid's name for it");
  }
  return content as Record<string, unknown>;
}

function readFields(kind: LibraryKind, content: Record<string, unknown>): Record<string, unknown> {
  const types = editable(kind).fields;
  const problems: string[] = [];
  const read: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(content)) {
    const type = Object.prototype.hasOwnProperty.call(types, field) ? types[field] : undefined;
    if (type === undefined) {
      problems.push(`${field} is not a field this can set`);
      continue;
    }
    const problem = readValue(type, value);
    if (typeof problem === "string") problems.push(`${field} ${problem}`);
    else read[field] = problem.value;
  }
  if (problems.length > 0) throw new BadRequestException(problems);
  return read;
}

/** A field's value as stored, or what is wrong with it. Empty text clears a field that may be cleared. */
function readValue(type: FieldType, value: unknown): { value: unknown } | string {
  if (value === null || value === "") {
    if (type === "name") return "cannot be empty";
    if (type === "flag") return "must be true or false";
    return { value: null };
  }
  if (typeof type === "object") return readInRange(type, value);
  switch (type) {
    case "name":
      return typeof value === "string" && value.trim() !== "" ? { value: value.trim() } : "must be text";
    case "text":
      return typeof value === "string" ? { value } : "must be text";
    case "flag":
      return typeof value === "boolean" ? { value } : "must be true or false";
    case "number":
      return typeof value === "number" && Number.isFinite(value) && value >= 0 ? { value } : "must be a number of 0 or more";
    case "date":
      return typeof value === "string" && isDay(value) ? { value: `${value}T00:00:00.000` } : "must be a day, such as 2026-10-01";
    case "texts":
      return Array.isArray(value) && value.every((item) => typeof item === "string") ? { value } : "must be a list of text";
    case "wholeNumbers":
      return Array.isArray(value) && value.every((item) => Number.isInteger(item)) ? { value } : "must be a list of whole numbers";
    case "settingType":
      return value === "numeric" || value === "preset" ? { value } : "must be numeric or preset";
    case "basketSize":
      return typeof value === "string" && BASKET_SIZES.includes(value) ? { value } : `must be one of ${BASKET_SIZES.join(", ")}`;
    case "attributes":
      return readAttributes(value);
    case "id":
      return typeof value === "string" && UUID.test(value) ? { value: value.toLowerCase() } : "must be the item's id";
    case "ids":
      return Array.isArray(value) && value.every((item) => typeof item === "string" && UUID.test(item))
        ? { value: [...new Set(value.map((item: string) => item.toLowerCase()))] }
        : "must be a list of the items' ids";
    case "profileId":
      return typeof value === "string" && value.trim() !== "" ? { value: value.trim() } : "must be the Profile's id";
    case "toolAttributes":
      return readToolAttributes(value);
    case "grindSetting": {
      // As typed, or the number it reads as, as DYE2 v0.1.32 keeps one: a setting all blanks is none.
      const setting = grindSettingOf(value);
      if (typeof value === "string" && setting === null) return { value: null };
      return (typeof setting === "number" && setting >= 0) || typeof setting === "string" ? { value: setting } : "must be a number of 0 or more, or text";
    }
  }
}

/** A number within its range, or what the range is, such as "must be a whole number from 135 to 170". */
function readInRange(range: NumberRange, value: unknown): { value: number } | string {
  if (typeof value === "number" && Number.isFinite(value) && (!range.whole || Number.isInteger(value))) {
    if (range.offAtZero && value === 0) return { value };
    if (value >= range.min && (range.max === undefined || value <= range.max)) return { value };
  }
  const number = range.whole ? "a whole number" : "a number";
  const span = range.max === undefined ? `${number} of ${range.min} or more` : `${number} from ${range.min} to ${range.max}`;
  return `must be ${range.offAtZero ? `0 (off) or ${span}` : span}`;
}

/**
 * A Recipe's attributes of its Tools, by each Tool's global id, each a list
 * of `{ key, value }` as a Tool's own attributes are read (`readAttributes`),
 * as DYE2's recipe editor keeps them in `equipmentCustom` by its own ids.
 */
function readToolAttributes(value: unknown): { value: Record<string, { key: string; value: string }[]> } | string {
  const problem = "must name each Tool by its id, with its attributes as a list of { key, value }";
  if (typeof value !== "object" || value === null || Array.isArray(value)) return problem;
  const read: Record<string, { key: string; value: string }[]> = {};
  for (const [toolId, pairs] of Object.entries(value)) {
    if (!UUID.test(toolId)) return problem;
    const attributes = readAttributes(pairs);
    if (typeof attributes === "string") return problem;
    read[toolId.toLowerCase()] = attributes.value;
  }
  return { value: read };
}

/**
 * A Tool's attributes as DYE2's equipment page saves them: a list of `{ key,
 * value }`, each trimmed, a pair with no name left out (`readFieldRows`).
 */
function readAttributes(value: unknown): { value: { key: string; value: string }[] } | string {
  const problem = "must be a list of { key, value }, each text";
  if (!Array.isArray(value)) return problem;
  const pairs: { key: string; value: string }[] = [];
  for (const pair of value) {
    if (typeof pair !== "object" || pair === null || Array.isArray(pair)) return problem;
    const { key, value: text } = pair as Record<string, unknown>;
    if (typeof key !== "string" || typeof text !== "string") return problem;
    if (key.trim() !== "") pairs.push({ key: key.trim(), value: text.trim() });
  }
  return { value: pairs };
}

/** Whether text is a day that exists, as YYYY-MM-DD. */
function isDay(text: string): boolean {
  const match = /^(\d{4})-(\d\d)-(\d\d)$/.exec(text);
  if (!match) return false;
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return day.toISOString().slice(0, 10) === text;
}

/** A remaining weight in grams from a request, null to clear it: a number of 0 or more. */
function readWeight(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  throw new BadRequestException("remainingWeight must be a number of grams, 0 or more, or null");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a request Archives an item or restores it: `{ archived }`. */
export function readArchived(body: unknown): boolean {
  const archived = typeof body === "object" && body !== null ? (body as { archived?: unknown }).archived : undefined;
  if (typeof archived !== "boolean") throw new BadRequestException("Send archived: true to Archive it, or false to restore it");
  return archived;
}

/** A new batch, from a request: `{ beanId, content, locations }`, each Location `{ locationId, remainingWeight? }`, its ids in lower case. */
export function readNewBatch(body: unknown): { beanId: string; content: Record<string, unknown>; locations: { locationId: string; remainingWeight?: number | null }[] } {
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (typeof fields.beanId !== "string" || !UUID.test(fields.beanId)) throw new BadRequestException("Name the batch's Bean as beanId");
  const listed = fields.locations ?? [];
  if (!Array.isArray(listed)) throw new BadRequestException("Send the Locations it is at as locations, each { locationId, remainingWeight }");
  const locations = listed.map((here: unknown) => {
    const place = typeof here === "object" && here !== null ? (here as Record<string, unknown>) : {};
    if (typeof place.locationId !== "string" || !UUID.test(place.locationId)) throw new BadRequestException("Name each Location by its locationId");
    return {
      locationId: place.locationId.toLowerCase(),
      ...(place.remainingWeight === undefined ? {} : { remainingWeight: readWeight(place.remainingWeight) }),
    };
  });
  return { beanId: fields.beanId.toLowerCase(), content: readNewContent("beanBatch", { content: fields.content ?? {} }), locations };
}

/** Where a request places a batch at a Location: `{ atLocation, remainingWeight }`, either or both. */
export function readPlacement(body: unknown): { atLocation?: boolean; remainingWeight?: number | null } {
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (fields.atLocation !== undefined && typeof fields.atLocation !== "boolean") throw new BadRequestException("atLocation must be true or false");
  if (fields.atLocation === undefined && fields.remainingWeight === undefined) {
    throw new BadRequestException("Send atLocation, true to add the batch here or false to finish it here, or its remainingWeight here, or both");
  }
  return {
    ...(fields.atLocation === undefined ? {} : { atLocation: fields.atLocation as boolean }),
    ...(fields.remainingWeight === undefined ? {} : { remainingWeight: readWeight(fields.remainingWeight) }),
  };
}

/** A new Grinder's Location, from a request's `locationId`, in lower case. */
export function readGrinderLocation(body: unknown): string {
  const locationId = typeof body === "object" && body !== null ? (body as { locationId?: unknown }).locationId : undefined;
  if (typeof locationId !== "string" || !UUID.test(locationId)) throw new BadRequestException("Name the Location the Grinder belongs to as locationId");
  return locationId.toLowerCase();
}

/**
 * Where a request puts a Recipe: `{ slot }`, a Recipe Slot's number, `next`
 * for the lowest its Location leaves empty, or null for none.
 */
export type SlotChoice = number | "next" | null;

/** A Recipe Slot from a request's `slot`: a whole number from 1 to RECIPE_SLOTS, `next`, or null for none. */
export function readSlot(body: unknown): SlotChoice {
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (!Object.prototype.hasOwnProperty.call(fields, "slot")) {
    throw new BadRequestException("Send slot: a Recipe Slot's number, next for the lowest one free, or null for none");
  }
  return slotOf(fields.slot);
}

function slotOf(slot: unknown): SlotChoice {
  if (slot === null || slot === "next") return slot;
  if (isRecipeSlot(slot)) return slot;
  throw new BadRequestException(`slot must be a whole number from 1 to ${RECIPE_SLOTS}, next for the lowest one free, or null for none`);
}

/**
 * A new Recipe, from a request: `{ locationId, slot, content }`, the Location
 * it belongs to, in lower case, the Recipe Slot it goes in there (none if not
 * given), and its content.
 */
export function readNewRecipe(body: unknown): { locationId: string; slot: SlotChoice; content: Record<string, unknown> } {
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (typeof fields.locationId !== "string" || !UUID.test(fields.locationId)) throw new BadRequestException("Name the Location the Recipe belongs to as locationId");
  return { locationId: fields.locationId.toLowerCase(), slot: slotOf(fields.slot ?? null), content: readNewContent("recipe", body) };
}

/**
 * A Recipe's copy to a Location, from a request: `{ locationId, slot,
 * grinderId, beanBatchId }`, the Location it goes to, in lower case, the
 * Recipe Slot it goes in there (none if not given), its Grinder there, null
 * for none, and the Bean Batch it uses instead of the Recipe's, null for
 * none, or undefined, where not given, to keep the Recipe's (ticket #144).
 */
export function readRecipeCopy(body: unknown): { locationId: string; slot: SlotChoice; grinderId: string | null; beanBatchId: string | null | undefined } {
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (typeof fields.locationId !== "string" || !UUID.test(fields.locationId)) throw new BadRequestException("Name the Location the copy goes to as locationId");
  const id = (field: "grinderId" | "beanBatchId", what: string) => {
    const value = fields[field];
    if (value === null) return null;
    if (typeof value !== "string" || !UUID.test(value)) throw new BadRequestException(`${field} must be ${what}'s id, or null for none`);
    return value.toLowerCase();
  };
  if (!Object.prototype.hasOwnProperty.call(fields, "grinderId")) throw new BadRequestException("Choose the copy's Grinder at its Location as grinderId, or null for none");
  return {
    locationId: fields.locationId.toLowerCase(),
    slot: slotOf(fields.slot ?? null),
    grinderId: id("grinderId", "a Grinder"),
    beanBatchId: Object.prototype.hasOwnProperty.call(fields, "beanBatchId") ? id("beanBatchId", "a Bean Batch") : undefined,
  };
}

/** A new Basket or Tool, from a request: `{ locationId, content }`, the Location it is first shown at, in lower case, and its content. */
export function readNewEquipment(kind: "basket" | "tool", body: unknown): { locationId: string; content: Record<string, unknown> } {
  const locationId = typeof body === "object" && body !== null ? (body as { locationId?: unknown }).locationId : undefined;
  if (typeof locationId !== "string" || !UUID.test(locationId)) throw new BadRequestException(`Name the Location the ${KINDS[kind].name} is shown at as locationId`);
  return { locationId: locationId.toLowerCase(), content: readNewContent(kind, body) };
}

/** Whether a request shows a Profile at a Location or hides it there: `{ shown }`. */
export function readShown(body: unknown): boolean {
  const shown = typeof body === "object" && body !== null ? (body as { shown?: unknown }).shown : undefined;
  if (typeof shown !== "boolean") throw new BadRequestException("Send shown: true to show it at this Location, or false to hide it here");
  return shown;
}
