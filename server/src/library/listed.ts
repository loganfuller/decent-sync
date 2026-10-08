import { isRecordId } from "@decent-sync/protocol";

// What a tablet's report of one of its Library lists holds, read the same way
// for every kind.

/**
 * The ids of every record a reported list holds, whether or not Decent Sync
 * can take the record in: a record the tablet's map holds is deleted there
 * only once its id is gone from the list (ADR-0019), not when it can no
 * longer be read.
 */
export function listedIds(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.flatMap((record: unknown) => (isObject(record) && isRecordId(record.id) ? [record.id] : [])));
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
