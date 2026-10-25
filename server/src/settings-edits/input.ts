import { BadRequestException, NotFoundException } from "@nestjs/common";

// Request bodies for the Settings Edits endpoints, checked by hand like the
// other endpoints: each problem gets a message the management interface can
// show. The fields themselves are checked against their definitions
// (`validateSettingsEdit`) by the service.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Settings Edit as asked for: its collection, each field's new value, and each field's raw value in the report the page showed. */
export interface NewSettingsEdit {
  collection: string;
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
  // Each field changed is checked against what the tablet held, and nothing else is.
  const missing = Object.keys(changed).filter((path) => !Object.hasOwn(expected, path));
  const extra = Object.keys(expected).filter((path) => !Object.hasOwn(changed, path));
  if (missing.length > 0) problems.push(`Give the value shown of ${missing.join(", ")}`);
  if (extra.length > 0) problems.push(`Give the value shown only of the settings changed, not of ${extra.join(", ")}`);
  if (problems.length > 0) throw new BadRequestException(problems);
  return { collection, fields: changed, expected };
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
