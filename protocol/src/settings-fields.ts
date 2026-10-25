// The settings fields the management interface shows and edits, each defined
// once for the server, the plugin and the management interface (milestone 4,
// #220; ADR-0023), and the validation of a Settings Edit against them.
//
// Each field is named as Decaid v0.9.0's API names it. Labels, units, ranges,
// steps and choices follow Streamline's settings page
// (streamline-js:src/settings/settings.js at cec5664) where it has them, and
// Decaid's own limits otherwise. A reported value outside a field's range is
// shown as it is; only an edit must be in range.

import type { CollectionName } from "./index.js";

/** The collections holding a Machine's Machine Settings and its Tablet's Tablet Settings, in the order the Settings card shows them. */
export const SETTINGS_COLLECTION_NAMES = [
  "machineSettings",
  "advancedSettings",
  "machineCalibration",
  "sensorCalibration",
  "appSettings",
] as const satisfies readonly CollectionName[];

export type SettingsCollectionName = (typeof SETTINGS_COLLECTION_NAMES)[number];

export function isSettingsCollectionName(name: string): name is SettingsCollectionName {
  return (SETTINGS_COLLECTION_NAMES as readonly string[]).includes(name);
}

/**
 * The settings collections a Settings Edit changes, which the plugin writes
 * through Decaid's routes: only the machine's settings yet. The server
 * refuses an edit of any other, and the management interface offers none.
 */
export const EDITABLE_SETTINGS_COLLECTIONS = ["machineSettings"] as const satisfies readonly SettingsCollectionName[];

export type EditableSettingsCollection = (typeof EDITABLE_SETTINGS_COLLECTIONS)[number];

export function isEditableSettingsCollection(name: string): name is EditableSettingsCollection {
  return (EDITABLE_SETTINGS_COLLECTIONS as readonly string[]).includes(name);
}

/** The roles of accounts, as the server gives them: an Admin may change any field, Staff only the fields marked for Staff. */
export type SettingsRole = "admin" | "staff";

/**
 * What a field's value is:
 *
 * - `number`, within its range and on its step (`onStep`);
 * - `wholeNumber`, within its range;
 * - `onOff`, a boolean;
 * - `choice`, one of its choices' values;
 * - `timeOfDay`, minutes after midnight in the Tablet's own time, 0 to 1439.
 */
export type SettingsFieldKind = "number" | "wholeNumber" | "onOff" | "choice" | "timeOfDay";

export interface SettingsChoice {
  /** As Decaid takes and reports it. */
  value: string | number;
  label: string;
}

/**
 * What may become of a field's value after an edit, or what to do after
 * one, shown beside it:
 *
 * - `resetsOnReconnect`: Decaid sets it again each time it connects to the
 *   Machine (decentespresso/decaid#1027);
 * - `putBackByStreamline`: Streamline writes back a value a barista saved in
 *   its settings page when that page next opens (`checkMachineSettingsDrift`;
 *   decentespresso/streamline-js#172);
 * - `restartAfterChange`: the Machine takes the new value once restarted.
 */
export type SettingsNote = "resetsOnReconnect" | "putBackByStreamline" | "restartAfterChange";

interface SettingsFieldBase {
  /** Decaid's name for the field, its key in the collection; for `sensorCalibration`, the sensor target. */
  path: string;
  label: string;
  /** Shown after the value; none for a multiplier or a choice. */
  unit?: string;
  notes?: readonly SettingsNote[];
}

/** A field an edit may set, and who may. */
export interface EditableSettingsField extends SettingsFieldBase {
  kind: SettingsFieldKind;
  editableBy: SettingsRole;
  min?: number;
  max?: number;
  /** For a `number`: its values are multiples of the step, with no more decimal places than it has. */
  step?: number;
  /** For a `choice`. */
  choices?: readonly SettingsChoice[];
}

/** A field shown but never edited, with what sets it. */
export interface ReadOnlySettingsField extends SettingsFieldBase {
  /** Read-only fields have no range; a kind, where given, decides only how the value is shown. */
  kind?: SettingsFieldKind;
  /** What sets the field, as shown beside it. */
  setBy: string;
}

export type SettingsField = EditableSettingsField | ReadOnlySettingsField;

export function isEditable(field: SettingsField): field is EditableSettingsField {
  return "editableBy" in field;
}

const STREAMLINE: readonly SettingsNote[] = ["putBackByStreamline"];
const SET_BY_WORKFLOW = "Set by the Workflow";

/**
 * Each settings collection's fields, in the order the Settings card shows
 * them (#220, What is editable). The machine routes report
 * `machineSettings`, `advancedSettings` and `machineCalibration` from the
 * Machine's registers, and `sensorCalibration` holds each target's current
 * read, whose `measuredValue` is the field's value: a multiplier for `flow`
 * and `pressure`, an offset in °C for `temperature`.
 */
export const SETTINGS_FIELDS: Record<SettingsCollectionName, readonly SettingsField[]> = {
  machineSettings: [
    // The DE1 holds the fan threshold to 0 to 50 (`MMRItem`), as Streamline's page does (`FAN_THRESHOLD_MAX`).
    { path: "fan", label: "Fan threshold", unit: "°C", kind: "wholeNumber", min: 0, max: 50, editableBy: "staff", notes: ["resetsOnReconnect", "putBackByStreamline"] },
    {
      path: "steamPurgeMode",
      label: "Steam purge mode",
      kind: "choice",
      choices: [
        { value: 0, label: "Normal" },
        { value: 1, label: "Two Tap Stop" },
      ],
      editableBy: "staff",
      notes: STREAMLINE,
    },
    // Decaid writes the Workflow's back to the Machine on every reconnect (`_setDe1DefaultsFor`), and a Loaded Recipe holds them.
    { path: "steamFlow", label: "Steam flow", unit: "ml/s", kind: "number", setBy: SET_BY_WORKFLOW },
    { path: "hotWaterFlow", label: "Hot water flow", unit: "ml/s", kind: "number", setBy: SET_BY_WORKFLOW },
    { path: "flushFlow", label: "Flush flow", unit: "ml/s", kind: "number", setBy: SET_BY_WORKFLOW },
    { path: "flushTemp", label: "Flush temperature", unit: "°C", kind: "number", setBy: SET_BY_WORKFLOW },
    { path: "flushTimeout", label: "Flush time-out", unit: "s", kind: "number", setBy: SET_BY_WORKFLOW },
    { path: "tankTemp", label: "Tank temperature", unit: "°C", kind: "number", setBy: "Set by each profile" },
    // `BatteryController` switches it as the charging mode asks.
    { path: "usb", label: "USB charger", kind: "onOff", setBy: "Set by the Tablet's charging mode" },
  ],
  advancedSettings: [
    { path: "heaterPh1Flow", label: "Heater warmup flow", unit: "ml/s", kind: "number", min: 0, max: 10, step: 0.1, editableBy: "admin", notes: STREAMLINE },
    { path: "heaterPh2Flow", label: "Heater test flow", unit: "ml/s", kind: "number", min: 0, max: 10, step: 0.1, editableBy: "admin", notes: STREAMLINE },
    { path: "heaterIdleTemp", label: "Idle temperature", unit: "°C", kind: "wholeNumber", min: 0, max: 99, editableBy: "admin", notes: STREAMLINE },
    { path: "heaterPh2Timeout", label: "Heater test time-out", unit: "s", kind: "wholeNumber", min: 0, max: 60, editableBy: "admin", notes: STREAMLINE },
    // Only the two values Streamline offers: Decaid writes -1 for one outside 90 to 150 and 180 to 260 (`De1HeaterVoltage.fromInt`).
    // Streamline's restore leaves it alone.
    {
      path: "heaterVoltage",
      label: "Heater voltage",
      kind: "choice",
      choices: [
        { value: 120, label: "110 V" },
        { value: 230, label: "220 V" },
      ],
      editableBy: "admin",
      notes: ["restartAfterChange"],
    },
    {
      path: "refillKitSetting",
      label: "Refill kit",
      kind: "choice",
      choices: [
        { value: 2, label: "Auto-Detect" },
        { value: 1, label: "Force On" },
        { value: 0, label: "Force Off" },
      ],
      editableBy: "admin",
      notes: ["resetsOnReconnect", "putBackByStreamline"],
    },
  ],
  machineCalibration: [
    // The range Decaid clamps to (`calFlowEst`), in the thousandths the Machine keeps.
    { path: "flowMultiplier", label: "Flow multiplier", kind: "number", min: 0.13, max: 2, step: 0.001, editableBy: "admin" },
  ],
  sensorCalibration: [
    // The band Streamline accepts for one correction (`SENSOR_CAL_RATIO_MIN` and `SENSOR_CAL_RATIO_MAX` in
    // streamline-js:src/modules/sensor-cal.js). Upstream sets no bound for the temperature offset; this one is chosen here.
    { path: "flow", label: "Flow sensor multiplier", kind: "number", min: 0.75, max: 1.33, step: 0.0001, editableBy: "admin" },
    { path: "pressure", label: "Pressure sensor multiplier", kind: "number", min: 0.75, max: 1.33, step: 0.0001, editableBy: "admin" },
    { path: "temperature", label: "Temperature sensor offset", unit: "°C", kind: "number", min: -10, max: 10, step: 0.01, editableBy: "admin" },
  ],
  appSettings: [
    {
      path: "gatewayMode",
      label: "Gateway mode",
      kind: "choice",
      choices: [
        { value: "disabled", label: "Disabled" },
        { value: "tracking", label: "Tracking" },
        { value: "full", label: "Full" },
      ],
      editableBy: "admin",
    },
    {
      path: "scalePowerMode",
      label: "Scale power mode",
      kind: "choice",
      choices: [
        { value: "disabled", label: "Nothing" },
        { value: "displayOff", label: "Display Off" },
        { value: "disconnect", label: "Disconnect" },
      ],
      editableBy: "staff",
    },
    { path: "blockOnNoScale", label: "Block Shots with no scale", kind: "onOff", editableBy: "staff" },
    { path: "blockTareDuringShot", label: "Block taring during a Shot", kind: "onOff", editableBy: "staff" },
    { path: "stopHotWaterAtWeight", label: "Stop hot water at weight", kind: "onOff", editableBy: "staff" },
    { path: "weightFlowMultiplier", label: "Weight flow multiplier", kind: "number", min: 0, step: 0.1, editableBy: "staff" },
    { path: "volumeFlowMultiplier", label: "Volume flow multiplier", unit: "s", kind: "number", min: 0, step: 0.05, editableBy: "staff" },
    { path: "hotWaterFlowMultiplier", label: "Hot water flow multiplier", unit: "s", kind: "number", min: 0, step: 0.05, editableBy: "staff" },
    { path: "automaticUpdateCheck", label: "Automatic update checks", kind: "onOff", editableBy: "staff" },
    {
      path: "chargingMode",
      label: "Charging mode",
      kind: "choice",
      choices: [
        { value: "disabled", label: "Charge to 100%" },
        { value: "highAvailability", label: "Charge to 95%" },
        { value: "balanced", label: "Charge up to 80%" },
        { value: "longevity", label: "Charge up to 55%" },
      ],
      editableBy: "staff",
    },
    { path: "nightModeEnabled", label: "Night mode", kind: "onOff", editableBy: "staff" },
    { path: "nightModeSleepTime", label: "Night mode sleep time", kind: "timeOfDay", min: 0, max: 1439, editableBy: "staff" },
    { path: "nightModeMorningTime", label: "Night mode morning time", kind: "timeOfDay", min: 0, max: 1439, editableBy: "staff" },
    { path: "lowBatteryBrightnessLimit", label: "Dim the screen on low battery", kind: "onOff", editableBy: "staff" },
    // Decaid's own "Keep screen awake", apart from presence's keep-awake.
    { path: "keepAwake", label: "Keep the Tablet's screen on", kind: "onOff", editableBy: "staff" },
    {
      path: "themeMode",
      label: "Theme",
      kind: "choice",
      choices: [
        { value: "system", label: "System" },
        { value: "light", label: "Light" },
        { value: "dark", label: "Dark" },
      ],
      editableBy: "staff",
    },
    {
      path: "logLevel",
      label: "Log level",
      kind: "choice",
      choices: [
        { value: "ALL", label: "ALL" },
        { value: "FINEST", label: "FINEST" },
        { value: "FINER", label: "FINER" },
        { value: "FINE", label: "FINE" },
        { value: "CONFIG", label: "CONFIG" },
        { value: "INFO", label: "INFO" },
        { value: "WARNING", label: "WARNING" },
        { value: "SEVERE", label: "SEVERE" },
        { value: "SHOUT", label: "SHOUT" },
        { value: "OFF", label: "OFF" },
      ],
      editableBy: "staff",
    },
    // Reported only while Decaid reads the Tablet's battery.
    { path: "chargingState", label: "Charging state", setBy: "A reading of the Tablet's battery" },
    { path: "simulatedDevices", label: "Simulated devices", setBy: "For development" },
    { path: "webUiPath", label: "Web UI path", setBy: "Follows the default skin" },
    { path: "defaultSkinId", label: "Default skin", setBy: "Managed with the Tablet's skins" },
    { path: "preferredMachineId", label: "Preferred machine", setBy: "Managed with the preferred devices" },
    { path: "preferredScaleId", label: "Preferred scale", setBy: "Managed with the preferred devices" },
    { path: "preferredGrinderDeviceId", label: "Preferred grinder", setBy: "Managed with the preferred devices" },
  ],
};

/** The definition of a collection's field, or undefined for one no definition covers. */
export function settingsField(collection: SettingsCollectionName, path: string): SettingsField | undefined {
  return SETTINGS_FIELDS[collection].find((field) => field.path === path);
}

/**
 * Why an edit, or one of its fields, is not allowed:
 *
 * - `unknownCollection`: the edit names no settings collection;
 * - `noFields`: it sets nothing;
 * - `severalTargets`: it sets more than one sensor's calibration, where an
 *   edit names one target, which the plugin sets from one read of it;
 * - `unknown`: no definition covers the field;
 * - `readOnly`: the field is shown but never edited;
 * - `notAllowed`: the field is an Admin's to change, and the account is Staff;
 * - `invalid`: the value is not of the field's kind, such as text for a number;
 * - `notOffered`: the value is none of the field's choices;
 * - `outOfRange`: the value is below the field's minimum or above its maximum;
 * - `offStep`: the value is not on the field's step (`onStep`).
 */
export type SettingsEditRefusalReason =
  | "unknownCollection"
  | "noFields"
  | "severalTargets"
  | "unknown"
  | "readOnly"
  | "notAllowed"
  | "invalid"
  | "notOffered"
  | "outOfRange"
  | "offStep";

export interface SettingsEditRefusal {
  reason: SettingsEditRefusalReason;
  /** The field refused; absent where the whole edit is. */
  field?: string;
}

/** What a Settings Edit sets: its collection, and each field's new value by its path. */
export interface SettingsEditFields {
  collection: string;
  fields: Record<string, unknown>;
}

/**
 * Whether an edit's fields and values are allowed by the definitions and to
 * an account of `role`: none of its refusals, one for each field refused,
 * by the first reason that applies, in the order SettingsEditRefusalReason
 * lists them. An empty list allows the edit.
 */
export function validateSettingsEdit(edit: SettingsEditFields, role: SettingsRole): SettingsEditRefusal[] {
  if (!isSettingsCollectionName(edit.collection)) return [{ reason: "unknownCollection" }];
  const paths = Object.keys(edit.fields);
  if (paths.length === 0) return [{ reason: "noFields" }];
  if (edit.collection === "sensorCalibration" && paths.length > 1) return [{ reason: "severalTargets" }];
  const refusals: SettingsEditRefusal[] = [];
  for (const path of paths) {
    const reason = fieldRefusal(settingsField(edit.collection, path), edit.fields[path], role);
    if (reason) refusals.push({ reason, field: path });
  }
  return refusals;
}

/** A refusal of `validateSettingsEdit` as a sentence the management interface shows, naming the field by its label. */
export function settingsRefusalText(collection: string, refusal: SettingsEditRefusal): string {
  const field = refusal.field === undefined || !isSettingsCollectionName(collection) ? undefined : settingsField(collection, refusal.field);
  const name = field?.label ?? refusal.field ?? "";
  const editable = field && isEditable(field) ? field : undefined;
  switch (refusal.reason) {
    case "unknownCollection":
      return `There are no settings named ${collection}`;
    case "noFields":
      return "Change at least one setting";
    case "severalTargets":
      return "Set one sensor's calibration at a time";
    case "unknown":
      return `There is no setting named ${name}`;
    case "readOnly":
      return `${name} can't be changed here${field && !isEditable(field) ? `: ${field.setBy.charAt(0).toLowerCase()}${field.setBy.slice(1)}` : ""}`;
    case "notAllowed":
      return `Only an Admin can change ${name}`;
    case "invalid":
      return `${name} must be ${editable?.kind === "onOff" ? "on or off" : editable?.kind === "number" ? "a number" : "a whole number"}`;
    case "notOffered":
      return `${name} must be ${(editable?.choices ?? []).map((choice) => choice.label).join(" or ")}`;
    case "outOfRange":
      return `${name} must be ${rangeText(editable)}`;
    case "offStep":
      return `${name} must be a multiple of ${editable?.step}`;
  }
}

function rangeText(field: EditableSettingsField | undefined): string {
  if (field?.min !== undefined && field.max !== undefined) return `from ${field.min} to ${field.max}`;
  return field?.min !== undefined ? `${field.min} or more` : `${field?.max} or less`;
}

function fieldRefusal(field: SettingsField | undefined, value: unknown, role: SettingsRole): SettingsEditRefusalReason | undefined {
  if (!field) return "unknown";
  if (!isEditable(field)) return "readOnly";
  if (field.editableBy === "admin" && role !== "admin") return "notAllowed";
  switch (field.kind) {
    case "onOff":
      return typeof value === "boolean" ? undefined : "invalid";
    case "choice":
      return field.choices?.some((choice) => choice.value === value) ? undefined : "notOffered";
    case "wholeNumber":
    case "timeOfDay":
      if (typeof value !== "number" || !Number.isInteger(value)) return "invalid";
      return inRange(field, value) ? undefined : "outOfRange";
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return "invalid";
      if (!inRange(field, value)) return "outOfRange";
      return field.step === undefined || onStep(value, field.step) ? undefined : "offStep";
  }
}

function inRange(field: EditableSettingsField, value: number): boolean {
  return (field.min === undefined || value >= field.min) && (field.max === undefined || value <= field.max);
}

/**
 * Whether a number is on a step: it has no more decimal places than the step
 * has, and is a whole multiple of it, counted in the step's least decimal
 * place (0.35 is 35 hundredths, seven times a step of 0.05). The number is
 * taken as JavaScript writes it most briefly, as JSON carries it, and its
 * digits are divided exactly, never by floating-point arithmetic: 0.35 / 0.05
 * is 6.999999999999999, and scaling 90071992547410.11 by 100 loses its last
 * digit.
 */
export function onStep(value: number, step: number): boolean {
  const places = decimalPlaces(step);
  const { digits, exponent } = decimalDigits(value);
  if (exponent < -places) return false;
  // The step in its own least decimal place is a small whole number, such as 5 for 0.05, so this is exact.
  const units = Math.round(step * 10 ** places);
  let remainder = 0;
  for (const digit of digits + "0".repeat(exponent + places)) remainder = (remainder * 10 + Number(digit)) % units;
  return remainder === 0;
}

/** How many decimal places a number has, as JavaScript writes it most briefly: 0.05 has 2, 1.5e-7 has 8. */
export function decimalPlaces(value: number): number {
  return Math.max(0, -decimalDigits(value).exponent);
}

/** A number's magnitude as JavaScript writes it most briefly, as decimal digits times a power of ten: 0.35 is 35 and -2, 1e21 is 1 and 21. */
function decimalDigits(value: number): { digits: string; exponent: number } {
  const [mantissa = "", exponent = "0"] = String(Math.abs(value)).toLowerCase().split("e");
  const [whole = "", fraction = ""] = mantissa.split(".");
  return { digits: whole + fraction, exponent: Number(exponent) - fraction.length };
}
