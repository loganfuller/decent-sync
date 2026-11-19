// A profile, as Decaid v0.9.2 reads and writes one (`Profile`, `ProfileStep`
// and their parts in decaid:lib/src/models/data/profile.dart): its shape, how
// Decaid reads a record into it, the id Decaid gives it, the limits the
// server holds its numbers to and the checks it makes of one (ADR-0032).
// The server, the plugin, the management interface and the MCP tools read
// every profile through `readProfile`, never as an untyped object.
//
// Pure: no Node or browser API, as the plugin bundles this package.

import { sha256Hex } from "./sha256.js";

/** Decaid's drink kinds (`BeverageType`); it reads any other as espresso. */
export const BEVERAGE_TYPES = ["espresso", "pourover", "cleaning", "calibrate", "manual"] as const;
export type BeverageType = (typeof BEVERAGE_TYPES)[number];

/** What a step's pump controls; the other is capped by its limiter. */
export const STEP_PUMPS = ["pressure", "flow"] as const;
export type StepPump = (typeof STEP_PUMPS)[number];

/** Whether a step gets to its target at once (`fast`) or over the whole step (`smooth`). */
export const STEP_TRANSITIONS = ["fast", "smooth"] as const;
export type StepTransition = (typeof STEP_TRANSITIONS)[number];

/** Where a step's temperature is measured: in the coffee, or the water at the group. */
export const STEP_SENSORS = ["coffee", "water"] as const;
export type StepSensor = (typeof STEP_SENSORS)[number];

/** The quantity a step's exit watches. */
export const EXIT_TYPES = ["pressure", "flow"] as const;
export type ExitType = (typeof EXIT_TYPES)[number];

/** Whether a step's exit fires as the quantity goes over its value or under it. */
export const EXIT_CONDITIONS = ["over", "under"] as const;
export type ExitCondition = (typeof EXIT_CONDITIONS)[number];

/** A step's exit: it moves on to the next step once `type` goes `condition` `value` (`StepExitCondition`). */
export interface StepExit {
  type: ExitType;
  condition: ExitCondition;
  value: number;
}

/**
 * A step's limiter (`StepLimiter`): the cap on the quantity its pump does not
 * control, a flow limit on a pressure step and a pressure limit on a flow
 * step, eased into over `range`.
 */
export interface StepLimiter {
  value: number;
  range: number;
}

interface StepFields {
  name: string;
  transition: StepTransition;
  exit: StepExit | null;
  /** The water the step may pump, ml; 0 for no limit. */
  volume: number;
  /** The step's maximum time, s. */
  seconds: number;
  /** The weight in the cup that ends the step, g; null or 0 for none. */
  weight: number | null;
  /** °C, measured where `sensor` says. */
  temperature: number;
  sensor: StepSensor;
  limiter: StepLimiter | null;
}

/** A step whose pump controls pressure, toward `pressure` bar. */
export interface PressureStep extends StepFields {
  pump: "pressure";
  pressure: number;
}

/** A step whose pump controls flow, toward `flow` ml/s. */
export interface FlowStep extends StepFields {
  pump: "flow";
  flow: number;
}

export type ProfileStep = PressureStep | FlowStep;

/**
 * A profile as Decaid writes it (`Profile.toJson`): every field it reads and
 * writes, with the keys and the value types it writes them with. Title,
 * author and notes are its metadata, outside its id (`profileId`).
 */
export interface Profile {
  version: string | null;
  title: string;
  notes: string;
  author: string;
  beverage_type: BeverageType;
  steps: ProfileStep[];
  /** The volume that stops a Shot with no scale, ml; null or 0 for none. */
  target_volume: number | null;
  /** The weight that stops a Shot, g; null or 0 for none. */
  target_weight: number | null;
  /** The number of steps counted as preinfusion: water is counted toward `target_volume` from the step at this index. */
  target_volume_count_start: number;
  /** °C; 0 for none. */
  tank_temperature: number;
}

/** A profile read, or why Decaid would refuse to read it. */
export type ReadProfile = { profile: Profile; problem?: undefined } | { profile?: undefined; problem: string };

/**
 * Reads a profile as Decaid reads one it is sent or holds
 * (`Profile.fromRecordedJson`, whose steps are read as `Profile.fromJson`
 * reads them): a number written as text is read as the number, a version,
 * title, author or notes written as a number or a flag as its text, a drink
 * kind in any case, or none Decaid knows, as espresso, a missing author or
 * notes as empty, a missing tank temperature or preinfusion count as 0, and
 * fields Decaid does not know are left out. A step Decaid would refuse makes
 * the profile a problem, naming the step and field and never its value.
 *
 * Unlike Decaid, it keeps a missing title as empty, which Decaid reads as
 * "Unknown profile", so the checks can name it, and it refuses what Decaid
 * would read in a way JavaScript can't follow: a number written as text that
 * is not decimal (hexadecimal, `NaN`, `Infinity`), a number too large to
 * be a double, and a preinfusion count beyond the whole numbers a double
 * holds exactly.
 */
export function readProfile(value: unknown): ReadProfile {
  if (!isObject(value)) return { problem: "A profile must be an object" };
  const steps: ProfileStep[] = [];
  const rawSteps = Array.isArray(value.steps) ? value.steps : [];
  for (let index = 0; index < rawSteps.length; index++) {
    const step = readStep(rawSteps[index]);
    if (typeof step === "string") return { problem: `Step ${index + 1}: ${step}` };
    steps.push(step);
  }
  const targetVolume = readOptionalDouble(value.target_volume);
  if (targetVolume === undefined) return { problem: "target_volume must be a number" };
  const targetWeight = readOptionalDouble(value.target_weight);
  if (targetWeight === undefined) return { problem: "target_weight must be a number" };
  const countStart = readInt(value.target_volume_count_start ?? 0);
  if (countStart === undefined) return { problem: "target_volume_count_start must be a whole number" };
  const tank = readDouble(value.tank_temperature ?? 0);
  if (tank === undefined) return { problem: "tank_temperature must be a number" };
  return {
    profile: {
      version: readOptionalString(value.version),
      title: readOptionalString(value.title) ?? "",
      notes: readOptionalString(value.notes) ?? "",
      author: readOptionalString(value.author) ?? "",
      beverage_type: readBeverageType(value.beverage_type),
      steps,
      target_volume: targetVolume,
      target_weight: targetWeight,
      target_volume_count_start: countStart,
      tank_temperature: tank,
    },
  };
}

/** A profile read, or null where Decaid would refuse it (`readProfile`). */
export function profileOf(value: unknown): Profile | null {
  return readProfile(value).profile ?? null;
}

/** Reads one step, or says which field Decaid would refuse it for. */
function readStep(value: unknown): ProfileStep | string {
  if (!isObject(value)) return "must be an object";
  const pump = value.pump;
  if (pump !== "pressure" && pump !== "flow") return 'pump must be "pressure" or "flow"';
  if (typeof value.name !== "string") return "name must be text";
  const transition = value.transition;
  if (!isOneOf(STEP_TRANSITIONS, transition)) return 'transition must be "fast" or "smooth"';
  const sensor = value.sensor;
  if (!isOneOf(STEP_SENSORS, sensor)) return 'sensor must be "coffee" or "water"';
  let exit: StepExit | null = null;
  if (value.exit !== null && value.exit !== undefined) {
    if (!isObject(value.exit)) return "exit must be an object";
    const { type, condition } = value.exit;
    if (!isOneOf(EXIT_TYPES, type)) return 'exit.type must be "pressure" or "flow"';
    if (!isOneOf(EXIT_CONDITIONS, condition)) return 'exit.condition must be "over" or "under"';
    const exitValue = readDouble(value.exit.value);
    if (exitValue === undefined) return "exit.value must be a number";
    exit = { type, condition, value: exitValue };
  }
  let limiter: StepLimiter | null = null;
  if (value.limiter !== null && value.limiter !== undefined) {
    if (!isObject(value.limiter)) return "limiter must be an object";
    const limit = readDouble(value.limiter.value);
    if (limit === undefined) return "limiter.value must be a number";
    const range = readDouble(value.limiter.range);
    if (range === undefined) return "limiter.range must be a number";
    limiter = { value: limit, range };
  }
  const numbers: Record<"volume" | "seconds" | "temperature" | StepPump, number> = { volume: 0, seconds: 0, temperature: 0, pressure: 0, flow: 0 };
  for (const field of ["volume", "seconds", "temperature", pump] as const) {
    const number = readDouble(value[field]);
    if (number === undefined) return `${field} must be a number`;
    numbers[field] = number;
  }
  const weight = readOptionalDouble(value.weight);
  if (weight === undefined) return "weight must be a number";
  // In the order Decaid writes a step's fields (`toJson`), so a step read is written back as Decaid wrote it.
  const { volume, seconds, temperature } = numbers;
  const name = value.name;
  return pump === "pressure"
    ? { name, pump, transition, exit, volume, seconds, weight, temperature, sensor, pressure: numbers.pressure, limiter }
    : { name, pump, transition, exit, volume, seconds, weight, temperature, sensor, flow: numbers.flow, limiter };
}

/** A step's target: the pressure or flow its pump is asked for. */
export function stepTarget(step: ProfileStep): number {
  return step.pump === "pressure" ? step.pressure : step.flow;
}

// Decaid's id ----------------------------------------------------------------

/**
 * The id Decaid gives a profile (`ProfileHash.calculateProfileHash`):
 * `profile:` and the first 20 hex digits of the SHA-256 of what the machine
 * executes, its version, drink kind, steps, tank temperature, target weight
 * and volume and preinfusion count, written as Dart's `jsonEncode` writes
 * them with every object's keys sorted. A double is written as Dart writes
 * one, a whole one with `.0`, so 9 is `9.0`, and the preinfusion count, an
 * integer, without. Title, author and notes are outside it. Checked against
 * the ids Decaid gave every profile it bundles and hand-made cases
 * (`server/test/fixtures/decaid/profile-ids-v0.9.2/`).
 */
export function profileId(profile: Profile): string {
  const data: Record<string, Hashed> = {
    version: profile.version,
    beverage_type: profile.beverage_type,
    steps: profile.steps.map(stepHashed),
    tank_temperature: double(profile.tank_temperature),
    target_weight: optionalDouble(profile.target_weight),
    target_volume: optionalDouble(profile.target_volume),
    target_volume_count_start: { int: profile.target_volume_count_start },
  };
  return `profile:${sha256Hex(dartJson(data)).slice(0, 20)}`;
}

/**
 * What Decaid hashes for a profile's id (`profileId`) but its target weight,
 * with its steps as `stepsKey` reads them: what the machine executes, but
 * for what a Skin overrides as it loads a profile into the Workflow, the
 * yield and each step's temperature, as the server finds a Shot's Profile
 * (`profileOfSql` in server/src/shots/links.ts). Two profiles of one key run
 * the same Shot. A Draft's steps and a Workflow's are compared by it too
 * (ADR-0032).
 */
export function profileStepsKey(profile: Profile): string {
  return stableJson({
    version: profile.version,
    beverage_type: profile.beverage_type,
    tank_temperature: profile.tank_temperature,
    target_volume: profile.target_volume,
    target_volume_count_start: profile.target_volume_count_start,
    steps: JSON.parse(stepsKey(profile.steps)) as unknown,
  });
}

/**
 * A profile's steps as they identify it, as text that is the same for the
 * same steps, as the server compares them (`profile_steps_key` in its first
 * migration): each step's temperature left out, and a limiter of value 0,
 * which is no limiter, read as none, as a Skin overrides the temperature in
 * the profile it loads into the Workflow, and streamline-js sends such a
 * limiter as null while the record keeps it.
 */
export function stepsKey(steps: readonly ProfileStep[]): string {
  return stableJson(
    steps.map((step) => {
      const { temperature: _, ...rest } = step;
      return rest.limiter !== null && rest.limiter.value === 0 ? { ...rest, limiter: null } : rest;
    }),
  );
}

/** JSON with every object's keys sorted. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

/** A value as Dart's `jsonEncode` writes it: a double or an int marked as such, since JavaScript tells neither from the other. */
type Hashed = string | null | { double: number } | { int: number } | Hashed[] | { [key: string]: Hashed };

function double(value: number): Hashed {
  return { double: value };
}

function optionalDouble(value: number | null): Hashed {
  return value === null ? null : { double: value };
}

function stepHashed(step: ProfileStep): Record<string, Hashed> {
  const hashed: Record<string, Hashed> = {
    name: step.name,
    pump: step.pump,
    transition: step.transition,
    exit: step.exit === null ? null : { type: step.exit.type, condition: step.exit.condition, value: double(step.exit.value) },
    volume: double(step.volume),
    seconds: double(step.seconds),
    weight: optionalDouble(step.weight),
    temperature: double(step.temperature),
    sensor: step.sensor,
    limiter: step.limiter === null ? null : { value: double(step.limiter.value), range: double(step.limiter.range) },
  };
  hashed[step.pump] = double(stepTarget(step));
  return hashed;
}

/** Writes a value as Dart's `jsonEncode` writes it after Decaid sorts every map's keys (`_encodeJsonStable`). */
function dartJson(value: Hashed): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(dartJson).join(",")}]`;
  if ("double" in value && typeof value.double === "number") return dartDouble(value.double);
  if ("int" in value && typeof value.int === "number") return String(Math.trunc(value.int));
  const object = value as { [key: string]: Hashed };
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${dartJson(object[key]!)}`)
    .join(",")}}`;
}

/**
 * A double as Dart's `toString` writes it: the shortest text that reads back
 * as it, as JavaScript's, but a whole number below 1e21 with `.0` after it,
 * and negative zero as `-0.0`.
 */
function dartDouble(value: number): string {
  if (Object.is(value, -0)) return "-0.0";
  if (Number.isInteger(value) && Math.abs(value) < 1e21) return `${value}.0`;
  return String(value);
}

// Reading Decaid's values ----------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** A decimal number written as text, read as Dart's `double.parse` reads it, or undefined. */
function decimal(text: string): number | undefined {
  const trimmed = text.trim();
  if (!DECIMAL.test(trimmed)) return undefined;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : undefined;
}

/** Decaid's `parseDouble`: a number, or a number written as text; undefined where Decaid refuses it. */
function readDouble(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  return typeof value === "string" ? decimal(value) : undefined;
}

/**
 * Decaid's `parseOptionalDouble`: null for none, and for text that reads as
 * no number, which Decaid takes as none too; undefined where Decaid refuses
 * it, or where it would read a number JavaScript can't follow.
 */
function readOptionalDouble(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const number = decimal(value);
  if (number !== undefined) return number;
  return /^\s*[+-]?(0[xX][0-9a-fA-F]+|NaN|Infinity)\s*$/.test(value) || DECIMAL.test(value.trim()) ? undefined : null;
}

/**
 * Decaid's `parseInt`: a whole number, a double cut to one, or a whole
 * number written as text; undefined where Decaid refuses it, or where it is
 * beyond the whole numbers JavaScript holds exactly, which Decaid's 64-bit
 * `int` would read as another.
 */
function readInt(value: unknown): number | undefined {
  const int = typeof value === "number" ? (Number.isFinite(value) ? Math.trunc(value) + 0 : undefined) : typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value) ? Number.parseInt(value, 10) + 0 : undefined;
  return int !== undefined && Number.isSafeInteger(int) ? int : undefined;
}

/** Decaid's `parseOptionalString`: text as it is, a number or flag as its text, anything else as none. */
function readOptionalString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/** Decaid's `_parseBeverageType`: one of its five drink kinds in any case, and espresso for anything else. */
function readBeverageType(value: unknown): BeverageType {
  const name = typeof value === "string" ? value.toLowerCase() : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
  return isOneOf(BEVERAGE_TYPES, name) ? name : "espresso";
}

// Limits -----------------------------------------------------------------------

/** A number's range, inclusive. */
export interface Range {
  min: number;
  max: number;
}

/**
 * The ranges the server holds a profile's numbers to, Streamline's
 * (`FIELD_LIMITS` and `EXIT_MAX_MAP` in
 * streamline-js:src/modules/profile-field-limits.js, v0.2.27), as the spec
 * lists them (#574). Decaid checks none of them, and the machine's wire
 * format holds less than a double: a step's time goes as one byte, in
 * tenths of a second below 12.75 s and whole seconds from there, so
 * anything over 127 s runs as 127 s (`convert_float_to_F8_1_7` in
 * decaid:lib/src/models/device/impl/de1/unified_de1/unified_de1.profile.dart,
 * v0.9.2). A step's target and exit are ranged by the quantity, its limiter
 * by the quantity it caps.
 */
export const PROFILE_LIMITS = {
  pressure: { min: 0, max: 12 },
  flow: { min: 0, max: 15 },
  temperature: { min: 0, max: 105 },
  seconds: { min: 0, max: 127 },
  volume: { min: 0, max: 500 },
  weight: { min: 0, max: 500 },
  /** A flow limit, on a pressure step. */
  flowLimit: { min: 0, max: 8 },
  /** A pressure limit, on a flow step. */
  pressureLimit: { min: 0, max: 12 },
  limiterRange: { min: 0, max: 5 },
  pressureExit: { min: 0, max: 12 },
  flowExit: { min: 0, max: 8 },
  tankTemperature: { min: 0, max: 110 },
  targetWeight: { min: 0, max: 500 },
  targetVolume: { min: 0, max: 500 },
} as const satisfies Record<string, Range>;

/** The most steps a profile may have, as Streamline's editor allows. */
export const MAX_PROFILE_STEPS = 20;

/** About the most flow the machine's pump gives, ml/s. */
export const PUMP_MAX_FLOW = 8;

/** A profile's field, named by its path in Decaid's JSON (`steps.2.limiter.value`), and the step it is of, by index, or null for the profile's own. */
export interface ProfileField {
  step: number | null;
  path: string;
}

/** A value held to its range, from what it was. */
export interface HeldValue extends ProfileField {
  from: number;
  to: number;
}

/** Each number of a profile with its range: [step index or null, path, value, range]. */
function rangedNumbers(profile: Profile): Array<[number | null, string, number, Range]> {
  const numbers: Array<[number | null, string, number, Range]> = [];
  profile.steps.forEach((step, index) => {
    const at = `steps.${index}`;
    numbers.push([index, `${at}.${step.pump}`, stepTarget(step), PROFILE_LIMITS[step.pump]]);
    numbers.push([index, `${at}.temperature`, step.temperature, PROFILE_LIMITS.temperature]);
    numbers.push([index, `${at}.seconds`, step.seconds, PROFILE_LIMITS.seconds]);
    numbers.push([index, `${at}.volume`, step.volume, PROFILE_LIMITS.volume]);
    if (step.weight !== null) numbers.push([index, `${at}.weight`, step.weight, PROFILE_LIMITS.weight]);
    if (step.exit) numbers.push([index, `${at}.exit.value`, step.exit.value, step.exit.type === "pressure" ? PROFILE_LIMITS.pressureExit : PROFILE_LIMITS.flowExit]);
    if (step.limiter) {
      numbers.push([index, `${at}.limiter.value`, step.limiter.value, step.pump === "pressure" ? PROFILE_LIMITS.flowLimit : PROFILE_LIMITS.pressureLimit]);
      numbers.push([index, `${at}.limiter.range`, step.limiter.range, PROFILE_LIMITS.limiterRange]);
    }
  });
  numbers.push([null, "tank_temperature", profile.tank_temperature, PROFILE_LIMITS.tankTemperature]);
  if (profile.target_weight !== null) numbers.push([null, "target_weight", profile.target_weight, PROFILE_LIMITS.targetWeight]);
  if (profile.target_volume !== null) numbers.push([null, "target_volume", profile.target_volume, PROFILE_LIMITS.targetVolume]);
  return numbers;
}

/** Each of a profile's numbers outside its range. */
export function outOfRange(profile: Profile): HeldValue[] {
  return rangedNumbers(profile)
    .filter(([, , value, range]) => value < range.min || value > range.max)
    .map(([step, path, value, range]) => ({ step, path, from: value, to: Math.min(range.max, Math.max(range.min, value)) }));
}

/**
 * A profile with each number held to the nearest end of its range, and what
 * was held, so an imported profile's changes can be reported. Its steps are
 * never cut: more than MAX_PROFILE_STEPS is a check that stops publishing.
 */
export function holdToLimits(profile: Profile): { profile: Profile; held: HeldValue[] } {
  const held = outOfRange(profile);
  if (held.length === 0) return { profile, held };
  const copy = copied(profile) as Profile;
  for (const { path, to } of held) setPath(copy, path, to);
  return { profile: copy, held };
}

/** A deep copy of plain data, keeping each number as it is, as JSON would not a -0, which Decaid hashes as written. */
function copied(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copied);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, copied(entry)]));
  return value;
}

function setPath(target: unknown, path: string, value: number): void {
  const keys = path.split(".");
  let at = target as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) at = at[key] as Record<string, unknown>;
  at[keys[keys.length - 1]!] = value;
}

// Checks -----------------------------------------------------------------------

/** What a check found. Each names its step by index, or null for the profile as a whole. */
export type ProfileCheckCode =
  | "noTitle"
  | "noSteps"
  | "tooManySteps"
  | "stepNoName"
  | "outOfRange"
  | "sameSteps"
  | "titleInUse"
  | "weightNeedsScale"
  | "exitOnNoLength"
  | "pumpTooSlow";

export interface ProfileCheck {
  code: ProfileCheckCode;
  /** The step's index, or null for the profile as a whole. */
  step: number | null;
  /** The field's path in Decaid's JSON, for a check of one field. */
  path?: string;
  /** What was found, in words for a person, naming the step by its number and name. */
  message: string;
}

/** What stops a profile from being published, and what is advice: what the machine accepts but a person may not mean. */
export interface ProfileChecks {
  blocking: ProfileCheck[];
  advice: ProfileCheck[];
}

/** What else the checks are judged against, where the caller knows it. */
export interface ProfileCheckContext {
  /** The Library's Profiles, by id and title: one with this profile's id has its steps. */
  libraryProfiles?: ReadonlyArray<{ id: string; title: string }>;
  /** The titles of the Profiles shown where this one would be, for a separate Profile, which may share none of them. */
  titlesInUse?: readonly string[];
}

/** A step named for a person: its number from 1 and its name, if it has one. */
export function stepLabel(profile: Profile, index: number): string {
  const name = profile.steps[index]?.name.trim();
  return name ? `Step ${index + 1}, "${name}"` : `Step ${index + 1}`;
}

/** A field named for a person, by its path. */
const FIELD_NAMES: Record<string, string> = {
  pressure: "pressure",
  flow: "flow",
  temperature: "temperature",
  seconds: "maximum time",
  volume: "water pumped",
  weight: "weight",
  "exit.value": "exit",
  "limiter.value": "limit",
  "limiter.range": "limit's range",
  tank_temperature: "Tank temperature",
  target_weight: "Stop-at weight",
  target_volume: "Stop-at volume",
};

function fieldLabel(profile: Profile, field: ProfileField): string {
  if (field.step === null) return FIELD_NAMES[field.path] ?? field.path;
  const name = FIELD_NAMES[field.path.replace(/^steps\.\d+\./, "")] ?? field.path;
  return `${stepLabel(profile, field.step)}: its ${name}`;
}

/**
 * Checks a profile (#574): what stops it being published, and advice. A
 * check that needs to know of the Library, or of the simulated run, is made
 * only where the context, or a later caller, gives what it needs.
 */
export function checkProfile(profile: Profile, context: ProfileCheckContext = {}): ProfileChecks {
  const blocking: ProfileCheck[] = [];
  const advice: ProfileCheck[] = [];
  if (profile.title.trim() === "") blocking.push({ code: "noTitle", step: null, path: "title", message: "It has no title." });
  if (profile.steps.length === 0) blocking.push({ code: "noSteps", step: null, path: "steps", message: "It has no steps." });
  if (profile.steps.length > MAX_PROFILE_STEPS)
    blocking.push({ code: "tooManySteps", step: null, path: "steps", message: `It has ${profile.steps.length} steps, and the machine takes at most ${MAX_PROFILE_STEPS}.` });
  profile.steps.forEach((step, index) => {
    if (step.name.trim() === "") blocking.push({ code: "stepNoName", step: index, path: `steps.${index}.name`, message: `${stepLabel(profile, index)} has no name.` });
  });
  for (const held of outOfRange(profile)) {
    const range = rangedNumbers(profile).find(([, path]) => path === held.path)![3];
    blocking.push({
      code: "outOfRange",
      step: held.step,
      path: held.path,
      message: `${fieldLabel(profile, held)} is ${held.from}, outside ${range.min} to ${range.max}.`,
    });
  }
  if (context.libraryProfiles && profile.steps.length > 0) {
    const id = profileId(profile);
    const same = context.libraryProfiles.find((item) => item.id === id);
    if (same) blocking.push({ code: "sameSteps", step: null, path: "steps", message: `Its steps are those of "${same.title}", which the Library has.` });
  }
  if (context.titlesInUse) {
    const title = profile.title.trim().toLowerCase();
    if (title !== "" && context.titlesInUse.some((other) => other.trim().toLowerCase() === title))
      blocking.push({ code: "titleInUse", step: null, path: "title", message: `A Profile shown there is titled "${profile.title.trim()}" already.` });
  }
  profile.steps.forEach((step, index) => {
    const label = stepLabel(profile, index);
    if (step.weight !== null && step.weight > 0)
      advice.push({ code: "weightNeedsScale", step: index, path: `steps.${index}.weight`, message: `${label} ends at a weight in the cup, which needs a scale connected.` });
    // Decaid sends a step's time in tenths of a second, rounded, so one under 0.05 s runs as none (`convert_float_to_F8_1_7`).
    if (step.seconds < 0.05 && step.exit !== null)
      advice.push({ code: "exitOnNoLength", step: index, path: `steps.${index}.exit`, message: `${label} has no length, so the machine leaves it at once and its exit never applies.` });
    if (step.pump === "flow" && step.flow > PUMP_MAX_FLOW)
      advice.push({ code: "pumpTooSlow", step: index, path: `steps.${index}.flow`, message: `${label} asks for ${step.flow} ml/s, and the pump gives about ${PUMP_MAX_FLOW} ml/s at most.` });
  });
  return { blocking, advice };
}

// Title, author and notes --------------------------------------------------------

/** A Profile's metadata: what a person may edit without making a new Profile, as it is outside its id (ADR-0032). */
export const PROFILE_TEXT_FIELDS = ["title", "author", "notes"] as const;
export type ProfileTextField = (typeof PROFILE_TEXT_FIELDS)[number];

/** A Profile's title, author and notes. */
export type ProfileText = Record<ProfileTextField, string>;

/**
 * A profile's title, author and notes as `readProfile` reads them, each
 * empty where it has none, whether or not Decaid would read its steps: they
 * are edited apart from them.
 */
export function profileTextOf(value: unknown): ProfileText {
  const profile = isObject(value) ? value : {};
  return { title: readOptionalString(profile.title) ?? "", author: readOptionalString(profile.author) ?? "", notes: readOptionalString(profile.notes) ?? "" };
}
