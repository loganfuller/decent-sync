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
 * A plugin's `source` fields that Decaid's update checks write, whatever
 * they find: `lastChecked`, and `lastError`, set by a check that fails,
 * as one does while the Tablet is offline, and cleared by the next.
 */
const PLUGIN_CHECK_FIELDS = ["lastChecked", "lastError"];

/**
 * A plugin's `pendingUpdate` field that each update check writes again
 * while an update waits for its new permissions to be approved:
 * `detectedAt` (`PluginSourceService` in Decaid v0.9.1).
 */
const PENDING_UPDATE_CHECK_FIELDS = ["detectedAt"];

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
 *   `source` and `pendingUpdate` without what its update checks write.
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
      return byId(value, (plugin) => ({
        ...plugin,
        ...(isObject(plugin.source) ? { source: without(plugin.source, PLUGIN_CHECK_FIELDS) } : {}),
        ...(isObject(plugin.pendingUpdate) ? { pendingUpdate: without(plugin.pendingUpdate, PENDING_UPDATE_CHECK_FIELDS) } : {}),
      }));
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

/**
 * How soon a field changed back makes its change brief (#433): about 2
 * minutes, as long as Decaid shows the refill kit on automatic after the
 * machine reconnects before it writes the kept value back (ADR-0023), and a
 * remembered scale stays out of the paired devices while Decaid lists it
 * `discovered`, between being switched on and connecting.
 */
export const BRIEF_CHANGE_MS = 2 * 60_000;

/** A value of a collection's Settings History, as its changes are worked out from it. */
export interface HistoryValue {
  value: unknown;
  /** When it was received, in milliseconds since the epoch. */
  receivedAt: number;
  /** The Settings Edit that set the fields `editedFields` names, if one. */
  settingsEditId: string | null;
  editedFields: readonly string[];
}

/** One field's change, as `settingsHistoryFields` keys and projects the field. */
export interface HistoryFieldChange {
  field: string;
  /** Added, where the value before held no such field; removed, where the value after holds none; changed otherwise. */
  change: "added" | "changed" | "removed";
  /** As compared, null where absent. */
  before: unknown;
  after: unknown;
  /**
   * For a brief change, one changed back to `before` within
   * `BRIEF_CHANGE_MS` from outside Decent Sync, when it changed back; null
   * for any other. The change back is folded into this one.
   */
  backAt: number | null;
}

/**
 * The changes of one value from the one before it: those a Settings Edit
 * made, or those made outside Decent Sync, `settingsEditId` null.
 */
export interface HistoryChange {
  /** The index of the value, in the values given. */
  index: number;
  settingsEditId: string | null;
  fields: HistoryFieldChange[];
}

/**
 * A collection's changes, oldest first, from its Settings History's values
 * in the order they were written: each value's changes from the one before
 * it, compared field by field (`settingsHistoryFields`), as one change for
 * the fields the value's Settings Edit set and one for those changed outside
 * Decent Sync. The first value is the history's baseline, no change. A value
 * with no field changed from the one before, as compared, has none.
 *
 * A field changed from outside Decent Sync, then changed back to its value
 * before by its next change, also from outside, within `BRIEF_CHANGE_MS`, is
 * a brief change: the first change gives when it changed back (`backAt`),
 * and the change back is left out. A change made or undone through a
 * Settings Edit is never brief, as someone chose it.
 */
export function settingsHistoryChanges(name: SettingsHistoryCollection, values: readonly HistoryValue[]): HistoryChange[] {
  const projected = values.map((entry) => settingsHistoryFields(name, entry.value));
  const fields = values.map((entry, index): (HistoryFieldChange & { edited: boolean; folded: boolean })[] => {
    if (index === 0) return [];
    const [before, after] = [projected[index - 1]!, projected[index]!];
    const keys = new Set([...Object.keys(after), ...Object.keys(before)]);
    return [...keys]
      .filter((field) => !sameValue(before[field], after[field]))
      .map((field) => ({
        field,
        change: !(field in before) ? "added" : !(field in after) ? "removed" : "changed",
        before: before[field] ?? null,
        after: after[field] ?? null,
        backAt: null,
        edited: entry.settingsEditId !== null && entry.editedFields.includes(field),
        folded: false,
      }));
  });
  for (const [index, changes] of fields.entries()) {
    for (const change of changes) {
      if (change.edited || change.folded) continue;
      // The field's next change, if within the time a brief change takes.
      for (let next = index + 1; next < values.length && values[next]!.receivedAt - values[index]!.receivedAt <= BRIEF_CHANGE_MS; next++) {
        const back = fields[next]!.find((candidate) => candidate.field === change.field);
        if (!back) continue;
        if (!back.edited && sameValue(projected[next]![change.field], projected[index - 1]![change.field])) {
          change.backAt = values[next]!.receivedAt;
          back.folded = true;
        }
        break;
      }
    }
  }
  return fields.flatMap((changes, index) => {
    const kept = changes.filter((change) => !change.folded);
    const settingsEditId = values[index]!.settingsEditId;
    return [
      { index, settingsEditId, fields: kept.filter((change) => change.edited) },
      { index, settingsEditId: null, fields: kept.filter((change) => !change.edited) },
    ]
      .filter((change) => change.fields.length > 0)
      .map((change) => ({ ...change, fields: change.fields.map(({ edited: _edited, folded: _folded, ...field }) => field) }));
  });
}
