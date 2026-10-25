// The wire contract between the plugin and the server. Both ends import it from
// here so they cannot drift apart. The plugin bundles it into an ES2020 script,
// so this package must not depend on Node or browser APIs.
//
// Every message is one JSON object, told apart by its `type`, in a WebSocket
// text frame of its own or, if too large for one, in chunks (chunking.ts).
// Validators accept fields they do not know, so either end can add one
// without breaking the other, and never echo field values in the problems
// they report, apart from a Decaid version's release numbers: a `hello`
// carries the Machine's token.

import type { Chunk } from "./chunking.js";

export * from "./chunking.js";
export * from "./settings-fields.js";

/** The protocol version this build of the plugin and server speaks. */
export const PROTOCOL_VERSION = 1;

/**
 * The oldest protocol version the server accepts. Both stay 1: a wire change
 * needs only the plugin and server of the same commit, so it raises neither,
 * and a plugin from before it fails validation (ADR-0017).
 */
export const OLDEST_SUPPORTED_PROTOCOL_VERSION = 1;

/**
 * The oldest Decaid release the server accepts, always a release rather than
 * a pre-release. A release that relies on a newer Decaid raises it
 * (ADR-0017).
 */
export const OLDEST_SUPPORTED_DECAID = "0.9.0";

/** The path of the server's sync endpoint, under its public URL's host. */
export const SYNC_PATH = "/sync";

/**
 * Either end closes a connection it has heard nothing on for this many
 * heartbeat intervals, so neither waits on a dead one until TCP gives up.
 */
export const MISSED_HEARTBEATS = 3;

/**
 * The longest id a delivery or chunk may have, in UTF-16 code units. The
 * plugin's are about 30 (`Outbox.nextId`). The server keeps the ids of
 * recent deliveries for each connection, and of Workflow, machine state and
 * collection deliveries for 90 days, so a longer one is refused.
 */
export const MAX_ID_LENGTH = 128;

/**
 * The longest machine model, serial or connection id a `hello` may report, in
 * UTF-16 code units, which is also the longest serial an Admin may enter.
 * Decaid's are far shorter: a model such as DE1Pro, a serial number, and a
 * Bluetooth address or a USB id made of the device's vendor, product and
 * serial (`computeUsbStableId` in decaid:lib/src/services/serial/utils.dart).
 * The server keeps them in unique indexes, which refuse an entry over about
 * 2.7 KB every time it is tried, so a longer one is refused in `hello`, and a
 * Shot recording one counts as recording no hardware.
 */
export const MAX_HARDWARE_LENGTH = 100;

/**
 * The longest Shot or Steam Record id the server stores, in UTF-16 code
 * units. Decaid's are UUIDs. A longer one could not be indexed by
 * PostgreSQL, so a record whose id fails `isRecordId` is never sent,
 * requested or stored.
 */
export const MAX_RECORD_ID_LENGTH = 128;

/**
 * Whether a value is a Shot or Steam Record id the server stores: a string
 * of 1 to MAX_RECORD_ID_LENGTH code units without NUL, which PostgreSQL's
 * text cannot hold. The plugin leaves other records and index entries out;
 * the server acknowledges a record with another id without storing it, and
 * never requests one.
 */
export function isRecordId(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= MAX_RECORD_ID_LENGTH && !value.includes("\u0000");
}

/** Why the server refused or ended a connection, sent in an `error` before it closes. */
export type ErrorCode =
  | "protocol_error"
  | "bad_token"
  | "plugin_too_old"
  | "replaced"
  | "hardware_dismissed"
  | "decaid_too_old"
  | "machine_held"
  | "superseded";

/** The WebSocket close code that goes with each error. */
export const CLOSE_CODES: Readonly<Record<ErrorCode, number>> = {
  /** A frame that is not a valid message here, including no `hello` in time. */
  protocol_error: 4000,
  /** The token is unknown or has been revoked. */
  bad_token: 4001,
  /** The plugin speaks a protocol version older than the server supports. */
  plugin_too_old: 4002,
  /**
   * A connection from another tablet took over with the same token. The
   * plugin waits, then connects only with a `yielding` hello.
   */
  replaced: 4003,
  /**
   * An Admin dismissed the hardware this tablet reports for this token: its
   * machine is not the one the token was issued for.
   */
  hardware_dismissed: 4004,
  /** The tablet runs a Decaid older than the server supports. */
  decaid_too_old: 4005,
  /**
   * A `yielding` hello was refused because a live connection from another
   * tablet holds the Machine. The plugin waits, then tries again the same way.
   */
  machine_held: 4006,
  /**
   * This connection no longer holds its Machine, but no other tablet's does:
   * another connection from this tablet does, as when it reconnected while
   * the server still held this one, or none does. The plugin reconnects.
   */
  superseded: 4007,
};

/** The hardware a machine reports while it is connected to its tablet. */
export interface MachineHardware {
  /** Decaid's model name, such as DE1Pro. */
  model: string;
  /** The serial number; older DE1s report "0". */
  serial: string;
  firmware?: string | null;
}

/**
 * A machine's identity: its model and serial together, so the same serial on
 * another model is other hardware. Both ends compare reports with the helpers
 * below, so they agree on what is the same hardware.
 */
export interface Hardware {
  model: string;
  serial: string;
}

/** Whether a serial identifies hardware: not empty, and not the "0" older DE1s report. */
export function isRealSerial(serial: string): boolean {
  const trimmed = serial.trim();
  return trimmed !== "" && trimmed !== "0";
}

/** The reported model and serial, trimmed, if they name real hardware. */
export function realHardware(reported: MachineHardware | null | undefined): Hardware | null {
  if (!reported) return null;
  const model = reported.model.trim();
  const serial = reported.serial.trim();
  if (model === "" || !isRealSerial(serial)) return null;
  return { model, serial };
}

/** Whether two reports name the same hardware: model and serial, trimmed, whatever the firmware. Two absent reports are the same. */
export function sameHardware(a: Hardware | null, b: Hardware | null): boolean {
  if (a === null || b === null) return a === b;
  return a.model.trim() === b.model.trim() && a.serial.trim() === b.serial.trim();
}

/** Whether a value is a UUID, such as 0f8e5d34-6c1b-4f0a-9d2e-7b3c4a5f6e81, in either case. */
function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Whether a value is a tablet id as the plugin makes one: a UUID, in either case. */
export function isTabletId(value: unknown): value is string {
  return isUuid(value);
}

/**
 * Whether a value is a Library item's global id as the server gives one
 * (ADR-0006): a UUID, in either case. The plugin writes it into the item's
 * record on each tablet, in `extras` under GLOBAL_ID_KEY.
 */
export function isGlobalId(value: unknown): value is string {
  return isUuid(value);
}

/**
 * The key in a Library record's `extras` that holds its global id. Decaid
 * replaces `extras` whole when a record is updated, so the plugin keeps the
 * other keys there, which other plugins write, whenever it writes this one.
 */
export const GLOBAL_ID_KEY = "decentSyncId";

/**
 * The key two Beans with the same roaster and name share, ignoring case and
 * white space at either end: how a bean new to the Library is matched to a
 * Library Bean (ADR-0018). The server matches a tablet's new beans by it, and
 * the plugin a bean it is asked to create to one its tablet already holds.
 */
export function beanMatchKey(roaster: string, name: string): string {
  return JSON.stringify([roaster.trim().toLowerCase(), name.trim().toLowerCase()]);
}

/**
 * Whether two values a Library record holds are the same, as JSON: objects
 * compared key by key whatever their order, arrays element by element. A
 * field a record does not hold is the same as one holding null, since Decaid
 * leaves out a field it holds no value for. The server compares a tablet's
 * records by it to find what an edit changed (ADR-0020), and the plugin a
 * record with what the server expects it to hold before it writes a field.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => sameValue(value, b[index]));
  }
  if (!isObject(a) || !isObject(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => sameValue(a[key], b[key]));
}

/** The global id a tablet's Library record carries in its `extras`, or null if it carries none. */
export function globalIdOf(record: unknown): string | null {
  const extras = isObject(record) ? record.extras : undefined;
  const id = isObject(extras) ? extras[GLOBAL_ID_KEY] : undefined;
  return isGlobalId(id) ? id.toLowerCase() : null;
}

/** The plugin's first message on every connection. */
export interface Hello {
  type: "hello";
  protocolVersion: number;
  token: string;
  pluginVersion: string;
  /** Decaid's full version, such as 0.9.0+2977. */
  decaidVersion: string;
  /**
   * The tablet's id (ADR-0006): a random UUID the plugin made on its first
   * run and keeps in Decaid's plugin storage. Resetting the tablet's Decaid
   * data makes a new one, and restoring a Decaid backup that holds it brings
   * it back.
   */
  tabletId: string;
  /** The connection id of Decaid's preferred machine: a Bluetooth address or USB id. */
  connectionId?: string | null;
  /** Absent or null while no machine is connected to the tablet. */
  machine?: MachineHardware | null;
  /**
   * Asks not to replace a live connection from another tablet: the server
   * refuses the hello with `machine_held` while one holds the Machine, and
   * otherwise accepts it as any other. Sent by a plugin whose connection
   * another tablet replaced, so two tablets with one token never take turns.
   */
  yielding?: boolean;
}

/**
 * Sent by the plugin every `heartbeatIntervalMs` from `welcome`, and by the
 * server in reply to each, so each end hears from the other every interval.
 */
export interface Heartbeat {
  type: "heartbeat";
}

/** The server's reply to an accepted `hello`. */
export interface Welcome {
  type: "welcome";
  protocolVersion: number;
  /** How often the plugin sends `heartbeat`; either end closes a connection silent for `MISSED_HEARTBEATS` intervals. */
  heartbeatIntervalMs: number;
}

/** Sent by the server just before it closes the connection with `CLOSE_CODES[code]`. */
export interface ErrorMessage {
  type: "error";
  code: ErrorCode;
  /** Says what went wrong, for the plugin's log. */
  message: string;
}

/**
 * Decaid data stays opaque; only the delivery envelope is validated. A `shot`
 * is the full record; a `shotUpdated` is the edited Shot's complete metadata,
 * as Decaid's event supplies it, without curves.
 */
export interface ShotDelivery {
  type: "shot" | "shotUpdated";
  /** An id for this logical delivery, retained until acknowledged. */
  id: string;
  shotId: string;
  shot: Record<string, unknown>;
}

/** One bounded page of the tablet's history. Reloads include edit times; reconnects omit them. */
export interface ShotIndex {
  type: "shotIndex";
  id: string;
  shots: { id: string; updatedAt?: string | null }[];
}

export interface RequestShots {
  type: "requestShots";
  shotIds: string[];
}

/**
 * A Steam Record, as Decaid serves it, beside its time in UTC. Decaid writes
 * a Steam Record's `timestamp` in the tablet's local time without an offset,
 * so the plugin, which runs in the tablet's time zone, places it.
 */
export interface SteamDelivery {
  type: "steam";
  /** An id for this logical delivery, retained until acknowledged. */
  id: string;
  steamId: string;
  /** The record's `timestamp`, read as the tablet's local time, as a UTC instant such as 2026-10-05T14:07:03.341Z. */
  steamedAt: string;
  steam: Record<string, unknown>;
}

/**
 * One bounded page of the tablet's Steam Record ids. Steam Records have no
 * edit time, so an entry is only an id.
 */
export interface SteamIndex {
  type: "steamIndex";
  id: string;
  steams: { id: string }[];
}

export interface RequestSteams {
  type: "requestSteams";
  steamIds: string[];
}

/**
 * Asks the plugin to send its latest Workflow again, then read every
 * collection again and send each in full, as it does on every `welcome`.
 * The server sends it when the Machine's Location changes, so the tablet's
 * Workflow and Library are taken in at its new Location before anything is
 * written to it there (ADR-0008).
 */
export interface RequestCollections {
  type: "requestCollections";
}

/**
 * Whether the tablet's Machine is a Capture-only Machine, at no Location or
 * with sharing off, taking no part in the Library: sent after `welcome` and
 * whenever that changes. The plugin loads no Recipe into the Workflow of one, and runs
 * none of ADR-0022's workarounds there, as nothing there shares it. Until
 * told, the plugin takes its Machine to take part, so a load made while the
 * tablet is offline is still recorded.
 */
export interface CaptureOnly {
  type: "captureOnly";
  captureOnly: boolean;
}

/**
 * The tablet's Workflow, as Decaid's `workflowUpdated` event gave it, sent on
 * every change and again on every `welcome`. The Workflow stays opaque.
 */
export interface WorkflowDelivery {
  type: "workflow";
  /**
   * An id for this logical delivery, retained until acknowledged and kept
   * when it is sent again: the server records every one it has handled, so a
   * resend changes nothing.
   */
  id: string;
  /**
   * When the plugin observed it, by the tablet's clock, in UTC, such as
   * 2026-10-05T14:05:43.648Z. Delivery may come much later.
   */
  observedAt: string;
  workflow: Record<string, unknown>;
  /**
   * True while DYE2 is not there to keep the Workflow's recipe on the
   * tablet: Decaid lists no DYE2, or lists it disabled, or not loaded for
   * longer than twice the plugin's poll interval (ADR-0022). The recipe the
   * Workflow names (DYE2_RECIPE_FIELD) then names no Loaded Recipe, whatever
   * was last written there. The plugin sends the Workflow again as this
   * changes, where it names a recipe.
   */
  dye2Absent?: boolean;
  /**
   * Where the plugin held this change back while the Workflow came to name
   * the recipe it names (DYE2_RECIPE_FIELD), as during a write of its own,
   * when Decaid first reported it naming that recipe, by the tablet's clock,
   * in UTC, at or before `observedAt` by a clock that does not jump back:
   * the Machine has that Recipe loaded from then, so a Shot pulled with it
   * meanwhile is pulled with it. The Workflow's other parts are as observed
   * at `observedAt`.
   */
  recipeNamedAt?: string;
}

/** A change of the machine's state or substate, from Decaid's `stateUpdate` event. */
export interface MachineStateDelivery {
  type: "machineState";
  /** As for a Workflow: kept when it is sent again. */
  id: string;
  /** When the plugin observed it, as for a Workflow. */
  observedAt: string;
  /** Decaid's name for the state, such as espresso. */
  state: string;
  /** Decaid's name for the substate, such as preinfusion. */
  substate: string;
}

/**
 * The collections a tablet reports, each read from Decaid's local API (or
 * DYE2's storage in it) and stored by the server as the latest value for its
 * Machine:
 *
 * - `beans`, `beanBatches` and `grinders`, archived ones included;
 * - `profiles`, hidden ones included;
 * - `dye2Recipes`, `dye2Equipment` and `dye2Baskets`, DYE2's keys
 *   (`DYE2_LISTS`): its recipes, tools and baskets, taken into the Library
 *   and written to (ADR-0005);
 * - `appSettings`, `presenceSettings` (the presence settings with the wake
 *   schedules), `machineSettings` and `advancedSettings`, whose fields, with
 *   those of the two calibrations, are defined in settings-fields.ts
 *   (`SETTINGS_FIELDS`), the first two sent with the tablet's UTC offset
 *   (`UTC_OFFSET_COLLECTIONS`);
 * - `machineCalibration`, the machine's flow calibration;
 * - `sensorCalibration`, the firmware's current flow, pressure and temperature
 *   sensor calibration;
 * - `plugins`, Decaid's plugin list, DYE2 among them;
 * - `skins`, Decaid's Skins: their list, the default Skin and what the WebUI
 *   server serves;
 * - `pairedDevices`, the device inventory without devices only discovered nearby;
 * - `scaleInfo`, the connected scale's firmware and battery level;
 * - `sensors`.
 */
export const COLLECTION_NAMES = [
  "beans",
  "beanBatches",
  "grinders",
  "profiles",
  "dye2Recipes",
  "dye2Equipment",
  "dye2Baskets",
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
] as const;

export type CollectionName = (typeof COLLECTION_NAMES)[number];

export function isCollectionName(name: string): name is CollectionName {
  return (COLLECTION_NAMES as readonly string[]).includes(name);
}

/**
 * The collections holding times in the tablet's local time without an
 * offset (night mode's times, the wake schedules' times and
 * `keepAwakeUntil`), each sent with the tablet's UTC offset as it was read
 * (`CollectionDelivery.utcOffsetMinutes`), which the management interface
 * labels them with.
 */
export const UTC_OFFSET_COLLECTIONS = ["appSettings", "presenceSettings"] as const satisfies readonly CollectionName[];

export function hasUtcOffset(name: string): boolean {
  return (UTC_OFFSET_COLLECTIONS as readonly string[]).includes(name);
}

/** The furthest a UTC offset may be from UTC, in minutes: 18 hours, as ISO 8601 and Java bound it; the zones in use reach 14. */
export const MAX_UTC_OFFSET_MINUTES = 18 * 60;


/** DYE2's namespace in Decaid's store, under which it keeps its lists. */
export const DYE2_NAMESPACE = "dye2.reaplugin";

/**
 * DYE2's lists, each kept whole under one key of Decaid's store
 * (`/store/dye2.reaplugin/{key}`), by the collection the plugin reports it
 * as: its recipes, its tools (DYE2's `equipment`) and its baskets. A key
 * never written reads as `null`, which DYE2 takes for an empty list, and so
 * does the plugin, which reports it as one (ADR-0005).
 */
export const DYE2_LISTS = { dye2Recipes: "recipes", dye2Equipment: "equipment", dye2Baskets: "baskets" } as const satisfies Partial<Record<CollectionName, string>>;

export type Dye2List = keyof typeof DYE2_LISTS;

export function isDye2List(name: string): name is Dye2List {
  return Object.prototype.hasOwnProperty.call(DYE2_LISTS, name);
}

/**
 * The records of a DYE2 list in a shape the plugin and server recognise:
 * an array of objects, each with an id (`isRecordId`) no other holds; null
 * for any other value. A recipe's id is opaque, as DYE2 gives its own: a
 * UUID from its editor, `recipe-…` from its `save-recipe`, and a Recipe
 * Slot's number for a recipe saved before DYE2 v0.1.25. A list in another
 * shape is never taken in, nor written to, on that tablet, so DYE2's data
 * is never corrupted (ADR-0005).
 */
export function dye2Records(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null;
  const ids = new Set<string>();
  for (const record of value) {
    if (!isObject(record) || !isRecordId(record.id) || ids.has(record.id)) return null;
    ids.add(record.id);
  }
  return value as Record<string, unknown>[];
}

/** How many Recipe Slots each Location has: the buttons of Streamline's DYE strip, as DYE2's `stripSlot` numbers them. */
export const RECIPE_SLOTS = 5;

/** Whether a value is a Recipe Slot's number: a whole number from 1 to RECIPE_SLOTS. */
export function isRecipeSlot(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= RECIPE_SLOTS;
}

/**
 * The Recipe Slot a DYE2 recipe record is in: its `stripSlot`, the button of
 * Streamline's DYE strip it is on (`recipeStripCells` in
 * streamline-js:src/modules/dye-selection.js), shared by every Machine at its
 * Location; null for none, as for one DYE2 keeps only in its library, which
 * its Select Recipe page lists and applies all the same.
 */
export function recipeSlotOf(record: unknown): number | null {
  const slot = isObject(record) ? record[RECIPE_SLOT_FIELD] : undefined;
  return isRecipeSlot(slot) ? slot : null;
}

/** The field of a DYE2 recipe record holding its Recipe Slot (`recipeSlotOf`). */
export const RECIPE_SLOT_FIELD = "stripSlot";

/**
 * The steam, hot water and flush settings a Recipe may hold, as DYE2's recipe
 * does (decentespresso/dye2#23): each by its name in a Recipe's content, with
 * DYE2's name for it in a recipe record's `dashboardVariables` and the path
 * of the Workflow field holding it (`MACHINE_MAP` in
 * dye2:dye2-plugin/src/utils/workflow-record.ts at v0.1.26), and whether
 * Decaid keeps it as a whole number (`SteamSettings`, `HotWaterData` and
 * `RinseData` in decaid:lib/src/models/data/workflow.dart). Each is
 * optional: one a Recipe holds none of is the Machine's own, which loading
 * it leaves alone. 0 is a value, as a milk stop of 0 is off. Decaid calls
 * the flush settings `rinseData`.
 */
export const RECIPE_SETTINGS = {
  steamTemperature: { dye2: "steamTempC", workflow: "steamSettings.targetTemperature", whole: true },
  steamDuration: { dye2: "steamTimeS", workflow: "steamSettings.duration", whole: true },
  steamFlow: { dye2: "steamFlowMls", workflow: "steamSettings.flow", whole: false },
  steamStopTemperature: { dye2: "steamStopAtTempC", workflow: "steamSettings.stopAtTemperature", whole: false },
  hotWaterTemperature: { dye2: "hotWaterTempC", workflow: "hotWaterData.targetTemperature", whole: true },
  hotWaterDuration: { dye2: "hotWaterTimeS", workflow: "hotWaterData.duration", whole: true },
  hotWaterVolume: { dye2: "hotWaterMl", workflow: "hotWaterData.volume", whole: true },
  hotWaterFlow: { dye2: "hotWaterFlowMls", workflow: "hotWaterData.flow", whole: false },
  flushTemperature: { dye2: "flushTempC", workflow: "rinseData.targetTemperature", whole: true },
  flushDuration: { dye2: "flushS", workflow: "rinseData.duration", whole: true },
  flushFlow: { dye2: "flushFlowMls", workflow: "rinseData.flow", whole: false },
} as const satisfies Record<string, { dye2: string; workflow: string; whole: boolean }>;

/** One of the settings a Recipe may hold (RECIPE_SETTINGS). */
export type RecipeSetting = keyof typeof RECIPE_SETTINGS;

/** The settings a Recipe may hold, in the order RECIPE_SETTINGS lists them. */
export const RECIPE_SETTING_NAMES = Object.keys(RECIPE_SETTINGS) as RecipeSetting[];

/**
 * The parts of a Workflow holding the settings a Recipe may hold, which
 * Decaid writes to the machine as they change, and refuses to change while
 * no machine is connected (`De1Controller.updateWorkflowSettings`).
 */
export const MACHINE_SETTING_PARTS = ["steamSettings", "hotWaterData", "rinseData"] as const;

/**
 * Whether a Workflow's steam is off: its steam temperature below
 * STEAM_ON_FROM, as Decaid judges it, or none. A Workflow none of whose
 * fields says otherwise has steam on.
 */
export function steamOff(workflow: unknown): boolean {
  const temperature = workflowValueAt(workflow, RECIPE_SETTINGS.steamTemperature.workflow);
  return typeof temperature === "number" && temperature < STEAM_ON_FROM;
}

/**
 * The global id a DYE2 record carries in its own top-level field,
 * GLOBAL_ID_KEY, which DYE2 and Streamline keep when they save the record
 * (ADR-0006), or null if it carries none.
 */
export function dye2GlobalIdOf(record: unknown): string | null {
  const id = isObject(record) ? record[GLOBAL_ID_KEY] : undefined;
  return isGlobalId(id) ? id.toLowerCase() : null;
}

/**
 * The key two Baskets, or two Tools, with the same name share, ignoring case
 * and white space at either end: how one a tablet creates is matched to one
 * in the Library (ADR-0018), by the server, and by the plugin to one its
 * tablet holds already.
 */
export function equipmentMatchKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * One collection, as Decaid's API answered it, sent when it changed and in
 * full on every `welcome`. A read that failed or had nothing to report (no
 * machine or scale connected) is sent as unavailable, without a value, so it
 * never replaces what the server knows. A DYE2 key never written is an empty
 * list (`DYE2_LISTS`).
 */
export interface CollectionDelivery {
  type: "collection";
  /** An id for this logical delivery, retained until acknowledged and kept when it is sent again, as for a Workflow. */
  id: string;
  /** One of COLLECTION_NAMES. A server ignores a name it does not know. */
  name: string;
  available: boolean;
  /** Decaid's response, as sent, while available: anything but null. Absent while unavailable. */
  value?: unknown;
  /**
   * For one of the LIBRARY_LISTS, each record's `updatedAt`, read as the
   * tablet's local time and placed in UTC, such as
   * 2026-10-05T14:07:03.341Z, in the order of `value`: null for a record
   * whose time cannot be read. DYE2's records carry no edit time, so for a
   * list of a DYE2 kind (`dye2Key`) it is when the plugin first read each
   * record's current content, which times its edits (ADR-0005). Only with a
   * list `value`, and as long as it.
   */
  updatedAt?: (string | null)[];
  /**
   * For one of the UTC_OFFSET_COLLECTIONS, the tablet's UTC offset as the
   * value was read, in whole minutes east of UTC: the negative of
   * `Date.prototype.getTimezoneOffset()`, such as -240 for Toronto in
   * summer. Part of what decides whether the collection changed, so a
   * daylight saving change is sent. Only with a `value`, and within
   * MAX_UTC_OFFSET_MINUTES of 0.
   */
  utcOffsetMinutes?: number;
}

/**
 * What a kind declares its items' ids to be, which every message naming an
 * item of that kind is checked against (`itemIdRule`).
 */
export interface ItemIdRule {
  /** Whether a value is such an id. */
  test(value: unknown): value is string;
  /** What a message is refused with, after the field's name, when its id is not one. */
  problem: string;
}

/** A global id the server gives an item, which the plugin writes into its records (ADR-0006): a UUID. */
export const GLOBAL_ITEM_ID: ItemIdRule = { test: isGlobalId, problem: "must be a UUID" };

/** What the protocol says of a kind of Library item (`LIBRARY_ITEM_KINDS`). */
export interface LibraryKindDescription {
  /** The tablet's list of its records, one of COLLECTION_NAMES, which the plugin reports and the server takes into the Library. */
  list: CollectionName;
  /** What its items' ids are. */
  id: ItemIdRule;
  /**
   * The kind its records are made under on a tablet, if any: a Bean Batch's
   * under its bean's record. Its list is reported in full after that kind's
   * whenever that one is, and taken in only once that one is, as a record
   * whose parent the server does not know yet waits for it.
   */
  under?: string;
  /**
   * For a kind DYE2 keeps (ADR-0005), the key of Decaid's store its list is
   * kept whole under, in DYE2_NAMESPACE: the plugin reads the list, changes
   * one record and posts the list back. Its records carry their global id in
   * a top-level field of their own (`dye2GlobalIdOf`), have no edit time,
   * and cannot be archived or hidden, so one a Location stops offering is
   * removed from the list (`LibraryRemove`).
   */
  dye2Key?: (typeof DYE2_LISTS)[Dye2List];
}

/**
 * Each kind of Library item the server shares with tablets, described once
 * (`LIBRARY.md`, Adding a Library kind), in the order its lists are read and
 * written: Beans, Bean Batches, Grinders and Profiles, through Decaid's API,
 * then Baskets, Tools and Recipes, through DYE2's lists in Decaid's store
 * (ADR-0005), Recipes last, as they name the others by their ids on the
 * tablet. A Profile keeps Decaid's id, a hash of what the machine executes
 * that is the same on every tablet (ADR-0006); every other kind's is its
 * global id.
 */
export const LIBRARY_ITEM_KINDS = {
  bean: { list: "beans", id: GLOBAL_ITEM_ID },
  beanBatch: { list: "beanBatches", id: GLOBAL_ITEM_ID, under: "bean" },
  grinder: { list: "grinders", id: GLOBAL_ITEM_ID },
  profile: { list: "profiles", id: { test: isRecordId, problem: `must be a Profile's id of 1 to ${MAX_RECORD_ID_LENGTH} characters without NUL` } },
  basket: { list: "dye2Baskets", id: GLOBAL_ITEM_ID, dye2Key: "baskets" },
  tool: { list: "dye2Equipment", id: GLOBAL_ITEM_ID, dye2Key: "equipment" },
  recipe: { list: "dye2Recipes", id: GLOBAL_ITEM_ID, dye2Key: "recipes" },
} as const satisfies Readonly<Record<string, LibraryKindDescription>>;

/** The kinds of Library item the server writes to tablets, in the order of LIBRARY_ITEM_KINDS. */
export type LibraryKind = keyof typeof LIBRARY_ITEM_KINDS;

export const LIBRARY_KINDS = Object.keys(LIBRARY_ITEM_KINDS) as readonly LibraryKind[];

export function isLibraryKind(kind: string): kind is LibraryKind {
  return Object.prototype.hasOwnProperty.call(LIBRARY_ITEM_KINDS, kind);
}

/** The kind of Library item whose records a list holds. */
export type LibraryList = (typeof LIBRARY_ITEM_KINDS)[LibraryKind]["list"];

/**
 * The collections that are the tablet's Library lists, one for each kind.
 * Decaid writes each of their records' `updatedAt` in the tablet's local
 * time without an offset, so the plugin sends each placed in UTC beside the
 * list.
 */
export const LIBRARY_LISTS: readonly LibraryList[] = LIBRARY_KINDS.map((kind) => LIBRARY_ITEM_KINDS[kind].list);

export function isLibraryList(name: string): name is LibraryList {
  return (LIBRARY_LISTS as readonly string[]).includes(name);
}

/** The key of Decaid's store a kind DYE2 keeps is listed under (`LibraryKindDescription.dye2Key`), or undefined for a kind kept by Decaid's API. */
export function dye2Key(kind: LibraryKind): (typeof DYE2_LISTS)[Dye2List] | undefined {
  const description: LibraryKindDescription = LIBRARY_ITEM_KINDS[kind];
  return description.dye2Key;
}

/**
 * The global id a tablet's record of a Library item carries, or null if it
 * carries none: in its own top-level field for a kind DYE2 keeps
 * (`dye2GlobalIdOf`), and in its `extras` otherwise (`globalIdOf`). A
 * Profile's records carry none, their id being Decaid's.
 */
export function recordGlobalId(kind: LibraryKind, record: unknown): string | null {
  return dye2Key(kind) === undefined ? globalIdOf(record) : dye2GlobalIdOf(record);
}

/** The kind whose records the list holds. */
export function listKind(list: LibraryList): LibraryKind {
  return LIBRARY_KINDS.find((kind) => LIBRARY_ITEM_KINDS[kind].list === list)!;
}

/**
 * The kind whose records a kind's records are made under
 * (`LibraryKindDescription.under`), if any: one listed before it, whose own
 * records are made under none, as records are nested one deep. Throws
 * otherwise, which REMOVAL_ORDER, read as this module loads, finds.
 */
export function parentKind(kind: LibraryKind): LibraryKind | undefined {
  const { under }: LibraryKindDescription = LIBRARY_ITEM_KINDS[kind];
  if (under === undefined) return undefined;
  const parent: LibraryKindDescription | undefined = isLibraryKind(under) ? LIBRARY_ITEM_KINDS[under] : undefined;
  if (!isLibraryKind(under) || LIBRARY_KINDS.indexOf(under) >= LIBRARY_KINDS.indexOf(kind) || parent?.under !== undefined) {
    throw new Error(`A ${kind}'s records are made under ${under}, which is no kind listed before it whose records are made under none`);
  }
  return under;
}

/** The kinds whose records are made under a kind's (`LibraryKindDescription.under`). */
export function childKinds(kind: LibraryKind): LibraryKind[] {
  return LIBRARY_KINDS.filter((child) => parentKind(child) === kind);
}

/** The list of the kind a list's records are made under (`parentKind`), if any: the beans, for the bean batches. */
export function parentList(list: LibraryList): LibraryList | undefined {
  const parent = parentKind(listKind(list));
  return parent === undefined ? undefined : LIBRARY_ITEM_KINDS[parent].list;
}

/** The lists of the kinds whose records are made under a list's (`childKinds`): the bean batches, for the beans. */
export function childLists(list: LibraryList): LibraryList[] {
  return childKinds(listKind(list)).map((kind) => LIBRARY_ITEM_KINDS[kind].list);
}

/**
 * The kinds in the order a tablet's records of them are deleted or set
 * aside: the order of LIBRARY_ITEM_KINDS, but each kind after the kinds
 * whose records are made under it, as Decaid refuses to delete a bean that
 * has batches.
 */
export const REMOVAL_ORDER: readonly LibraryKind[] = LIBRARY_KINDS.filter((kind) => parentKind(kind) === undefined).flatMap((kind) => [...childKinds(kind), kind]);

/**
 * What the server writes to a tablet as its Machine joins a Location that
 * does not offer the grinder, batch or Basket its Workflow names: that
 * Workflow's grinder, batch and Basket, cleared (ADR-0008). A `write` of
 * this kind carries them.
 */
export const WORKFLOW_KIND = "workflow";

/**
 * The fields of a Workflow naming its grinder, its batch, and its Basket, by
 * their paths, each group's id first, which a write of WORKFLOW_KIND clears
 * together: the grinder and batch as Decaid's `WorkflowContext.clearGrinder`
 * and `clearBeanBatch` do (decaid:lib/src/models/data/workflow_context.dart),
 * the grinder with its burrs, and the Basket as Streamline's
 * `clearDyeWorkflowContext` does (streamline-js:src/modules/dyeStrip.js), all
 * as DYE2 sets them: the grinder's setting and the RPM stay, and so do the
 * profile, dose and yield. A Workflow holds burrs only as a repeated Shot
 * brings them; Decaid replaces them with its grinder's as it stores a Shot
 * pulled naming one, but keeps them on a Shot pulled naming none.
 */
export const WORKFLOW_GRINDER = ["context.grinderId", "context.grinderModel", "context.grinderBurrs"] as const;
export const WORKFLOW_BATCH = ["context.beanBatchId", "context.coffeeName", "context.coffeeRoaster"] as const;
export const WORKFLOW_BASKET = ["context.extras.basketId", "context.extras.basketName"] as const;

/** The groups of fields a write of WORKFLOW_KIND clears, each whole. */
export const WORKFLOW_CLEARED = [WORKFLOW_GRINDER, WORKFLOW_BATCH, WORKFLOW_BASKET] as const;

/**
 * The recipe a tablet's Workflow is dialled in to, as DYE2 and Streamline
 * write it there by its path: the id of DYE2's record of it, which DYE2's
 * dashboard, its Select Recipe page and Streamline's DYE strip set as they
 * apply a recipe, and DYE2 clears (null) once the Workflow's profile moves off
 * the one it held when the id appeared (`workflowChanged` in
 * dye2:dye2-plugin/src/plugin.ts at v0.1.26, decentespresso/dye2#36). Decaid
 * copies the Workflow onto every Shot pulled with it, offline ones included.
 * The server reads the Machine's Loaded Recipe from it (ADR-0022), and the
 * plugin clears it, as DYE2 does, to unload one.
 */
export const DYE2_RECIPE_FIELD = "context.extras.dye.recipeId";

/** The id of DYE2's record of the recipe a Workflow names (DYE2_RECIPE_FIELD), as DYE2 reads it (`recipeIdOf`): text, a number as text; null for none. */
export function dye2RecipeIdOf(workflow: unknown): string | null {
  const id = workflowValueAt(workflow, DYE2_RECIPE_FIELD);
  if (typeof id === "number") return Number.isFinite(id) ? String(id) : null;
  return typeof id === "string" && id !== "" ? id : null;
}

/**
 * A profile as DYE2 fingerprints one to tell a change of profile, which
 * clears the Workflow's DYE2_RECIPE_FIELD (`profileFingerprint` in
 * dye2:dye2-plugin/src/utils/workflow-record.ts at v0.1.26): its title, tank
 * temperature and steps, but each step's temperature, and a step limiter of
 * value 0, which is none, read as none, as Streamline sends it
 * (decentespresso/dye2#32). Its target weight and volume are the yield,
 * which Streamline sends with the profile, so they are left out
 * (decentespresso/dye2#18). Null for none.
 */
export function dye2Fingerprint(profile: unknown): string | null {
  if (!isObject(profile)) return null;
  const steps = Array.isArray(profile.steps)
    ? profile.steps.map((step: unknown) => {
        if (!isObject(step)) return step;
        const { temperature: _, limiter, ...rest } = step;
        // Kept unless it is none, or of value 0, as DYE2 reads one (`limiter && Number(limiter.value) !== 0`).
        return { ...rest, limiter: Boolean(limiter) && Number(isObject(limiter) ? limiter.value : undefined) !== 0 ? limiter : null };
      })
    : profile.steps;
  return JSON.stringify({ title: profile.title, tank_temperature: profile.tank_temperature, steps });
}

/**
 * What the server writes into a tablet's Workflow for the Recipe it has
 * loaded (ADR-0022): the Recipe's fields that changed since the Workflow last
 * took them, where it holds them otherwise, as an edit of the Recipe made
 * anywhere reaches every Machine that has it loaded, or the clearing of the
 * Workflow's DYE2_RECIPE_FIELD, as the server unloads it. A `write` of this
 * kind carries them, named by the Recipe's global id.
 */
export const LOADED_RECIPE_KIND = "loadedRecipe";

/**
 * A Workflow's brew temperature, by its path: its profile's first step's
 * temperature. A write of LOADED_RECIPE_KIND setting it moves every step of
 * the profile by the same amount, as Streamline's Brew tile does
 * (`shiftedTemperatures` in streamline-js:src/modules/brew-temp.js), so the
 * profile keeps its shape.
 */
export const BREW_TEMPERATURE_FIELD = "profile.steps.0.temperature";

/**
 * A profile at a brew temperature, as Streamline's Brew tile sets one
 * (`profileAtBrewTemp` in streamline-js:src/modules/brew-temp.js) and DYE2
 * applies a recipe's: its first step at that temperature, and every other
 * moved by the same amount, so the profile keeps its shape however often it
 * is moved. Null for a profile with no usable first step temperature, which
 * is written none.
 */
export function profileAtBrewTemperature(profile: unknown, temperature: number): Record<string, unknown> | null {
  if (!isObject(profile) || !Array.isArray(profile.steps)) return null;
  const steps = profile.steps as unknown[];
  const temperatures = shiftedTemperatures(steps.map((step) => (isObject(step) ? step.temperature : undefined)), temperature);
  if (temperatures === null) return null;
  return { ...profile, steps: steps.map((step, index) => (isObject(step) ? { ...step, temperature: temperatures[index] } : step)) };
}

/**
 * Step temperatures moved so the first is `first` and the others keep their
 * distance from it, each rounded to 0.01 °C, a step with none set to `first`
 * (`shiftedTemperatures` in streamline-js:src/modules/brew-temp.js); null
 * where the first step has no usable temperature to measure from.
 */
export function shiftedTemperatures(base: readonly unknown[], first: number): number[] | null {
  const origin = base[0];
  if (base.length === 0 || !Number.isFinite(first) || typeof origin !== "number" || !Number.isFinite(origin)) return null;
  const shift = first - origin;
  const round = (value: number) => Math.round(value * 100) / 100;
  return base.map((value) => (typeof value === "number" && Number.isFinite(value) ? round(value + shift) : round(first)));
}

/**
 * The parts of a Workflow that follow its Loaded Recipe (ADR-0022): its
 * dose, yield, grind setting, RPM, Basket, Bean Batch, brew temperature and
 * the eleven steam, hot water and flush settings (RECIPE_SETTINGS, each part
 * named as the setting), and its Grinder and Profile, a change of which
 * there unloads it instead; each with the fields of the Workflow that hold
 * it, by their paths, its id or value first. A write of LOADED_RECIPE_KIND
 * sets a part's fields together: a Grinder with its model, a Basket with its
 * name, and a Bean Batch with its Bean's name and roaster, as DYE2 and a
 * load write them, a Profile whole, and a brew temperature as
 * BREW_TEMPERATURE_FIELD says.
 */
export const LOADED_RECIPE_PARTS = {
  profile: ["profile"],
  grinder: ["context.grinderId", "context.grinderModel"],
  dose: ["context.targetDoseWeight"],
  yield: ["context.targetYield"],
  grind: ["context.grinderSetting"],
  rpm: ["context.extras.rpm"],
  basket: ["context.extras.basketId", "context.extras.basketName"],
  batch: ["context.beanBatchId", "context.coffeeName", "context.coffeeRoaster"],
  brewTemperature: [BREW_TEMPERATURE_FIELD],
  steamTemperature: [RECIPE_SETTINGS.steamTemperature.workflow],
  steamDuration: [RECIPE_SETTINGS.steamDuration.workflow],
  steamFlow: [RECIPE_SETTINGS.steamFlow.workflow],
  steamStopTemperature: [RECIPE_SETTINGS.steamStopTemperature.workflow],
  hotWaterTemperature: [RECIPE_SETTINGS.hotWaterTemperature.workflow],
  hotWaterDuration: [RECIPE_SETTINGS.hotWaterDuration.workflow],
  hotWaterVolume: [RECIPE_SETTINGS.hotWaterVolume.workflow],
  hotWaterFlow: [RECIPE_SETTINGS.hotWaterFlow.workflow],
  flushTemperature: [RECIPE_SETTINGS.flushTemperature.workflow],
  flushDuration: [RECIPE_SETTINGS.flushDuration.workflow],
  flushFlow: [RECIPE_SETTINGS.flushFlow.workflow],
} as const satisfies Record<string, readonly [string, ...string[]]>;

/** A part of a Workflow that follows its Loaded Recipe (LOADED_RECIPE_PARTS). */
export type LoadedRecipePart = keyof typeof LOADED_RECIPE_PARTS;

/** The value a Workflow holds at a path, such as `context.extras.rpm`, a number naming an item of a list; undefined where it holds none. */
export function workflowValueAt(workflow: unknown, path: string): unknown {
  let value: unknown = workflow;
  for (const name of path.split(".")) value = isObject(value) ? value[name] : Array.isArray(value) && /^\d+$/.test(name) ? value[Number(name)] : undefined;
  return value;
}

/**
 * The body of a `PUT /workflow` setting each field given by its path to its
 * value, null clearing it: Decaid merges a Workflow's `context`, its
 * `extras`, and its steam, hot water and flush settings key by key.
 */
export function workflowPatch(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(fields)) {
    const names = path.split(".");
    let target = patch;
    for (const name of names.slice(0, -1)) {
      if (!isObject(target[name])) target[name] = {};
      target = target[name] as Record<string, unknown>;
    }
    target[names[names.length - 1]!] = value;
  }
  return patch;
}

/**
 * What a `write` writes: a Library item of one of LIBRARY_KINDS, a
 * Workflow's grinder, batch and Basket, cleared, or its Loaded Recipe's
 * fields.
 */
export type WrittenKind = LibraryKind | typeof WORKFLOW_KIND | typeof LOADED_RECIPE_KIND;

export function isWrittenKind(kind: string): kind is WrittenKind {
  return kind === WORKFLOW_KIND || kind === LOADED_RECIPE_KIND || isLibraryKind(kind);
}

/**
 * What the id of an item of that kind is: what a Library kind declares
 * (`LIBRARY_ITEM_KINDS`); otherwise a UUID: a Workflow's is the tablet's id,
 * a Loaded Recipe's is its Recipe's global id, and a kind this side does not
 * know is taken to have global ids.
 */
export function itemIdRule(kind: string): ItemIdRule {
  return isLibraryKind(kind) ? LIBRARY_ITEM_KINDS[kind].id : GLOBAL_ITEM_ID;
}

/**
 * Decaid has no steam on/off flag: a steam target temperature below this, in
 * °C, means steam is off (`De1Controller.updateWorkflowSettings`).
 */
export const STEAM_ON_FROM = 135;

/**
 * Asks the plugin to write one Library item to its tablet through Decaid's
 * API (ADR-0006). The server sends one at a time, and the next once this one
 * is answered with `written` or `writeRefused`. A write too large for one
 * frame comes in chunks, which the plugin puts back together.
 *
 * With no `localId`, the plugin creates the record, unless the tablet already
 * holds one carrying this global id, as when the answer to an earlier write
 * was lost: it answers with that one instead. Nor does it create one when an
 * unarchived record without a global id is the same item, such as a bean with
 * the same roaster and name (`beanMatchKey`) entered before the tablet
 * reported it: it writes only the global id to that record. Bean Batches and
 * Grinders are never the same item (ADR-0018). With a `localId`, it updates
 * that record.
 * Either way it sets only `fields`, and writes the global id into the
 * record's `extras`, keeping the other keys there. An update sets a field
 * only while the record holds the value `expected` names for it, as the
 * tablet last reported it: a field changed on the tablet since, such as a
 * barista's edit of a Bean's notes not yet reported, is kept, and reaches the
 * server in the answer, which leaves it out of `writtenFields`.
 *
 * A Bean Batch is created under its Bean: `fields.beanId` is the tablet's id
 * for the Bean's record, which the server writes first. Decaid's create
 * takes neither `archived` nor `weightRemaining`, setting the remaining
 * weight to `weight`, so the plugin writes those it is given in a second
 * request when they differ from what Decaid made. A Grinder's create takes no
 * `archived` either.
 *
 * A Profile keeps Decaid's id, which is its `globalId` and, on every tablet,
 * its `localId` (ADR-0006), and its record carries no global id. To create
 * one, the plugin posts `fields.profile`, with `fields.metadata` and with
 * `fields.parentId` if the tablet holds that Profile, as Decaid refuses a
 * parent it lacks. Decaid derives the record's id from the profile, and
 * answers with the record it holds already if it has one with that id,
 * hidden or deleted as it may be. So the plugin then sets
 * `fields.visibility` where the record has another (`PUT
 * /profiles/{id}/visibility`). To update one, it sets `fields.visibility`
 * alone, and its title, author and notes, where `fields` holds them, in
 * the record's `profile`, which Decaid's `PUT /profiles/{id}` takes whole:
 * they are outside the hash, so the record keeps its id (ADR-0006).
 *
 * A Basket or Tool lives in one of DYE2's lists in Decaid's store
 * (`dye2Key`, ADR-0005). The plugin reads the list, which must be in a shape
 * it recognises (`dye2Records`), or it answers `listUnrecognised` and writes
 * nothing; a key never written is an empty list. To create one, it answers
 * with a record already carrying the global id, as one whose answer was
 * lost, or writes only the global id to a record without one whose name is
 * the item's (`equipmentMatchKey`), entered before the tablet reported it
 * (`linked`); otherwise it adds a record with `fields`, a new random UUID as
 * its id, as DYE2 gives one, and its `createdAt`. To update one, it sets
 * `fields` on the record with `localId`, each only while it holds the value
 * expected, a null field left out. Either way the global id goes in the
 * record's own top-level field (`dye2GlobalIdOf`), and the plugin posts the
 * list back whole. Its answer's `updatedAt` is when the plugin wrote it, as
 * these records carry no edit time.
 *
 * A Recipe lives in DYE2's `recipes` the same way, under its record id, the
 * same on every tablet at its Location, which never changes (ADR-0005).
 * `fields` name its record's fields by their path, a field of its
 * `dashboardVariables` as `dashboardVariables.dose`, and so does `expected`.
 * To create one, `fields.id` is its record id: the plugin answers with a
 * record of that id already carrying the global id, as one whose answer was
 * lost; writes only the global id to one of that id without one, saved there
 * before the tablet reported it (`linked`), which the server takes as an
 * edit of the Recipe; refuses an id whose record carries another item's
 * global id; and otherwise adds a record with `fields` and its `capturedAt`,
 * at the end of the list. To update one, it sets each of `fields` the
 * record still holds as expected, a null one left out. Either way the
 * global id goes in the record's own field. A write setting a record's
 * RECIPE_SLOT_FIELD to a Recipe Slot clears it (null) on any other record in
 * that slot, in the same post, as DYE2's editor does (`takeSlot`), so a slot
 * holds one recipe on every tablet. And before it posts a list that removes
 * the record the Workflow's DYE2_RECIPE_FIELD names, or gives its id to
 * another item's record, the plugin clears that field, so the Workflow never
 * names another Recipe than it applied.
 *
 * A write of WORKFLOW_KIND clears the grinder, batch and Basket of the
 * tablet's Workflow, as its Machine joins a Location that does not offer
 * them (ADR-0008): `globalId` is the tablet's id, `localId` null, and
 * `fields` names one or more of WORKFLOW_CLEARED's groups, each field null,
 * with `expected` the values the Workflow held for them as the tablet last
 * reported it. The plugin reads the tablet's Workflow and clears, through
 * `PUT /workflow` (`workflowPatch`), each group whole, only while it still
 * names it by the id expected (`context.grinderId`, `context.beanBatchId`,
 * `context.extras.basketId`): a barista who picked another grinder, batch
 * or Basket since keeps it.
 * Decaid needs no machine for this. Its answer's `record` is the Workflow's
 * `context` as Decaid returned it, and its `updatedAt` when the plugin had
 * Decaid's answer, by its own clock, as a Workflow carries no time. The
 * plugin's own write is not sent back as a change of the tablet's Workflow
 * ahead of its answer, so the server never reads it as one: the Workflow
 * change it causes is sent after the answer.
 *
 * A write of LOADED_RECIPE_KIND writes into the tablet's Workflow the
 * fields of its Loaded Recipe that the Workflow is due (ADR-0022):
 * `globalId` is the Recipe's global id, `localId` null, and `fields` names
 * the fields of LOADED_RECIPE_PARTS to set, each part's fields together,
 * with `expected` the value the Workflow held of each part's first field as
 * the tablet last reported it, null for none, but for a Profile, which
 * carries none, as a skin overrides parts of the one it loads; or it names
 * DYE2_RECIPE_FIELD alone, null, as the server unloads the Recipe. Either
 * way `expected` names the id of the tablet's record of the Recipe at
 * DYE2_RECIPE_FIELD, and the plugin writes nothing unless the Workflow it
 * reads first still names it there, so a write never lands in a recipe a
 * barista applied in the moment between. An unload sets DYE2_RECIPE_FIELD
 * null, as DYE2 does, and nothing else. Otherwise the plugin sets, through
 * `PUT /workflow` (`workflowPatch`), each part whose first field still holds
 * the value expected, or the value written already, as one DYE2 saved that
 * the server did not hold, or that expects none: a part a barista changed
 * since, or cleared, is kept, which its Workflow change brings to the
 * server. A write that changes the profile, as DYE2 fingerprints one
 * (`dye2Fingerprint`), which DYE2 clears DYE2_RECIPE_FIELD on, is made as two:
 * DYE2_RECIPE_FIELD cleared, then the write with the Recipe's id set there
 * again, so DYE2 takes the new profile as the recipe's (interim, until
 * decentespresso/dye2#38); the Workflow's changes between them are not sent.
 * A steam temperature is never written into a Workflow whose steam is off
 * (`steamOff`), as it would turn steam on: the plugin leaves it out, and
 * keeps it as the one Streamline turns steam back on at (ADR-0021). Decaid
 * refuses to change the steam, hot water and flush settings while no
 * machine is connected (MACHINE_SETTING_PARTS), so the rest is then written
 * without them. Its answer's `record` is the Workflow's `context`, its
 * steam, hot water and flush settings and its `profile` as Decaid returned
 * them, timed as a WORKFLOW_KIND write's is, and the Workflow change it
 * causes is sent after the answer, as that write's is.
 */
export interface LibraryWrite {
  type: "write";
  /** Names this write, which its answer repeats. */
  id: string;
  /** One of LIBRARY_KINDS, WORKFLOW_KIND or LOADED_RECIPE_KIND. A plugin answers a kind it does not know with `writeRefused`. */
  kind: string;
  /** The item's global id, a Profile's id, the tablet's id for a Workflow, or a Loaded Recipe's global id (`itemIdRule`). */
  globalId: string;
  /** The tablet's record to update, or null to create one. */
  localId: string | null;
  /** The record's fields to set, as Decaid names them: on creating, its content. */
  fields: Record<string, unknown>;
  /**
   * On updating, the value the record held for each of `fields` as the
   * tablet last reported it, null for none: the plugin sets a field only
   * while the record still holds it.
   */
  expected?: Record<string, unknown>;
  /**
   * When the latest edit of the item's content the write carries was
   * decided, by the server's database clock: a UTC time the plugin repeats
   * in its answer, so the server knows what the record it answers with has
   * seen even when the answer comes after the server stopped awaiting it.
   */
  contentDecidedAt?: string;
}

/**
 * The plugin's answer to a `write` Decaid carried out: the record as Decaid
 * returned it, which the server records as the tablet's version of the item.
 * The server acknowledges it with `ack` once recorded.
 *
 * The plugin reads the tablet's lists of the kinds it writes and carries
 * out writes one at a time, and sends answers through its outbox, behind
 * every report it read before the write. So the server takes in a report
 * read before a write before that write's answer, and never reads an item it
 * wrote as deleted from a report that predates it. An answer the
 * connection's drop held back is sent on the next connection, ahead of every
 * report read after the write, and the server records it there too, as it
 * does one arriving after its write timed out, though not as the answer to
 * a write that connection asked for.
 */
export interface ItemWritten {
  type: "written";
  /** The write's id. */
  id: string;
  kind: string;
  /** The write's `globalId`. */
  globalId: string;
  /** The record as Decaid returned it, its global id in `extras` but for a Profile's. */
  record: Record<string, unknown>;
  /** The record's `updatedAt`, read as the tablet's local time and placed in UTC; null if it cannot be read. */
  updatedAt: string | null;
  /**
   * The names of the fields the write set, as it named them. The plugin reads
   * a record before it updates it, and Decaid keeps the fields it is not sent,
   * so every other field the record holds is as the tablet had it, a change
   * made there since its last report included. The server reads such changes
   * from the answer, whether or not it still awaits it.
   */
  writtenFields: string[];
  /**
   * Set when the write was to create a Bean, and the plugin found the tablet
   * holding the same coffee without a global id, entered there before it was
   * reported, and wrote only the global id to it: the record is linked to the
   * Bean, and so takes the Bean's content, each field it held otherwise kept
   * as a Conflict (ADR-0018).
   */
  linked?: boolean;
  /** The write's `contentDecidedAt`, repeated. */
  contentDecidedAt?: string;
}

/**
 * The plugin's answer to a `write` Decaid refused, or could not be asked to
 * carry out, sent as `written` is. The server acknowledges it with `ack` and
 * goes on to its next write.
 */
export interface WriteRefused {
  type: "writeRefused";
  /** The write's id. */
  id: string;
  kind: string;
  globalId: string;
  /** Decaid's HTTP status, such as 400 or 404, or null if Decaid did not answer. */
  status: number | null;
  /** What Decaid answered, or why it could not be asked, cut to MAX_REFUSAL_LENGTH. */
  error: string;
}

/**
 * Asks the plugin to delete a tablet's record of a Library item an Admin
 * hard-deleted (ADR-0003): a Bean, Bean Batch, Grinder or Profile no Shot
 * names, or a record of a kind DYE2 keeps, which is removed from its list as
 * a `remove` does. The server sends it as it sends a `write`, one at a time with them,
 * and it is answered with `deleted` or `writeRefused`. The plugin deletes the
 * record unless it carries another item's global id (ANOTHER_ITEMS_RECORD),
 * as one the server mapped may not carry one yet, or a Shot the plugin queued
 * since it loaded, or has yet to send, names it, or one of a bean's batches;
 * and a bean only once its batches are deleted, as Decaid refuses to delete a
 * bean that has any: so it deletes the bean's batches first, as DYE2 does. A
 * Profile's record carries no global id, its id being Decaid's, the same on
 * every tablet, and is purged, as Decaid's delete only marks it deleted. A
 * record already gone is deleted.
 */
export interface LibraryDelete {
  type: "delete";
  /** Names this delete, which its answer repeats. */
  id: string;
  /** One of LIBRARY_KINDS (`isDeletedKind`). A plugin answers a kind it does not know with `writeRefused`. */
  kind: string;
  /** The deleted item's global id, which the record carries; a Profile's is Decaid's id, as its record's is. */
  globalId: string;
  /** The tablet's record to delete. */
  localId: string;
}

/**
 * Asks the plugin to remove a tablet's record of a Library item from one of
 * DYE2's lists, as its Machine's Location no longer offers the item: DYE2
 * cannot archive or hide a record (ADR-0005, ADR-0008), so the record is
 * removed, and the tablet's Shots keep the names DYE2 stored on them. The
 * server sends it as it sends a `write`, one at a time with them, and it is
 * answered with `removed`, `writeRefused` or `listUnrecognised`. The plugin
 * reads the list, leaves out the record and posts the list back, unless the
 * record carries another item's global id (ANOTHER_ITEMS_RECORD), or differs
 * from the record the server last knew the tablet to hold (`expected`), as
 * one a barista changed since the plugin last read the list
 * (RECORD_CHANGED): the server then has the plugin report the list, takes
 * the change in, and asks again. A record already gone is removed.
 */
export interface LibraryRemove {
  type: "remove";
  /** Names this request, which its answer repeats. */
  id: string;
  /** A kind DYE2 keeps (`dye2Key`). A plugin answers a kind it does not know with `writeRefused`. */
  kind: string;
  /** The item's global id. */
  globalId: string;
  /** The tablet's record to remove. */
  localId: string;
  /** The record as the server last knew the tablet to hold it, which the plugin removes only while the tablet's still is; absent for any. */
  expected?: Record<string, unknown>;
}

/**
 * The plugin's answer to a `remove` it carried out, or that found the record
 * gone: the tablet holds the record no more. Sent as `written` is, through
 * the outbox, behind every report read before it.
 */
export interface ItemRemoved {
  type: "removed";
  /** The request's id. */
  id: string;
  kind: string;
  globalId: string;
  localId: string;
}

/**
 * The plugin's answer to a `write`, `remove`, `delete` or `leaveOut` of a
 * kind DYE2 keeps, when the tablet's list of it is in a shape the plugin
 * does not recognise (`dye2Records`): nothing was written to it. The server
 * writes nothing more to that list on that tablet until the tablet reports
 * it in a shape it recognises, and shows it in the Machine's sharing status
 * (ADR-0005). Sent as `written` is.
 */
export interface ListUnrecognised {
  type: "listUnrecognised";
  /** The request's id. */
  id: string;
  kind: string;
}

/**
 * The error of a `writeRefused` answering a `delete` whose record carries
 * another item's global id: it is not the deleted item's, so the server takes
 * it in again rather than asking for its delete.
 */
export const ANOTHER_ITEMS_RECORD = "The record carries another item's global id";

/** Why the plugin refused a `remove` of a record that differs from the one the server expected (`LibraryRemove.expected`): changed since the plugin last read the list. */
export const RECORD_CHANGED = "The record changed since the plugin last read the list";

/**
 * The error of a `writeRefused` answering a `delete` the plugin cannot judge
 * yet: more Shots are still to be read and sent than it reads to see whether
 * one names the record, as during a backfill. The server asks again on the
 * same connection a little later, rather than skipping it until the next.
 */
export const SHOTS_STILL_TO_READ = "More Shots are still to be sent than a delete reads; ask again once they are";

/**
 * The machine state Decaid reports (`stateUpdate`) while its machine pulls a
 * Shot, during which it rewrites the frames the machine runs whenever the
 * Workflow's profile changes (ADR-0022).
 */
export const SHOT_STATE = "espresso";

/**
 * The error of a `writeRefused`, or a `leftOut` refused, answering a change
 * the plugin held while its Machine pulled a Shot (ADR-0022): it carries out
 * none of the server's changes from the moment the machine state is
 * SHOT_STATE until Decaid has stored the Shot, and answers the one it held
 * so once the Shot is stored, or after a while if it is still being pulled.
 * The server plans the tablet's changes afresh at once, so what it then
 * writes holds what changed meanwhile.
 */
export const PULLING_SHOT = "The Machine was pulling a Shot; ask again";

export type DeletedKind = LibraryKind;

/**
 * Whether an Admin hard-deletes items of that kind from tablets: every
 * Library kind, as a tablet holds records of each. A tablet's own delete of a
 * Profile only hides it at its Location (ADR-0019).
 */
export function isDeletedKind(kind: string): kind is DeletedKind {
  return isLibraryKind(kind);
}

/**
 * The plugin's answer to a `delete` Decaid carried out, or that found the
 * record gone: the tablet holds the record no more. Sent as `written` is,
 * through the outbox, behind every report read before it.
 */
export interface ItemDeleted {
  type: "deleted";
  /** The delete's id. */
  id: string;
  kind: string;
  globalId: string;
  localId: string;
}

/**
 * Asks the plugin to set aside a tablet's record the Library leaves out, as
 * its Machine joined a Location that offers items of that kind already
 * (ADR-0018): to archive a bean, bean batch or grinder, or hide a profile,
 * so the tablet offers only what its Location does. The record carries no
 * global id, and is never deleted, so the tablet's Shots still find it, but
 * for one of a kind DYE2 keeps, which cannot be archived or hidden: it is
 * removed from its list, and not kept (ADR-0005), and answered as set
 * aside. The
 * server sends it as it sends a `write`, one at a time with them, and it is
 * answered with `leftOut`. The plugin sets aside only a record without a
 * global id, and changes nothing else of it.
 */
export interface LeaveOut {
  type: "leaveOut";
  /** Names this request, which its answer repeats. */
  id: string;
  /** One of LIBRARY_KINDS (`isDeletedKind`), the kinds a tablet holds records of. A plugin answers a kind it does not know as `refused`. */
  kind: string;
  /** The tablet's record to set aside. */
  localId: string;
}

/**
 * What became of a `leaveOut`: the record is archived or hidden now, as it
 * was or as the plugin set it (`setAside`); the tablet holds no such record
 * (`gone`); it carries a global id now, as one a write made a Library
 * item's record (`taken`); or Decaid refused, or could not be asked
 * (`refused`).
 */
export const LEFT_OUT_OUTCOMES = ["setAside", "gone", "taken", "refused"] as const;

export type LeftOutOutcome = (typeof LEFT_OUT_OUTCOMES)[number];

/** The plugin's answer to a `leaveOut`, sent as `written` is, through the outbox, behind every report read before it. */
export interface ItemLeftOut {
  type: "leftOut";
  /** The request's id. */
  id: string;
  kind: string;
  localId: string;
  outcome: LeftOutOutcome;
  /** For `refused`: Decaid's HTTP status, or null if Decaid did not answer. */
  status?: number | null;
  /** For `refused`: what Decaid answered, or why it could not be asked, cut to MAX_REFUSAL_LENGTH. */
  error?: string;
}

/**
 * How long a Settings Edit has to be answered from when it was made, by
 * PostgreSQL's clock (ADR-0023): the time it has left (`timeLeftMs`) counts
 * down from this. One unanswered by then, or whose connection stopped
 * holding its Machine first, is not confirmed; an answer arriving after
 * that still counts, marked late, but for an `expired` refusal.
 */
export const SETTINGS_EDIT_MS = 60_000;

/**
 * The least time a Settings Edit must have left for the plugin to start its
 * write, so a write it starts has time to finish within SETTINGS_EDIT_MS:
 * with less, it refuses the edit as `expired`. A write started in time can
 * still finish later, as Decaid writes fields one at a time.
 */
export const SETTINGS_EDIT_WRITE_MARGIN_MS = 15_000;

/**
 * Asks the plugin to carry out a Settings Edit made in the management
 * interface (ADR-0023): one write of a settings collection's fields through
 * Decaid's API, made only while its Machine is online and sent only on the
 * connection that held the Machine as it was made. The plugin carries out
 * Settings Edits one at a time, in the order they arrive, in a queue of
 * their own beside its reads of the settings collections, apart from the
 * Library's writes, and keeps none across an unload. For each, it refuses
 * it as `expired` once the connection that sent it has closed, or where it
 * would start the write with less than SETTINGS_EDIT_WRITE_MARGIN_MS of
 * `timeLeftMs` left; reads the machine's state, and goes ahead only while
 * the machine is idle (SETTINGS_EDIT_STATES); reads the collection, and
 * goes ahead only while each field still holds its `expected` value; checks
 * the fields against their definitions again (`validateSettingsEdit`),
 * writing none without one; writes only the edit's fields; and then,
 * whether Decaid took the write or not, reads the collection again and
 * sends it as a `collection` delivery before its answer, `settingsEdited`.
 * A `sensorCalibration` edit sets one sensor target's current value, read
 * and set by target: it reads that target for the check, sets it from that
 * read's value (an absolute set, as Streamline's), and reads it again after,
 * sending the collection with it and the other targets as last read, or
 * with all three read again where the last read was unavailable.
 */
export interface SettingsEdit {
  type: "settingsEdit";
  /** The edit's id, a UUID, which its answer repeats. */
  id: string;
  /** The settings collection it changes, one of EDITABLE_SETTINGS_COLLECTIONS. A plugin answers one it does not write as refused by `decaid`, with a null status. */
  collection: string;
  /** Each field it sets, by its path in the collection, with its new value; for `sensorCalibration`, its one target with its `measuredValue`. */
  fields: Record<string, unknown>;
  /**
   * The value each of `fields` held in the report the edit was made over, as
   * the plugin sent it: the plugin writes only while the tablet still holds
   * each, compared as `sameValue` does.
   */
  expected: Record<string, unknown>;
  /**
   * How long it has left, in ms, of SETTINGS_EDIT_MS since it was made, as
   * the server sent it: the plugin counts it down from when it arrives, by
   * its own clock.
   */
  timeLeftMs: number;
}

/**
 * The machine states Decaid names (`MachineState` in
 * decaid:lib/src/models/device/machine.dart) in which the plugin carries out
 * a Settings Edit: the machine is running nothing. In any other, such as a
 * Shot, steam, hot water, a flush or a cleaning cycle, it refuses the edit
 * as `machineBusy`.
 */
export const SETTINGS_EDIT_STATES = ["idle", "schedIdle", "sleeping", "needsWater"] as const;

/**
 * Why the plugin did not carry out a Settings Edit, or Decaid refused it:
 *
 * - `machineBusy`: the machine was running something, named by its state;
 * - `changedSince`: a field it sets no longer held its expected value, as
 *   one changed on the tablet since the report the edit was made over;
 * - `expired`: the plugin got it too late to write it in time: its
 *   connection closed, or it had less than SETTINGS_EDIT_WRITE_MARGIN_MS
 *   left. Nothing was written. Answered after the edit was marked not
 *   confirmed, it leaves that mark;
 * - `decaid`: Decaid refused a read or the write, or did not answer, or was
 *   not asked, as for a collection or field this plugin does not write.
 */
export const SETTINGS_EDITED_REFUSALS = ["machineBusy", "changedSince", "expired", "decaid"] as const;

export type SettingsEditedRefusal = (typeof SETTINGS_EDITED_REFUSALS)[number];

/**
 * The plugin's answer to a `settingsEdit`, sent through its outbox behind
 * the report of the collection read after the write, so the server takes in
 * the read-back before the answer. Acknowledged with `ack` once recorded, by
 * whichever server instance it reaches, on this connection or a later one.
 */
export interface SettingsEdited {
  type: "settingsEdited";
  /** The edit's id. */
  id: string;
  /** `written`: Decaid took the write; `refused`: the plugin did not ask it to, or Decaid refused (`reason`). */
  outcome: "written" | "refused";
  /** Why it was refused; absent once written. */
  reason?: SettingsEditedRefusal;
  /** For `machineBusy`: the machine's state, as Decaid names it. */
  state?: string;
  /**
   * The edit's fields as the plugin read them: once written, or refused by
   * Decaid, as read back after the write, which shows any field Decaid
   * applied before refusing, as its settings writes are not atomic; for
   * `changedSince`, as the tablet holds them now. Absent where that read
   * failed, or nothing was read. A field the read did not hold is absent.
   */
  values?: Record<string, unknown>;
  /** For `decaid`: Decaid's HTTP status, or null if Decaid did not answer or was not asked. */
  status?: number | null;
  /** For `decaid`: what Decaid answered (its `error` or `message`), or why it did not answer or was not asked, cut to MAX_REFUSAL_LENGTH. */
  message?: string;
}

/** The most of Decaid's answer a `writeRefused` repeats, in UTF-16 code units. */
export const MAX_REFUSAL_LENGTH = 1000;

/** The most field names a `written` may list; a Library record has a few dozen fields. */
export const MAX_WRITTEN_FIELDS = 1000;

/** A logical delivery acknowledged only after its transaction commits. */
export interface Ack {
  type: "ack";
  id: string;
}

/**
 * Sent by the server for every chunk it receives, so the plugin knows the
 * chunk has left the tablet and can send more. It says nothing about
 * storage: a chunked delivery is acknowledged once, by its `ack`.
 */
export interface ChunkReceived {
  type: "chunkReceived";
  /** The chunk's `id`. */
  id: string;
  /** The chunk's `index`. */
  index: number;
}

/** Messages the plugin sends, each in a frame of its own or in chunks. */
export type PluginMessage =
  | Hello
  | Heartbeat
  | ShotDelivery
  | ShotIndex
  | SteamDelivery
  | SteamIndex
  | WorkflowDelivery
  | MachineStateDelivery
  | CollectionDelivery
  | ItemWritten
  | ItemDeleted
  | ItemRemoved
  | ItemLeftOut
  | ListUnrecognised
  | WriteRefused
  | SettingsEdited;
/** Messages the server sends, each in a frame of its own or, a `write` too large for one, in chunks. */
export type ServerMessage =
  | Welcome
  | Heartbeat
  | ErrorMessage
  | RequestShots
  | RequestSteams
  | RequestCollections
  | CaptureOnly
  | Ack
  | ChunkReceived
  | LibraryWrite
  | LibraryDelete
  | LibraryRemove
  | LeaveOut
  | SettingsEdit;

export type Decoded<T> =
  | { ok: true; message: T }
  | {
      ok: false;
      error: Extract<ErrorCode, "protocol_error" | "plugin_too_old" | "decaid_too_old">;
      problem: string;
      /**
       * The token of a `hello` refused for its protocol or Decaid version, so
       * the server can show the reason on that token's Machine. Never log it.
       */
      token?: string;
    };

export function encode(message: PluginMessage | ServerMessage): string {
  return JSON.stringify(message);
}

/** Reads a frame the plugin sent: a whole message, or a chunk of one too large for a frame. */
export function decodePluginFrame(frame: string): Decoded<PluginMessage | Chunk> {
  const object = parseObject(frame);
  if (typeof object === "string") return invalid(object);
  if (object.type !== "chunk") return decodeMessage(object);
  return check<Chunk>(object, "chunk", (fields) => {
    fields.id();
    fields.integer("index", { nonNegative: true });
    fields.integer("count", { positive: true });
    fields.string("data");
  });
}

/**
 * Reads a whole message from the plugin: a frame that is not a chunk, or the
 * encoding a message's chunks were put back together into.
 */
export function decodePluginMessage(text: string): Decoded<PluginMessage> {
  const object = parseObject(text);
  if (typeof object === "string") return invalid(object);
  if (object.type === "chunk") return invalid("A chunked message must not be a chunk itself");
  return decodeMessage(object);
}

/**
 * Reads a Workflow or machine state delivery as `decodePluginMessage` does,
 * for the plugin, which keeps them in Decaid's plugin storage across unloads
 * and sends only those the server would take.
 */
export function decodeMachineEvent(text: string): Decoded<WorkflowDelivery | MachineStateDelivery> {
  const object = parseObject(text);
  if (typeof object === "string") return invalid(object);
  if (object.type !== "workflow" && object.type !== "machineState") return invalid("Not a Workflow or machine state delivery");
  return checkMachineEvent(object);
}

/** Checks a Workflow or machine state delivery, by its `type`. */
function checkMachineEvent(object: Fields & { type: string }): Decoded<WorkflowDelivery | MachineStateDelivery> {
  if (object.type === "workflow") {
    return check<WorkflowDelivery>(object, "workflow", (fields) => {
      fields.id();
      fields.instant("observedAt");
      fields.objectField("workflow");
      fields.optionalBoolean("dye2Absent");
      if (object.recipeNamedAt !== undefined) fields.instant("recipeNamedAt");
    });
  }
  return check<MachineStateDelivery>(object, "machineState", (fields) => {
    fields.id();
    fields.instant("observedAt");
    fields.string("state", { nonEmpty: true });
    fields.string("substate", { nonEmpty: true });
  });
}

/**
 * A `hello` is checked for its protocol version before anything else, so a
 * plugin too old to send today's `hello` is told it is too old rather than
 * that its message is invalid. A valid `hello` is then checked for its Decaid
 * version.
 */
function decodeMessage(object: Fields & { type: string }): Decoded<PluginMessage> {
  switch (object.type) {
    case "hello": {
      const version = object.protocolVersion;
      if (typeof version !== "number" || !Number.isInteger(version)) {
        return invalid("hello.protocolVersion must be a whole number");
      }
      // A hello of another version need not have today's fields, but a string token is kept.
      const token = typeof object.token === "string" && object.token !== "" ? { token: object.token } : {};
      if (version < OLDEST_SUPPORTED_PROTOCOL_VERSION) {
        return {
          ok: false,
          error: "plugin_too_old",
          problem: `The plugin speaks protocol version ${version}, but this server needs ${OLDEST_SUPPORTED_PROTOCOL_VERSION} or newer: update the plugin`,
          ...token,
        };
      }
      if (version > PROTOCOL_VERSION) {
        return {
          ...invalid(`The plugin speaks protocol version ${version}, newer than this server's ${PROTOCOL_VERSION}: update the server`),
          ...token,
        };
      }
      const hello = check<Hello>(object, "hello", (fields) => {
        fields.string("token", { nonEmpty: true });
        fields.string("pluginVersion");
        fields.string("decaidVersion", { nonEmpty: true });
        fields.uuid("tabletId");
        fields.optionalString("connectionId", { maxLength: MAX_HARDWARE_LENGTH });
        fields.optionalObject("machine", (machine) => {
          machine.string("model", { maxLength: MAX_HARDWARE_LENGTH });
          machine.string("serial", { maxLength: MAX_HARDWARE_LENGTH });
          machine.optionalString("firmware");
        });
        fields.optionalBoolean("yielding");
      });
      if (!hello.ok) return hello;
      const decaid = decaidRelease(hello.message.decaidVersion);
      if (decaid && supportedDecaid(decaid)) return hello;
      // Only the release numbers are repeated: they cannot hold a token.
      const runs = decaid
        ? `This tablet runs ${decaid.preRelease ? "a pre-release of " : ""}Decaid ${decaid.numbers.join(".")}`
        : "This tablet's Decaid reports no release version";
      return {
        ok: false,
        error: "decaid_too_old",
        problem: `${runs}, but this server needs ${OLDEST_SUPPORTED_DECAID} or newer: update Decaid`,
        token: hello.message.token,
      };
    }
    case "shot":
    case "shotUpdated":
      return check<ShotDelivery>(object, object.type, (fields) => {
        fields.id();
        fields.string("shotId", { nonEmpty: true });
        fields.objectField("shot");
      });
    case "shotIndex":
      return check<ShotIndex>(object, "shotIndex", (fields) => {
        fields.id();
        fields.array("shots", (value) => isObject(value) && typeof value.id === "string" && value.id !== "" &&
          (value.updatedAt === undefined || typeof value.updatedAt === "string"), 100);
      });
    case "steam":
      return check<SteamDelivery>(object, "steam", (fields) => {
        fields.id();
        fields.string("steamId", { nonEmpty: true });
        fields.instant("steamedAt");
        fields.objectField("steam");
      });
    case "steamIndex":
      return check<SteamIndex>(object, "steamIndex", (fields) => {
        fields.id();
        fields.array("steams", (value) => isObject(value) && typeof value.id === "string" && value.id !== "", 100);
      });
    case "workflow":
    case "machineState":
      return checkMachineEvent(object);
    case "collection":
      return check<CollectionDelivery>(object, "collection", (fields) => {
        fields.id();
        fields.string("name", { nonEmpty: true });
        fields.boolean("available");
        if (object.available === true) fields.present("value");
        else if (object.available === false) fields.absent("value");
        if (object.updatedAt !== undefined) {
          const length = Array.isArray(object.value) ? object.value.length : -1;
          fields.instants("updatedAt", length);
        }
        if (object.utcOffsetMinutes !== undefined) {
          if (object.available !== true) fields.absent("utcOffsetMinutes");
          else fields.integer("utcOffsetMinutes", { within: MAX_UTC_OFFSET_MINUTES });
        }
      });
    case "written":
      return check<ItemWritten>(object, "written", (fields) => {
        fields.id();
        fields.string("kind", { nonEmpty: true });
        fields.itemId("globalId", object.kind);
        fields.objectField("record");
        if (object.updatedAt !== null) fields.instant("updatedAt");
        fields.array("writtenFields", (value) => typeof value === "string", MAX_WRITTEN_FIELDS);
        fields.optionalBoolean("linked");
        if (object.contentDecidedAt !== undefined) fields.instant("contentDecidedAt");
      });
    case "deleted":
      return check<ItemDeleted>(object, "deleted", (fields) => {
        fields.id();
        fields.string("kind", { nonEmpty: true });
        fields.itemId("globalId", object.kind);
        fields.string("localId", { nonEmpty: true, maxLength: MAX_RECORD_ID_LENGTH });
      });
    case "removed":
      return check<ItemRemoved>(object, "removed", (fields) => {
        fields.id();
        fields.string("kind", { nonEmpty: true });
        fields.itemId("globalId", object.kind);
        fields.string("localId", { nonEmpty: true, maxLength: MAX_RECORD_ID_LENGTH });
      });
    case "listUnrecognised":
      return check<ListUnrecognised>(object, "listUnrecognised", (fields) => {
        fields.id();
        fields.string("kind", { nonEmpty: true });
      });
    case "leftOut":
      return check<ItemLeftOut>(object, "leftOut", (fields) => {
        fields.id();
        fields.string("kind", { nonEmpty: true });
        fields.string("localId", { nonEmpty: true, maxLength: MAX_RECORD_ID_LENGTH });
        fields.oneOf("outcome", LEFT_OUT_OUTCOMES);
        if (object.status !== undefined && object.status !== null) fields.integer("status", { nonNegative: true });
        if (object.error !== undefined) fields.string("error", { maxLength: MAX_REFUSAL_LENGTH });
      });
    case "writeRefused":
      return check<WriteRefused>(object, "writeRefused", (fields) => {
        fields.id();
        fields.string("kind", { nonEmpty: true });
        fields.itemId("globalId", object.kind);
        if (object.status !== null) fields.integer("status", { nonNegative: true });
        fields.string("error", { maxLength: MAX_REFUSAL_LENGTH });
      });
    case "settingsEdited":
      return check<SettingsEdited>(object, "settingsEdited", (fields) => {
        fields.uuid("id");
        fields.oneOf("outcome", ["written", "refused"]);
        if (object.outcome === "refused") fields.oneOf("reason", SETTINGS_EDITED_REFUSALS);
        else fields.absent("reason");
        if (object.reason === "machineBusy") fields.string("state", { nonEmpty: true, maxLength: MAX_HARDWARE_LENGTH });
        if (object.reason === "decaid") {
          if (object.status !== null) fields.integer("status", { nonNegative: true });
          fields.string("message", { maxLength: MAX_REFUSAL_LENGTH });
        }
        if (object.values !== undefined) fields.objectField("values");
      });
    case "heartbeat":
      return check<Heartbeat>(object, "heartbeat", () => {});
    default:
      return invalid("Unknown message type");
  }
}

/** Reads a frame the server sent: a whole message, or a chunk of one too large for a frame. */
export function decodeServerFrame(frame: string): Decoded<ServerMessage | Chunk> {
  const object = parseObject(frame);
  if (typeof object === "string") return invalid(object);
  if (object.type !== "chunk") return decodeServerObject(object);
  return check<Chunk>(object, "chunk", (fields) => {
    fields.id();
    fields.integer("index", { nonNegative: true });
    fields.integer("count", { positive: true });
    fields.string("data");
  });
}

/**
 * Reads a whole message from the server: a frame that is not a chunk, or the
 * encoding a message's chunks were put back together into.
 */
export function decodeServerMessage(text: string): Decoded<ServerMessage> {
  const object = parseObject(text);
  if (typeof object === "string") return invalid(object);
  if (object.type === "chunk") return invalid("A chunked message must not be a chunk itself");
  return decodeServerObject(object);
}

function decodeServerObject(object: Fields & { type: string }): Decoded<ServerMessage> {
  switch (object.type) {
    case "welcome":
      return check<Welcome>(object, "welcome", (fields) => {
        fields.integer("protocolVersion");
        fields.integer("heartbeatIntervalMs", { positive: true });
      });
    case "ack":
      return check<Ack>(object, "ack", (fields) => fields.string("id", { nonEmpty: true }));
    case "chunkReceived":
      return check<ChunkReceived>(object, "chunkReceived", (fields) => {
        fields.string("id", { nonEmpty: true });
        fields.integer("index", { nonNegative: true });
      });
    case "requestShots":
      return check<RequestShots>(object, "requestShots", (fields) => {
        fields.array("shotIds", (value) => typeof value === "string" && value !== "", 100);
      });
    case "requestSteams":
      return check<RequestSteams>(object, "requestSteams", (fields) => {
        fields.array("steamIds", (value) => typeof value === "string" && value !== "", 100);
      });
    case "requestCollections":
      return check<RequestCollections>(object, "requestCollections", () => {});
    case "captureOnly":
      return check<CaptureOnly>(object, "captureOnly", (fields) => fields.boolean("captureOnly"));
    case "heartbeat":
      return check<Heartbeat>(object, "heartbeat", () => {});
    case "error":
      return check<ErrorMessage>(object, "error", (fields) => {
        fields.string("code");
        fields.string("message");
      });
    case "write":
      return check<LibraryWrite>(object, "write", (fields) => {
        fields.id();
        fields.string("kind", { nonEmpty: true });
        fields.itemId("globalId", object.kind);
        if (object.localId !== null) fields.string("localId", { nonEmpty: true, maxLength: MAX_RECORD_ID_LENGTH });
        fields.objectField("fields");
        if (object.expected !== undefined) fields.objectField("expected");
        if (object.contentDecidedAt !== undefined) fields.instant("contentDecidedAt");
      });
    case "delete":
      return check<LibraryDelete>(object, "delete", (fields) => {
        fields.id();
        fields.string("kind", { nonEmpty: true });
        fields.itemId("globalId", object.kind);
        fields.string("localId", { nonEmpty: true, maxLength: MAX_RECORD_ID_LENGTH });
      });
    case "remove":
      return check<LibraryRemove>(object, "remove", (fields) => {
        fields.id();
        fields.string("kind", { nonEmpty: true });
        fields.itemId("globalId", object.kind);
        fields.string("localId", { nonEmpty: true, maxLength: MAX_RECORD_ID_LENGTH });
        if (object.expected !== undefined) fields.objectField("expected");
      });
    case "leaveOut":
      return check<LeaveOut>(object, "leaveOut", (fields) => {
        fields.id();
        fields.string("kind", { nonEmpty: true });
        fields.string("localId", { nonEmpty: true, maxLength: MAX_RECORD_ID_LENGTH });
      });
    case "settingsEdit":
      return check<SettingsEdit>(object, "settingsEdit", (fields) => {
        fields.uuid("id");
        fields.string("collection", { nonEmpty: true });
        fields.objectField("fields");
        fields.objectField("expected");
        fields.integer("timeLeftMs", { nonNegative: true });
      });
    default:
      return invalid("Unknown message type");
  }
}

interface DecaidRelease {
  numbers: [number, number, number];
  preRelease: boolean;
}

/**
 * The release a Decaid `fullVersion` names: the tag it was built from, then
 * `+` and a build number, such as 0.9.0+2977 or 0.9.0-beta.2+2970.
 */
function decaidRelease(version: string): DecaidRelease | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return null;
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], preRelease: match[4] !== undefined };
}

/** Whether a release is OLDEST_SUPPORTED_DECAID or newer. A pre-release comes before its release. */
function supportedDecaid(release: DecaidRelease): boolean {
  const oldest = decaidRelease(OLDEST_SUPPORTED_DECAID)!.numbers;
  for (const [index, number] of release.numbers.entries()) {
    if (number !== oldest[index]) return number > oldest[index]!;
  }
  return !release.preRelease;
}

type Fields = Record<string, unknown>;

/** Records what is wrong with an object's fields, by name and never by value. */
class FieldChecker {
  constructor(
    private readonly object: Fields,
    private readonly path: string,
    readonly problems: string[],
  ) {}

  string(key: string, options: { nonEmpty?: boolean; maxLength?: number } = {}): void {
    const value = this.object[key];
    if (typeof value !== "string") this.problem(key, "must be a string");
    else if (options.nonEmpty && value === "") this.problem(key, "must not be empty");
    else if (options.maxLength !== undefined && value.length > options.maxLength) {
      this.problem(key, `must be at most ${options.maxLength} characters`);
    }
  }

  /** The id of a delivery or a chunk. */
  id(): void {
    this.string("id", { nonEmpty: true, maxLength: MAX_ID_LENGTH });
  }

  /** A UUID, in either case, as a tablet id is. */
  uuid(key: string): void {
    if (!isTabletId(this.object[key])) this.problem(key, "must be a UUID");
  }

  /** The id of an item of the kind given, as that kind declares its ids (`itemIdRule`). */
  itemId(key: string, kind: unknown): void {
    const rule = itemIdRule(String(kind));
    if (!rule.test(this.object[key])) this.problem(key, rule.problem);
  }

  optionalString(key: string, options: { maxLength?: number } = {}): void {
    const value = this.object[key];
    if (value === undefined || value === null) return;
    if (typeof value !== "string") this.problem(key, "must be a string or null");
    else if (options.maxLength !== undefined && value.length > options.maxLength) {
      this.problem(key, `must be at most ${options.maxLength} characters`);
    }
  }

  integer(key: string, options: { positive?: boolean; nonNegative?: boolean; within?: number } = {}): void {
    const value = this.object[key];
    if (typeof value !== "number" || !Number.isInteger(value)) this.problem(key, "must be a whole number");
    else if (options.positive && value <= 0) this.problem(key, "must be positive");
    else if (options.nonNegative && value < 0) this.problem(key, "must not be negative");
    else if (options.within !== undefined && Math.abs(value) > options.within) this.problem(key, `must be from -${options.within} to ${options.within}`);
  }

  /** One of `values`. */
  oneOf(key: string, values: readonly string[]): void {
    if (!values.includes(this.object[key] as string)) this.problem(key, `must be one of ${values.join(", ")}`);
  }

  boolean(key: string): void {
    if (typeof this.object[key] !== "boolean") this.problem(key, "must be true or false");
  }

  optionalBoolean(key: string): void {
    const value = this.object[key];
    if (value !== undefined && typeof value !== "boolean") this.problem(key, "must be true or false");
  }

  objectField(key: string): void {
    if (!isObject(this.object[key])) this.problem(key, "must be an object");
  }

  /** Any JSON value but null. */
  present(key: string): void {
    const value = this.object[key];
    if (value === undefined || value === null) this.problem(key, "must be present and not null");
  }

  absent(key: string): void {
    if (this.object[key] !== undefined) this.problem(key, "must be absent");
  }

  /** A UTC instant as `Date.prototype.toISOString` writes it. Read back, it must be written the same, so times that do not exist, which Date rolls over, are refused. */
  instant(key: string): void {
    if (!isInstant(this.object[key])) this.problem(key, "must be a UTC time such as 2026-10-05T14:07:03.341Z");
  }

  /**
   * An array of `length` UTC instants, as `instant` reads one, or nulls. A
   * `length` below zero says there is nothing for it to go beside.
   */
  instants(key: string, length: number): void {
    const value = this.object[key];
    if (length < 0) this.problem(key, "must be absent unless value is a list");
    else if (!Array.isArray(value) || value.length !== length || !value.every((entry) => entry === null || isInstant(entry))) {
      this.problem(key, "must be an array as long as value, of UTC times such as 2026-10-05T14:07:03.341Z or nulls");
    }
  }

  array(key: string, valid: (value: unknown) => boolean, max: number): void {
    const value = this.object[key];
    if (!Array.isArray(value) || value.length > max || !value.every(valid)) {
      this.problem(key, `must be an array of at most ${max} valid entries`);
    }
  }

  optionalObject(key: string, checkFields: (fields: FieldChecker) => void): void {
    const value = this.object[key];
    if (value === undefined || value === null) return;
    if (!isObject(value)) {
      this.problem(key, "must be an object or null");
      return;
    }
    checkFields(new FieldChecker(value, `${this.path}.${key}`, this.problems));
  }

  private problem(key: string, what: string): void {
    this.problems.push(`${this.path}.${key} ${what}`);
  }
}

function check<T>(object: Fields, type: string, checkFields: (fields: FieldChecker) => void): Decoded<T> {
  const fields = new FieldChecker(object, type, []);
  checkFields(fields);
  if (fields.problems.length > 0) return invalid(fields.problems.join("; "));
  return { ok: true, message: object as T };
}

/** The frame as an object with a string `type`, or what is wrong with it. */
function parseObject(frame: string): (Fields & { type: string }) | string {
  let value: unknown;
  try {
    value = JSON.parse(frame);
  } catch {
    return "The frame is not JSON";
  }
  if (!isObject(value)) return "A message must be a JSON object";
  if (typeof value.type !== "string") return "A message must have a string type";
  return value as Fields & { type: string };
}

function isObject(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a value is a UTC instant as `Date.prototype.toISOString` writes it, naming a time that exists. */
function isInstant(value: unknown): boolean {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function invalid(problem: string): { ok: false; error: "protocol_error"; problem: string } {
  return { ok: false, error: "protocol_error", problem };
}
