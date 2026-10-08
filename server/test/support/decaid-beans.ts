// Decaid v0.8.7's beans API, as the simulated tablet answers writes to it:
// `BeansHandler` in decaid:lib/src/services/webserver/beans_handler.dart and
// `Bean` in lib/src/models/data/bean.dart, unchanged in v0.8.8. What it
// answers was recorded on Decaid's Linux release
// (fixtures/decaid/bean-writes-v0.8.7/), and
// server/test/simulated-bean-writes.test.ts replays those requests here.
//
// - `POST /beans` makes a record from the fields Bean.create takes, giving it
//   a random UUID and `createdAt` and `updatedAt` of now. It ignores
//   `archived` and fields it does not know, and answers 201.
// - `PUT /beans/{id}` merges the fields sent over the record, top level only,
//   so `extras` is replaced whole and null clears a field, then sets
//   `updatedAt` to now. It refuses null for roaster, name, decaf and archived,
//   and mistyped altitude and variety lists, with 400; an unknown id with 404.
// - Either refuses a field of the wrong type with 400, naming Dart's cast.
// - A record lists its fields in Bean.toJson's order, leaving out optional
//   ones that are null.
// - Times are the tablet's local time without an offset, as Dart's
//   `toIso8601String` writes one: milliseconds, then microseconds unless 0.
// - `GET /beans` lists the most recently updated first.

/** What Decaid answers: its status, and its body as JSON. */
export interface DecaidAnswer {
  status: number;
  body: unknown;
}

type Bean = Record<string, unknown>;

/** Bean's fields after its id and names, in Bean.toJson's order, with the Dart type its JSON is cast to. */
const OPTIONAL_FIELDS: readonly [string, "String" | "bool" | "List"][] = [
  ["species", "String"],
  ["decaf", "bool"],
  ["decafProcess", "String"],
  ["country", "String"],
  ["region", "String"],
  ["producer", "String"],
  ["variety", "List"],
  ["altitude", "List"],
  ["processing", "String"],
  ["notes", "String"],
];

class DartTypeError extends Error {}

/** Creates a bean from a request's body, as `POST /beans` does. */
export function createBean(beans: Bean[], body: unknown): { answer: DecaidAnswer; beans: Bean[] } {
  if (!isObject(body)) return { answer: badRequest(castError(body, "Map<String, dynamic>")), beans };
  try {
    const now = decaidNow();
    const bean = toJson({
      id: crypto.randomUUID(),
      roaster: cast(body.roaster, "String"),
      name: cast(body.name, "String"),
      ...Object.fromEntries(OPTIONAL_FIELDS.map(([key, type]) => [key, castOptional(body[key], type)])),
      decaf: castOptional(body.decaf, "bool") ?? false,
      archived: false,
      createdAt: now,
      updatedAt: now,
      extras: castOptional(body.extras, "Map<String, dynamic>"),
    });
    return { answer: { status: 201, body: bean }, beans: [...beans, bean] };
  } catch (error) {
    if (error instanceof DartTypeError) return { answer: badRequest(error.message), beans };
    throw error;
  }
}

/** Updates a bean with a request's body, as `PUT /beans/{id}` does. */
export function updateBean(beans: Bean[], id: string, body: unknown): { answer: DecaidAnswer; beans: Bean[] } {
  const existing = beans.find((bean) => bean.id === id);
  if (!existing) return { answer: { status: 404, body: { error: "Bean not found" } }, beans };
  if (!isObject(body)) return { answer: badRequest(castError(body, "Map<String, dynamic>")), beans };
  for (const field of ["roaster", "name", "decaf", "archived"]) {
    if (field in body && body[field] === null) return { answer: badRequest(`FormatException: Field "${field}" cannot be null`), beans };
  }
  if (!listOf(body.altitude, Number.isInteger)) return { answer: badRequest('FormatException: Field "altitude" must be an array of integers or null'), beans };
  if (!listOf(body.variety, (item) => typeof item === "string")) {
    return { answer: badRequest('FormatException: Field "variety" must be an array of strings or null'), beans };
  }
  try {
    const merged: Bean = { ...existing, ...body, id: existing.id, createdAt: existing.createdAt, updatedAt: decaidNow() };
    const bean = toJson({
      id: merged.id,
      roaster: cast(merged.roaster, "String"),
      name: cast(merged.name, "String"),
      ...Object.fromEntries(OPTIONAL_FIELDS.map(([key, type]) => [key, castOptional(merged[key], type)])),
      decaf: castOptional(merged.decaf, "bool") ?? false,
      archived: castOptional(merged.archived, "bool") ?? false,
      createdAt: merged.createdAt,
      updatedAt: merged.updatedAt,
      extras: castOptional(merged.extras, "Map<String, dynamic>"),
    });
    return { answer: { status: 200, body: bean }, beans: beans.map((candidate) => (candidate === existing ? bean : candidate)) };
  } catch (error) {
    if (error instanceof DartTypeError) return { answer: badRequest(error.message), beans };
    throw error;
  }
}

/** The beans as `GET /beans` lists them: the most recently updated first. */
export function listedBeans(beans: Bean[]): Bean[] {
  return [...beans].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/** A record with Bean.toJson's fields, in its order, without the optional ones that are null. */
function toJson(fields: Bean): Bean {
  const order = ["id", "roaster", "name", ...OPTIONAL_FIELDS.map(([key]) => key), "archived", "createdAt", "updatedAt", "extras"];
  const required = new Set(["id", "roaster", "name", "decaf", "archived", "createdAt", "updatedAt"]);
  return Object.fromEntries(order.filter((key) => required.has(key) || (fields[key] !== null && fields[key] !== undefined)).map((key) => [key, fields[key]]));
}

/** Microseconds since the epoch at which Decaid last read its clock; every read is later than the one before. */
let lastMicros = 0;

/** Now, as Decaid writes `DateTime.now()`: the tablet's local time without an offset, by `toIso8601String`. */
export function decaidNow(): string {
  lastMicros = Math.max(lastMicros + 1, Math.floor((performance.timeOrigin + performance.now()) * 1000));
  const time = new Date(Math.floor(lastMicros / 1000));
  const micros = lastMicros % 1000;
  const two = (value: number) => String(value).padStart(2, "0");
  const three = (value: number) => String(value).padStart(3, "0");
  return (
    `${String(time.getFullYear()).padStart(4, "0")}-${two(time.getMonth() + 1)}-${two(time.getDate())}` +
    `T${two(time.getHours())}:${two(time.getMinutes())}:${two(time.getSeconds())}.${three(time.getMilliseconds())}` +
    (micros === 0 ? "" : three(micros))
  );
}

function cast(value: unknown, type: "String"): string {
  if (typeof value !== "string") throw new DartTypeError(castError(value, type));
  return value;
}

/** A JSON value cast to a nullable Dart type, as `json[key] as T?` does. */
function castOptional(value: unknown, type: "String" | "bool" | "List" | "Map<String, dynamic>"): unknown {
  if (value === undefined || value === null) return null;
  const fits =
    type === "String" ? typeof value === "string" : type === "bool" ? typeof value === "boolean" : type === "List" ? Array.isArray(value) : isObject(value);
  if (!fits) throw new DartTypeError(castError(value, `${type === "List" ? "List<dynamic>" : type}?`));
  return value;
}

/** The message of the TypeError Dart throws casting a JSON value to a type it is not. */
export function castError(value: unknown, type: string): string {
  return `type '${dartType(value)}' is not a subtype of type '${type}' in type cast`;
}

/** The Dart type jsonDecode gives a JSON value. */
function dartType(value: unknown): string {
  if (value === null || value === undefined) return "Null";
  if (typeof value === "string") return "String";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "double";
  if (Array.isArray(value)) return "List<dynamic>";
  return "_Map<String, dynamic>";
}

/** Whether a value is absent, null, or a list whose every item is valid. */
function listOf(value: unknown, valid: (item: unknown) => boolean): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.every(valid));
}

function badRequest(error: string): DecaidAnswer {
  return { status: 400, body: { error } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
