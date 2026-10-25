import { randomUUID } from "node:crypto";
import type { DecaidAnswer } from "./decaid-beans.js";

// Decaid's settings writes, as v0.9.0 carries them out, learned from
// fixtures/decaid/settings-writes-v0.9.0/ and Decaid's source, for the
// writes its simulated machine (`MockDe1`) can't show: the machine's
// settings, advanced settings and flow calibration (de1handler.dart in
// decaid:lib/src/services/webserver/) are written to a DE1's registers one
// field at a time, in the handler's order, with each register's write scale
// and bounds (`MMRItem` in decaid:lib/src/models/device/impl/de1/de1.models.dart,
// `_writeMMRScaled` and `_writeMMRInt` in unified_de1.mmr.dart), so a value
// is stored truncated, the flow multiplier then as a real DE1's firmware
// holds it (fixtures/decaid/de1pro-v0.9.0/), and a field whose write fails
// leaves the ones before it written; a sensor's calibration is a correction
// of the value it holds (`De1Calibration` and `De1CalibrationCodec`);
// Decaid's own settings (settings_handler.dart) are applied one field at a
// time too, refusing the first invalid value with the earlier ones applied;
// and the presence settings and wake schedules (presence_handler.dart,
// `WakeSchedule` in decaid:lib/src/models/wake_schedule.dart) need no
// machine. A request Decaid fails on, as when a field's value is not a
// number, is answered as shelf answers an uncaught error: 500, `Internal
// Server Error` as text. Requests Decaid would fail on in ways not recorded
// throw instead.

type Json = Record<string, unknown>;

/** What Decaid answers: its status, and its body as JSON, or as `text` for one that is not JSON (an empty body is `null`). */
export interface SettingsAnswer {
  status: number;
  body: unknown;
  text?: string;
}

/**
 * Called as Decaid is about to write each field of a settings write, by the
 * name the request gives it: an answer fails that field's write, and the
 * request is answered with it, the fields before it written, as when the
 * machine does not take a register's write in time.
 */
export type FieldWriteFailure = (field: string) => DecaidAnswer | undefined;

/** A DE1 register as `MMRItem` defines it: read as a whole number times `readScale`, written as the value times `writeScale`, truncated, then held to `min` and `max`; `firmware` is what the machine holds of the whole number written, where it is not that number. */
interface Register {
  readScale?: number;
  writeScale?: number;
  min?: number;
  max?: number;
  firmware?: (written: number) => number;
}

const WHOLE: Register = {};
const TENTHS: Register = { readScale: 0.1, writeScale: 10 };

/**
 * What a register holds once Decaid writes `value` to it, as `GET` reads it
 * back: `_writeMMRScaled` truncates the value times the write scale toward
 * zero, `_writeMMRInt` clamps it to the register's bounds, the machine
 * holds what its firmware makes of it, and `_readMMRScaled` multiplies that
 * by the read scale.
 */
function registerHolds(register: Register, value: number): number {
  const scaled = register.writeScale === undefined ? value : Math.trunc(value * register.writeScale);
  const clamped = register.min !== undefined && register.max !== undefined ? Math.min(Math.max(scaled, register.min), register.max) : scaled;
  const held = register.firmware ? register.firmware(clamped) : clamped;
  return register.readScale === undefined ? held : held * register.readScale;
}

/**
 * What a DE1 holds of a flow multiplier written in thousandths, fitted to
 * the test DE1Pro's reads on firmware 1358 (`calibration-writes.json` in
 * fixtures/decaid/de1pro-v0.9.0/): the firmware keeps the float32 of the
 * thousandths over 1000 and answers that times 1000 in float32, truncated.
 * So 1004 is held as 1003, and 251 as 250. JavaScript's division and
 * product of float32 values, each rounded to float32, are the float32 ones.
 */
function flowMultiplierFirmware(thousandths: number): number {
  return Math.trunc(Math.fround(Math.fround(thousandths / 1000) * 1000));
}

/** The register holding the flow multiplier (`calFlowEst`), which `GET /machine/calibration` reads. */
const FLOW_MULTIPLIER: Register = { readScale: 0.001, writeScale: 1000, min: 130, max: 2000, firmware: flowMultiplierFirmware };

/** Thrown where Decaid fails on a value, answered as shelf answers an uncaught error. */
class Unhandled extends Error {}

const UNHANDLED: SettingsAnswer = { status: 500, body: "Internal Server Error", text: "Internal Server Error" };
const MACHINE_NOT_CONNECTED: SettingsAnswer = { status: 500, body: { error: "DeviceNotConnectedException: machine not connected" } };
const ACCEPTED: SettingsAnswer = { status: 202, body: null, text: "" };

/** Dart's `int.parse` of a string: decimal digits, or hexadecimal after `0x`, with a sign and surrounding whitespace allowed; undefined where it fails. */
function dartInt(text: string): number | undefined {
  const match = /^([+-]?)(?:0[xX]([0-9a-fA-F]+)|(\d+))$/.exec(text.trim());
  if (!match) return undefined;
  const magnitude = match[2] === undefined ? Number(match[3]) : Number.parseInt(match[2], 16);
  return match[1] === "-" ? -magnitude : magnitude;
}

/** `parseInt` in decaid:lib/src/models/data/utils.dart: a number, cut toward zero, or a string `int.parse` reads; Decaid fails on anything else. */
function parseInt(value: unknown): number {
  if (typeof value === "number") return Math.trunc(value);
  const parsed = typeof value === "string" ? dartInt(value) : undefined;
  if (parsed === undefined) throw new Unhandled();
  return parsed;
}

/**
 * `parseDouble` in utils.dart: a number, or a string `double.tryParse` reads
 * (a decimal, surrounding whitespace allowed), or else `int.parse` does;
 * Decaid fails on anything else. `NaN` and `Infinity`, which Dart reads too,
 * fail the register's write in ways not modelled.
 */
function parseDouble(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") throw new Unhandled();
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value.trim())) return Number(value.trim());
  if (/^[+-]?(NaN|Infinity)$/.test(value.trim())) throw new Error(`Decaid v0.9.0 fails writing ${value} to a register; the simulated tablet does not model it`);
  const parsed = dartInt(value);
  if (parsed === undefined) throw new Unhandled();
  return parsed;
}

/** A machine route's body as de1handler.dart reads it, JSON and an object, or Decaid's refusal of it. */
function machineBody(body: string | undefined): { json: Json } | { refused: Written } {
  let json: unknown;
  try {
    json = JSON.parse(body ?? "");
  } catch {
    return { refused: { answer: { status: 400, body: { error: "Invalid JSON body" } } } };
  }
  return isObject(json) ? { json } : { refused: { answer: { status: 400, body: { error: "Request body must be a JSON object" } } } };
}

/** A field of a machine route: the name the request and `GET` give it, how Decaid reads it, and the register it writes. */
interface MachineField {
  name: string;
  parse(value: unknown): number | boolean;
  register?: Register;
}

/** The fan threshold's register (`fanThreshold`), held to 0 to 50. */
const FAN: Register = { min: 0, max: 50 };

/** `POST /machine/settings`'s fields, in the order `De1Controller.updateMachineSettings` writes them. */
const MACHINE_SETTINGS: readonly MachineField[] = [
  // Only the text `enable` turns USB charging on (`json['usb'] == 'enable'`); `GET` reads it back as a boolean.
  { name: "usb", parse: (value) => value === "enable" },
  { name: "fan", parse: parseInt, register: FAN },
  { name: "flushTemp", parse: parseDouble, register: TENTHS },
  { name: "flushFlow", parse: parseDouble, register: TENTHS },
  { name: "flushTimeout", parse: parseDouble, register: TENTHS },
  { name: "hotWaterFlow", parse: parseDouble, register: TENTHS },
  { name: "steamFlow", parse: parseDouble, register: { readScale: 0.01, writeScale: 100 } },
  { name: "tankTemp", parse: parseInt, register: WHOLE },
  { name: "steamPurgeMode", parse: parseInt, register: WHOLE },
];

/** The refill kit settings Decaid takes (`De1RefillKitSettings`): force off, force on, auto. */
const REFILL_KIT_SETTINGS = [0, 1, 2];

/**
 * `De1HeaterVoltage.fromInt`: a voltage a DE1 reports with 1000 added for a
 * set one is read without it; 90 to 150 is the 110 V setting (120), 180 to
 * 260 the 220 V one (230), and anything else is unset (-1).
 */
function heaterVoltageFrom(value: number): number {
  const voltage = value > 1000 ? value - 1000 : value;
  if (voltage >= 90 && voltage <= 150) return 120;
  if (voltage >= 180 && voltage <= 260) return 230;
  return -1;
}

/** `POST /machine/settings/advanced`'s fields, in the order de1handler.dart writes them. `GET` answers the heater voltage and refill kit setting Decaid last wrote, not the machine's registers. */
const ADVANCED_SETTINGS: readonly MachineField[] = [
  { name: "heaterPh1Flow", parse: parseDouble, register: TENTHS },
  { name: "heaterPh2Flow", parse: parseDouble, register: TENTHS },
  { name: "heaterIdleTemp", parse: parseDouble, register: TENTHS },
  { name: "heaterPh2Timeout", parse: parseDouble, register: TENTHS },
  { name: "heaterVoltage", parse: (value) => heaterVoltageFrom(parseInt(value)) },
  { name: "refillKitSetting", parse: parseInt },
];

/** Where a machine route's writes land, and what it is written with. */
interface MachineWrite {
  current: unknown;
  body: string | undefined;
  machineConnected: boolean;
  failWrite?: FieldWriteFailure | undefined;
}

/** What a write did: Decaid's answer, and what the matching `GET` answers from then on, if anything was written. */
export interface Written {
  answer: SettingsAnswer;
  value?: Json;
}

/**
 * Carries out `POST /machine/settings` as Decaid does: every field read
 * first, then each one given written to its register in turn.
 */
export function writeMachineSettings(write: MachineWrite): Written {
  return writeFields(write, MACHINE_SETTINGS, () => undefined);
}

/** The machine's settings, by their `GET /machine/settings` names, as its registers hold them once Decaid writes these values to them, as it does a Workflow's. */
export function machineSettingsHeld(written: Json): Json {
  return Object.fromEntries(
    Object.entries(written).map(([name, value]) => {
      const register = MACHINE_SETTINGS.find((field) => field.name === name)?.register;
      return [name, register && typeof value === "number" ? registerHolds(register, value) : value];
    }),
  );
}

/** Carries out `POST /machine/settings/advanced` as Decaid does, refusing a refill kit setting it does not know before writing anything. */
export function writeAdvancedSettings(write: MachineWrite): Written {
  return writeFields(write, ADVANCED_SETTINGS, (parsed) =>
    "refillKitSetting" in parsed && !REFILL_KIT_SETTINGS.includes(parsed.refillKitSetting as number)
      ? { status: 400, body: { error: "refillKitSetting must be 0 (force off), 1 (force on) or 2 (auto)" } }
      : undefined,
  );
}

/** Carries out `POST /machine/calibration` as Decaid does: the flow multiplier, truncated to the thousandth and clamped to 0.13 to 2.0, held as the DE1's firmware holds it. */
export function writeCalibration(write: MachineWrite): Written {
  return writeFields(write, [{ name: "flowMultiplier", parse: parseDouble, register: FLOW_MULTIPLIER }], () => undefined);
}

/** Reads every field given, as Decaid does before writing any, skipping one sent as null, then writes each in turn. */
function writeFields(write: MachineWrite, fields: readonly MachineField[], refuse: (parsed: Json) => SettingsAnswer | undefined): Written {
  const read = machineBody(write.body);
  if ("refused" in read) return read.refused;
  const body = read.json;
  const parsed: Json = {};
  try {
    for (const field of fields) if (body[field.name] !== undefined && body[field.name] !== null) parsed[field.name] = field.parse(body[field.name]);
  } catch (error) {
    if (error instanceof Unhandled) return { answer: UNHANDLED };
    throw error;
  }
  const refused = refuse(parsed);
  if (refused) return { answer: refused };
  if (!write.machineConnected) return { answer: MACHINE_NOT_CONNECTED };
  if (!isObject(write.current)) throw new Error("The simulated tablet holds no settings for this route to write to");
  const value: Json = { ...write.current };
  for (const field of fields) {
    if (!(field.name in parsed)) continue;
    const failed = write.failWrite?.(field.name);
    if (failed) return { answer: failed, value };
    const given = parsed[field.name] as number | boolean;
    value[field.name] = field.register && typeof given === "number" ? registerHolds(field.register, given) : given;
  }
  return { answer: ACCEPTED, value };
}

/** The sensors a DE1 calibrates (`De1CalibrationTarget`), and whether its calibration is an offset, added, or a ratio, multiplied. */
const SENSORS: Readonly<Record<string, "ratio" | "offset">> = { flow: "ratio", pressure: "ratio", temperature: "offset" };

/** The signed Q16.16 values the calibration characteristic carries (`De1Calibration.fixedPointScale`, `minValue` and `maxValueExclusive`). */
const Q16 = 65536;
const Q16_MIN = -32768;
const Q16_MAX_EXCLUSIVE = 32768;

/** A value as Decaid sends it in a calibration packet, and as the machine holds it: in signed Q16.16, rounded (`_encodeQ16_16Signed`). */
const q16 = (value: number) => dartRound(value * Q16) / Q16;

/** Dart's `round`: to the nearest whole number, a half away from zero (JavaScript's `Math.round` takes -0.5 to 0). */
function dartRound(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/**
 * Carries out `PUT /machine/calibration/{target}` as Decaid does: a
 * correction of the value the sensor holds, not a set. A ratio is multiplied
 * by `measuredValue / de1ReportedValue` and an offset has their difference
 * added, as the DE1's firmware folds a write in (`MockDe1.writeCalibration`),
 * each value sent in signed Q16.16 and the result held in it. `GET` answers
 * the held value as `measuredValue`, beside a `de1ReportedValue` of 1 for a
 * ratio and 0 for an offset.
 */
export function writeSensorCalibration(write: MachineWrite & { target: string }): Written {
  const kind = SENSORS[write.target];
  if (!kind) return { answer: { status: 400, body: { error: `Unknown calibration target: ${write.target}` } } };
  const read = machineBody(write.body);
  if ("refused" in read) return read.refused;
  const { de1ReportedValue: reported, measuredValue: measured } = read.json;
  if (typeof reported !== "number" || !Number.isFinite(reported)) return { answer: { status: 400, body: { error: "de1ReportedValue must be a finite number" } } };
  if (typeof measured !== "number" || !Number.isFinite(measured)) return { answer: { status: 400, body: { error: "measuredValue must be a finite number" } } };
  if ([reported, measured].some((value) => value < Q16_MIN || value >= Q16_MAX_EXCLUSIVE)) {
    return { answer: { status: 400, body: { error: "calibration values must be within the signed Q16.16 range -32768..32767.9999" } } };
  }
  if (!write.machineConnected) return { answer: MACHINE_NOT_CONNECTED };
  // `De1Calibration.validateForWrite`, in the machine's write queue.
  if (kind === "ratio" && dartRound(reported * Q16) === 0) {
    return { answer: { status: 400, body: { error: `Invalid argument (de1ReportedValue): must not encode as zero for flow or pressure: ${dartDouble(reported)}` } } };
  }
  if (!isObject(write.current) || typeof write.current.measuredValue !== "number") throw new Error(`The simulated tablet holds no ${write.target} calibration to correct`);
  const failed = write.failWrite?.(write.target);
  if (failed) return { answer: failed };
  const held = write.current.measuredValue;
  const corrected = kind === "offset" ? held + (q16(measured) - q16(reported)) : held * (q16(measured) / q16(reported));
  return { answer: ACCEPTED, value: { ...write.current, measuredValue: q16(corrected) } };
}

/** A double as Dart writes it in text: a whole one with `.0`. */
function dartDouble(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

/** A field of `POST /settings`: how Decaid takes its value, given the field's name and value, answering the refusal's `message`, or what it holds from then on. */
type AppField = (value: unknown) => { message: string } | { set: unknown } | "ignored";

const boolean =
  (name: string): AppField =>
  (value) =>
    typeof value === "boolean" ? { set: value } : { message: `${name} must be a boolean` };
const number =
  (name: string): AppField =>
  (value) =>
    typeof value === "number" ? { set: value } : { message: `${name} must be a number` };
const stringOrNull =
  (name: string): AppField =>
  (value) =>
    value === null || typeof value === "string" ? { set: value } : { message: `${name} must be a string or null` };
const timeOfDay =
  (name: string): AppField =>
  (value) =>
    Number.isInteger(value) && (value as number) >= 0 && (value as number) < 1440 ? { set: value } : { message: `${name} must be an integer 0-1439` };
/** A choice Decaid reads with a `fromString` taking a String: it fails on any other type, and answers `message` for a name it does not know. */
const choice =
  (names: Readonly<Record<string, string>>, message: (value: string) => string): AppField =>
  (value) => {
    if (typeof value !== "string") throw new Unhandled();
    const name = names[value];
    return name === undefined ? { message: message(value) } : { set: name };
  };
const exactly = (...names: string[]) => Object.fromEntries(names.map((name) => [name, name]));

/** The log levels of package:logging (`Level.LEVELS`), by name. */
const LOG_LEVELS = ["ALL", "FINEST", "FINER", "FINE", "CONFIG", "INFO", "WARNING", "SEVERE", "SHOUT", "OFF"];

/**
 * `POST /settings`'s fields, in the order settings_handler.dart takes them.
 * `webUiPath`, `defaultSkinId` and `simulatedDevices` change what Decaid
 * serves and connects, which the simulated tablet does not model.
 */
const APP_SETTINGS: ReadonlyArray<[string, AppField]> = [
  ["gatewayMode", choice(exactly("full", "tracking", "disabled"), (value) => `${value} is not a gateway mode`)],
  ["webUiPath", notModelled("webUiPath")],
  // `updateLogLevel` takes a String, and ignores a level it does not know.
  [
    "logLevel",
    (value) => {
      if (value !== null && typeof value !== "string") throw new Unhandled();
      return typeof value === "string" && LOG_LEVELS.includes(value) ? { set: value } : "ignored";
    },
  ],
  ["weightFlowMultiplier", number("weightFlowMultiplier")],
  ["volumeFlowMultiplier", number("volumeFlowMultiplier")],
  ["hotWaterFlowMultiplier", number("hotWaterFlowMultiplier")],
  // `ScalePowerModeFromString.fromString` ignores case, and takes `display_off` too.
  [
    "scalePowerMode",
    (value) => {
      if (typeof value !== "string") throw new Unhandled();
      const mode = { disabled: "disabled", displayoff: "displayOff", display_off: "displayOff", disconnect: "disconnect" }[value.toLowerCase()];
      return mode === undefined ? { message: `${value} is not a valid scale power mode` } : { set: mode };
    },
  ],
  ["blockOnNoScale", boolean("blockOnNoScale")],
  ["blockTareDuringShot", boolean("blockTareDuringShot")],
  ["stopHotWaterAtWeight", boolean("stopHotWaterAtWeight")],
  ["preferredMachineId", stringOrNull("preferredMachineId")],
  ["preferredScaleId", stringOrNull("preferredScaleId")],
  ["preferredGrinderDeviceId", stringOrNull("preferredGrinderDeviceId")],
  ["defaultSkinId", notModelled("defaultSkinId")],
  ["automaticUpdateCheck", boolean("automaticUpdateCheck")],
  ["chargingMode", choice(exactly("disabled", "longevity", "balanced", "highAvailability"), (value) => `${value} is not a valid charging mode`)],
  ["nightModeEnabled", boolean("nightModeEnabled")],
  ["nightModeSleepTime", timeOfDay("nightModeSleepTime")],
  ["nightModeMorningTime", timeOfDay("nightModeMorningTime")],
  ["lowBatteryBrightnessLimit", boolean("lowBatteryBrightnessLimit")],
  ["keepAwake", boolean("keepAwake")],
  ["simulatedDevices", notModelled("simulatedDevices")],
  [
    "themeMode",
    (value) => {
      if (typeof value !== "string") return { message: "themeMode must be a string" };
      return ["system", "light", "dark"].includes(value) ? { set: value } : { message: `Invalid theme mode: ${value}. Valid values: system, light, dark` };
    },
  ],
];

function notModelled(name: string): AppField {
  return () => {
    throw new Error(`The simulated tablet does not carry out a write of Decaid's ${name}`);
  };
}

/**
 * Carries out `POST /settings` as Decaid does, with or without a machine:
 * each field given taken in turn, the first it refuses answered 400 with its
 * `message`, the ones before it applied. A body that is not a JSON object
 * fails it. It answers `null`.
 */
export function writeAppSettings(write: { current: unknown; body: string | undefined; failWrite?: FieldWriteFailure | undefined }): Written {
  let json: unknown;
  try {
    json = JSON.parse(write.body ?? "");
  } catch {
    return { answer: UNHANDLED };
  }
  if (!isObject(json)) return { answer: UNHANDLED };
  if (!isObject(write.current)) throw new Error("The simulated tablet holds no app settings to write to");
  const value: Json = { ...write.current };
  try {
    for (const [name, take] of APP_SETTINGS) {
      if (!(name in json)) continue;
      const taken = take(json[name]);
      if (taken === "ignored") continue;
      if ("message" in taken) return { answer: { status: 400, body: { message: taken.message } }, value };
      const failed = write.failWrite?.(name);
      if (failed) return { answer: failed, value };
      value[name] = taken.set;
    }
  } catch (error) {
    if (error instanceof Unhandled) return { answer: UNHANDLED, value };
    throw error;
  }
  return { answer: { status: 200, body: null }, value };
}

/** Decaid's presence settings, as `GET /presence/settings` answers them while a machine is connected. */
interface Presence {
  userPresenceEnabled: boolean;
  sleepTimeoutMinutes: number;
  keepAwakeUntil: string | null;
  schedules: WakeSchedule[];
}

/** A wake schedule as `WakeSchedule.toJson` writes it: no `keepAwakeFor` without a keep-awake time. */
interface WakeSchedule {
  id: string;
  time: string;
  daysOfWeek: number[];
  enabled: boolean;
  keepAwakeFor?: number;
}

/**
 * What `GET /presence/settings` answers: the presence settings held, but
 * `keepAwakeUntil` null while no machine is connected, as
 * `PresenceController.keepAwakeUntil` is. While one is, `keepAwakeUntil` is
 * what the tablet is served with, null unless a test serves a time: Decaid
 * works it out from the schedules and its clock, which is not modelled.
 */
export function presenceSettings(current: unknown, machineConnected: boolean): unknown {
  return isObject(current) && !machineConnected ? { ...current, keepAwakeUntil: null } : current;
}

/** Carries out a request to the presence routes as Decaid does, with or without a machine; undefined for a route that is none of them, or a `GET`. */
export function writePresence(method: string, route: string, body: string | undefined, current: unknown): Written | undefined {
  const scheduleId = /^\/presence\/schedules\/([^/]+)$/.exec(route)?.[1];
  if (!(method === "POST" && (route === "/presence/settings" || route === "/presence/schedules")) && !(scheduleId && (method === "PUT" || method === "DELETE"))) {
    return undefined;
  }
  if (!isObject(current)) throw new Error("The simulated tablet holds no presence settings to write to");
  const presence = current as unknown as Presence;
  if (route === "/presence/settings") return writePresenceSettings(presence, body);
  if (scheduleId === undefined) return addSchedule(presence, body);
  const id = decodeURIComponent(scheduleId);
  const index = presence.schedules.findIndex((schedule) => schedule.id === id);
  if (index === -1) return { answer: { status: 404, body: { error: "Schedule not found", id } } };
  if (method === "DELETE") return { answer: { status: 200, body: { deleted: id } }, value: { ...presence, schedules: presence.schedules.filter((_, at) => at !== index) } };
  return changeSchedule(presence, index, body);
}

/** `_updateSettingsHandler`: both fields checked before either is set, the sleep timeout held to 0 to 240 minutes. */
function writePresenceSettings(presence: Presence, body: string | undefined): Written {
  let json: unknown;
  try {
    json = JSON.parse(body ?? "");
  } catch {
    return { answer: { status: 400, body: { error: "Malformed JSON" } } };
  }
  if (!isObject(json)) return { answer: { status: 400, body: { error: "Request body must be a JSON object" } } };
  const value = { ...presence };
  if ("userPresenceEnabled" in json) {
    if (typeof json.userPresenceEnabled !== "boolean") return { answer: { status: 400, body: { error: "userPresenceEnabled must be a boolean" } } };
    value.userPresenceEnabled = json.userPresenceEnabled;
  }
  if ("sleepTimeoutMinutes" in json) {
    if (!Number.isInteger(json.sleepTimeoutMinutes)) return { answer: { status: 400, body: { error: "sleepTimeoutMinutes must be an integer" } } };
    value.sleepTimeoutMinutes = Math.min(Math.max(json.sleepTimeoutMinutes as number, 0), 240);
  }
  return { answer: { status: 200, body: { userPresenceEnabled: value.userPresenceEnabled, sleepTimeoutMinutes: value.sleepTimeoutMinutes } }, value: value as unknown as Json };
}

/** A schedule request's body: a JSON object, the only kind the handlers read without failing. */
function scheduleBody(body: string | undefined): Json {
  const json: unknown = JSON.parse(body ?? "");
  if (!isObject(json)) throw new Error("Decaid v0.9.0 fails on a wake schedule body that is not an object; the simulated tablet does not model it");
  return json;
}

/** A field cast as the handlers cast it (`as int?`, `as bool?`): Decaid fails on another type, which the simulated tablet does not model. */
function cast<T>(json: Json, field: string, type: "int" | "bool"): T | undefined {
  const value = json[field];
  if (value === undefined || value === null) return undefined;
  if (type === "int" ? Number.isInteger(value) : typeof value === "boolean") return value as T;
  throw new Error(`Decaid v0.9.0 fails on a wake schedule's ${field} of ${JSON.stringify(value)}; the simulated tablet does not model it`);
}

/** A schedule's `time`, `HH:MM`, as the handlers split it; one missing or malformed fails Decaid, which the simulated tablet does not model. */
function timeParts(json: Json): [number, number] {
  const parts = typeof json.time === "string" ? json.time.split(":") : [];
  if (parts.length < 2 || !parts.slice(0, 2).every((part) => /^[+-]?\d+$/.test(part))) {
    throw new Error(`Decaid v0.9.0 fails on a wake schedule's time of ${JSON.stringify(json.time)}; the simulated tablet does not model it`);
  }
  return [Number(parts[0]), Number(parts[1])];
}

const KEEP_AWAKE_REFUSED: Written = { answer: { status: 400, body: { error: "keepAwakeFor must be 1-720 minutes, or 0/null to clear" } } };
const TIME_REFUSED: Written = { answer: { status: 400, body: { error: "time must be hour 0-23 and minute 0-59" } } };
const DAYS_REFUSED: Written = { answer: { status: 400, body: { error: "daysOfWeek must contain weekdays 1 to 7" } } };

/** The days a request gives, as a set (`cast<int>().toSet()`), or undefined if it gives none. */
function days(json: Json): number[] | undefined {
  if (!("daysOfWeek" in json)) return undefined;
  if (!Array.isArray(json.daysOfWeek) || !json.daysOfWeek.every((day) => Number.isInteger(day))) {
    throw new Error(`Decaid v0.9.0 fails on daysOfWeek of ${JSON.stringify(json.daysOfWeek)}; the simulated tablet does not model it`);
  }
  return [...new Set(json.daysOfWeek as number[])];
}

/** `WakeSchedule.toJson`: the time as `HH:MM`, the days sorted, and the keep-awake time only if there is one. */
function scheduleJson(schedule: { id: string; hour: number; minute: number; days: number[]; enabled: boolean; keepAwakeFor: number | undefined }): WakeSchedule {
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    id: schedule.id,
    time: `${pad(schedule.hour)}:${pad(schedule.minute)}`,
    daysOfWeek: [...schedule.days].sort((a, b) => a - b),
    enabled: schedule.enabled,
    ...(schedule.keepAwakeFor === undefined ? {} : { keepAwakeFor: schedule.keepAwakeFor }),
  };
}

/** `_addScheduleHandler`: a new schedule, under an id Decaid makes (a v4 UUID), every day when no day is given, and on unless `enabled` says otherwise; answered 201. */
function addSchedule(presence: Presence, body: string | undefined): Written {
  const json = scheduleBody(body);
  const keepAwakeFor = cast<number>(json, "keepAwakeFor", "int");
  if (keepAwakeFor !== undefined && (keepAwakeFor < 0 || keepAwakeFor > 720)) return KEEP_AWAKE_REFUSED;
  const hour = cast<number>(json, "hour", "int") ?? timeParts(json)[0];
  const minute = cast<number>(json, "minute", "int") ?? timeParts(json)[1];
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return TIME_REFUSED;
  const given = days(json) ?? [];
  if (given.some((day) => day < 1 || day > 7)) return DAYS_REFUSED;
  const schedule = scheduleJson({
    id: randomUUID(),
    hour,
    minute,
    days: given,
    enabled: cast<boolean>(json, "enabled", "bool") ?? true,
    keepAwakeFor: keepAwakeFor !== undefined && keepAwakeFor > 0 ? keepAwakeFor : undefined,
  });
  return { answer: { status: 201, body: schedule }, value: { ...presence, schedules: [...presence.schedules, schedule] } as unknown as Json };
}

/** `_updateScheduleHandler`: the fields given replace the schedule's, `hour` and `minute` over `time`; a keep-awake time of 0 or null clears it. */
function changeSchedule(presence: Presence, index: number, body: string | undefined): Written {
  const json = scheduleBody(body);
  const existing = presence.schedules[index]!;
  let [hour, minute] = timeParts(existing as unknown as Json);
  if ("time" in json) [hour, minute] = timeParts(json);
  if ("hour" in json) hour = cast<number>(json, "hour", "int") ?? notCast("hour");
  if ("minute" in json) minute = cast<number>(json, "minute", "int") ?? notCast("minute");
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return TIME_REFUSED;
  const given = days(json);
  if (given?.some((day) => day < 1 || day > 7)) return DAYS_REFUSED;
  let keepAwakeFor = existing.keepAwakeFor;
  if ("keepAwakeFor" in json) {
    const value = cast<number>(json, "keepAwakeFor", "int");
    if (value !== undefined && (value < 0 || value > 720)) return KEEP_AWAKE_REFUSED;
    keepAwakeFor = value === undefined || value === 0 ? undefined : value;
  }
  const enabled = "enabled" in json ? (cast<boolean>(json, "enabled", "bool") ?? notCast("enabled")) : existing.enabled;
  const schedule = scheduleJson({ id: existing.id, hour, minute, days: given ?? existing.daysOfWeek, enabled, keepAwakeFor });
  return { answer: { status: 200, body: schedule }, value: { ...presence, schedules: presence.schedules.map((kept, at) => (at === index ? schedule : kept)) } as unknown as Json };
}

/** A field the update handler casts without `?`, sent as null: Decaid fails on it. */
function notCast(field: string): never {
  throw new Error(`Decaid v0.9.0 fails on a wake schedule's ${field} of null; the simulated tablet does not model it`);
}

/**
 * The machine's settings once it connects to Decaid again: Decaid writes the
 * fan threshold's default, 55, which the register holds as its most, 50
 * (`_setDe1DefaultsFor` in decaid:lib/src/controllers/de1_controller.defaults.dart),
 * and sets the refill kit to auto (`UnifiedDe1.onConnect`). Decaid also
 * writes the Workflow's steam, hot water and flush settings back to the
 * machine then, which leaves them as the simulated tablet already holds
 * them after its Workflow writes, so only a test that changed them some
 * other way would see a difference.
 */
export function reconnected(settings: unknown, advanced: unknown): { settings: unknown; advanced: unknown } {
  return {
    settings: isObject(settings) ? { ...settings, fan: registerHolds(FAN, 55) } : settings,
    advanced: isObject(advanced) ? { ...advanced, refillKitSetting: 2 } : advanced,
  };
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
