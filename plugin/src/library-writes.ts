import {
  GLOBAL_ID_KEY,
  type ItemWritten,
  type LibraryWrite,
  MAX_REFUSAL_LENGTH,
  type WriteRefused,
  beanMatchKey,
  globalIdOf,
  sameValue,
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
// An update sets a field only while the record holds what the server expects
// it to (`LibraryWrite.expected`), so a barista's change the tablet has not
// reported yet is kept, and reaches the server in the answer (ADR-0020).

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
   * a bean with the same roaster and name (ADR-0018). Bean Batches and
   * Grinders never are.
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
  grinder: {
    list: "/grinders?includeArchived=true",
    records: "/grinders",
    create: () => "/grinders",
    deferred: ["archived"],
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
    if (write.localId === null) return await create(route, write);
    const updated = await update(route, write, write.localId);
    return answerTo(write, updated.answer, updated.written);
  } catch (error) {
    return refused(write, null, `Decaid did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Writes a Profile. To update one, it reads the tablet's record of it, then
 * sets its title, author and notes, where the write holds them, in its
 * `profile`, which Decaid's `PUT /profiles/{id}` takes whole, and its
 * visibility, each only while the record holds what the server expects. To
 * create one, it first reads the tablet's record of it,
 * hidden or deleted as it may be. Unless the tablet holds one already, as
 * when an earlier write's answer was lost, it posts the profile with its
 * metadata, and with its parent if the tablet holds that, since Decaid
 * refuses a parent it lacks. Decaid derives the record's id from the
 * profile, and answers a post of one it holds with that record, unchanged.
 * Either way, it then sets the record's visibility where it differs, as an
 * update of a Profile does alone. Should that fail, the record as it was is
 * the answer, and the server asks for the visibility again. A record Decaid
 * made under another id, as a Decaid hashing profiles otherwise would, is
 * the answer as made: it is not the Profile, and the server does not record
 * it as one, so the tablet's next report adds it to the Library as a new one.
 */
async function writeProfile(write: LibraryWrite): Promise<WriteAnswer> {
  const visibility = write.fields.visibility;
  if (write.localId !== null) return await updateProfile(write, write.localId);
  const held = await heldProfile(write.globalId);
  if ("refused" in held) return refused(write, held.refused.status, held.refused.text);
  let record = held.record;
  /** The fields this write sets: none on a record the tablet holds already, but its visibility below. */
  const writtenFields: string[] = [];
  if (!record) {
    const { parentId, metadata } = write.fields;
    const parent = typeof parentId === "string" ? await heldProfile(parentId) : undefined;
    if (parent && "refused" in parent) return refused(write, parent.refused.status, parent.refused.text);
    const body = { profile: write.fields.profile, ...(parent?.record ? { parentId } : {}), ...(isObject(metadata) ? { metadata } : {}) };
    const made = await request("POST", "/profiles", body);
    const created = made.ok ? parsed(made.text) : undefined;
    if (!isObject(created) || typeof created.id !== "string") return refused(write, made.status, made.text);
    record = created;
    writtenFields.push(...Object.keys(body));
  }
  if (record.id !== write.globalId || typeof visibility !== "string" || record.visibility === visibility) return written(write, record, writtenFields);
  const again = await setVisibility(write.globalId, visibility).catch(() => undefined);
  const updated = again?.ok ? parsed(again.text) : undefined;
  if (!isObject(updated) || updated.id !== write.globalId) return written(write, record, writtenFields);
  return written(write, updated, [...writtenFields, "visibility"]);
}

/** The fields of a Profile's `profile` the server writes: outside the hash of what the machine executes, so its id stays (ADR-0006). */
const PROFILE_TEXT = ["title", "author", "notes"] as const;

/**
 * Updates the tablet's record of a Profile: its title, author and notes in
 * its `profile`, then its visibility, each only while the record holds what
 * the server expects. Should the visibility fail once the rest is written,
 * the record as it then is is the answer, and the server asks for the
 * visibility again.
 */
async function updateProfile(write: LibraryWrite, id: string): Promise<WriteAnswer> {
  const held = await heldProfile(id);
  if ("refused" in held) return refused(write, held.refused.status, held.refused.text);
  if (!held.record) return refused(write, 404, "Profile not found");
  let record = held.record;
  const fields = settable(write, (field) => (field === "visibility" ? record.visibility : isObject(record.profile) ? record.profile[field] : undefined));
  const writtenFields: string[] = [];
  const text = PROFILE_TEXT.filter((field) => field in fields);
  if (text.length > 0) {
    const profile: Record<string, unknown> = { ...(isObject(record.profile) ? record.profile : {}) };
    // Decaid leaves out a field it holds no value for.
    for (const field of text) {
      if (fields[field] === null) delete profile[field];
      else profile[field] = fields[field];
    }
    const answer = await request("PUT", `/profiles/${encodeURIComponent(id)}`, { profile });
    const updated = answer.ok ? parsed(answer.text) : undefined;
    if (!isObject(updated) || typeof updated.id !== "string") return refused(write, answer.status, answer.text);
    // Under another id, it is not the Profile: the server does not record it as one.
    if (updated.id !== id) return written(write, updated, text);
    record = updated;
    writtenFields.push(...text);
  }
  if ("visibility" in fields) {
    if (record.visibility !== fields.visibility) {
      const answer = await setVisibility(id, fields.visibility).catch((error: unknown) => {
        if (writtenFields.length === 0) throw error;
        return undefined;
      });
      const updated = answer?.ok ? parsed(answer.text) : undefined;
      if (!isObject(updated) || updated.id !== id) {
        return writtenFields.length === 0 ? refused(write, answer?.status ?? null, answer?.text ?? "") : written(write, record, writtenFields);
      }
      record = updated;
    }
    writtenFields.push("visibility");
  }
  return written(write, record, writtenFields);
}

/**
 * The write's fields that the record still holds as the server expects
 * (`LibraryWrite.expected`), read by `current`: one the tablet changed since
 * it last reported the record is left as the tablet has it.
 */
function settable(write: LibraryWrite, current: (field: string) => unknown): Record<string, unknown> {
  const expected = write.expected;
  return Object.fromEntries(
    Object.entries(write.fields).filter(([field]) => !expected || !(field in expected) || sameValue(current(field), expected[field])),
  );
}

/** The tablet's record of the Profile with that id, none if Decaid answers 404, or Decaid's refusal to read it. */
async function heldProfile(id: string): Promise<{ record: Record<string, unknown> | undefined } | { refused: Answer }> {
  const answer = await request("GET", `/profiles/${encodeURIComponent(id)}`);
  if (answer.status === 404) return { record: undefined };
  const record = answer.ok ? parsed(answer.text) : undefined;
  return isObject(record) && record.id === id ? { record } : { refused: answer };
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
  // Nothing is written to a record the tablet holds already, but the global id.
  const held = records.find((record) => globalIdOf(record) === write.globalId.toLowerCase());
  if (held) return written(write, held, []);
  const same = records.find((record) => globalIdOf(record) === null && record.archived !== true && route.sameItem(record, write.fields));
  if (same && typeof same.id === "string") {
    const answer = answerTo(write, (await update(route, { ...write, fields: {} }, same.id)).answer, []);
    return answer.type === "written" ? { ...answer, linked: true } : answer;
  }
  const path = route.create(write.fields);
  if (path === null) return refused(write, null, `A ${write.kind} to create must name what it belongs to`);
  const body: Record<string, unknown> = { ...write.fields, extras: { [GLOBAL_ID_KEY]: write.globalId } };
  for (const field of route.deferred) delete body[field];
  const made = await request("POST", path, body);
  const record = made.ok ? parsed(made.text) : undefined;
  if (!isObject(record) || typeof record.id !== "string") return refused(write, made.status, made.text);
  const later = Object.fromEntries(route.deferred.flatMap((field) => (field in write.fields && write.fields[field] !== (record[field] ?? null) ? [[field, write.fields[field]]] : [])));
  const writtenFields = Object.keys(write.fields);
  if (Object.keys(later).length === 0) return written(write, record, writtenFields);
  const again = await request("PUT", `${route.records}/${encodeURIComponent(record.id)}`, later).catch(() => undefined);
  const updated = again?.ok ? parsed(again.text) : undefined;
  return written(write, isObject(updated) && typeof updated.id === "string" ? updated : record, writtenFields);
}

/**
 * Updates the record's fields that it still holds as the server expects, and
 * writes the global id beside the other keys in its `extras`, which Decaid
 * replaces whole. Answers with what Decaid answered last, and the fields set.
 */
async function update(route: Route, write: LibraryWrite, localId: string): Promise<{ answer: Answer; written: string[] }> {
  const path = `${route.records}/${encodeURIComponent(localId)}`;
  const current = await request("GET", path);
  if (!current.ok) return { answer: current, written: [] };
  const parsedRecord = parsed(current.text);
  const record = isObject(parsedRecord) ? parsedRecord : {};
  const extras = isObject(record.extras) ? record.extras : {};
  const fields = settable(write, (field) => record[field]);
  return { answer: await request("PUT", path, { ...fields, extras: { ...extras, [GLOBAL_ID_KEY]: write.globalId } }), written: Object.keys(fields) };
}

/** The answer to a write that set `writtenFields`, from what Decaid answered last: the record it holds now, or its refusal. */
function answerTo(write: LibraryWrite, answer: Answer, writtenFields: string[]): WriteAnswer {
  const record = answer.ok ? parsed(answer.text) : undefined;
  if (isObject(record) && typeof record.id === "string") return written(write, record, writtenFields);
  return refused(write, answer.status, answer.text);
}

/** A write's answer: the record Decaid holds now, and the fields the write set, beside its global id in `extras`, repeating what the write carried. */
function written(write: LibraryWrite, record: Record<string, unknown>, writtenFields: string[]): ItemWritten {
  return {
    type: "written",
    id: write.id,
    kind: write.kind,
    globalId: write.globalId,
    record,
    updatedAt: utcTime(record.updatedAt),
    writtenFields,
    ...(write.contentDecidedAt === undefined ? {} : { contentDecidedAt: write.contentDecidedAt }),
  };
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
