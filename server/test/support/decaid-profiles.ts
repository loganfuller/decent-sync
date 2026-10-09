import { createHash } from "node:crypto";
import { type DecaidAnswer, castError, decaidNow } from "./decaid-beans.js";

// Decaid v0.8.7's profiles API, as the simulated tablet answers it:
// `ProfileHandler` in decaid:lib/src/services/webserver/profile_handler.dart,
// `ProfileController` in lib/src/controllers/profile_controller.dart,
// `ProfileRecord`, `Profile` and `ProfileHash` in lib/src/models/data/, and
// `ProfileDao` in lib/src/services/database/daos/profile_dao.dart, unchanged
// in v0.8.8. What it answers was recorded on Decaid's Linux release
// (fixtures/decaid/profile-writes-v0.8.7/), and
// server/test/simulated-profile-writes.test.ts replays those requests here.
//
// - A record's id is `profile:` and the first 20 hex digits of the SHA-256
//   of what the machine executes: the profile's version, beverage type,
//   steps, tank temperature and targets, as Dart's `jsonEncode` writes them
//   with their keys sorted. Title, author and notes are outside it, in
//   `metadataHash`. So the same profile has the same id on every tablet.
// - `POST /profiles` makes a record of `profile`, read as `Profile.fromJson`
//   reads one (fields it does not know dropped), with `parentId` and
//   `metadata`, visible, and answers 201. A parent it lacks is refused with
//   400. A profile whose id it holds already, hidden or deleted as it may be,
//   is answered with that record, unchanged, still with 201.
// - `PUT /profiles/{id}` replaces the profile and metadata sent, keeping the
//   record's parent, visibility and `createdAt`, and sets `updatedAt` to now.
//   New steps make a new id: the record is replaced by one under it, and one
//   it holds already under that id is refused with 400. A bundled profile's
//   content is refused with 400.
// - `PUT /profiles/{id}/visibility` sets `visible`, `hidden` or `deleted`,
//   refusing `deleted` for a bundled profile; `DELETE /profiles/{id}` marks a
//   user's profile deleted and hides a bundled one; `DELETE
//   /profiles/{id}/purge` removes a user's profile and refuses a bundled one.
//   Each sets `updatedAt` to now. An unknown id is refused with 400, but with
//   404 by `GET` and `DELETE /profiles/{id}`.
// - `GET /profiles` lists the visible ones, the most recently updated first:
//   with `includeHidden=true` every one, hidden and deleted ones included;
//   with `visibility`, those with it; with `parentId`, the children of that
//   Profile, whatever their visibility.
// - A refusal answers `{ error, message }`, the message as Dart prints the
//   exception: `Invalid argument(s): ...` or `FormatException: ...`.

/** What Decaid's records hold, as `ProfileRecord.toJson` writes it. */
type ProfileRecord = Record<string, unknown>;

/** Dart's errors, as their `toString` prints them, which Decaid's refusals repeat. */
class DartError extends Error {
  constructor(
    readonly kind: "ArgumentError" | "FormatException" | "TypeError" | "Exception",
    message: string,
  ) {
    super(kind === "ArgumentError" ? `Invalid argument(s): ${message}` : kind === "TypeError" ? message : `${kind}: ${message}`);
  }
}

/** The record with that id, as `GET /profiles/{id}` answers it. */
export function getProfile(profiles: readonly ProfileRecord[], id: string): DecaidAnswer {
  const found = profiles.find((record) => record.id === id);
  return found ? { status: 200, body: found } : { status: 404, body: { error: "Profile not found", id } };
}

/** The records `GET /profiles` lists for its query: the most recently updated first. */
export function listProfiles(profiles: readonly ProfileRecord[], query: URLSearchParams): DecaidAnswer {
  const parentId = query.get("parentId");
  if (parentId !== null) return { status: 200, body: byUpdate(profiles.filter((record) => record.parentId === parentId)) };
  const named = query.get("visibility");
  let visibility: string | null = null;
  if (named !== null) {
    try {
      visibility = visibilityOf(named);
    } catch {
      return { status: 400, body: { error: "Invalid visibility value", message: "Valid values: visible, hidden, deleted" } };
    }
  }
  if (query.get("includeHidden") === "true") return { status: 200, body: byUpdate(profiles) };
  return { status: 200, body: byUpdate(profiles.filter((record) => record.visibility === (visibility ?? "visible"))) };
}

/** Creates a profile from a request's body, as `POST /profiles` does. */
export function createProfile(profiles: readonly ProfileRecord[], body: unknown): { answer: DecaidAnswer; profiles: ProfileRecord[] } {
  const all = [...profiles];
  try {
    const json = castMap(body);
    if (!("profile" in json)) return { answer: { status: 400, body: { error: "Missing required field", message: 'Request must contain "profile" field' } }, profiles: all };
    const profile = readProfile(castMap(json.profile));
    const parentId = castOptional(json.parentId, "String") as string | null;
    const metadata = castOptional(json.metadata, "Map<String, dynamic>") as Record<string, unknown> | null;
    if (parentId !== null && !all.some((record) => record.id === parentId)) throw new DartError("ArgumentError", `Parent profile not found: ${parentId}`);
    const now = decaidNow();
    const record = recordOf(profile, { parentId, visibility: "visible", isDefault: false, createdAt: now, updatedAt: now, metadata });
    const existing = all.find((candidate) => candidate.id === record.id);
    if (existing) return { answer: { status: 201, body: existing }, profiles: all };
    return { answer: { status: 201, body: record }, profiles: [...all, record] };
  } catch (error) {
    return { answer: refusal(error, ["ArgumentError", "FormatException"]), profiles: all };
  }
}

/** Replaces a profile's content or metadata with a request's body, as `PUT /profiles/{id}` does. */
export function updateProfile(profiles: readonly ProfileRecord[], id: string, body: unknown): { answer: DecaidAnswer; profiles: ProfileRecord[] } {
  const all = [...profiles];
  try {
    const json = castMap(body);
    let profile: Record<string, unknown> | null = null;
    if ("profile" in json) {
      if (json.profile === null || json.profile === undefined) throw new DartError("FormatException", 'Field "profile" cannot be null');
      profile = readProfile(castMap(json.profile));
    }
    const metadata = castOptional(json.metadata, "Map<String, dynamic>") as Record<string, unknown> | null;
    const existing = all.find((record) => record.id === id);
    if (!existing) throw new DartError("ArgumentError", `Profile not found: ${id}`);
    if (existing.isDefault === true && profile !== null) throw new DartError("ArgumentError", "Cannot modify default profile content");
    const updated = recordOf(profile ?? (existing.profile as Record<string, unknown>), {
      parentId: existing.parentId,
      visibility: existing.visibility,
      isDefault: existing.isDefault,
      createdAt: existing.createdAt,
      updatedAt: decaidNow(),
      metadata: "metadata" in json && metadata === null ? null : (metadata ?? existing.metadata),
    });
    if (updated.id === existing.id) return { answer: { status: 200, body: updated }, profiles: all.map((record) => (record === existing ? updated : record)) };
    // New steps: a new id, replacing the record (DriftProfileStorageService.replace).
    if (all.some((record) => record.id === updated.id)) throw new DartError("ArgumentError", `Profile already exists: ${String(updated.id)}`);
    return { answer: { status: 200, body: updated }, profiles: [...all.filter((record) => record !== existing), updated] };
  } catch (error) {
    return { answer: refusal(error, ["ArgumentError", "FormatException", "TypeError"]), profiles: all };
  }
}

/** Sets a profile's visibility from a request's body, as `PUT /profiles/{id}/visibility` does. */
export function setProfileVisibility(profiles: readonly ProfileRecord[], id: string, body: unknown): { answer: DecaidAnswer; profiles: ProfileRecord[] } {
  const all = [...profiles];
  try {
    const json = castMap(body);
    if (!("visibility" in json)) return { answer: { status: 400, body: { error: "Missing required field", message: 'Request must contain "visibility" field' } }, profiles: all };
    const visibility = visibilityOf(castString(json.visibility));
    const existing = all.find((record) => record.id === id);
    if (!existing) throw new DartError("ArgumentError", `Profile not found: ${id}`);
    if (existing.isDefault === true && visibility === "deleted") throw new DartError("ArgumentError", "Cannot delete default profiles, only hide them");
    const updated = { ...existing, visibility, updatedAt: decaidNow() };
    return { answer: { status: 200, body: updated }, profiles: all.map((record) => (record === existing ? updated : record)) };
  } catch (error) {
    return { answer: refusal(error, ["ArgumentError"]), profiles: all };
  }
}

/** Deletes a profile, as `DELETE /profiles/{id}` does: a user's is marked deleted, and a bundled one hidden. */
export function deleteProfile(profiles: readonly ProfileRecord[], id: string): { answer: DecaidAnswer; profiles: ProfileRecord[] } {
  const existing = profiles.find((record) => record.id === id);
  if (!existing) return { answer: { status: 404, body: { error: "Not found", message: `Invalid argument(s): Profile not found: ${id}` } }, profiles: [...profiles] };
  const updated = { ...existing, visibility: existing.isDefault === true ? "hidden" : "deleted", updatedAt: decaidNow() };
  return {
    answer: { status: 200, body: { success: true, message: "Profile deleted", id } },
    profiles: profiles.map((record) => (record === existing ? updated : record)),
  };
}

/** Removes a user's profile, as `DELETE /profiles/{id}/purge` does. */
export function purgeProfile(profiles: readonly ProfileRecord[], id: string): { answer: DecaidAnswer; profiles: ProfileRecord[] } {
  const existing = profiles.find((record) => record.id === id);
  const refused = (message: string) => ({ answer: { status: 400, body: { error: "Invalid request", message: `Invalid argument(s): ${message}` } }, profiles: [...profiles] });
  if (!existing) return refused(`Profile not found: ${id}`);
  if (existing.isDefault === true) return refused("Cannot purge default profiles");
  return { answer: { status: 200, body: { success: true, message: "Profile permanently deleted", id } }, profiles: profiles.filter((record) => record !== existing) };
}

/** The id Decaid gives a profile: `profile:` and the start of the hash of what the machine executes (ProfileHash.calculateProfileHash). */
export function profileId(profile: Record<string, unknown>): string {
  const executed = {
    version: profile.version,
    beverage_type: profile.beverage_type,
    steps: profile.steps,
    tank_temperature: profile.tank_temperature,
    target_weight: profile.target_weight,
    target_volume: profile.target_volume,
    target_volume_count_start: profile.target_volume_count_start,
  };
  return `profile:${sha256(dartJson(executed, EXECUTED)).slice(0, 20)}`;
}

/** A record of a profile, as `ProfileRecord.toJson` writes one, with its hashes. */
function recordOf(profile: Record<string, unknown>, fields: Omit<ProfileRecord, "id" | "profile" | "metadataHash" | "compoundHash">): ProfileRecord {
  const id = profileId(profile);
  const metadataHash = sha256(dartJson({ title: profile.title, author: profile.author, notes: profile.notes }, METADATA));
  return {
    id,
    profile,
    metadataHash,
    compoundHash: sha256(`${id}:${metadataHash}`),
    parentId: fields.parentId,
    visibility: fields.visibility,
    isDefault: fields.isDefault,
    createdAt: fields.createdAt,
    updatedAt: fields.updatedAt,
    metadata: fields.metadata,
  };
}

/** The Dart type of each field a hash covers, so it is written as Dart writes it: a double with its `.0`. */
type Schema = { readonly [key: string]: "String" | "int" | "double" | "steps" | Schema };
const EXIT: Schema = { type: "String", condition: "String", value: "double" };
const LIMITER: Schema = { value: "double", range: "double" };
const STEP: Schema = {
  name: "String",
  pump: "String",
  transition: "String",
  exit: EXIT,
  volume: "double",
  seconds: "double",
  weight: "double",
  temperature: "double",
  sensor: "String",
  pressure: "double",
  flow: "double",
  limiter: LIMITER,
};
const EXECUTED: Schema = {
  version: "String",
  beverage_type: "String",
  steps: "steps",
  tank_temperature: "double",
  target_weight: "double",
  target_volume: "double",
  target_volume_count_start: "int",
};
const METADATA: Schema = { title: "String", author: "String", notes: "String" };

/** A map as `ProfileHash._encodeJsonStable` writes it: its keys sorted, and its values as Dart's `jsonEncode` writes them. */
function dartJson(value: Record<string, unknown>, schema: Schema): string {
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${dartValue(value[key], schema[key]!)}`);
  return `{${entries.join(",")}}`;
}

function dartValue(value: unknown, type: Schema[string]): string {
  if (value === null || value === undefined) return "null";
  if (type === "steps") return `[${(value as Record<string, unknown>[]).map((step) => dartJson(step, STEP)).join(",")}]`;
  if (typeof type === "object") return dartJson(value as Record<string, unknown>, type);
  if (type === "double") return dartDouble(value as number);
  return JSON.stringify(value);
}

/** How Dart writes a double: a whole one with `.0`, below 1e21. */
function dartDouble(value: number): string {
  if (Object.is(value, -0)) return "-0.0";
  return Number.isInteger(value) && Math.abs(value) < 1e21 ? `${value}.0` : String(value);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * A profile as `Profile.fromJson` reads one and `toJson` writes it back:
 * only the fields Decaid knows, in its order, with a title, steps, a tank
 * temperature and a volume count start required.
 */
function readProfile(json: Record<string, unknown>): Record<string, unknown> {
  const title = optionalString(json.title);
  if (title === null || title === "") throw new DartError("ArgumentError", 'Profile must have a non-empty "title"');
  if (!Array.isArray(json.steps) || json.steps.length === 0) throw new DartError("ArgumentError", 'Profile must have a non-empty "steps" array');
  if (json.tank_temperature === null || json.tank_temperature === undefined) throw new DartError("ArgumentError", 'Profile must have "tank_temperature"');
  if (json.target_volume_count_start === null || json.target_volume_count_start === undefined) {
    throw new DartError("ArgumentError", 'Profile must have "target_volume_count_start"');
  }
  return {
    version: optionalString(json.version),
    title,
    notes: optionalString(json.notes) ?? "",
    author: optionalString(json.author) ?? "",
    beverage_type: beverageType(json.beverage_type),
    steps: json.steps.map((step) => readStep(castMap(step))),
    target_volume: optionalDouble(json.target_volume),
    target_weight: optionalDouble(json.target_weight),
    target_volume_count_start: parseInt(json.target_volume_count_start),
    tank_temperature: parseDouble(json.tank_temperature),
  };
}

/** A step as `ProfileStep.fromJson` reads one and `toJson` writes it back. */
function readStep(json: Record<string, unknown>): Record<string, unknown> {
  const pump = json.pump;
  if (pump !== "pressure" && pump !== "flow") throw new DartError("Exception", 'Invalid step type. Must include either "pressure" or "flow".');
  return {
    name: castString(json.name),
    pump,
    transition: enumValue(json.transition, ["fast", "smooth"]),
    exit: json.exit === null || json.exit === undefined ? null : readExit(castMap(json.exit)),
    volume: parseDouble(json.volume),
    seconds: parseDouble(json.seconds),
    weight: optionalDouble(json.weight),
    temperature: parseDouble(json.temperature),
    sensor: enumValue(json.sensor, ["coffee", "water"]),
    [pump]: parseDouble(json[pump]),
    limiter: json.limiter === null || json.limiter === undefined ? null : readLimiter(castMap(json.limiter)),
  };
}

/** A step's exit condition, as `StepExitCondition.fromJson` reads it. */
function readExit(json: Record<string, unknown>): Record<string, unknown> {
  return { type: enumValue(json.type, ["pressure", "flow"]), condition: enumValue(json.condition, ["over", "under"]), value: parseDouble(json.value) };
}

/** A step's limiter, as `StepLimiter.fromJson` reads it. */
function readLimiter(json: Record<string, unknown>): Record<string, unknown> {
  return { value: parseDouble(json.value), range: parseDouble(json.range) };
}

/** `_parseBeverageType`: a known type, in any case, or espresso. */
function beverageType(value: unknown): string {
  const name = value === null || value === undefined ? "" : String(value).toLowerCase();
  return ["espresso", "calibrate", "cleaning", "manual", "pourover"].includes(name) ? name : "espresso";
}

/** `Visibility.fromString`: visible, hidden or deleted, in any case. */
function visibilityOf(value: string): string {
  const name = value.toLowerCase();
  if (!["visible", "hidden", "deleted"].includes(name)) throw new DartError("ArgumentError", `Invalid visibility value: ${value}`);
  return name;
}

/** `values.byName`: one of an enum's names. */
function enumValue(value: unknown, names: readonly string[]): string {
  const name = castString(value);
  if (!names.includes(name)) throw new DartError("ArgumentError", `No enum value with that name: "${name}"`);
  return name;
}

/** `parseOptionalString`: a string, or a number or boolean as Dart prints it. */
function optionalString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/** `parseDouble`: a number, or a string Dart parses as one. */
function parseDouble(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") throw new DartError("TypeError", castError(value, "String"));
  const parsed = Number(value.trim());
  if (value.trim() === "" || Number.isNaN(parsed)) throw new DartError("FormatException", `Invalid double\n${value}`);
  return parsed;
}

function optionalDouble(value: unknown): number | null {
  return value === null || value === undefined ? null : parseDouble(value);
}

/** `parseInt`: a number, truncated, or a string Dart parses as a whole one. */
function parseInt(value: unknown): number {
  if (typeof value === "number") return Math.trunc(value);
  const parsed = typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed)) throw new DartError("FormatException", `Invalid radix-10 number\n${String(value)}`);
  return parsed;
}

function castMap(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new DartError("TypeError", castError(value, "Map<String, dynamic>"));
  return value;
}

function castString(value: unknown): string {
  if (typeof value !== "string") throw new DartError("TypeError", castError(value, "String"));
  return value;
}

/** A JSON value cast to a nullable Dart type, as `json[key] as T?` does. */
function castOptional(value: unknown, type: "String" | "Map<String, dynamic>"): unknown {
  if (value === undefined || value === null) return null;
  if (type === "String" ? typeof value !== "string" : !isObject(value)) throw new DartError("TypeError", castError(value, `${type}?`));
  return value;
}

/** Decaid's answer to an exception: 400 for those its handler catches (`caught`), 500 for the rest. */
function refusal(error: unknown, caught: readonly DartError["kind"][]): DecaidAnswer {
  if (!(error instanceof DartError)) throw error;
  if (caught.includes(error.kind)) return { status: 400, body: { error: "Invalid request", message: error.message } };
  return { status: 500, body: { error: "Internal server error", message: error.message } };
}

function byUpdate(profiles: readonly ProfileRecord[]): ProfileRecord[] {
  return [...profiles].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
