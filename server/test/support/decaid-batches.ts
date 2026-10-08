import { type DecaidAnswer, castError, decaidNow } from "./decaid-beans.js";

// Decaid v0.8.7's bean batches API, as the simulated tablet answers writes to
// it: the batch routes of `BeansHandler` in
// decaid:lib/src/services/webserver/beans_handler.dart, `BeanBatch` in
// lib/src/models/data/bean.dart and `BeanDao` in
// lib/src/services/database/daos/bean_dao.dart, unchanged in v0.8.8. What it
// answers was recorded on Decaid's Linux release
// (fixtures/decaid/bean-batch-writes-v0.8.7/), and
// server/test/simulated-batch-writes.test.ts replays those requests here.
//
// - `POST /beans/{beanId}/batches` makes a batch of that bean from the fields
//   BeanBatch.create takes, giving it a random UUID, `createdAt` and
//   `updatedAt` of now, and `weightRemaining` equal to `weight`. It ignores
//   `archived`, `weightRemaining` and fields it does not know, and answers
//   201. A bean the tablet does not hold fails SQLite's foreign key, with 400.
// - `PUT /bean-batches/{id}` merges the fields sent over the record, top level
//   only, so `extras` is replaced whole and null clears a field, keeping its
//   id, bean and `createdAt`, then sets `updatedAt` to now. It refuses null
//   for frozen and archived, and a number field that is not a number, with
//   400; an unknown id with 404.
// - Either refuses a field of the wrong type with 400, naming Dart's cast, and
//   a date Dart cannot parse with 400. Dates are parsed as Dart's
//   DateTime.parse does: one without an offset is the tablet's local time,
//   and one with an offset is written back in UTC.
// - `DELETE /bean-batches/{id}` answers 200 whether or not it held the batch.
//   `DELETE /beans/{id}` refuses, with 500, while the bean has batches, which
//   reference it with no cascade while SQLite enforces foreign keys, and
//   otherwise answers 200 as a batch's does.
// - A record lists its fields in BeanBatch.toJson's order, leaving out
//   optional ones that are null.
// - `GET /bean-batches` lists the most recently updated first, without
//   archived batches or the batches of archived beans unless asked for
//   archived ones; `GET /beans/{beanId}/batches` lists one bean's, leaving
//   out only archived batches.

type Batch = Record<string, unknown>;
type Bean = Record<string, unknown>;

/** BeanBatch.toJson's fields, in its order. */
const ORDER = [
  "id",
  "beanId",
  "roastDate",
  "roastLevel",
  "harvestDate",
  "qualityScore",
  "price",
  "currency",
  "weight",
  "weightRemaining",
  "buyDate",
  "openDate",
  "bestBeforeDate",
  "freezeDate",
  "unfreezeDate",
  "frozen",
  "archived",
  "notes",
  "createdAt",
  "updatedAt",
  "extras",
] as const;
const REQUIRED = new Set(["id", "beanId", "frozen", "archived", "createdAt", "updatedAt"]);
const DATES = new Set(["roastDate", "buyDate", "openDate", "bestBeforeDate", "freezeDate", "unfreezeDate"]);
/** The number fields `PUT` checks before it reads the record (validatePatchFieldTypes). */
const PATCHED_NUMBERS = ["qualityScore", "price", "weight", "weightRemaining"];

class DartError extends Error {}

/** Creates a batch of a bean from a request's body, as `POST /beans/{beanId}/batches` does. */
export function createBatch(beans: readonly Bean[], batches: Batch[], beanId: string, body: unknown): { answer: DecaidAnswer; batches: Batch[] } {
  if (!isObject(body)) return { answer: badRequest(castError(body, "Map<String, dynamic>")), batches };
  try {
    // In BeanBatch.create's order, which is the order Dart reads them in.
    const read = {
      roastDate: body.roastDate !== null && body.roastDate !== undefined ? parseDate(castString(body.roastDate)) : null,
      roastLevel: castOptional(body.roastLevel, "String"),
      harvestDate: castOptional(body.harvestDate, "String"),
      qualityScore: castOptional(body.qualityScore, "num"),
      price: castOptional(body.price, "num"),
      currency: castOptional(body.currency, "String"),
      weight: castOptional(body.weight, "num"),
      buyDate: optionalDate(body.buyDate),
      openDate: optionalDate(body.openDate),
      bestBeforeDate: optionalDate(body.bestBeforeDate),
      freezeDate: optionalDate(body.freezeDate),
      unfreezeDate: optionalDate(body.unfreezeDate),
      frozen: castOptional(body.frozen, "bool") ?? false,
      notes: castOptional(body.notes, "String"),
      extras: castOptional(body.extras, "Map<String, dynamic>"),
    };
    const now = decaidNow();
    const batch = toJson({ ...read, id: crypto.randomUUID(), beanId, weightRemaining: read.weight, archived: false, createdAt: now, updatedAt: now });
    if (!beans.some((bean) => bean.id === beanId)) return { answer: badRequest(insertRefused(batch)), batches };
    return { answer: { status: 201, body: batch }, batches: [...batches, batch] };
  } catch (error) {
    if (error instanceof DartError) return { answer: badRequest(error.message), batches };
    throw error;
  }
}

/** Updates a batch with a request's body, as `PUT /bean-batches/{id}` does. */
export function updateBatch(batches: Batch[], id: string, body: unknown): { answer: DecaidAnswer; batches: Batch[] } {
  const existing = batches.find((batch) => batch.id === id);
  if (!existing) return { answer: { status: 404, body: { error: "Batch not found" } }, batches };
  if (!isObject(body)) return { answer: badRequest(castError(body, "Map<String, dynamic>")), batches };
  for (const field of ["frozen", "archived"]) {
    if (field in body && body[field] === null) return { answer: badRequest(`FormatException: Field "${field}" cannot be null`), batches };
  }
  for (const field of PATCHED_NUMBERS) {
    if (body[field] !== undefined && body[field] !== null && typeof body[field] !== "number") {
      return { answer: badRequest(`FormatException: Field "${field}" must be a number or null`), batches };
    }
  }
  try {
    const merged: Batch = { ...existing, ...body, id: existing.id, beanId: existing.beanId, createdAt: existing.createdAt, updatedAt: decaidNow() };
    // In BeanBatch.fromJson's order.
    const batch = toJson({
      id: merged.id,
      beanId: merged.beanId,
      roastDate: optionalDate(merged.roastDate),
      roastLevel: castOptional(merged.roastLevel, "String"),
      harvestDate: castOptional(merged.harvestDate, "String"),
      qualityScore: castOptional(merged.qualityScore, "num"),
      price: castOptional(merged.price, "num"),
      currency: castOptional(merged.currency, "String"),
      weight: castOptional(merged.weight, "num"),
      weightRemaining: castOptional(merged.weightRemaining, "num"),
      buyDate: optionalDate(merged.buyDate),
      openDate: optionalDate(merged.openDate),
      bestBeforeDate: optionalDate(merged.bestBeforeDate),
      freezeDate: optionalDate(merged.freezeDate),
      unfreezeDate: optionalDate(merged.unfreezeDate),
      frozen: castOptional(merged.frozen, "bool") ?? false,
      archived: castOptional(merged.archived, "bool") ?? false,
      notes: castOptional(merged.notes, "String"),
      createdAt: merged.createdAt,
      updatedAt: merged.updatedAt,
      extras: castOptional(merged.extras, "Map<String, dynamic>"),
    });
    return { answer: { status: 200, body: batch }, batches: batches.map((candidate) => (candidate === existing ? batch : candidate)) };
  } catch (error) {
    if (error instanceof DartError) return { answer: badRequest(error.message), batches };
    throw error;
  }
}

/** Deletes a batch, as `DELETE /bean-batches/{id}` does, whether or not the tablet holds it. */
export function deleteBatch(batches: Batch[], id: string): { answer: DecaidAnswer; batches: Batch[] } {
  return { answer: { status: 200, body: { success: true, id } }, batches: batches.filter((batch) => batch.id !== id) };
}

/** Deletes a bean, as `DELETE /beans/{id}` does: refused while it has batches. */
export function deleteBean(beans: Bean[], batches: readonly Batch[], id: string): { answer: DecaidAnswer; beans: Bean[] } {
  if (batches.some((batch) => batch.beanId === id)) {
    return {
      answer: {
        status: 500,
        body: {
          error: `${FOREIGN_KEY_FAILED}\n  Causing statement: DELETE FROM "beans" WHERE "id" = ?;, parameters: ${id}`,
        },
      },
      beans,
    };
  }
  return { answer: { status: 200, body: { success: true, id } }, beans: beans.filter((bean) => bean.id !== id) };
}

/** The batches as `GET /bean-batches` lists them: the most recently updated first, archived ones and an archived bean's only if asked for. */
export function listedBatches(beans: readonly Bean[], batches: readonly Batch[], includeArchived: boolean): Batch[] {
  const archivedBeans = new Set(beans.filter((bean) => bean.archived === true).map((bean) => bean.id));
  return byUpdate(includeArchived ? batches : batches.filter((batch) => batch.archived !== true && !archivedBeans.has(batch.beanId)));
}

/** A bean's batches as `GET /beans/{beanId}/batches` lists them. */
export function batchesOf(batches: readonly Batch[], beanId: string, includeArchived: boolean): Batch[] {
  return byUpdate(batches.filter((batch) => batch.beanId === beanId && (includeArchived || batch.archived !== true)));
}

function byUpdate(batches: readonly Batch[]): Batch[] {
  return [...batches].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

const FOREIGN_KEY_FAILED = "SqliteException(787): while executing statement, FOREIGN KEY constraint failed, constraint failed (code 787)";

/** What SQLite answers inserting a batch of a bean that is not there, naming the statement and its parameters as drift binds them. */
function insertRefused(batch: Batch): string {
  const columns = ORDER.map((field) => `"${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}"`);
  const parameters = ORDER.map((field) => sqlParameter(field, batch[field]));
  return (
    `${FOREIGN_KEY_FAILED}\n  Causing statement: INSERT INTO "bean_batches" (${columns.join(", ")}) ` +
    `VALUES (${ORDER.map(() => "?").join(", ")}), parameters: ${parameters.join(", ")}`
  );
}

/** A value as drift binds it and SQLite's error prints it: dates as text with their offset, booleans as 0 or 1, doubles as Dart prints them, maps as JSON. */
function sqlParameter(field: string, value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return dartDouble(value);
  if (isObject(value)) return JSON.stringify(value);
  const text = String(value);
  if ((DATES.has(field) || field === "createdAt" || field === "updatedAt") && !text.endsWith("Z")) return `${text} ${localOffset(text)}`;
  return text;
}

/** How Dart prints a double. */
function dartDouble(value: number): string {
  return Number.isInteger(value) && Math.abs(value) < 1e21 ? value.toFixed(1) : String(value);
}

/** The tablet's offset from UTC at a local time Dart wrote, as ±hh:mm. */
function localOffset(local: string): string {
  const [date, time] = local.split("T") as [string, string];
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const [hour, minute, second] = time.split(":").map((part) => Math.trunc(Number(part))) as [number, number, number];
  const minutes = -new Date(year, month - 1, day, hour, minute, second).getTimezoneOffset();
  const pad = (value: number) => String(Math.trunc(value)).padStart(2, "0");
  return `${minutes < 0 ? "-" : "+"}${pad(Math.abs(minutes) / 60)}:${pad(Math.abs(minutes) % 60)}`;
}

/** A record with BeanBatch.toJson's fields, in its order, without the optional ones that are null. */
function toJson(fields: Batch): Batch {
  return Object.fromEntries(ORDER.filter((key) => REQUIRED.has(key) || (fields[key] !== null && fields[key] !== undefined)).map((key) => [key, fields[key]]));
}

/** A date field as BeanBatch reads one: `DateTime.parse(json[key] as String)` unless it is null. */
function optionalDate(value: unknown): string | null {
  return value === null || value === undefined ? null : parseDate(castString(value));
}

/**
 * A date as Dart's `DateTime.parse` reads it, written back by
 * `toIso8601String`. Without an offset it is the tablet's local time, rolled
 * over as Dart's constructor does; with one, it is written in UTC.
 */
function parseDate(text: string): string {
  const match = /^([+-]?\d{4,6})-?(\d\d)-?(\d\d)(?:[ T](\d\d)(?::?(\d\d)(?::?(\d\d)(?:[.,](\d+))?)?)?( ?[zZ]| ?([-+])(\d\d)(?::?(\d\d))?)?)?$/.exec(text);
  if (!match) throw new DartError(`FormatException: Invalid date format\n${text}`);
  const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map((index) => Number(match[index] ?? 0)) as [number, number, number, number, number, number];
  const fraction = (match[7] ?? "").padEnd(6, "0").slice(0, 6);
  const [ms, us] = [Number(fraction.slice(0, 3)), Number(fraction.slice(3))];
  if (match[8] === undefined) {
    const local = new Date(year, month - 1, day, hour, minute, second, ms);
    return iso([local.getFullYear(), local.getMonth() + 1, local.getDate(), local.getHours(), local.getMinutes(), local.getSeconds(), local.getMilliseconds()], us, false);
  }
  const offset = match[9] === undefined ? 0 : (match[9] === "-" ? -1 : 1) * (Number(match[10]) * 60 + Number(match[11] ?? 0));
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms) - offset * 60_000);
  return iso([utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate(), utc.getUTCHours(), utc.getUTCMinutes(), utc.getUTCSeconds(), utc.getUTCMilliseconds()], us, true);
}

/** A time as Dart's `toIso8601String` writes it: milliseconds, then microseconds unless 0, then Z if in UTC. */
function iso(parts: [number, number, number, number, number, number, number], us: number, utc: boolean): string {
  const [year, month, day, hour, minute, second, ms] = parts;
  const two = (value: number) => String(value).padStart(2, "0");
  const yearText = year >= 0 && year <= 9999 ? String(year).padStart(4, "0") : `${year < 0 ? "-" : "+"}${String(Math.abs(year)).padStart(6, "0")}`;
  return `${yearText}-${two(month)}-${two(day)}T${two(hour)}:${two(minute)}:${two(second)}.${String(ms).padStart(3, "0")}${us === 0 ? "" : String(us).padStart(3, "0")}${utc ? "Z" : ""}`;
}

function castString(value: unknown): string {
  if (typeof value !== "string") throw new DartError(castError(value, "String"));
  return value;
}

/** A JSON value cast to a nullable Dart type, as `json[key] as T?` does. */
function castOptional(value: unknown, type: "String" | "bool" | "num" | "Map<String, dynamic>"): unknown {
  if (value === undefined || value === null) return null;
  const fits = type === "String" ? typeof value === "string" : type === "bool" ? typeof value === "boolean" : type === "num" ? typeof value === "number" : isObject(value);
  if (!fits) throw new DartError(castError(value, `${type}?`));
  return value;
}

function badRequest(error: string): DecaidAnswer {
  return { status: 400, body: { error } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
