import {
  ANOTHER_ITEMS_RECORD,
  GLOBAL_ID_KEY,
  type ItemDeleted,
  type ItemWritten,
  type LibraryDelete,
  type LibraryWrite,
  MAX_REFUSAL_LENGTH,
  SETTINGS_KIND,
  SETTINGS_PARTS,
  STEAM_SETTINGS,
  type WriteRefused,
  beanMatchKey,
  globalIdOf,
  sameValue,
  settingsParts,
  steamIsOn,
} from "@decent-sync/protocol";
import { type Answer, readShot, request } from "./decaid.js";
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
// A Location's steam, hot water and rinse settings are written into the
// tablet's Workflow the same way (ADR-0014). A record of an item an Admin
// hard-deleted is deleted the same way too, a Profile's purged, the one
// thing the plugin deletes (ADR-0003).

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

/** What becomes of a delete: the record is gone, or why it is not. */
export type DeleteAnswer = ItemDeleted | WriteRefused;

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
 * Holds back the changes of the tablet's Workflow the plugin sends while it
 * writes the shared settings into it, and sends the latest once released
 * (`MachineEvents`).
 */
export interface WorkflowChanges {
  hold(): void;
  release(): void;
}

/**
 * Carries out the server's writes in the order they arrive, one at a time,
 * between reads of the lists it writes to, and queues each answer in the
 * outbox, behind the reports read before it. So the server takes in each
 * report read before a write before that write's answer, and never reads an
 * item the plugin wrote as deleted from a report that predates it (ADR-0019).
 *
 * Decaid refuses to change the shared settings while no machine is
 * connected (500, `DeviceNotConnectedException`), which `machineMissing` is
 * told of. Decaid sends the plugin the Workflow a write of the shared
 * settings changed (`workflowUpdated`), around when it answers the write. That change
 * is held back until the answer is queued, so the server takes in the answer
 * first and finds the change is the plugin's own write, not the tablet's
 * edit (ADR-0003).
 */
export class LibraryWrites {
  constructor(
    private readonly library: LibraryAccess,
    private readonly outbox: Outbox,
    private readonly workflow: WorkflowChanges,
    /** Told when Decaid refuses a write of the shared settings as no machine is connected. */
    private readonly machineMissing: () => void,
  ) {
    outbox.watch((delivery) => {
      if (delivery.type === "shot" || delivery.type === "shotUpdated") this.noteShot(delivery.shot);
    });
  }

  /**
   * The batch, Grinder and profile records the Shots this plugin queued since
   * it loaded name, as `kind:id`: a few per batch, Grinder and profile used.
   * A profile is named by its steps (`stepsKey`), as a skin sets the
   * Workflow's profile's targets for the Shot, and by the id a skin recorded,
   * if one did.
   */
  private readonly shotsName = new Set<string>();
  /** The Shots still to be sent that `namedByShot` read. */
  private readonly shotsRead = new Set<string>();

  /** Deletes a record of a hard-deleted item once the reads and writes before it are done, and queues its answer. It never rejects. */
  remove(remove: LibraryDelete): Promise<void> {
    return this.library.run(async () => this.outbox.enqueue(await carryOutDelete(remove, (kind, ids) => this.namedByShot(kind, ids))));
  }

  /**
   * Whether a Shot this plugin queued since it loaded, or has yet to read and
   * send, names one of the records, as one pulled while the tablet was
   * offline: the server may have planned the delete before it had the Shot,
   * and so could not keep the record for it. A Shot still to be read, as the
   * outbox reads a new Shot only as it sends it, is read here once.
   */
  private async namedByShot(kind: NamedKind, ids: ReadonlySet<string>): Promise<boolean> {
    const unread = this.outbox.requestedIds("shot").filter((id) => !this.shotsRead.has(id));
    // As during a backfill: reading them all would hold up every write behind this one, so the delete waits for a later connection.
    if (unread.length > MAX_SHOTS_READ) return true;
    for (const id of unread) {
      const shot = await readShot(id);
      this.shotsRead.add(id);
      if (shot) this.noteShot(shot);
    }
    return [...ids].some((id) => this.shotsName.has(`${kind}:${id}`));
  }

  /** Notes the batch, Grinder and profile records a Shot names. */
  private noteShot(shot: Record<string, unknown>): void {
    const workflow = shot.workflow;
    if (!isObject(workflow)) return;
    const steps = stepsKey(workflow.profile);
    if (steps !== null) this.shotsName.add(`profile:${steps}`);
    const context = workflow.context;
    if (!isObject(context)) return;
    if (typeof context.beanBatchId === "string") this.shotsName.add(`beanBatch:${context.beanBatchId}`);
    if (typeof context.grinderId === "string") this.shotsName.add(`grinder:${context.grinderId}`);
    const skin = isObject(context.extras) ? context.extras.workflowSkin : undefined;
    if (isObject(skin) && typeof skin.selectedProfileId === "string") this.shotsName.add(`profile:${skin.selectedProfileId}`);
  }

  /** Carries out a write once the reads and writes before it are done, and queues its answer. It never rejects. */
  apply(write: LibraryWrite): Promise<void> {
    if (write.kind !== SETTINGS_KIND) return this.library.run(async () => this.outbox.enqueue(await carryOut(write)));
    return this.library.run(async () => {
      this.workflow.hold();
      try {
        const answer = await carryOut(write);
        if (answer.type === "writeRefused" && answer.status === 500 && answer.error.includes("DeviceNotConnectedException")) this.machineMissing();
        this.outbox.enqueue(answer);
      } finally {
        this.workflow.release();
      }
    });
  }
}

/** The kinds of record a Shot names. */
type NamedKind = "beanBatch" | "grinder" | "profile";

/**
 * Deletes the tablet's record of a hard-deleted item (`LibraryDelete`),
 * unless it carries another item's global id: one the server mapped may
 * carry none yet, as when the write of its global id was still due. A record
 * already gone is deleted. A bean's batches, archived ones included, are
 * deleted first, as DYE2 does (dye2:dye2-plugin/src/utils/bean-delete.ts),
 * since Decaid refuses to delete a bean that has any. A batch or Grinder
 * record, or a bean one of whose batches is, that a Shot this plugin queued
 * since it loaded, or has yet to read and send, names (`namedByShot`) is not deleted, nor is
 * anything while more Shots than MAX_SHOTS_READ are still to be read: the server keeps such
 * a record once it has the Shot, and otherwise asks again on the tablet's
 * next connection.
 */
async function carryOutDelete(
  remove: LibraryDelete,
  namedByShot: (kind: NamedKind, ids: ReadonlySet<string>) => Promise<boolean>,
): Promise<DeleteAnswer> {
  if (remove.kind === "profile") return purgeProfile(remove, namedByShot);
  const route = Object.prototype.hasOwnProperty.call(ROUTES, remove.kind) ? ROUTES[remove.kind] : undefined;
  if (!route) return refused(remove, null, `This plugin cannot delete a ${remove.kind}`);
  try {
    const path = `${route.records}/${encodeURIComponent(remove.localId)}`;
    const current = await request("GET", path);
    if (current.status === 404) return deleted(remove);
    const record = current.ok ? parsed(current.text) : undefined;
    if (!isObject(record)) return refused(remove, current.status, current.text);
    const carried = globalIdOf(record);
    if (carried !== null && carried !== remove.globalId.toLowerCase()) return refused(remove, null, ANOTHER_ITEMS_RECORD);
    if ((remove.kind === "beanBatch" || remove.kind === "grinder") && (await namedByShot(remove.kind, new Set([remove.localId])))) {
      return refused(remove, null, SHOT_NOT_SENT);
    }
    if (remove.kind === "bean") {
      const listed = await request("GET", `${path}/batches?includeArchived=true`);
      const batches = listed.ok ? parsed(listed.text) : undefined;
      if (!Array.isArray(batches)) return refused(remove, listed.status, listed.text);
      const ids = new Set(batches.filter(isObject).flatMap((batch) => (typeof batch.id === "string" ? [batch.id] : [])));
      if (await namedByShot("beanBatch", ids)) return refused(remove, null, SHOT_NOT_SENT);
      for (const batch of batches.filter(isObject)) {
        if (typeof batch.id !== "string") continue;
        const gone = await request("DELETE", `/bean-batches/${encodeURIComponent(batch.id)}`);
        if (!gone.ok && gone.status !== 404) return refused(remove, gone.status, gone.text);
      }
    }
    const answer = await request("DELETE", path);
    return answer.ok || answer.status === 404 ? deleted(remove) : refused(remove, answer.status, answer.text);
  } catch (error) {
    return refused(remove, null, `Decaid did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Purges the tablet's record of a hard-deleted Profile, as Decaid's delete
 * only marks a user's profile deleted (`DELETE /profiles/{id}/purge`),
 * unless a Shot this plugin queued since it loaded, or has yet to read and
 * send, used it (`namedByShot`), as `carryOutDelete` keeps a batch's record.
 * Its record carries no global id: its id is Decaid's, the same on every
 * tablet. A record already gone is deleted. Decaid refuses to purge one of
 * its bundled profiles, which the server never deletes.
 */
async function purgeProfile(remove: LibraryDelete, namedByShot: (kind: NamedKind, ids: ReadonlySet<string>) => Promise<boolean>): Promise<DeleteAnswer> {
  try {
    const path = `/profiles/${encodeURIComponent(remove.localId)}`;
    const current = await request("GET", path);
    if (current.status === 404) return deleted(remove);
    const record = current.ok ? parsed(current.text) : undefined;
    if (!isObject(record)) return refused(remove, current.status, current.text);
    const steps = stepsKey(record.profile);
    if (await namedByShot("profile", new Set(steps === null ? [remove.localId] : [remove.localId, steps]))) return refused(remove, null, SHOT_NOT_SENT);
    const answer = await request("DELETE", `${path}/purge`);
    // Decaid answers a purge of a profile it no longer holds, as one replaced since it was read, with 400.
    return answer.ok || (answer.status === 400 && answer.text.includes("Profile not found")) ? deleted(remove) : refused(remove, answer.status, answer.text);
  } catch (error) {
    return refused(remove, null, `Decaid did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * A profile's steps, as text that is the same for the same steps, its keys
 * sorted, as a Shot's Workflow and a profile's record hold them alike; null
 * if it has none. Its other fields are not compared, as the server does not
 * compare them: a skin sets the Workflow's profile's targets for the Shot.
 */
function stepsKey(profile: unknown): string | null {
  return isObject(profile) && Array.isArray(profile.steps) ? stableJson(profile.steps) : null;
}

/** JSON with every object's keys sorted. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

/** Why a delete is refused while a Shot this plugin queued, or has yet to send, may name its record or one of its batches. */
const SHOT_NOT_SENT = "A Shot this plugin has queued or has yet to send names the record or one of its batches, or too many are still to be read";

/** The most Shots still to be read that a delete reads to see whether they name its record. */
const MAX_SHOTS_READ = 20;

function deleted(remove: LibraryDelete): ItemDeleted {
  return { type: "deleted", id: remove.id, kind: remove.kind, globalId: remove.globalId, localId: remove.localId };
}

async function carryOut(write: LibraryWrite): Promise<WriteAnswer> {
  const route = Object.prototype.hasOwnProperty.call(ROUTES, write.kind) ? ROUTES[write.kind] : undefined;
  if (!route && write.kind !== "profile" && write.kind !== SETTINGS_KIND) return refused(write, null, `This plugin cannot write a ${write.kind}`);
  try {
    if (write.kind === SETTINGS_KIND) return await writeSettings(write);
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

/**
 * Writes a Location's shared settings into the tablet's Workflow (ADR-0014):
 * reads the Workflow, then sets, through `PUT /workflow`, which Decaid merges
 * into it, the fields it still holds as the server expects, its steam
 * settings only while it keeps steam on: a barista may have turned steam off
 * since the tablet last reported, which stays on this Machine. The answer is
 * the Workflow's steam, hot water and rinse parts as Decaid returned them,
 * or as read when nothing was left to set, timed now, as a Workflow carries
 * no time. Decaid refuses to change them while no machine is connected.
 */
async function writeSettings(write: LibraryWrite): Promise<WriteAnswer> {
  const current = await request("GET", "/workflow");
  const workflow = current.ok ? parsed(current.text) : undefined;
  if (!isObject(workflow)) return refused(write, current.status, current.text);
  const held = (field: string) => {
    const [part, name] = field.split(".") as [string, string];
    const values = workflow[part];
    return isObject(values) ? values[name] : undefined;
  };
  const steamOn = steamIsOn({ "steamSettings.targetTemperature": held("steamSettings.targetTemperature") });
  const fields = Object.fromEntries(
    Object.entries(settable(write, held)).filter(([field]) => steamOn || !(STEAM_SETTINGS as readonly string[]).includes(field)),
  );
  if (Object.keys(fields).length === 0) return written(write, workflowSettings(workflow), [], new Date().toISOString());
  const answer = await request("PUT", "/workflow", settingsParts(fields));
  const updated = answer.ok ? parsed(answer.text) : undefined;
  if (!isObject(updated)) return refused(write, answer.status, answer.text);
  return written(write, workflowSettings(updated), Object.keys(fields), new Date().toISOString());
}

/** The steam, hot water and rinse parts of a Workflow, as Decaid holds them. */
function workflowSettings(workflow: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(SETTINGS_PARTS.flatMap((part) => (part in workflow ? [[part, workflow[part]]] : [])));
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

/**
 * A write's answer: the record Decaid holds now, and the fields the write
 * set, beside its global id in `extras`, repeating what the write carried.
 * Timed by the record's `updatedAt`, or `at` for settings, which carry none.
 */
function written(write: LibraryWrite, record: Record<string, unknown>, writtenFields: string[], at?: string): ItemWritten {
  return {
    type: "written",
    id: write.id,
    kind: write.kind,
    globalId: write.globalId,
    record,
    updatedAt: at ?? utcTime(record.updatedAt),
    writtenFields,
    ...(write.contentDecidedAt === undefined ? {} : { contentDecidedAt: write.contentDecidedAt }),
  };
}

function refused(write: LibraryWrite | LibraryDelete, status: number | null, error: string): WriteRefused {
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
