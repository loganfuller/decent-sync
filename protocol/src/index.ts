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

/** The protocol version this build of the plugin and server speaks. */
export const PROTOCOL_VERSION = 1;

/**
 * The oldest protocol version the server accepts. Before v1 it is always
 * PROTOCOL_VERSION: a wire change older plugins can't follow raises both.
 * From v1 it is the version the previous release's plugin speaks (ADR-0017).
 */
export const OLDEST_SUPPORTED_PROTOCOL_VERSION = 1;

/**
 * The oldest Decaid release the server accepts, always a release rather than
 * a pre-release. Before v1 it is 0.8.7. From v1, each release sets it to the
 * second Decaid release tag before the newest, so tablets may run the newest
 * or either of the two before it (ADR-0017).
 */
export const OLDEST_SUPPORTED_DECAID = "0.8.7";

/** The path of the server's sync endpoint, under its public URL's host. */
export const SYNC_PATH = "/sync";

/**
 * Either end closes a connection it has heard nothing on for this many
 * heartbeat intervals, so neither waits on a dead one until TCP gives up.
 */
export const MISSED_HEARTBEATS = 3;

/** Why the server refused or ended a connection, sent in an `error` before it closes. */
export type ErrorCode = "protocol_error" | "bad_token" | "plugin_too_old" | "replaced" | "hardware_dismissed" | "decaid_too_old";

/** The WebSocket close code that goes with each error. */
export const CLOSE_CODES: Readonly<Record<ErrorCode, number>> = {
  /** A frame that is not a valid message here, including no `hello` in time. */
  protocol_error: 4000,
  /** The token is unknown or has been revoked. */
  bad_token: 4001,
  /** The plugin speaks a protocol version older than the server supports. */
  plugin_too_old: 4002,
  /** A newer connection with the same token took over. */
  replaced: 4003,
  /**
   * An Admin dismissed the hardware this tablet reports for this token: its
   * machine is not the one the token was issued for.
   */
  hardware_dismissed: 4004,
  /** The tablet runs a Decaid older than the server supports. */
  decaid_too_old: 4005,
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

/** The plugin's first message on every connection. */
export interface Hello {
  type: "hello";
  protocolVersion: number;
  token: string;
  pluginVersion: string;
  /** Decaid's full version, such as 0.8.7+2847. */
  decaidVersion: string;
  /** The connection id of Decaid's preferred machine: a Bluetooth address or USB id. */
  connectionId?: string | null;
  /** Absent or null while no machine is connected to the tablet. */
  machine?: MachineHardware | null;
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
export type PluginMessage = Hello | Heartbeat | ShotDelivery | ShotIndex | WorkflowDelivery | MachineStateDelivery;
export type ServerMessage = Welcome | Heartbeat | ErrorMessage | RequestShots | Ack | ChunkReceived;

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
    fields.string("id", { nonEmpty: true });
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
        fields.optionalString("connectionId");
        fields.optionalObject("machine", (machine) => {
          machine.string("model");
          machine.string("serial");
          machine.optionalString("firmware");
        });
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
        fields.string("id", { nonEmpty: true });
        fields.string("shotId", { nonEmpty: true });
        fields.objectField("shot");
      });
    case "shotIndex":
      return check<ShotIndex>(object, "shotIndex", (fields) => {
        fields.string("id", { nonEmpty: true });
        fields.array("shots", (value) => isObject(value) && typeof value.id === "string" && value.id !== "" &&
          (value.updatedAt === undefined || typeof value.updatedAt === "string"), 100);
      });
    case "workflow":
      return check<WorkflowDelivery>(object, "workflow", (fields) => {
        fields.string("id", { nonEmpty: true });
        fields.utcTime("observedAt");
        fields.objectField("workflow");
      });
    case "machineState":
      return check<MachineStateDelivery>(object, "machineState", (fields) => {
        fields.string("id", { nonEmpty: true });
        fields.utcTime("observedAt");
        fields.string("state", { nonEmpty: true });
        fields.string("substate", { nonEmpty: true });
      });
    case "heartbeat":
      return check<Heartbeat>(object, "heartbeat", () => {});
    default:
      return invalid("Unknown message type");
  }
}

/** Reads a frame the server sent. */
export function decodeServerMessage(frame: string): Decoded<ServerMessage> {
  const object = parseObject(frame);
  if (typeof object === "string") return invalid(object);

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
    case "heartbeat":
      return check<Heartbeat>(object, "heartbeat", () => {});
    case "error":
      return check<ErrorMessage>(object, "error", (fields) => {
        fields.string("code");
        fields.string("message");
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
 * `+` and a build number, such as 0.8.7+2847 or 0.8.8-beta.2+2860.
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

  string(key: string, options: { nonEmpty?: boolean } = {}): void {
    const value = this.object[key];
    if (typeof value !== "string") this.problem(key, "must be a string");
    else if (options.nonEmpty && value === "") this.problem(key, "must not be empty");
  }

  optionalString(key: string): void {
    const value = this.object[key];
    if (value !== undefined && value !== null && typeof value !== "string") this.problem(key, "must be a string or null");
  }

  integer(key: string, options: { positive?: boolean; nonNegative?: boolean } = {}): void {
    const value = this.object[key];
    if (typeof value !== "number" || !Number.isInteger(value)) this.problem(key, "must be a whole number");
    else if (options.positive && value <= 0) this.problem(key, "must be positive");
    else if (options.nonNegative && value < 0) this.problem(key, "must not be negative");
  }

  objectField(key: string): void {
    if (!isObject(this.object[key])) this.problem(key, "must be an object");
  }

  /** A time in UTC, as `Date.prototype.toISOString` writes one: 2026-10-05T14:05:43.648Z. */
  utcTime(key: string): void {
    const value = this.object[key];
    if (typeof value !== "string" || !isUtcTime(value)) this.problem(key, "must be a UTC time, such as 2026-10-05T14:05:43.648Z");
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

/**
 * Whether the text names a real time in UTC, to the millisecond at most.
 * `Date` rolls days and hours that do not exist over, February 30 into
 * March, so the time it reads must read back the same.
 */
function isUtcTime(text: string): boolean {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(text)) return false;
  const time = new Date(text);
  return Number.isFinite(time.getTime()) && time.toISOString().slice(0, 19) === text.slice(0, 19);
}

function invalid(problem: string): { ok: false; error: "protocol_error"; problem: string } {
  return { ok: false, error: "protocol_error", problem };
}
