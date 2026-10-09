import { BadRequestException } from "@nestjs/common";

// What the management interface may set of a Bean's, a Bean Batch's and a
// Grinder's content: Decaid's record fields, each of the type Decaid takes
// (`Bean`, `BeanBatch` and `Grinder` in decaid:lib/src/models/data/, v0.8.7),
// so a tablet never refuses a write of them
// (server/test/fixtures/decaid/*-writes-v0.8.7/). A date is written as Decaid
// returns one it is sent as a day, so the content is what every tablet's
// record then holds, and is not written to them again.

/** How a field is read: its type, and whether it may be cleared, which Decaid refuses for some. */
type FieldType = "text" | "name" | "flag" | "number" | "date" | "texts" | "wholeNumbers" | "settingType";

const BEAN_FIELDS: Readonly<Record<string, FieldType>> = {
  roaster: "name",
  name: "name",
  species: "text",
  decaf: "flag",
  decafProcess: "text",
  country: "text",
  region: "text",
  producer: "text",
  variety: "texts",
  altitude: "wholeNumbers",
  processing: "text",
  notes: "text",
};

const BATCH_FIELDS: Readonly<Record<string, FieldType>> = {
  roastDate: "date",
  roastLevel: "text",
  harvestDate: "text",
  qualityScore: "number",
  price: "number",
  currency: "text",
  weight: "number",
  buyDate: "date",
  openDate: "date",
  bestBeforeDate: "date",
  freezeDate: "date",
  unfreezeDate: "date",
  frozen: "flag",
  notes: "text",
};

const GRINDER_FIELDS: Readonly<Record<string, FieldType>> = {
  model: "name",
  burrs: "text",
  burrSize: "number",
  burrType: "text",
  notes: "text",
  settingType: "settingType",
  settingValues: "texts",
  settingSmallStep: "number",
  settingBigStep: "number",
  rpmSmallStep: "number",
  rpmBigStep: "number",
};

/** What Decaid makes a new record hold where it is not sent a value, so the content created is what the tablet's record holds. */
const DEFAULTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  bean: { decaf: false },
  beanBatch: { frozen: false },
  grinder: { settingType: "numeric" },
};

const KINDS = { bean: BEAN_FIELDS, beanBatch: BATCH_FIELDS, grinder: GRINDER_FIELDS } as const;

type EditedKind = keyof typeof KINDS;

/**
 * The content fields an edit sets, from a request's `content`, each with
 * its value, null to clear it. 400 for a field that is not one of the
 * kind's, or a value Decaid would refuse.
 */
export function readContentEdit(kind: EditedKind, body: unknown): Record<string, unknown> {
  const content = contentOf(body);
  if (Object.keys(content).length === 0) throw new BadRequestException("Send the fields to change as content, each by Decaid's name for it");
  return readFields(kind, content);
}

/**
 * A new item's content, from a request's `content`: its fields as
 * `readContentEdit` reads them, those cleared left out, and what Decaid
 * makes a record hold where it is not sent one. A Bean needs its roaster and
 * name, a Grinder its model.
 */
export function readNewContent(kind: EditedKind, body: unknown): Record<string, unknown> {
  const fields = readFields(kind, contentOf(body));
  const content = { ...DEFAULTS[kind], ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null)) };
  const required = Object.entries(KINDS[kind]).flatMap(([field, type]) => (type === "name" && !(field in content) ? [field] : []));
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

function readFields(kind: EditedKind, content: Record<string, unknown>): Record<string, unknown> {
  const types = KINDS[kind];
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
  }
}

/** Whether text is a day that exists, as YYYY-MM-DD. */
function isDay(text: string): boolean {
  const match = /^(\d{4})-(\d\d)-(\d\d)$/.exec(text);
  if (!match) return false;
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return day.toISOString().slice(0, 10) === text;
}

/** A remaining weight in grams from a request, null to clear it: a number of 0 or more. */
export function readWeight(value: unknown): number | null {
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

/** Whether a request shows a Profile at a Location or hides it there: `{ shown }`. */
export function readShown(body: unknown): boolean {
  const shown = typeof body === "object" && body !== null ? (body as { shown?: unknown }).shown : undefined;
  if (typeof shown !== "boolean") throw new BadRequestException("Send shown: true to show the Profile at this Location, or false to hide it here");
  return shown;
}
