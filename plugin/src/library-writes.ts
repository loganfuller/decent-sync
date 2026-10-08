import {
  GLOBAL_ID_KEY,
  type ItemWritten,
  type LibraryWrite,
  MAX_REFUSAL_LENGTH,
  type WriteRefused,
  beanMatchKey,
  globalIdOf,
} from "@decent-sync/protocol";
import { type Answer, request } from "./decaid.js";
import { utcTime } from "./local-time.js";
import type { Outbox } from "./outbox.js";

// The Library items the server shares, written to this tablet through
// Decaid's API (ADR-0006), one at a time, in the order the server asks.
// Decaid replaces a record's `extras` whole when it updates one, so the
// plugin reads the record first and keeps the keys other plugins wrote there
// beside the item's global id. Decaid assigns new records their ids itself.
// A Profile keeps Decaid's id, which Decaid derives from what the machine
// executes, so it is the same on every tablet, and carries no global id.

interface Route {
  /** The kind's records, archived ones included. */
  list: string;
  /** Where each record is found under its id. */
  records: string;
  /** Where a record with these fields is created, or null if they do not say. */
  create(fields: Record<string, unknown>): string | null;
  /** Fields Decaid's create does not take, written after it when they differ from what it made. */
  deferred: readonly string[];
  /**
   * Whether a record without a global id is the item a write would create:
   * a bean with the same roaster and name (ADR-0018). Bean Batches never are.
   */
  sameItem(record: Record<string, unknown>, fields: Record<string, unknown>): boolean;
}

/** Where each kind of record lives in Decaid's API (v0.8.7, rest_v1.yml). */
const ROUTES: Readonly<Record<string, Route>> = {
  bean: {
    list: "/beans?includeArchived=true",
    records: "/beans",
    create: () => "/beans",
    deferred: ["archived"],
    sameItem: (record, fields) =>
      typeof record.roaster === "string" &&
      typeof record.name === "string" &&
      typeof fields.roaster === "string" &&
      typeof fields.name === "string" &&
      beanMatchKey(record.roaster, record.name) === beanMatchKey(fields.roaster, fields.name),
  },
  beanBatch: {
    list: "/bean-batches?includeArchived=true",
    records: "/bean-batches",
    // Under the tablet's record of its bean, which `beanId` names; the path decides it, and Decaid ignores the field.
    create: (fields) => (typeof fields.beanId === "string" && fields.beanId !== "" ? `/beans/${encodeURIComponent(fields.beanId)}/batches` : null),
    deferred: ["archived", "weightRemaining"],
    sameItem: () => false,
  },
};

/** What becomes of a write: the record Decaid returned, or why it did not write one. */
export type WriteAnswer = ItemWritten | WriteRefused;

/**
 * Reads of the tablet's Library lists and writes to them, one at a time, in
 * the order they are asked for. A report of a list then either holds a
 * write's record or was read, and queued to be sent, before the write began
 * (`LibraryWrites`).
 */
export class LibraryAccess {
  private queue: Promise<unknown> = Promise.resolve();

  /** Runs `work` once everything asked for before it is done, and resolves or rejects as it does. */
  run<T>(work: () => Promise<T>): Promise<T> {
    const done = this.queue.then(work);
    this.queue = done.catch(() => {});
    return done;
  }
}

/**
 * Carries out the server's writes in the order they arrive, one at a time,
 * between reads of the lists it writes to, and queues each answer in the
 * outbox, behind the reports read before it. So the server takes in each
 * report read before a write before that write's answer, and never reads an
 * item the plugin wrote as deleted from a report that predates it (ADR-0019).
 */
export class LibraryWrites {
  constructor(
    private readonly library: LibraryAccess,
    private readonly outbox: Outbox,
  ) {}

  /** Carries out a write once the reads and writes before it are done, and queues its answer. It never rejects. */
  apply(write: LibraryWrite): Promise<void> {
    return this.library.run(async () => this.outbox.enqueue(await carryOut(write)));
  }
}

async function carryOut(write: LibraryWrite): Promise<WriteAnswer> {
  const route = Object.prototype.hasOwnProperty.call(ROUTES, write.kind) ? ROUTES[write.kind] : undefined;
  if (!route && write.kind !== "profile") return refused(write, null, `This plugin cannot write a ${write.kind}`);
  try {
    if (!route) return await writeProfile(write);
    return write.localId === null ? await create(route, write) : answerTo(write, await update(route, write, write.localId));
  } catch (error) {
    return refused(write, null, `Decaid did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Writes a Profile. To create one, it first reads the tablet's profiles,
 * hidden and deleted ones included. Unless the tablet holds the Profile
 * already, as when an earlier write's answer was lost, it posts the profile
 * with its metadata, and with its parent if the tablet holds that, since
 * Decaid refuses a parent it lacks. Decaid derives the record's id from the
 * profile, and answers a post of one it holds with that record, unchanged.
 * Either way, it then sets the record's visibility where it differs, as an
 * update of a Profile does alone. Should that fail, the record as it was is
 * the answer, and the server asks for the visibility again. A record Decaid
 * made under another id, as a Decaid hashing profiles otherwise would, is
 * the answer as made: it is not the Profile, and the server records nothing.
 */
async function writeProfile(write: LibraryWrite): Promise<WriteAnswer> {
  const visibility = write.fields.visibility;
  if (write.localId !== null) return answerTo(write, await setVisibility(write.localId, visibility));
  const listed = await request("GET", "/profiles?includeHidden=true");
  if (!listed.ok) return refused(write, listed.status, listed.text);
  const parsedList = parsed(listed.text);
  const records = Array.isArray(parsedList) ? parsedList.filter(isObject) : [];
  let record = records.find((candidate) => candidate.id === write.globalId);
  if (!record) {
    const { parentId, metadata } = write.fields;
    const body = {
      profile: write.fields.profile,
      ...(typeof parentId === "string" && records.some((candidate) => candidate.id === parentId) ? { parentId } : {}),
      ...(isObject(metadata) ? { metadata } : {}),
    };
    const made = await request("POST", "/profiles", body);
    const created = made.ok ? parsed(made.text) : undefined;
    if (!isObject(created) || typeof created.id !== "string") return refused(write, made.status, made.text);
    record = created;
  }
  if (record.id !== write.globalId || typeof visibility !== "string" || record.visibility === visibility) return written(write, record);
  const again = await setVisibility(write.globalId, visibility).catch(() => undefined);
  const updated = again?.ok ? parsed(again.text) : undefined;
  return written(write, isObject(updated) && updated.id === write.globalId ? updated : record);
}

/** Shows or hides a Profile on the tablet, as Decaid's `PUT /profiles/{id}/visibility` does. */
function setVisibility(id: string, visibility: unknown): Promise<Answer> {
  return request("PUT", `/profiles/${encodeURIComponent(id)}/visibility`, { visibility });
}

/**
 * Creates the item's record, unless the tablet already holds it. A record
 * carrying its global id was made by an earlier write whose answer was lost
 * when its connection dropped: it is the answer, and nothing is written. An
 * unarchived record without a global id that is the same item, such as a
 * bean a barista entered with the same roaster and name before the tablet
 * reported it, becomes the item: only the global id is written to it, as the
 * server writes it to a record it links (ADR-0018). Otherwise the record is
 * created, with the global id in its `extras`, and the fields Decaid's
 * create does not take, such as a batch's remaining weight, are written to
 * it after, where they differ from what Decaid made. Should that second
 * write fail or go unanswered, the record as created is the answer, and the
 * server asks for those fields again.
 */
async function create(route: Route, write: LibraryWrite): Promise<WriteAnswer> {
  const listed = await request("GET", route.list);
  if (!listed.ok) return refused(write, listed.status, listed.text);
  const parsedList = parsed(listed.text);
  const records = Array.isArray(parsedList) ? parsedList.filter(isObject) : [];
  const held = records.find((record) => globalIdOf(record) === write.globalId.toLowerCase());
  if (held) return written(write, held);
  const same = records.find((record) => globalIdOf(record) === null && record.archived !== true && route.sameItem(record, write.fields));
  if (same && typeof same.id === "string") return answerTo(write, await update(route, { ...write, fields: {} }, same.id));
  const path = route.create(write.fields);
  if (path === null) return refused(write, null, `A ${write.kind} to create must name what it belongs to`);
  const body: Record<string, unknown> = { ...write.fields, extras: { [GLOBAL_ID_KEY]: write.globalId } };
  for (const field of route.deferred) delete body[field];
  const made = await request("POST", path, body);
  const record = made.ok ? parsed(made.text) : undefined;
  if (!isObject(record) || typeof record.id !== "string") return refused(write, made.status, made.text);
  const later = Object.fromEntries(route.deferred.flatMap((field) => (field in write.fields && write.fields[field] !== (record[field] ?? null) ? [[field, write.fields[field]]] : [])));
  if (Object.keys(later).length === 0) return written(write, record);
  const again = await request("PUT", `${route.records}/${encodeURIComponent(record.id)}`, later).catch(() => undefined);
  const updated = again?.ok ? parsed(again.text) : undefined;
  return written(write, isObject(updated) && typeof updated.id === "string" ? updated : record);
}

/** Updates the record's fields, and writes the global id beside the other keys in its `extras`, which Decaid replaces whole. */
async function update(route: Route, write: LibraryWrite, localId: string): Promise<Answer> {
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
