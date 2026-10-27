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
  "presenceSettings",
] as const satisfies readonly CollectionName[];

export type SettingsCollectionName = (typeof SETTINGS_COLLECTION_NAMES)[number];

export function isSettingsCollectionName(name: string): name is SettingsCollectionName {
  return (SETTINGS_COLLECTION_NAMES as readonly string[]).includes(name);
}

/**
 * The settings collections a Settings Edit changes, which the plugin writes
 * through Decaid's routes: every settings collection, the machine's
 * settings, its advanced settings, its flow calibration, its sensors'
 * calibration, Decaid's own settings and its presence settings, whose wake
 * schedules are added, changed and deleted one at a time
 * (`WakeScheduleEdit`). The server refuses an edit of any other, and the
 * management interface offers none.
 */
export const EDITABLE_SETTINGS_COLLECTIONS = [
  "machineSettings",
  "advancedSettings",
  "machineCalibration",
  "sensorCalibration",
  "appSettings",
  "presenceSettings",
] as const satisfies readonly SettingsCollectionName[];

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
 * - `timeOfDay`, minutes after midnight in the Tablet's own time, 0 to 1439;
 * - `hoursMinutes`, a time of day in the Tablet's own time written HH:MM, as
 *   Decaid writes a wake schedule's;
 * - `weekdays`, ISO days of the week, Monday 1 to Sunday 7, each once and in
 *   order, as Decaid reports a wake schedule's, where none means every day;
 * - `localTime`, a date and time in the Tablet's own time without an offset,
 *   as Dart's `toIso8601String` writes a local `DateTime`, such as
 *   2026-10-25T08:30:00.000;
 * - `wakeSchedules`, Decaid's wake schedules (`WakeSchedule.toJson`), each
 *   with its id, its time as HH:MM in the Tablet's own time, its ISO days
 *   of the week (none means every day), whether it is on, and its
 *   `keepAwakeFor` in minutes, absent for none. They are added, changed and
 *   deleted one at a time, never set as a field.
 */
export type SettingsFieldKind = "number" | "wholeNumber" | "onOff" | "choice" | "timeOfDay" | "hoursMinutes" | "weekdays" | "localTime" | "wakeSchedules";

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
  /** Whether null is a value too, none, as for a wake schedule's keep-awake time. */
  orNone?: boolean;
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
    // Each a lead time in seconds: Decaid stops a Shot, or hot water, that long before its target at the flow it is
    // pouring (`ShotSequencer`, `HotWaterSequencer`). Decaid takes any number, and Streamline's page any of 0 or more: its
    // ± buttons' 0.1 and 0.05 are increments, not limits. Upstream sets no step; this one is chosen here, 0.01 s being
    // 0.05 g at 5 g/s (#343).
    { path: "weightFlowMultiplier", label: "Weight flow multiplier", kind: "number", min: 0, step: 0.01, editableBy: "staff" },
    { path: "volumeFlowMultiplier", label: "Volume flow multiplier", unit: "s", kind: "number", min: 0, step: 0.01, editableBy: "staff" },
    { path: "hotWaterFlowMultiplier", label: "Hot water flow multiplier", unit: "s", kind: "number", min: 0, step: 0.01, editableBy: "staff" },
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
  // `GET /presence/settings` (presence_handler.dart), labelled as Streamline's presence settings label them.
  presenceSettings: [
    { path: "userPresenceEnabled", label: "Presence detection", kind: "onOff", editableBy: "staff" },
    // Decaid takes 0 to 240 (`normalizeSleepTimeoutPreferenceMinutes`); Streamline's page offers 1 to 120.
    { path: "sleepTimeoutMinutes", label: "Sleep timeout", unit: "min", kind: "wholeNumber", min: 1, max: 120, editableBy: "staff" },
    { path: "schedules", label: "Wake schedules", kind: "wakeSchedules", editableBy: "staff" },
    // The end of the keep-awake window of the wake schedule that last woke the Machine, while it lasts (`PresenceController`).
    // Labelled with the offset as it was read, so a window that ends across a daylight saving change shows its end with
    // the offset before it until the window ends: an accepted gap.
    { path: "keepAwakeUntil", label: "Kept awake until", kind: "localTime", setBy: "Set while a wake schedule keeps the Machine awake" },
  ],
};

/**
 * A wake schedule's fields, which an edit adding or changing one sets, as
 * Decaid names them (`WakeSchedule.toJson` in
 * decaid:lib/src/models/wake_schedule.dart) and its handlers take them
 * (presence_handler.dart): its time, its days (none for every day, as Decaid
 * takes an empty list), whether it is on, and how long it keeps the Machine
 * awake, null for none, which Decaid reports by leaving the field out.
 * Labelled as the Settings card lists the schedules.
 */
export const WAKE_SCHEDULE_FIELDS: readonly EditableSettingsField[] = [
  { path: "time", label: "Time", kind: "hoursMinutes", editableBy: "staff" },
  { path: "daysOfWeek", label: "Days", kind: "weekdays", editableBy: "staff" },
  { path: "enabled", label: "On", kind: "onOff", editableBy: "staff" },
  // Decaid takes 1 to 720, and 0 or null for none (`_addScheduleHandler`).
  { path: "keepAwakeFor", label: "Keeps awake for", unit: "min", kind: "wholeNumber", min: 1, max: 720, orNone: true, editableBy: "staff" },
];

/** The definition of a wake schedule's field, or undefined for one no definition covers. */
export function wakeScheduleField(path: string): EditableSettingsField | undefined {
  return WAKE_SCHEDULE_FIELDS.find((field) => field.path === path);
}

/** What an edit of a wake schedule does to it. */
export const WAKE_SCHEDULE_ACTIONS = ["add", "change", "delete"] as const;

export type WakeScheduleAction = (typeof WAKE_SCHEDULE_ACTIONS)[number];

/**
 * The wake schedule an edit of the presence settings adds, changes or
 * deletes, each on its own (#220), and what it does. A change or a delete
 * names the schedule by the id Decaid gave it, and expects the whole
 * schedule as reported; an add expects nothing, and sets every field of
 * WAKE_SCHEDULE_FIELDS; a delete sets none.
 */
export type WakeScheduleEdit = { action: "add" } | { action: "change" | "delete"; id: string };

/** The definition of a collection's field, or undefined for one no definition covers. */
export function settingsField(collection: SettingsCollectionName, path: string): SettingsField | undefined {
  return SETTINGS_FIELDS[collection].find((field) => field.path === path);
}

/**
 * Why an edit, or one of its fields, is not allowed:
 *
 * - `unknownCollection`: the edit names no settings collection;
 * - `notSchedules`: it names a wake schedule, of a collection other than the
 *   presence settings;
 * - `noFields`: it sets nothing, but for a wake schedule's delete;
 * - `incompleteSchedule`: it adds a wake schedule without setting each of
 *   its fields;
 * - `deleteSetsNothing`: it deletes a wake schedule, and sets a field;
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
  | "notSchedules"
  | "noFields"
  | "incompleteSchedule"
  | "deleteSetsNothing"
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
  /** Whether the field is a wake schedule's (WAKE_SCHEDULE_FIELDS). */
  schedule?: true;
}

/** What a Settings Edit sets: its collection, the wake schedule it adds, changes or deletes if it does, and each field's new value by its path. */
export interface SettingsEditFields {
  collection: string;
  schedule?: WakeScheduleEdit;
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
  if (edit.schedule) return validateScheduleEdit(edit.collection, edit.schedule, edit.fields, role);
  if (paths.length === 0) return [{ reason: "noFields" }];
  if (edit.collection === "sensorCalibration" && paths.length > 1) return [{ reason: "severalTargets" }];
  const refusals: SettingsEditRefusal[] = [];
  for (const path of paths) {
    const reason = fieldRefusal(settingsField(edit.collection, path), edit.fields[path], role);
    if (reason) refusals.push({ reason, field: path });
  }
  return refusals;
}

/** An edit of a wake schedule's refusals, as `validateSettingsEdit` gives them. */
function validateScheduleEdit(collection: SettingsCollectionName, schedule: WakeScheduleEdit, fields: Record<string, unknown>, role: SettingsRole): SettingsEditRefusal[] {
  if (collection !== "presenceSettings") return [{ reason: "notSchedules" }];
  const paths = Object.keys(fields);
  if (schedule.action === "delete") return paths.length === 0 ? [] : [{ reason: "deleteSetsNothing" }];
  if (paths.length === 0) return [{ reason: "noFields" }];
  if (schedule.action === "add" && WAKE_SCHEDULE_FIELDS.some((field) => !(field.path in fields))) return [{ reason: "incompleteSchedule" }];
  const refusals: SettingsEditRefusal[] = [];
  for (const path of paths) {
    const reason = fieldRefusal(wakeScheduleField(path), fields[path], role);
    if (reason) refusals.push({ reason, field: path, schedule: true });
  }
  return refusals;
}

/** A refusal of `validateSettingsEdit` as a sentence the management interface shows, naming the field by its label. */
export function settingsRefusalText(collection: string, refusal: SettingsEditRefusal): string {
  const field =
    refusal.field === undefined || !isSettingsCollectionName(collection)
      ? undefined
      : refusal.schedule
        ? wakeScheduleField(refusal.field)
        : settingsField(collection, refusal.field);
  const name = field?.label ?? refusal.field ?? "";
  const editable = field && isEditable(field) ? field : undefined;
  switch (refusal.reason) {
    case "unknownCollection":
      return `There are no settings named ${collection}`;
    case "notSchedules":
      return "Only the presence settings have wake schedules";
    case "noFields":
      return "Change at least one setting";
    case "incompleteSchedule":
      return "Give a new wake schedule its time, its days, whether it is on and how long it keeps the Machine awake";
    case "deleteSetsNothing":
      return "Deleting a wake schedule changes none of its settings";
    case "severalTargets":
      return "Set one sensor's calibration at a time";
    case "unknown":
      return `There is no setting named ${name}`;
    case "readOnly":
      return `${name} can't be changed here${field && !isEditable(field) ? `: ${field.setBy.charAt(0).toLowerCase()}${field.setBy.slice(1)}` : ""}`;
    case "notAllowed":
      return `Only an Admin can change ${name}`;
    case "invalid":
      if (editable?.kind === "wakeSchedules") return `${name} are added, changed and deleted one at a time`;
      if (editable?.kind === "weekdays") return `${name} must be days of the week, 1 (Monday) to 7 (Sunday), each once and in order`;
      return `${name} must be ${kindText(editable)}`;
    case "notOffered":
      return `${name} must be ${(editable?.choices ?? []).map((choice) => choice.label).join(" or ")}`;
    case "outOfRange":
      return `${name} must be ${rangeText(editable)}${editable?.orNone ? ", or none" : ""}`;
    case "offStep":
      return `${name} must be a multiple of ${editable?.step}`;
  }
}

/**
 * How the plugin begins its refusal of an edit its own definitions refuse,
 * as `decaid` with no status, before each refusal's text
 * (`settingsRefusalText`), joined by "; ".
 */
export const NOT_WRITTEN = "Not written: ";

/**
 * Whether a plugin refused an edit by its own definitions though these
 * allow it: a plugin at another release, whose definitions differ, such as
 * the previous release's beside this one (ADR-0025), as 1.3.1's put a weight
 * flow multiplier of 0.86 off a step of 0.1 (#343). Nothing was written, and
 * the plugin takes the edit once it updates. Judged as the plugin judges, as
 * an Admin's.
 */
export function refusedByOtherDefinitions(edit: SettingsEditFields, refusal: { reason?: string; status?: number | null; message?: string | null }): boolean {
  return refusal.reason === "decaid" && refusal.status === null && (refusal.message?.startsWith(NOT_WRITTEN) ?? false) && validateSettingsEdit(edit, "admin").length === 0;
}

function kindText(field: EditableSettingsField | undefined): string {
  switch (field?.kind) {
    case "onOff":
      return "on or off";
    case "number":
      return "a number";
    case "timeOfDay":
    case "hoursMinutes":
      return "a time of day";
    default:
      return field?.orNone ? "a whole number, or none" : "a whole number";
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
  if (value === null && field.orNone) return undefined;
  switch (field.kind) {
    case "onOff":
      return typeof value === "boolean" ? undefined : "invalid";
    case "choice":
      return field.choices?.some((choice) => choice.value === value) ? undefined : "notOffered";
    case "wholeNumber":
    case "timeOfDay":
      if (typeof value !== "number" || !Number.isInteger(value)) return "invalid";
      return inRange(field, value) ? undefined : "outOfRange";
    case "hoursMinutes":
      return isHoursMinutes(value) ? undefined : "invalid";
    case "weekdays":
      return Array.isArray(value) && value.every((day, index) => Number.isInteger(day) && day >= 1 && day <= 7 && (index === 0 || day > value[index - 1])) ? undefined : "invalid";
    // Only shown, as no editable field is one.
    case "localTime":
    // Added, changed and deleted one at a time, never set as a field.
    case "wakeSchedules":
      return "invalid";
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return "invalid";
      if (!inRange(field, value)) return "outOfRange";
      return field.step === undefined || onStep(value, field.step) ? undefined : "offStep";
  }
}

/** Whether a value is a time of day written HH:MM, 00:00 to 23:59, as Decaid writes a wake schedule's. */
export function isHoursMinutes(value: unknown): value is string {
  const match = typeof value === "string" ? /^(\d\d):(\d\d)$/.exec(value) : null;
  return match !== null && Number(match[1]) < 24 && Number(match[2]) < 60;
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
