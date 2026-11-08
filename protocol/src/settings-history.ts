// A Machine's Settings History (#432): what its Tablet reported for each
// collection below, each value kept from when the server received it,
// whatever changed it. Values are compared through a projection that leaves
// out what other things set or what changes on its own; the value stored
// stays whole, as sent. Shared by the server, which records the history, and
// whatever shows it.

import { type CollectionName, sameValue } from "./index.js";
import type { WakeScheduleAction } from "./settings-fields.js";

/**
 * The collections whose values a Settings History keeps: every collection
 * but the Library's lists, which the Library keeps with its own history
 * (`LIBRARY_LISTS`): the Machine Settings, the Tablet Settings with the
 * presence settings, the plugins and Skins, the paired devices, the scale's
 * information and the sensors.
 */
export const SETTINGS_HISTORY_COLLECTIONS = [
  "appSettings",
  "presenceSettings",
  "machineSettings",
  "advancedSettings",
  "machineCalibration",
  "sensorCalibration",
  "plugins",
  "skins",
  "pairedDevices",
  "scaleInfo",
  "sensors",
] as const satisfies readonly CollectionName[];

export type SettingsHistoryCollection = (typeof SETTINGS_HISTORY_COLLECTIONS)[number];

export function isSettingsHistoryCollection(name: string): name is SettingsHistoryCollection {
  return (SETTINGS_HISTORY_COLLECTIONS as readonly string[]).includes(name);
}

/**
 * The top-level fields of a collection that a Settings History compares
 * none of:
 *
 * - in `machineSettings`, those the Workflow or the Tablet sets (ADR-0023,
 *   Not everything reported is editable): the steam, hot water and flush
 *   settings, which Decaid writes from the Workflow, whose own changes are
 *   recorded as Workflow changes; the tank temperature, which each profile
 *   sets; and `usb`, which the Tablet's charging mode switches;
 * - `appSettings.chargingState`, a reading of the Tablet's battery;
 * - `presenceSettings.keepAwakeUntil`, set while a wake schedule keeps the
 *   Machine awake;
 * - `scaleInfo.batteryLevel`, the scale's battery.
 */
export const LEFT_OUT_OF_SETTINGS_HISTORY: Readonly<Partial<Record<SettingsHistoryCollection, readonly string[]>>> = {
  machineSettings: ["steamFlow", "hotWaterFlow", "flushFlow", "flushTemp", "flushTimeout", "tankTemp", "usb"],
  appSettings: ["chargingState"],
  presenceSettings: ["keepAwakeUntil"],
  scaleInfo: ["batteryLevel"],
};

/**
 * A paired device's fields that say how it is connected now, which a
 * Settings History compares none of: its `state`, whether it is in range
 * (`available`) and, for a scale, the role it is connected in
 * (`connectionRole`). Decaid's inventory carries no battery level.
 */
const DEVICE_CONNECTION_FIELDS = ["state", "available", "connectionRole"];

/**
 * A plugin's `source` fields that move with each of Decaid's update checks,
 * whatever they find: `lastChecked`.
 */
const PLUGIN_CHECK_FIELDS = ["lastChecked"];

/** How a wake schedule's field is keyed among a projection's fields: `schedules/<id>`, by the id Decaid gave it. */
export const SCHEDULE_KEY_PREFIX = "schedules/";

/**
 * A collection's value as a Settings History compares it, field by field:
 * an object of its fields, each compared whole (`sameValue`), left out
 * where `LEFT_OUT_OF_SETTINGS_HISTORY` and the rules below leave it out.
 * The value stored stays whole, as sent.
 *
 * - The presence settings' wake schedules are a field each, keyed by their
 *   id (`schedules/<id>`), each as a wake schedule's Settings Edit names
 *   its fields, with a `keepAwakeFor` of null for none, which Decaid leaves
 *   out.
 * - The sensor calibration is a field per target, its `measuredValue`, the
 *   value a Settings Edit of it sets.
 * - The plugins, paired devices and sensors are a field per entry, keyed by
 *   its id; each paired device without its connection, and each plugin's
 *   `source` without its update checks' time.
 * - Any other value that is no object is one field, keyed "".
 */
export function settingsHistoryFields(name: SettingsHistoryCollection, value: unknown): Record<string, unknown> {
  switch (name) {
    case "presenceSettings": {
      const fields = topLevelFields(name, value);
      const schedules = fields.schedules;
      if (!Array.isArray(schedules) || !schedules.every((schedule) => isObject(schedule) && typeof schedule.id === "string")) return fields;
      delete fields.schedules;
      for (const schedule of schedules as Record<string, unknown>[]) {
        const { id, ...rest } = schedule;
        fields[`${SCHEDULE_KEY_PREFIX}${id as string}`] = { ...rest, keepAwakeFor: rest.keepAwakeFor ?? null };
      }
      return fields;
    }
    case "sensorCalibration":
      return Object.fromEntries(Object.entries(topLevelFields(name, value)).map(([target, read]) => [target, isObject(read) ? (read.measuredValue ?? null) : read]));
    case "plugins":
      return byId(value, (plugin) => (isObject(plugin.source) ? { ...plugin, source: without(plugin.source, PLUGIN_CHECK_FIELDS) } : plugin));
    case "pairedDevices":
      return byId(value, (device) => without(device, DEVICE_CONNECTION_FIELDS));
    case "sensors":
      return byId(value, (sensor) => sensor);
    default:
      return topLevelFields(name, value);
  }
}

/**
 * The fields that differ between two values of a collection, as
 * `settingsHistoryFields` keys them, in the order the later value's
 * fields come, then those only the earlier had, each compared as JSON, an
 * object's keys in any order and a field absent counting as null
 * (`sameValue`). None where the values are the same for a Settings History,
 * though the values as sent may differ.
 */
export function changedSettingsHistoryFields(name: SettingsHistoryCollection, before: unknown, after: unknown): string[] {
  const earlier = settingsHistoryFields(name, before);
  const later = settingsHistoryFields(name, after);
  const keys = new Set([...Object.keys(later), ...Object.keys(earlier)]);
  return [...keys].filter((key) => !sameValue(earlier[key], later[key]));
}

/**
 * What a Settings Edit set, for labelling a change in a Settings History:
 * its fields, by their paths, and the wake schedule it added, changed or
 * deleted, if one, by its id, which an add's answer gives only after its
 * read-back.
 */
export interface HistoryEdit {
  fields: Record<string, unknown>;
  schedule?: { action: WakeScheduleAction; id: string | null };
}

/**
 * The fields of a change that a Settings Edit made, of those that changed
 * between `before` and `after` (`changed`, as `changedSettingsHistoryFields`
 * gives them): those it set, whatever came of it. A wake schedule's change
 * or delete set the schedule it names. An add set each schedule new in
 * `after` that holds every field the edit set, as Decaid gives the new id
 * only in the edit's answer, which follows its read-back.
 */
export function editedSettingsHistoryFields(name: SettingsHistoryCollection, edit: HistoryEdit, before: unknown, after: unknown, changed: readonly string[]): string[] {
  if (!edit.schedule) return changed.filter((field) => field in edit.fields);
  if (edit.schedule.action !== "add") return changed.filter((field) => field === `${SCHEDULE_KEY_PREFIX}${edit.schedule!.id}`);
  const earlier = settingsHistoryFields(name, before);
  const later = settingsHistoryFields(name, after);
  const holdsEdit = (schedule: unknown) => isObject(schedule) && Object.entries(edit.fields).every(([path, value]) => sameValue(schedule[path], value));
  return changed.filter((field) => field.startsWith(SCHEDULE_KEY_PREFIX) && !(field in earlier) && holdsEdit(later[field]));
}

/** An object's fields, but those left out of the collection's history; any other value as one field, "". */
function topLevelFields(name: SettingsHistoryCollection, value: unknown): Record<string, unknown> {
  if (!isObject(value)) return { "": value };
  return without(value, LEFT_OUT_OF_SETTINGS_HISTORY[name] ?? []);
}

/** A list's entries by their ids, each as `project` gives it; the list as one field, "", where an entry has no string id. */
function byId(value: unknown, project: (entry: Record<string, unknown>) => unknown): Record<string, unknown> {
  if (!Array.isArray(value) || !value.every((entry) => isObject(entry) && typeof entry.id === "string")) return { "": value };
  return Object.fromEntries((value as Record<string, unknown>[]).map((entry) => [entry.id as string, project(entry)]));
}

function without(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const kept = { ...value };
  for (const key of keys) delete kept[key];
  return kept;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
