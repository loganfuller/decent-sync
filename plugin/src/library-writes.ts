import {
  ANOTHER_ITEMS_RECORD,
  RECORD_CHANGED,
  type CollectionName,
  DYE2_NAMESPACE,
  LIBRARY_ITEM_KINDS,
  BREW_TEMPERATURE_FIELD,
  DYE2_SELECTION_FIELD,
  LOADED_RECIPE_KIND,
  LOADED_RECIPE_PARTS,
  MACHINE_SETTING_PARTS,
  RECIPE_SETTINGS,
  SHOTS_STILL_TO_READ,
  GLOBAL_ID_KEY,
  type ItemDeleted,
  type ItemLeftOut,
  type ItemRemoved,
  type ItemWritten,
  type LeaveOut,
  type LibraryDelete,
  type LibraryKind,
  type LibraryRemove,
  type LibraryWrite,
  type ListUnrecognised,
  MAX_REFUSAL_LENGTH,
  WORKFLOW_CLEARED,
  WORKFLOW_KIND,
  type WriteRefused,
  type WrittenKind,
  beanMatchKey,
  childKinds,
  dye2GlobalIdOf,
  dye2Key,
  dye2Records,
  equipmentMatchKey,
  globalIdOf,
  isLibraryKind,
  isSlotId,
  profileAtBrewTemperature,
  sameValue,
  steamOff,
  workflowPatch,
  workflowValueAt,
} from "@decent-sync/protocol";
import { type Answer, readShot, request } from "./decaid.js";
import { utcTime } from "./local-time.js";
import type { WorkflowChanges } from "./machine-events.js";
import type { Outbox } from "./outbox.js";
import { clearsSelection, stepsKey } from "./loaded-recipe-rules.js";
import { type LoadedRecipeWrites, machineMissing } from "./loaded-recipes.js";
import type { Skins } from "./skins.js";
import { keepStreamlineSteamTemperature } from "./streamline.js";
import { randomUuid } from "./tablet-id.js";

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
// The clearing of the Workflow's grinder, batch and Basket as its Machine
// joins a Location that does not offer them is written into the tablet's
// Workflow the same way (ADR-0008). A record of an item an Admin
// hard-deleted is deleted the same way too, a Profile's purged, the one
// thing the plugin deletes (ADR-0003), and a record the Library leaves out
// as its Machine joins a Location is archived or hidden (ADR-0018).
//
// Baskets, Tools and Recipes live in DYE2's lists in Decaid's store, each
// kept whole under one key (ADR-0005): the plugin reads the list, changes one
// record and posts the list back, as DYE2 and Streamline do, so records
// others wrote survive. A key never written is an empty list. A list in a
// shape the plugin does not recognise is never written (`dye2Records`), and
// the answer says so. A record carries its global id in a top-level field of
// its own, which DYE2 keeps when it saves. DYE2 can neither archive nor hide
// a record, so one its Location stops offering is removed from the list. A
// recipe's id is its Recipe Slot, and the plugin keeps the list in slot
// order whenever it writes it. Once Decaid takes a post of DYE2's recipes,
// or a write into the Workflow that changes it, the skins listening for
// changes are told (`ListPosted`, skins.ts).

/** Where a kind's records live in Decaid's API, for the kinds whose records the plugin writes as they are (`recordWriter`). */
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
  /** Whether a Shot names a record of the kind by its id, so one a Shot this plugin has yet to send names is not deleted (`namedByShot`). */
  namedByShots: boolean;
  /**
   * For a kind whose records are made under another's (`parentKind`), where
   * those under the record at `parentPath` are listed, archived ones
   * included: they are deleted before it, as Decaid refuses to delete a bean
   * that has batches.
   */
  listUnder?(parentPath: string): string;
}

/**
 * How the plugin carries out the server's changes of one kind on the
 * tablet, each kind described once (`WRITERS`, and `LIBRARY.md`, Adding a
 * Library kind).
 */
interface KindWriter {
  /** Carries out a write, and answers it. It may throw, as when Decaid does not answer. */
  write(write: LibraryWrite, log: (message: string) => void, posted: ListPosted): Promise<WriteAnswer>;
  /**
   * Whether its writes change the tablet's Workflow: the change of the
   * Workflow a write causes is held back until its answer is queued, so the
   * server takes it as the plugin's own write rather than the tablet's edit.
   */
  changesWorkflow?: true;
}

/** How the plugin carries out the server's changes of a kind of Library item, whose records the tablet lists. */
interface LibraryKindWriter extends KindWriter {
  /** Where Decaid's API lists the kind's records, archived or hidden ones included, which the plugin reports (`CollectionCapture`). */
  list: string;
  /** Deletes the tablet's record of a hard-deleted item (`carryOutDelete`), and answers it. It may throw, as `write` may. */
  remove(remove: LibraryDelete, namedByShot: NamedByShot, posted: ListPosted): Promise<DeleteAnswer>;
  /** Sets aside a record the Library leaves out (`setAside`): what to answer, or that its list is in a shape not recognised. It may throw, as `write` may. */
  setAside(leave: LeaveOut, posted: ListPosted): Promise<ItemLeftOut["outcome"] | Answer | "unrecognised">;
  /** For a kind DYE2 keeps, removes the tablet's record from its list, as its Location no longer offers the item (`LibraryRemove`). It may throw, as `write` may. */
  drop?(remove: LibraryRemove, posted: ListPosted): Promise<RemoveAnswer>;
}

/**
 * Told each time Decaid takes a post of one of DYE2's lists, under its key,
 * and never when nothing was posted. It must not throw. It carries the
 * Loaded Recipe's part in the writes (`LoadedRecipeWrites`), where there is
 * one, and what is told of each write into the Workflow Decaid takes.
 */
export interface ListPosted {
  (key: Dye2Key): void;
  loaded?: LoadedRecipeWrites;
  /** Told of each `PUT /workflow` Decaid took, with the Workflow read before it and the one Decaid answered (`Skins.workflowWritten`). It must not throw. */
  workflowWritten: Skins["workflowWritten"];
}

/** Whether a Shot this plugin queued since it loaded, or has yet to send, names one of a kind's records (`LibraryWrites.namedByShot`). */
type NamedByShot = (kind: LibraryKind, ids: ReadonlySet<string>) => Promise<boolean | "tooMany">;

/** Where the kinds whose records the plugin writes as they are live in Decaid's API (v0.9.0, rest_v1.yml). */
const ROUTES = {
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
    namedByShots: false,
  },
  beanBatch: {
    list: "/bean-batches?includeArchived=true",
    records: "/bean-batches",
    // Under the tablet's record of its bean, which `beanId` names; the path decides it, and Decaid ignores the field.
    create: (fields) => (typeof fields.beanId === "string" && fields.beanId !== "" ? `/beans/${encodeURIComponent(fields.beanId)}/batches` : null),
    deferred: ["archived", "weightRemaining"],
    sameItem: () => false,
    namedByShots: true,
    listUnder: (parentPath) => `${parentPath}/batches?includeArchived=true`,
  },
  grinder: {
    list: "/grinders?includeArchived=true",
    records: "/grinders",
    create: () => "/grinders",
    deferred: ["archived"],
    sameItem: () => false,
    namedByShots: true,
  },
} satisfies Readonly<Record<string, Route>>;

/**
 * Each kind the server writes, described once: the Library's kinds
 * (`LIBRARY_ITEM_KINDS`), the clearing of a Workflow's grinder, batch and
 * Basket, and a Workflow's Loaded Recipe.
 */
const WRITERS: { readonly [K in WrittenKind]: K extends LibraryKind ? LibraryKindWriter : KindWriter } = {
  bean: recordWriter("bean", ROUTES.bean),
  beanBatch: recordWriter("beanBatch", ROUTES.beanBatch),
  grinder: recordWriter("grinder", ROUTES.grinder),
  profile: {
    list: "/profiles?includeHidden=true",
    write: writeProfile,
    remove: purgeProfile,
    setAside: (leave) => readThen("/profiles", leave, hideProfile),
  },
  basket: dye2Writer("baskets"),
  tool: dye2Writer("equipment"),
  recipe: dye2Writer("recipes"),
  [WORKFLOW_KIND]: { write: clearWorkflow, changesWorkflow: true },
  [LOADED_RECIPE_KIND]: { write: writeLoadedRecipe, changesWorkflow: true },
};

/** How the plugin carries out the server's changes of a kind, or undefined for a kind it does not know. */
function writerOf(kind: string): KindWriter | undefined {
  return Object.prototype.hasOwnProperty.call(WRITERS, kind) ? WRITERS[kind as WrittenKind] : undefined;
}

/** How the plugin carries out the server's changes of a kind of Library item, or undefined for a kind it does not know. */
function libraryWriterOf(kind: string): LibraryKindWriter | undefined {
  return isLibraryKind(kind) ? WRITERS[kind] : undefined;
}

/** Where a kind written through a route (`ROUTES`) lives in Decaid's API, or undefined for one that is not. */
function routeOf(kind: string): Route | undefined {
  return Object.prototype.hasOwnProperty.call(ROUTES, kind) ? ROUTES[kind as keyof typeof ROUTES] : undefined;
}

/** Where Decaid's API lists a kind's records, archived or hidden ones included. */
export function libraryListPath(kind: LibraryKind): string {
  return WRITERS[kind].list;
}

/** A kind whose records the plugin writes as they are, through its route. */
function recordWriter(kind: LibraryKind, route: Route): LibraryKindWriter {
  return {
    list: route.list,
    write: async (write) => {
      if (write.localId === null) return await create(route, write);
      const updated = await update(route, write, write.localId);
      return answerTo(write, updated.answer, updated.written);
    },
    remove: (remove, namedByShot) => deleteRecord(kind, route, remove, namedByShot),
    setAside: (leave) => readThen(route.records, leave, archiveRecord),
  };
}

/** What becomes of a write: the record Decaid returned, or why it did not write one. */
export type WriteAnswer = ItemWritten | WriteRefused | ListUnrecognised;

/** What becomes of a delete: the record is gone, or why it is not. */
export type DeleteAnswer = ItemDeleted | WriteRefused | ListUnrecognised;

/** What becomes of a removal from one of DYE2's lists: the record is gone, or why it is not. */
export type RemoveAnswer = ItemRemoved | WriteRefused | ListUnrecognised;

/**
 * Reads of the tablet's Library lists and writes to them, one at a time, in
 * the order they are asked for. A report of a list then either holds a
 * write's record or was read, and queued to be sent, before the write began
 * (`LibraryWrites`).
 */
export class LibraryAccess {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners: ((list: CollectionName) => void)[] = [];

  /** Runs `work` once everything asked for before it is done, and resolves or rejects as it does. */
  run<T>(work: () => Promise<T>): Promise<T> {
    const done = this.queue.then(work);
    this.queue = done.catch(() => {});
    return done;
  }

  /** Tells `listener` of each list the plugin wrote, as it is written (`wrote`). */
  onWrite(listener: (list: CollectionName) => void): void {
    this.listeners.push(listener);
  }

  /**
   * The plugin wrote one of DYE2's lists, whose reports are compared by
   * content: its next read is reported whatever it holds, so one another app
   * rewrote at the same moment, losing the write, is reported though it reads
   * as it was last reported (ADR-0005).
   */
  wrote(list: CollectionName): void {
    for (const listener of this.listeners) listener(list);
  }
}

/**
 * Carries out the server's writes in the order they arrive, one at a time,
 * between reads of the lists it writes to, and queues each answer in the
 * outbox, behind the reports read before it. So the server takes in each
 * report read before a write before that write's answer, and never reads an
 * item the plugin wrote as deleted from a report that predates it (ADR-0019).
 *
 * Decaid refuses to change a Loaded Recipe's hot water while no machine is
 * connected (500, `DeviceNotConnectedException`), which `machineMissing` is
 * told of. Decaid sends the plugin the Workflow a write into it changed
 * (`workflowUpdated`), around when it answers the write. That change is
 * held back until the answer is queued, so the server takes in the answer
 * first and finds the change is the plugin's own write, not the tablet's
 * edit (ADR-0003).
 */
export class LibraryWrites {
  /** Told of each post of one of DYE2's lists and each write into the Workflow Decaid took, carrying the Loaded Recipe's part in them. */
  private readonly posted: ListPosted;

  constructor(
    private readonly library: LibraryAccess,
    private readonly outbox: Outbox,
    private readonly workflow: WorkflowChanges,
    /** The Machine's Loaded Recipe, which the server's writes of it, and moves of it to another slot, keep in step with DYE2's selection. */
    loaded: LoadedRecipeWrites,
    /** Told when Decaid refuses a write into the Workflow as no machine is connected. */
    private readonly machineMissing: () => void,
    private readonly log: (message: string) => void,
    /** Told of each post of one of DYE2's lists and each write into the Workflow Decaid took. */
    skins: Skins,
  ) {
    this.posted = Object.assign((key: Dye2Key) => skins.listPosted(key), { loaded, workflowWritten: skins.workflowWritten });
    outbox.watch((delivery) => {
      if (delivery.type === "shot" || delivery.type === "shotUpdated") this.noteShot(delivery.shotId, delivery.shot);
    });
  }

  /**
   * The batch, Grinder, profile, basket and tool records each Shot this
   * plugin queued since it loaded names, by its id, as `kind:id`, as its
   * latest record names them, with that record's edit time (`editOrder`):
   * a few per Shot. A profile is named by its steps (`stepsKey`), as a skin
   * sets the Workflow's profile's targets for the Shot, and by the id a skin
   * recorded, if one did.
   */
  private readonly shotsName = new Map<string, { version: string; names: Set<string> }>();
  /** The Shots still to be sent that `namedByShot` read. */
  private readonly shotsRead = new Set<string>();

  /** Deletes a record of a hard-deleted item once the reads and writes before it are done, and queues its answer. It never rejects. */
  remove(remove: LibraryDelete): Promise<void> {
    return this.library.run(async () => this.outbox.enqueue(this.wrote(remove.kind, await carryOutDelete(remove, (kind, ids) => this.namedByShot(kind, ids), this.posted))));
  }

  /**
   * Whether a Shot this plugin queued since it loaded, or has yet to read and
   * send, names one of the records, as one pulled while the tablet was
   * offline: the server may have planned the delete before it had the Shot,
   * and so could not keep the record for it. A Shot still to be read, as the
   * outbox reads a new Shot only as it sends it, is read here once.
   */
  private async namedByShot(kind: LibraryKind, ids: ReadonlySet<string>): Promise<boolean | "tooMany"> {
    const unread = this.outbox.requestedIds("shot").filter((id) => !this.shotsRead.has(id));
    // As during a backfill: reading them all would hold up every write behind this one, so the server asks again later.
    if (unread.length > MAX_SHOTS_READ) return "tooMany";
    for (const id of unread) {
      const shot = await readShot(id);
      this.shotsRead.add(id);
      if (shot) this.noteShot(id, shot);
    }
    const named = [...ids].map((id) => `${kind}:${id}`);
    return [...this.shotsName.values()].some(({ names }) => named.some((name) => names.has(name)));
  }

  /**
   * Notes the batch, Grinder, profile, basket and tool records a Shot names,
   * in place of what an older record of it named, as the server keeps a
   * Shot's latest metadata by its edit time: so an edit naming another
   * basket, say, no longer keeps the one it named before, and a record read
   * before that edit but noted after it, as one whose read was slow, changes
   * nothing. A record of the same edit time adds what it names, as keeping
   * more records is the safe side.
   */
  private noteShot(id: string, shot: Record<string, unknown>): void {
    const version = editOrder(shot.updatedAt);
    const noted = this.shotsName.get(id);
    if (noted && version < noted.version) return;
    const names = noted && version === noted.version ? noted.names : new Set<string>();
    this.shotsName.set(id, { version, names });
    const workflow = isObject(shot.workflow) ? shot.workflow : {};
    const steps = stepsKey(isObject(workflow.profile) ? workflow.profile.steps : undefined);
    if (steps !== null) names.add(`profile:${steps}`);
    const context = isObject(workflow.context) ? workflow.context : {};
    const extras = isObject(context.extras) ? context.extras : {};
    if (typeof context.beanBatchId === "string") names.add(`beanBatch:${context.beanBatchId}`);
    if (typeof context.grinderId === "string") names.add(`grinder:${context.grinderId}`);
    if (isObject(extras.workflowSkin) && typeof extras.workflowSkin.selectedProfileId === "string") names.add(`profile:${extras.workflowSkin.selectedProfileId}`);
    // DYE2's Edit Shot page records the basket and tools in the annotations' extras, its basket over the Workflow's, as
    // the server reads them (shots/extraction.ts).
    const edited = isObject(shot.annotations) && isObject(shot.annotations.extras) ? shot.annotations.extras : {};
    const basket = edited.basketId != null || edited.basketName != null ? edited.basketId : extras.basketId;
    if (typeof basket === "string") names.add(`basket:${basket}`);
    for (const recorded of [edited, extras]) {
      const tools = Array.isArray(recorded.equipmentIds) ? recorded.equipmentIds : [recorded.equipmentId];
      for (const id of tools) if (typeof id === "string") names.add(`tool:${id}`);
    }
  }

  /** Removes a record from one of DYE2's lists once the reads and writes before it are done, and queues its answer. It never rejects. */
  drop(remove: LibraryRemove): Promise<void> {
    return this.library.run(async () => this.outbox.enqueue(this.wrote(remove.kind, await carryOutRemove(remove, this.posted))));
  }

  /** Has the next read of the kind's list reported whatever it holds, if it is one of DYE2's, which the plugin may just have written; returns the answer. */
  private wrote<T>(kind: string, answer: T): T {
    if (isLibraryKind(kind) && dye2Key(kind) !== undefined) this.library.wrote(LIBRARY_ITEM_KINDS[kind].list);
    return answer;
  }

  /** Sets aside a record the Library leaves out once the reads and writes before it are done, and queues its answer. It never rejects. */
  leaveOut(leave: LeaveOut): Promise<void> {
    return this.library.run(async () => this.outbox.enqueue(this.wrote(leave.kind, await setAside(leave, this.posted))));
  }

  /** Carries out a write once the reads and writes before it are done, and queues its answer. It never rejects. */
  apply(write: LibraryWrite): Promise<void> {
    if (!writerOf(write.kind)?.changesWorkflow) {
      return this.library.run(async () => this.outbox.enqueue(this.wrote(write.kind, await carryOut(write, this.log, this.posted))));
    }
    return this.library.run(async () => {
      this.workflow.hold();
      try {
        const answer = await carryOut(write, this.log, this.posted);
        if (answer.type === "writeRefused" && answer.status === 500 && answer.error.includes("DeviceNotConnectedException")) this.machineMissing();
        this.outbox.enqueue(answer);
      } finally {
        this.workflow.release();
      }
    });
  }
}

/**
 * Removes the tablet's record from one of DYE2's lists (`LibraryRemove`), as
 * its kind does (`LibraryKindWriter.drop`).
 */
async function carryOutRemove(remove: LibraryRemove, posted: ListPosted): Promise<RemoveAnswer> {
  const drop = libraryWriterOf(remove.kind)?.drop;
  if (!drop) return refused(remove, null, `This plugin cannot remove a ${remove.kind}`);
  try {
    return await drop(remove, posted);
  } catch (error) {
    return refused(remove, null, `Decaid did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Deletes the tablet's record of a hard-deleted item (`LibraryDelete`), as
 * its kind deletes one (`LibraryKindWriter.remove`). A record already gone is
 * deleted. Nothing is deleted while more Shots than MAX_SHOTS_READ are still
 * to be read (SHOTS_STILL_TO_READ), as during a backfill, which the server
 * asks again for soon, on the same connection.
 */
async function carryOutDelete(remove: LibraryDelete, namedByShot: NamedByShot, posted: ListPosted): Promise<DeleteAnswer> {
  const writer = libraryWriterOf(remove.kind);
  if (!writer) return refused(remove, null, `This plugin cannot delete a ${remove.kind}`);
  try {
    return await writer.remove(remove, namedByShot, posted);
  } catch (error) {
    return refused(remove, null, `Decaid did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Deletes the tablet's record of a hard-deleted item of a kind written
 * through its route, unless it carries another item's global id: one the
 * server mapped may carry none yet, as when the write of its global id was
 * still due. A record's records of the kinds made under it, archived ones
 * included, such as a bean's batches, are deleted first, as DYE2 does
 * (dye2:dye2-plugin/src/utils/bean-delete.ts), since Decaid refuses to
 * delete a bean that has any. A record, or one of those under it, that a
 * Shot this plugin queued since it loaded, or has yet to read and send,
 * names (`namedByShot`) is not deleted: the server keeps such a record once
 * it has the Shot, and otherwise asks again on the tablet's next connection.
 */
async function deleteRecord(kind: LibraryKind, route: Route, remove: LibraryDelete, namedByShot: NamedByShot): Promise<DeleteAnswer> {
  const path = `${route.records}/${encodeURIComponent(remove.localId)}`;
  const current = await request("GET", path);
  if (current.status === 404) return deleted(remove);
  const record = current.ok ? parsed(current.text) : undefined;
  if (!isObject(record)) return refused(remove, current.status, current.text);
  const carried = globalIdOf(record);
  if (carried !== null && carried !== remove.globalId.toLowerCase()) return refused(remove, null, ANOTHER_ITEMS_RECORD);
  if (route.namedByShots) {
    const named = await namedByShot(kind, new Set([remove.localId]));
    if (named !== false) return refused(remove, null, named === "tooMany" ? SHOTS_STILL_TO_READ : SHOT_NOT_SENT);
  }
  for (const child of childKinds(kind)) {
    const under = routeOf(child)?.listUnder;
    if (!under) return refused(remove, null, `This plugin cannot delete the ${child} records under a ${kind}`);
    const listed = await request("GET", under(path));
    const children = listed.ok ? parsed(listed.text) : undefined;
    if (!Array.isArray(children)) return refused(remove, listed.status, listed.text);
    const ids = new Set(children.filter(isObject).flatMap((record) => (typeof record.id === "string" ? [record.id] : [])));
    const named = await namedByShot(child, ids);
    if (named !== false) return refused(remove, null, named === "tooMany" ? SHOTS_STILL_TO_READ : SHOT_NOT_SENT);
    for (const id of ids) {
      const gone = await request("DELETE", `${routeOf(child)!.records}/${encodeURIComponent(id)}`);
      if (!gone.ok && gone.status !== 404) return refused(remove, gone.status, gone.text);
    }
  }
  const answer = await request("DELETE", path);
  return answer.ok || answer.status === 404 ? deleted(remove) : refused(remove, answer.status, answer.text);
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
async function purgeProfile(remove: LibraryDelete, namedByShot: NamedByShot): Promise<DeleteAnswer> {
  const path = `/profiles/${encodeURIComponent(remove.localId)}`;
  const current = await request("GET", path);
  if (current.status === 404) return deleted(remove);
  const record = current.ok ? parsed(current.text) : undefined;
  if (!isObject(record)) return refused(remove, current.status, current.text);
  const steps = stepsKey(isObject(record.profile) ? record.profile.steps : undefined);
  const named = await namedByShot("profile", new Set(steps === null ? [remove.localId] : [remove.localId, steps]));
  if (named !== false) return refused(remove, null, named === "tooMany" ? SHOTS_STILL_TO_READ : SHOT_NOT_SENT);
  const answer = await request("DELETE", `${path}/purge`);
  // Decaid answers a purge of a profile it no longer holds, as one replaced since it was read, with 400.
  return answer.ok || (answer.status === 400 && answer.text.includes("Profile not found")) ? deleted(remove) : refused(remove, answer.status, answer.text);
}

/**
 * A Shot's edit time, `updatedAt` in UTC as Decaid writes it, as text that
 * sorts in time order, to the microsecond and beyond, as the server compares
 * them; empty, sorting first, for a record without one, which the server
 * ignores.
 */
function editOrder(updatedAt: unknown): string {
  const parts = typeof updatedAt === "string" ? /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?Z$/.exec(updatedAt) : null;
  return parts ? `${parts[1]}.${(parts[2] ?? "").padEnd(12, "0")}` : "";
}

/** Why a delete is refused while a Shot this plugin queued, or has yet to send, may name its record or one of its batches. */
const SHOT_NOT_SENT = "A Shot this plugin has queued or has yet to send names the record or one of its batches";

/** The most Shots still to be read that a delete reads to see whether they name its record. */
const MAX_SHOTS_READ = 20;

/**
 * Sets aside the tablet's record the Library leaves out (`LeaveOut`), as its
 * kind does (`LibraryKindWriter.setAside`): archives a bean, bean batch or
 * grinder, or hides a profile, unless it is so already. A record already
 * gone is `gone`.
 */
async function setAside(leave: LeaveOut, posted: ListPosted): Promise<ItemLeftOut | ListUnrecognised> {
  const answer = (outcome: ItemLeftOut["outcome"], status?: number | null, error?: string): ItemLeftOut => ({
    type: "leftOut",
    id: leave.id,
    kind: leave.kind,
    localId: leave.localId,
    outcome,
    ...(outcome === "refused" ? { status: status ?? null, error: (error ?? "").slice(0, MAX_REFUSAL_LENGTH) } : {}),
  });
  const writer = libraryWriterOf(leave.kind);
  if (!writer) return answer("refused", null, `This plugin cannot set aside a ${leave.kind}`);
  try {
    const outcome = await writer.setAside(leave, posted);
    if (outcome === "unrecognised") return unrecognised(leave);
    return typeof outcome === "string" ? answer(outcome) : answer("refused", outcome.status, outcome.text);
  } catch (error) {
    return answer("refused", null, `Decaid did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Reads the tablet's record the Library leaves out, under `records`, and
 * sets it aside as `setAsideRecord` does: `gone` if Decaid holds no such
 * record.
 */
async function readThen(
  records: string,
  leave: LeaveOut,
  setAsideRecord: (leave: LeaveOut, record: Record<string, unknown>, path: string) => Promise<ItemLeftOut["outcome"] | Answer>,
): Promise<ItemLeftOut["outcome"] | Answer> {
  const path = `${records}/${encodeURIComponent(leave.localId)}`;
  const current = await request("GET", path);
  if (current.status === 404) return "gone";
  const record = current.ok ? parsed(current.text) : undefined;
  if (!isObject(record)) return current;
  return setAsideRecord(leave, record, path);
}

/**
 * Archives a record the Library leaves out, of a kind written through its
 * route. Only a record carrying no global id: one that carries one is a
 * Library item's now (`taken`), as when a write linked a bean of the same
 * roaster and name to it, and is left as it is. Nothing else of the record
 * changes: its `extras` are written back as read, since Decaid replaces them
 * whole.
 */
async function archiveRecord(_leave: LeaveOut, record: Record<string, unknown>, path: string): Promise<ItemLeftOut["outcome"] | Answer> {
  if (globalIdOf(record) !== null) return "taken";
  if (record.archived === true) return "setAside";
  const archived = await request("PUT", path, { archived: true, extras: isObject(record.extras) ? record.extras : {} });
  const updated = archived.ok ? parsed(archived.text) : undefined;
  return isObject(updated) && updated.archived === true ? "setAside" : archived;
}

/** Hides a profile the Library leaves out, unless it is hidden or deleted already. Its record carries no global id, its id being Decaid's. */
async function hideProfile(leave: LeaveOut, record: Record<string, unknown>): Promise<ItemLeftOut["outcome"] | Answer> {
  if (record.visibility !== "visible") return "setAside";
  const hidden = await setVisibility(leave.localId, "hidden");
  const updated = hidden.ok ? parsed(hidden.text) : undefined;
  return isObject(updated) && updated.visibility !== "visible" ? "setAside" : hidden;
}

function deleted(remove: LibraryDelete): ItemDeleted {
  return { type: "deleted", id: remove.id, kind: remove.kind, globalId: remove.globalId, localId: remove.localId };
}

/** Carries out a write, as its kind does (`KindWriter.write`). */
async function carryOut(write: LibraryWrite, log: (message: string) => void, posted: ListPosted): Promise<WriteAnswer> {
  const writer = writerOf(write.kind);
  if (!writer) return refused(write, null, `This plugin cannot write a ${write.kind}`);
  try {
    return await writer.write(write, log, posted);
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
 * Clears the grinder, batch and Basket of the tablet's Workflow that the
 * write names (`WORKFLOW_KIND`), each whole, only while the Workflow still
 * names the grinder, batch or Basket by the id expected, through `PUT
 * /workflow` (`workflowPatch`), which Decaid merges into the Workflow: a
 * field of its `context` merged in as null is cleared, and a key of its
 * `extras` set to null. A grinder, batch or Basket a barista picked since
 * stays whole, though another grinder may be of the same model, while one a
 * skin relabelled is still cleared. A clear Decaid takes is told of
 * (`ListPosted.workflowWritten`). Answers with the Workflow's `context`,
 * timed now, as a Workflow carries no time.
 */
async function clearWorkflow(write: LibraryWrite, _log: (message: string) => void, posted: ListPosted): Promise<WriteAnswer> {
  const current = await request("GET", "/workflow");
  const workflow = current.ok ? parsed(current.text) : undefined;
  if (!isObject(workflow)) return refused(write, current.status, current.text);
  const fields = Object.fromEntries(
    WORKFLOW_CLEARED.flatMap((group) => {
      const [id] = group;
      const named = group.filter((field) => field in write.fields);
      const expected = write.expected?.[id];
      const holds = named.includes(id) && expected !== undefined && expected !== null && sameValue(workflowValueAt(workflow, id), expected);
      return holds ? named.map((field) => [field, null]) : [];
    }),
  );
  if (Object.keys(fields).length === 0) return written(write, workflowContext(workflow), [], new Date().toISOString());
  const answer = await request("PUT", "/workflow", workflowPatch(fields));
  const updated = answer.ok ? parsed(answer.text) : undefined;
  if (!isObject(updated)) return refused(write, answer.status, answer.text);
  posted.workflowWritten(workflow, updated);
  return written(write, workflowContext(updated), Object.keys(fields), new Date().toISOString());
}

/**
 * Writes the fields of its Loaded Recipe that the server says the tablet's
 * Workflow is due (`LOADED_RECIPE_KIND`), through `PUT /workflow`, which
 * Decaid merges into the Workflow: each part whose first field still holds
 * the value expected, or none (`loadedRecipeFields`). A brew temperature
 * moves every step of the profile written, or else the Workflow's, by the
 * same amount (`profileAtBrewTemperature`). It is refused unless DYE2 still
 * has the Recipe's slot selected, or answers 404
 * (`LoadedRecipeWrites.mayWrite`), and once made, one that changed the
 * profile, batch or grinder, which DYE2 clears its selection on, has the slot
 * selected again (ADR-0022). A steam temperature is left out of a Workflow
 * whose steam is off (`steamOff`), as it would turn steam on, and kept as
 * the one Streamline turns steam back on at, written or not
 * (`keepStreamlineSteamTemperature`, interim until
 * decentespresso/streamline-js#156). Decaid refuses to change the steam, hot
 * water and flush settings while no machine is connected, so the rest is
 * then written without them, the Workflow read again first, and a write of
 * only them is refused. A write Decaid takes is told of
 * (`ListPosted.workflowWritten`). Answers with the Workflow's `context`,
 * steam, hot water and flush settings and `profile`, timed now, as a
 * Workflow carries no time. A write unloading the Recipe, naming
 * DYE2_SELECTION_FIELD, has DYE2's selection of its slot cleared instead,
 * the Workflow left as it is: DYE2 writes its field.
 */
async function writeLoadedRecipe(write: LibraryWrite, log: (message: string) => void, posted: ListPosted): Promise<WriteAnswer> {
  const globalId = write.globalId.toLowerCase();
  if (DYE2_SELECTION_FIELD in write.fields) {
    posted.loaded?.cleared(globalId);
    const current = await request("GET", "/workflow");
    const workflow = current.ok ? parsed(current.text) : undefined;
    if (!isObject(workflow)) return refused(write, current.status, current.text);
    return written(write, loadedRecipeParts(workflow), [DYE2_SELECTION_FIELD], new Date().toISOString());
  }
  if (posted.loaded && !(await posted.loaded.mayWrite(globalId))) return refused(write, null, ANOTHER_SELECTED);
  let machineSettings = true;
  for (;;) {
    const current = await request("GET", "/workflow");
    const workflow = current.ok ? parsed(current.text) : undefined;
    if (!isObject(workflow)) return refused(write, current.status, current.text);
    const fields = loadedRecipeFields(write, workflow, machineSettings);
    // The steam temperature carried, set in the Workflow or left out of one whose steam is off, is Streamline's to turn steam back on at.
    const steam = STEAM_TEMPERATURE in fields || (STEAM_TEMPERATURE in write.fields && steamOff(workflow)) ? write.fields[STEAM_TEMPERATURE] : undefined;
    if (Object.keys(fields).length === 0) {
      await keepStreamlineSteamTemperature(steam, log);
      return written(write, loadedRecipeParts(workflow), [], new Date().toISOString());
    }
    const patch = loadedRecipePatch(fields, workflow);
    const clears = clearsSelection(workflow, patch);
    if (clears) posted.loaded?.selectionClearing(globalId);
    let answer: Answer;
    try {
      answer = await request("PUT", "/workflow", patch);
    } catch (error) {
      // Decaid did not answer: the write may have landed, so the slot is selected again once DYE2 has none.
      if (clears) posted.loaded?.selectionUnsettled(globalId);
      throw error;
    }
    const updated = answer.ok ? parsed(answer.text) : undefined;
    // This write refused, the Workflow stayed, so DYE2 cleared nothing for it.
    if (clears && !isObject(updated)) posted.loaded?.selectionKept(globalId);
    if (isObject(updated)) {
      posted.workflowWritten(workflow, updated);
      posted.loaded?.written(globalId, workflow, updated, clears);
      await keepStreamlineSteamTemperature(steam, log);
      return written(write, loadedRecipeParts(updated), Object.keys(fields), new Date().toISOString());
    }
    const ofMachine = Object.keys(fields).filter(isMachineSetting);
    // Those alone, which Decaid refuses while no machine is connected, are refused, so the plugin writes them once the machine is back.
    if (ofMachine.length === 0 || ofMachine.length === Object.keys(fields).length || !machineMissing(answer)) return refused(write, answer.status, answer.text);
    machineSettings = false;
  }
}

/** The Workflow field holding its steam temperature. */
const STEAM_TEMPERATURE = RECIPE_SETTINGS.steamTemperature.workflow;

/** Whether a Workflow field is one of the steam, hot water and flush settings Decaid writes to the machine (MACHINE_SETTING_PARTS). */
function isMachineSetting(field: string): boolean {
  return MACHINE_SETTING_PARTS.some((part) => field.startsWith(`${part}.`));
}

/** Why the plugin refuses a write of the server's into the Workflow for its Loaded Recipe while DYE2 has another selected. */
const ANOTHER_SELECTED = "DYE2 has another recipe selected on the tablet, which the plugin follows first";

/**
 * The body of a `PUT /workflow` setting the fields of a write of
 * LOADED_RECIPE_KIND (`workflowPatch`), its brew temperature as the profile
 * it writes, or else the Workflow's, moved to it (`profileAtBrewTemperature`).
 */
function loadedRecipePatch(fields: Readonly<Record<string, unknown>>, workflow: Record<string, unknown>): Record<string, unknown> {
  const { [BREW_TEMPERATURE_FIELD]: temperature, ...rest } = fields;
  const patch = workflowPatch(rest);
  if (typeof temperature === "number") {
    const shifted = profileAtBrewTemperature(isObject(patch.profile) ? patch.profile : workflow.profile, temperature);
    if (shifted !== null) patch.profile = shifted;
  }
  return patch;
}

/**
 * The fields of a write of LOADED_RECIPE_KIND to set in the Workflow: each
 * part of LOADED_RECIPE_PARTS the write names, all its fields together,
 * while the Workflow holds the value expected of its first field, or none,
 * or the write expects none, as of a Profile; its steam, hot water and
 * flush settings only where `machineSettings` says; and a steam temperature
 * only where the Workflow's steam is on (`steamOff`).
 */
function loadedRecipeFields(write: LibraryWrite, workflow: Record<string, unknown>, machineSettings: boolean): Record<string, unknown> {
  return Object.fromEntries(
    Object.values(LOADED_RECIPE_PARTS).flatMap((part: readonly string[]) => {
      const [first] = part as [string];
      if (!(first in write.fields) || (!machineSettings && isMachineSetting(first))) return [];
      if (first === STEAM_TEMPERATURE && steamOff(workflow)) return [];
      const held = workflowValueAt(workflow, first);
      const expected = write.expected?.[first];
      // One holding the value written already is written too, so its answer has the server hold it: as where DYE2 recorded
      // a change the server did not hold, as of a report bringing a save of DYE2's editor with it.
      if (held !== undefined && held !== null && expected !== undefined && !sameValue(held, expected) && !sameValue(held, write.fields[first])) return [];
      return part.filter((field) => field in write.fields).map((field) => [field, write.fields[field]]);
    }),
  );
}

/** A Workflow's `context`, steam, hot water and flush settings and `profile`, as Decaid holds them, which hold the parts that follow its Loaded Recipe. */
function loadedRecipeParts(workflow: Record<string, unknown>): Record<string, unknown> {
  return {
    context: isObject(workflow.context) ? workflow.context : {},
    ...Object.fromEntries(MACHINE_SETTING_PARTS.map((part) => [part, isObject(workflow[part]) ? workflow[part] : {}])),
    ...(isObject(workflow.profile) ? { profile: workflow.profile } : {}),
  };
}

/** A Workflow's `context`, as Decaid holds it: none is an empty one. */
function workflowContext(workflow: Record<string, unknown>): Record<string, unknown> {
  return { context: isObject(workflow.context) ? workflow.context : {} };
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

/** The answer that the tablet's list of the request's kind is in a shape not recognised, so nothing was written to it. */
function unrecognised(request: { id: string; kind: string }): ListUnrecognised {
  return { type: "listUnrecognised", id: request.id, kind: request.kind };
}

function refused(write: LibraryWrite | LibraryDelete | LibraryRemove, status: number | null, error: string): WriteRefused {
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

/**
 * A kind DYE2 keeps in one of its lists in Decaid's store, under `key`
 * (ADR-0005): each change reads the list, changes one record and posts the
 * list back whole, as DYE2 and Streamline save, so records others wrote
 * survive. A key never written is an empty list, as DYE2 reads it. A list in
 * a shape the plugin does not recognise (`dye2Records`) is never written:
 * the answer says so.
 */
function dye2Writer(key: Dye2Key): LibraryKindWriter {
  const path = `/store/${DYE2_NAMESPACE}/${key}`;
  const list = (posted: ListPosted): ListPath => ({ path, key, posted });
  return {
    list: path,
    write: (write, _log, posted) => (key === "recipes" ? writeRecipe(list(posted), write) : writeInList(list(posted), write)),
    // A hard-deleted item's record is removed as one its Location no longer shows is. A Shot names a basket or tool by its
    // id here, so one a Shot this plugin has yet to send names is kept, as a batch is (`deleteRecord`); none names a recipe
    // by its id here, its slot.
    remove: async (remove, namedByShot, posted) => {
      if (key !== "recipes") {
        const named = await namedByShot(key === "baskets" ? "basket" : "tool", new Set([remove.localId]));
        if (named !== false) return refused(remove, null, named === "tooMany" ? SHOTS_STILL_TO_READ : SHOT_NOT_SENT);
      }
      const answer = await removeFromList(list(posted), remove);
      return answer.type === "removed" ? { ...answer, type: "deleted" } : answer;
    },
    drop: (remove, posted) => removeFromList(list(posted), remove),
    setAside: (leave, posted) => leaveOutOfList(list(posted), leave),
  };
}

/** A key DYE2 keeps one of its lists under. */
export type Dye2Key = "baskets" | "equipment" | "recipes";

/**
 * Where one of DYE2's lists is kept in Decaid's store, its key there, which
 * says what shape it is recognised in (`dye2Records`), and what to tell of a
 * post of it Decaid takes.
 */
interface ListPath {
  path: string;
  key: Dye2Key;
  posted: ListPosted;
}

/** One of DYE2's lists as the tablet holds it: its records, or that it is in a shape not recognised, or Decaid's refusal to read it. */
type Dye2List = { records: Record<string, unknown>[] } | { unrecognised: true } | { refused: Answer };

/** Reads one of DYE2's lists: a key never written, which Decaid answers with null, is empty. */
async function readList({ path, key }: ListPath): Promise<Dye2List> {
  const answer = await request("GET", path);
  const value = answer.ok ? parsed(answer.text) : undefined;
  if (value === undefined) return { refused: answer };
  if (value === null) return { records: [] };
  const records = dye2Records(value, key);
  return records === null ? { unrecognised: true } : { records: [...records] };
}

/**
 * Posts one of DYE2's lists back whole, DYE2's recipes in slot order, as
 * every tablet at a Location holds them (ADR-0005): DYE2 adds a recipe saved
 * in a new slot at the end. A post Decaid takes is told of (`ListPosted`).
 */
async function postList({ path, key, posted }: ListPath, records: Record<string, unknown>[], before: readonly Record<string, unknown>[]): Promise<Answer> {
  const ordered = key === "recipes" ? [...records].sort((a, b) => Number(a.id) - Number(b.id)) : records;
  // The Loaded Recipe moving to another slot is cleared from DYE2's selection first, so DYE2 never records into a recipe
  // put in its old slot, and selected in its new one after, and so is a slot whose recipe the post removes or replaces
  // (ADR-0022).
  if (key === "recipes") await posted.loaded?.moving(before, ordered);
  let answer: Answer;
  try {
    answer = await request("POST", path, ordered);
  } catch (error) {
    if (key === "recipes") posted.loaded?.postUnsettled();
    throw error;
  }
  if (answer.ok) {
    posted(key);
    if (key === "recipes") posted.loaded?.posted(ordered);
  } else if (key === "recipes") posted.loaded?.notPosted(before);
  return answer;
}

/**
 * Writes a Basket or Tool to its list (`LibraryWrite`). To create one, a
 * record already carrying its global id, made by a write whose answer was
 * lost, is the answer, and nothing is written; a record without a global id
 * of the same name (`equipmentMatchKey`), entered there before the tablet
 * reported it, becomes the item, and only the global id is written to it
 * (`linked`); otherwise a record is added with the write's fields, a new id,
 * as DYE2 gives one, and its creation time. To update one, the fields it
 * still holds as the server expects are set, a null one left out. Either
 * way the record carries the global id in its own field. The list is posted
 * back only where it changed. The answer is timed now, as DYE2's records
 * carry no edit time.
 */
async function writeInList(path: ListPath, write: LibraryWrite): Promise<WriteAnswer> {
  const list = await readList(path);
  if ("refused" in list) return refused(write, list.refused.status, list.refused.text);
  if ("unrecognised" in list) return unrecognised(write);
  const { records } = list;
  const globalId = write.globalId.toLowerCase();
  const now = new Date().toISOString();
  let index: number;
  let record: Record<string, unknown>;
  let writtenFields: string[];
  let linked = false;
  if (write.localId === null) {
    const held = records.find((candidate) => dye2GlobalIdOf(candidate) === globalId);
    if (held) return written(write, held, [], now);
    const name = write.fields.name;
    index = records.findIndex(
      (candidate) => dye2GlobalIdOf(candidate) === null && typeof candidate.name === "string" && typeof name === "string" && equipmentMatchKey(candidate.name) === equipmentMatchKey(name),
    );
    if (index !== -1) {
      record = { ...records[index]!, [GLOBAL_ID_KEY]: write.globalId };
      writtenFields = [];
      linked = true;
    } else {
      index = records.length;
      record = { ...withValues(write.fields), id: randomUuid(), createdAt: now, [GLOBAL_ID_KEY]: write.globalId };
      writtenFields = Object.keys(write.fields);
    }
  } else {
    index = records.findIndex((candidate) => candidate.id === write.localId);
    if (index === -1) return refused(write, 404, "Record not found");
    const current = records[index]!;
    const fields = settable(write, (field) => current[field]);
    record = { ...current, ...withValues(fields), [GLOBAL_ID_KEY]: write.globalId };
    for (const [field, value] of Object.entries(fields)) if (value === null) delete record[field];
    writtenFields = Object.keys(fields);
    if (sameValue(record, current)) return written(write, current, writtenFields, now);
  }
  const before = [...records];
  records[index] = record;
  const posted = await postList(path, records, before);
  if (!posted.ok) return refused(write, posted.status, posted.text);
  const answer = written(write, record, writtenFields, now);
  return linked ? { ...answer, linked } : answer;
}

/**
 * Removes the tablet's record from one of DYE2's lists, unless it carries
 * another item's global id (ANOTHER_ITEMS_RECORD), or a removal differs from
 * the record the server expected (RECORD_CHANGED), as one a barista changed
 * since the list was last read, which the server takes in first. A record
 * already gone is removed.
 */
async function removeFromList(path: ListPath, remove: LibraryRemove | LibraryDelete): Promise<RemoveAnswer> {
  const removed: ItemRemoved = { type: "removed", id: remove.id, kind: remove.kind, globalId: remove.globalId, localId: remove.localId };
  const list = await readList(path);
  if ("refused" in list) return refused(remove, list.refused.status, list.refused.text);
  if ("unrecognised" in list) return unrecognised(remove);
  const index = list.records.findIndex((record) => record.id === remove.localId);
  if (index === -1) return removed;
  const carried = dye2GlobalIdOf(list.records[index]);
  if (carried !== null && carried !== remove.globalId.toLowerCase()) return refused(remove, null, ANOTHER_ITEMS_RECORD);
  if (remove.type === "remove" && remove.expected !== undefined && !sameValue(list.records[index], remove.expected)) return refused(remove, null, RECORD_CHANGED);
  const posted = await postList(path, list.records.filter((_, at) => at !== index), list.records);
  return posted.ok ? removed : refused(remove, posted.status, posted.text);
}

/**
 * Sets aside a record the Library leaves out of one of DYE2's lists, which
 * can neither archive nor hide one: it is removed from the list, and not
 * kept (ADR-0005, ADR-0018). Only a record carrying no global id: one that
 * carries one is a Library item's now (`taken`).
 */
async function leaveOutOfList(path: ListPath, leave: LeaveOut): Promise<ItemLeftOut["outcome"] | Answer | "unrecognised"> {
  const list = await readList(path);
  if ("refused" in list) return list.refused;
  if ("unrecognised" in list) return "unrecognised";
  const index = list.records.findIndex((record) => record.id === leave.localId);
  if (index === -1) return "gone";
  if (dye2GlobalIdOf(list.records[index]) !== null) return "taken";
  const posted = await postList(path, list.records.filter((_, at) => at !== index), list.records);
  return posted.ok ? "setAside" : posted;
}

/**
 * Writes a Recipe to DYE2's recipes (`LibraryWrite`), whose fields are
 * named by their paths in the record (`dashboardVariables.dose`). To create
 * one, in the slot `fields.id` names: a record there already carrying its
 * global id, made by a write whose answer was lost, is the answer, and
 * nothing is written; a record there without a global id, saved in that
 * slot before the tablet reported it, becomes the Recipe's, and only the
 * global id is written to it (`linked`), so the server takes what it holds
 * as an edit of the Recipe; a record there carrying another item's global
 * id is left as it is, and the write refused, as the server removes it
 * first; otherwise a record is added with the write's fields and its
 * `capturedAt`, as DYE2 stamps one. To update one, each path it still holds
 * as the server expects is set, a null one left out. Either way the record
 * carries the global id in its own field, and the list is posted back, in
 * slot order, only where it changed. The answer is timed now, as DYE2's
 * records carry no edit time.
 */
async function writeRecipe(path: ListPath, write: LibraryWrite): Promise<WriteAnswer> {
  const list = await readList(path);
  if ("refused" in list) return refused(write, list.refused.status, list.refused.text);
  if ("unrecognised" in list) return unrecognised(write);
  const { records } = list;
  const globalId = write.globalId.toLowerCase();
  const now = new Date().toISOString();
  const { id: slot, ...fields } = write.fields;
  let index: number;
  let record: Record<string, unknown>;
  let writtenFields: string[];
  let linked = false;
  if (write.localId === null) {
    if (!isSlotId(slot)) return refused(write, null, "A Recipe to create must name its slot");
    index = records.findIndex((candidate) => candidate.id === slot);
    if (index !== -1) {
      const held = records[index]!;
      const carried = dye2GlobalIdOf(held);
      if (carried === globalId) return written(write, held, [], now);
      if (carried !== null) return refused(write, 409, `Slot ${slot} holds another item's record`);
      record = { ...held, [GLOBAL_ID_KEY]: write.globalId };
      writtenFields = [];
      linked = true;
    } else {
      index = records.length;
      record = { ...atPaths({}, withValues(fields)), id: slot, capturedAt: now, [GLOBAL_ID_KEY]: write.globalId };
      writtenFields = Object.keys(fields);
    }
  } else {
    index = records.findIndex((candidate) => candidate.id === write.localId);
    if (index === -1) return refused(write, 404, "Record not found");
    const current = records[index]!;
    const settled = settable(write, (field) => valueAt(current, field));
    record = atPaths({ ...current, [GLOBAL_ID_KEY]: write.globalId }, settled);
    writtenFields = Object.keys(settled);
    if (sameValue(record, current)) return written(write, current, writtenFields, now);
  }
  const before = [...records];
  records[index] = record;
  const posted = await postList(path, records, before);
  if (!posted.ok) return refused(write, posted.status, posted.text);
  const answer = written(write, record, writtenFields, now);
  return linked ? { ...answer, linked } : answer;
}

/** The field of a DYE2 recipe holding its dial, whose own fields a write names by their paths (`dashboardVariables.dose`). */
const DASHBOARD = "dashboardVariables";

/** The value at a path of a record: a field of its own, or of its `dashboardVariables`. */
function valueAt(record: Record<string, unknown>, path: string): unknown {
  if (!path.startsWith(`${DASHBOARD}.`)) return record[path];
  const variables = record[DASHBOARD];
  return isObject(variables) ? variables[path.slice(DASHBOARD.length + 1)] : undefined;
}

/** The record with each path set to its value, a null one left out, as a record leaves out a field it holds no value for. */
function atPaths(record: Record<string, unknown>, values: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...record };
  let variables: Record<string, unknown> | undefined;
  for (const [path, value] of Object.entries(values)) {
    let target = result;
    let field = path;
    if (path.startsWith(`${DASHBOARD}.`)) {
      variables ??= { ...(isObject(result[DASHBOARD]) ? result[DASHBOARD] : {}) };
      target = variables;
      field = path.slice(DASHBOARD.length + 1);
    }
    if (value === null) delete target[field];
    else target[field] = value;
  }
  if (variables) result[DASHBOARD] = variables;
  return result;
}

/** The fields given, but those null, which a record leaves out as it holds no value for them. */
function withValues(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null));
}
