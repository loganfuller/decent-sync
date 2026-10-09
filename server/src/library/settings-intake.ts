import { SHARED_SETTINGS, STEAM_SETTINGS, type SharedSetting, type SharedSettings, sameValue, steamIsOn } from "@decent-sync/protocol";
import type { FieldEdits } from "./merge.js";

// A Location's steam, hot water and rinse settings, shared by its Machines,
// whatever their model (ADR-0014): which of a tablet's reported settings are
// edits, and what a tablet is to be written. Each setting is a field of its
// own, merged as a Library item's content is (merge.ts, ADR-0020). A Machine
// whose steam is off (a steam target below 135 °C) neither shares its steam
// settings nor takes the Location's, so turning steam off stays on that
// Machine; once its steam is turned on again, it takes the Location's. Pure,
// so module tests can drive it; location-settings.ts reads what it needs.

/** The settings a Location has set, by field name: a field no Machine has set yet is absent. */
export type LocationValues = Readonly<Partial<Record<SharedSetting, number>>>;

/**
 * What a tablet's reported settings change at its Location: the fields it
 * is to merge as the tablet's edits (ADR-0020), with their values. That
 * covers fields the Location has not set yet, which nobody has edited, so
 * the report decides them: the first Machine there sets the Location's
 * settings.
 *
 * `known` is what the tablet last had of the same Location's settings, null
 * if nothing, as for a new tablet, or one whose Machine joined the Location:
 * such a report changes only fields the Location has not set, as the
 * Location's state wins (ADR-0008), and is written the rest. Otherwise each field that differs
 * from `known` is an edit. Steam settings count only while the report keeps
 * steam on: turned off, steam stays off on that Machine alone; turned on
 * again, it takes the Location's steam settings, rather than giving its own,
 * but for those the Location has not set yet.
 */
export function settingsEdits(known: SharedSettings | null, reported: SharedSettings, edits: FieldEdits): Partial<Record<SharedSetting, number>> {
  const steamShared = steamIsOn(reported);
  const steamJoins = known === null || !steamIsOn(known);
  const values: Partial<Record<SharedSetting, number>> = {};
  for (const field of SHARED_SETTINGS) {
    const steam = STEAM_SETTINGS.includes(field);
    if (steam && !steamShared) continue;
    const unset = !Object.prototype.hasOwnProperty.call(edits, field);
    const joins = known === null || (steam && steamJoins);
    if (unset || (!joins && !sameValue(known![field], reported[field]))) values[field] = reported[field];
  }
  return values;
}

/**
 * The fields a tablet is to be written to hold the Location's settings,
 * with the Location's values, and the value its Workflow holds for each, as
 * it last had them: each the Location has set that differs, but its steam
 * settings while its steam is off, which stays off. Null if none is due.
 */
export function settingsToWrite(location: LocationValues, held: SharedSettings): { fields: Record<string, number>; expected: Record<string, number> } | null {
  const fields: Record<string, number> = {};
  const expected: Record<string, number> = {};
  const steamOn = steamIsOn(held);
  for (const field of SHARED_SETTINGS) {
    const value = location[field];
    if (value === undefined || sameValue(value, held[field])) continue;
    if (!steamOn && STEAM_SETTINGS.includes(field)) continue;
    fields[field] = value;
    expected[field] = held[field];
  }
  return Object.keys(fields).length === 0 ? null : { fields, expected };
}

/** A Location's settings as stored, keeping only the shared settings it holds as numbers. */
export function readLocationValues(value: unknown): LocationValues {
  const values: Partial<Record<SharedSetting, number>> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return values;
  for (const field of SHARED_SETTINGS) {
    const setting = (value as Record<string, unknown>)[field];
    if (typeof setting === "number") values[field] = setting;
  }
  return values;
}
