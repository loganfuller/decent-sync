import { BadRequestException, NotFoundException } from "@nestjs/common";
import { MAX_RECORD_ID_LENGTH, WAKE_SCHEDULE_ACTIONS, type WakeScheduleAction, type WakeScheduleEdit } from "@decent-sync/protocol";

// Request bodies for the Settings Edits endpoints, checked by hand like the
// other endpoints: each problem gets a message the management interface can
// show. The fields themselves are checked against their definitions
// (`validateSettingsEdit`) by the service.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A Settings Edit as asked for: its collection, each field's new value, and
 * each field's raw value in the report the page showed; or, for a wake
 * schedule, what it does to which, its fields, and the whole schedule as
 * reported, for a change or a delete.
 */
export interface NewSettingsEdit {
  collection: string;
  schedule?: WakeScheduleEdit;
  fields: Record<string, unknown>;
  expected: Record<string, unknown>;
}

export function readSettingsEdit(body: unknown): NewSettingsEdit {
  const fields = isObject(body) ? body : {};
  const problems: string[] = [];
  const collection = typeof fields.collection === "string" ? fields.collection : "";
  if (collection === "") problems.push("Name the settings to change");
  if (!isObject(fields.fields)) problems.push("Give the settings' new values as an object");
  if (!isObject(fields.expected)) problems.push("Give each setting's value in the report shown as an object");
  if (problems.length > 0) throw new BadRequestException(problems);
  const changed = fields.fields as Record<string, unknown>;
  const expected = fields.expected as Record<string, unknown>;
  if (fields.schedule !== undefined) {
    const schedule = readSchedule(fields.schedule, expected);
    return { collection, schedule, fields: changed, expected };
  }
  // Each field changed is checked against what the tablet held, and nothing else is.
  const missing = Object.keys(changed).filter((path) => !Object.hasOwn(expected, path));
  const extra = Object.keys(expected).filter((path) => !Object.hasOwn(changed, path));
  if (missing.length > 0) problems.push(`Give the value shown of ${missing.join(", ")}`);
  if (extra.length > 0) problems.push(`Give the value shown only of the settings changed, not of ${extra.join(", ")}`);
  if (problems.length > 0) throw new BadRequestException(problems);
  return { collection, fields: changed, expected };
}

/**
 * The wake schedule an edit names, and what it does to it. A change or a
 * delete is checked against the whole schedule as reported, so `expected`
 * is that schedule, with its id; an add expects nothing.
 */
function readSchedule(value: unknown, expected: Record<string, unknown>): WakeScheduleEdit {
  const schedule = isObject(value) ? value : {};
  const action = schedule.action;
  if (!WAKE_SCHEDULE_ACTIONS.includes(action as WakeScheduleAction)) throw new BadRequestException(["Say whether the wake schedule is added, changed or deleted"]);
  if (action === "add") {
    const problems = [
      ...(schedule.id !== undefined ? ["A wake schedule added has no id until the Tablet gives it one"] : []),
      ...(Object.keys(expected).length > 0 ? ["A wake schedule added expects nothing"] : []),
    ];
    if (problems.length > 0) throw new BadRequestException(problems);
    return { action };
  }
  const id = schedule.id;
  if (typeof id !== "string" || id === "" || id.length > MAX_RECORD_ID_LENGTH) throw new BadRequestException(["Name the wake schedule by its id"]);
  // Decaid always reports a schedule's id, time, days and whether it is on; its keep-awake time only where it has one.
  if (expected.id !== id || !["time", "daysOfWeek", "enabled"].every((field) => field in expected)) {
    throw new BadRequestException(["Give the wake schedule as shown, its id included, as the value expected"]);
  }
  return { action: action as "change" | "delete", id };
}

export function readSettingsEditId(id: string): string {
  if (!UUID.test(id)) throw settingsEditNotFound();
  return id.toLowerCase();
}

export function settingsEditNotFound(): NotFoundException {
  return new NotFoundException("There is no such Settings Edit");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
