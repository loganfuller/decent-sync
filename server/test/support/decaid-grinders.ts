import { type DecaidAnswer, castError, decaidNow } from "./decaid-beans.js";

// Decaid v0.8.7's grinders API, as the simulated tablet answers writes to
// it: `GrindersHandler` in decaid:lib/src/services/webserver/grinders_handler.dart
// and `Grinder` in lib/src/models/data/grinder.dart. What it answers was
// recorded on Decaid's Linux release (fixtures/decaid/grinder-writes-v0.8.7/),
// and server/test/simulated-grinder-writes.test.ts replays those requests
// here.
//
// - `POST /grinders` makes a record from the fields Grinder.create takes,
//   giving it a random UUID and `createdAt` and `updatedAt` of now. It
//   ignores `archived` and fields it does not know, and answers 201.
// - `PUT /grinders/{id}` merges the fields sent over the record, top level
//   only, so `extras` is replaced whole and null clears a field, then sets
//   `updatedAt` to now. It refuses null for model, archived and settingType,
//   and mistyped numbers and setting values, with 400; an unknown id with 404.
// - Either refuses a field of the wrong type with 400, naming Dart's cast.
//   A setting type other than `preset` or `values`, which is `preset`, is
//   `numeric`.
// - `DELETE /grinders/{id}` deletes the record, and answers 200 whether or
//   not there was one.
// - A record lists its fields in Grinder.toJson's order, leaving out optional
//   ones that are null.
// - `GET /grinders` lists the most recently updated first.

type Grinder = Record<string, unknown>;

/** Grinder's optional text fields after its model, and its numbers, in Grinder.toJson's order. */
const TEXTS = ["burrs", "burrType", "notes"] as const;
const NUMBERS = ["burrSize", "settingSmallStep", "settingBigStep", "rpmSmallStep", "rpmBigStep"] as const;

class DartError extends Error {}

/** Creates a grinder from a request's body, as `POST /grinders` does. */
export function createGrinder(grinders: Grinder[], body: unknown): { answer: DecaidAnswer; grinders: Grinder[] } {
  if (!isObject(body)) return { answer: badRequest(castError(body, "Map<String, dynamic>")), grinders };
  try {
    const now = decaidNow();
    const grinder = toJson({
      id: crypto.randomUUID(),
      model: cast(body.model),
      burrs: castOptional(body.burrs, "String"),
      burrSize: castOptional(body.burrSize, "num"),
      burrType: castOptional(body.burrType, "String"),
      notes: castOptional(body.notes, "String"),
      archived: false,
      settingType: body.settingType === undefined || body.settingType === null ? "numeric" : settingType(cast(body.settingType)),
      settingValues: stringList(castOptional(body.settingValues, "List")),
      ...Object.fromEntries(NUMBERS.slice(1).map((key) => [key, castOptional(body[key], "num")])),
      createdAt: now,
      updatedAt: now,
      extras: castOptional(body.extras, "Map<String, dynamic>"),
    });
    return { answer: { status: 201, body: grinder }, grinders: [...grinders, grinder] };
  } catch (error) {
    if (error instanceof DartError) return { answer: badRequest(error.message), grinders };
    throw error;
  }
}

/** Updates a grinder with a request's body, as `PUT /grinders/{id}` does. */
export function updateGrinder(grinders: Grinder[], id: string, body: unknown): { answer: DecaidAnswer; grinders: Grinder[] } {
  const existing = grinders.find((grinder) => grinder.id === id);
  if (!existing) return { answer: { status: 404, body: { error: "Grinder not found" } }, grinders };
  if (!isObject(body)) return { answer: badRequest(castError(body, "Map<String, dynamic>")), grinders };
  for (const field of ["model", "archived", "settingType"]) {
    if (field in body && body[field] === null) return { answer: badRequest(`FormatException: Field "${field}" cannot be null`), grinders };
  }
  for (const field of NUMBERS) {
    if (body[field] !== undefined && body[field] !== null && typeof body[field] !== "number") {
      return { answer: badRequest(`FormatException: Field "${field}" must be a number or null`), grinders };
    }
  }
  const values = body.settingValues;
  if (values !== undefined && values !== null && !(Array.isArray(values) && values.every((value) => typeof value === "string"))) {
    return { answer: badRequest('FormatException: Field "settingValues" must be an array of strings or null'), grinders };
  }
  try {
    const merged: Grinder = { ...existing, ...body, id: existing.id, createdAt: existing.createdAt, updatedAt: decaidNow() };
    const grinder = toJson({
      id: merged.id,
      model: cast(merged.model),
      ...Object.fromEntries(TEXTS.map((key) => [key, castOptional(merged[key], "String")])),
      ...Object.fromEntries(NUMBERS.map((key) => [key, castOptional(merged[key], "num")])),
      archived: castOptional(merged.archived, "bool") ?? false,
      settingType: merged.settingType === undefined ? "numeric" : settingType(cast(merged.settingType)),
      settingValues: stringList(castOptional(merged.settingValues, "List")),
      createdAt: merged.createdAt,
      updatedAt: merged.updatedAt,
      extras: castOptional(merged.extras, "Map<String, dynamic>"),
    });
    return { answer: { status: 200, body: grinder }, grinders: grinders.map((candidate) => (candidate === existing ? grinder : candidate)) };
  } catch (error) {
    if (error instanceof DartError) return { answer: badRequest(error.message), grinders };
    throw error;
  }
}

/** Deletes a grinder, as `DELETE /grinders/{id}` does: whether or not there is one. */
export function deleteGrinder(grinders: Grinder[], id: string): { answer: DecaidAnswer; grinders: Grinder[] } {
  return { answer: { status: 200, body: { success: true, id } }, grinders: grinders.filter((grinder) => grinder.id !== id) };
}

/** The grinders as `GET /grinders` lists them: the most recently updated first. */
export function listedGrinders(grinders: Grinder[]): Grinder[] {
  return [...grinders].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/** A record with Grinder.toJson's fields, in its order, without the optional ones that are null. */
function toJson(fields: Grinder): Grinder {
  const order = ["id", "model", "burrs", "burrSize", "burrType", "notes", "archived", "settingType", "settingValues", ...NUMBERS.slice(1), "createdAt", "updatedAt", "extras"];
  const required = new Set(["id", "model", "archived", "settingType", "createdAt", "updatedAt"]);
  return Object.fromEntries(order.filter((key) => required.has(key) || (fields[key] !== null && fields[key] !== undefined)).map((key) => [key, fields[key]]));
}

/** GrinderSettingType.fromString: `preset`, or `values` read as it, else `numeric`. */
function settingType(value: string): string {
  return value === "preset" || value === "values" ? "preset" : "numeric";
}

/** A list cast to `List<String>`, as Decaid's `cast<String>()` does once the list is read. */
function stringList(value: unknown): unknown {
  if (Array.isArray(value)) for (const item of value) if (typeof item !== "string") throw new DartError(castError(item, "String"));
  return value;
}

function cast(value: unknown): string {
  if (typeof value !== "string") throw new DartError(castError(value, "String"));
  return value;
}

/** A JSON value cast to a nullable Dart type, as `json[key] as T?` does. */
function castOptional(value: unknown, type: "String" | "num" | "bool" | "List" | "Map<String, dynamic>"): unknown {
  if (value === undefined || value === null) return null;
  const fits =
    type === "String"
      ? typeof value === "string"
      : type === "num"
        ? typeof value === "number"
        : type === "bool"
          ? typeof value === "boolean"
          : type === "List"
            ? Array.isArray(value)
            : isObject(value);
  if (!fits) throw new DartError(castError(value, `${type === "List" ? "List<dynamic>" : type}?`));
  return value;
}

function badRequest(error: string): DecaidAnswer {
  return { status: 400, body: { error } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
