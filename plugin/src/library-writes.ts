import {
  GLOBAL_ID_KEY,
  type ItemWritten,
  type LibraryWrite,
  MAX_REFUSAL_LENGTH,
  type WriteRefused,
  globalIdOf,
} from "@decent-sync/protocol";
import { type Answer, request } from "./decaid.js";
import { utcTime } from "./local-time.js";

// The Library items the server shares, written to this tablet through
// Decaid's API (ADR-0006), one at a time, in the order the server asks.
// Decaid replaces a record's `extras` whole when it updates one, so the
// plugin reads the record first and keeps the keys other plugins wrote there
// beside the item's global id. Decaid assigns new records their ids itself.

/** Where each kind of record lives in Decaid's API (v0.8.7, rest_v1.yml). */
const ROUTES: Readonly<Record<string, { list: string; records: string }>> = {
  bean: { list: "/beans?includeArchived=true", records: "/beans" },
};

/** What becomes of a write: the record Decaid returned, or why it did not write one. */
export type WriteAnswer = ItemWritten | WriteRefused;

/** Carries out the server's writes in the order they arrive, one at a time. */
export class LibraryWrites {
  private queue: Promise<unknown> = Promise.resolve();

  /** Carries out a write once those before it are done, and resolves with its answer. It never rejects. */
  apply(write: LibraryWrite): Promise<WriteAnswer> {
    const answer = this.queue.then(() => carryOut(write));
    this.queue = answer;
    return answer;
  }
}

async function carryOut(write: LibraryWrite): Promise<WriteAnswer> {
  const route = ROUTES[write.kind];
  if (!route) return refused(write, null, `This plugin cannot write a ${write.kind}`);
  try {
    if (write.localId === null) {
      const held = await heldRecord(route, write);
      if (held !== null) return held;
    }
    return answerTo(write, write.localId === null ? await create(route, write) : await update(route, write, write.localId));
  } catch (error) {
    return refused(write, null, `Decaid did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The answer, when the tablet already holds a record carrying the item's
 * global id: one an earlier write created, whose answer was lost when its
 * connection dropped. Nothing is written then. Null if it holds none, or the
 * refusal if the tablet's records cannot be read.
 */
async function heldRecord(route: { list: string; records: string }, write: LibraryWrite): Promise<WriteAnswer | null> {
  const listed = await request("GET", route.list);
  if (!listed.ok) return refused(write, listed.status, listed.text);
  const records = parsed(listed.text);
  const held = Array.isArray(records) ? records.find((record) => globalIdOf(record) === write.globalId.toLowerCase()) : undefined;
  return isObject(held) ? written(write, held) : null;
}

/** Creates the record, with the global id in its `extras`. */
function create(route: { list: string; records: string }, write: LibraryWrite): Promise<Answer> {
  return request("POST", route.records, { ...write.fields, extras: { [GLOBAL_ID_KEY]: write.globalId } });
}

/** Updates the record's fields, and writes the global id beside the other keys in its `extras`, which Decaid replaces whole. */
async function update(route: { list: string; records: string }, write: LibraryWrite, localId: string): Promise<Answer> {
  const path = `${route.records}/${encodeURIComponent(localId)}`;
  const current = await request("GET", path);
  if (!current.ok) return current;
  const record = parsed(current.text);
  const extras = isObject(record) && isObject(record.extras) ? record.extras : {};
  return request("PUT", path, { ...write.fields, extras: { ...extras, [GLOBAL_ID_KEY]: write.globalId } });
}

/** The answer to a write from what Decaid answered last: the record it holds now, or its refusal. */
function answerTo(write: LibraryWrite, answer: Answer): WriteAnswer {
  const record = answer.ok ? parsed(answer.text) : undefined;
  if (isObject(record) && typeof record.id === "string") return written(write, record);
  return refused(write, answer.status, answer.text);
}

function written(write: LibraryWrite, record: Record<string, unknown>): ItemWritten {
  return { type: "written", id: write.id, kind: write.kind, globalId: write.globalId, record, updatedAt: utcTime(record.updatedAt) };
}

function refused(write: LibraryWrite, status: number | null, error: string): WriteRefused {
  return { type: "writeRefused", id: write.id, kind: write.kind, globalId: write.globalId, status, error: error.slice(0, MAX_REFUSAL_LENGTH) };
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
