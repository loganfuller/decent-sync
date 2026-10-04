// The wire contract between the plugin and the server. Both ends import it from
// here so they cannot drift apart. The plugin bundles it into an ES2020 script,
// so this package must not depend on Node or browser APIs.
//
// Every message is one JSON object in a WebSocket text frame, told apart by
// its `type`. Validators accept fields they do not know, so either end can add
// one without breaking the other, and never echo field values in the problems
// they report: a `hello` carries the Machine's token.

/** The protocol version this build of the plugin and server speaks. */
export const PROTOCOL_VERSION = 1;

/**
 * The oldest protocol version the server accepts. From the next protocol
 * release on, the server supports the current and the previous version.
 */
export const OLDEST_SUPPORTED_PROTOCOL_VERSION = 1;

/** The path of the server's sync endpoint, under its public URL's host. */
export const SYNC_PATH = "/sync";

/** Why the server refused or ended a connection, sent in an `error` before it closes. */
export type ErrorCode = "protocol_error" | "bad_token" | "plugin_too_old" | "replaced";

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
};

/** The hardware a machine reports while it is connected to its tablet. */
export interface MachineHardware {
  /** Decaid's model name, such as DE1Pro. */
  model: string;
  /** The serial number; older DE1s report "0". */
  serial: string;
  firmware?: string | null;
}

/** The plugin's first message on every connection. */
export interface Hello {
  type: "hello";
  protocolVersion: number;
  token: string;
  pluginVersion: string;
  /** Decaid's full version, such as 0.8.7+2850, when its API reports one. */
  decaidVersion?: string | null;
  /** The connection id of Decaid's preferred machine: a Bluetooth address or USB id. */
  connectionId?: string | null;
  /** Absent or null while no machine is connected to the tablet. */
  machine?: MachineHardware | null;
}

/** Sent by the plugin every `heartbeatIntervalMs` from `welcome`. */
export interface Heartbeat {
  type: "heartbeat";
}

/** The server's reply to an accepted `hello`. */
export interface Welcome {
  type: "welcome";
  protocolVersion: number;
  /** How often the plugin sends `heartbeat`; the server closes a connection silent for three intervals. */
  heartbeatIntervalMs: number;
}

/** Sent by the server just before it closes the connection with `CLOSE_CODES[code]`. */
export interface ErrorMessage {
  type: "error";
  code: ErrorCode;
  /** Says what went wrong, for the plugin's log. */
  message: string;
}

export type PluginMessage = Hello | Heartbeat;
export type ServerMessage = Welcome | ErrorMessage;

export type Decoded<T> =
  | { ok: true; message: T }
  | { ok: false; error: Extract<ErrorCode, "protocol_error" | "plugin_too_old">; problem: string };

export function encode(message: PluginMessage | ServerMessage): string {
  return JSON.stringify(message);
}

/**
 * Reads a frame the plugin sent. A `hello` is checked for its protocol version
 * before anything else, so a plugin too old to send today's `hello` is told it
 * is too old rather than that its message is invalid.
 */
export function decodePluginMessage(frame: string): Decoded<PluginMessage> {
  const object = parseObject(frame);
  if (typeof object === "string") return invalid(object);

  switch (object.type) {
    case "hello": {
      const version = object.protocolVersion;
      if (typeof version !== "number" || !Number.isInteger(version)) {
        return invalid("hello.protocolVersion must be a whole number");
      }
      if (version < OLDEST_SUPPORTED_PROTOCOL_VERSION) {
        return {
          ok: false,
          error: "plugin_too_old",
          problem: `The plugin speaks protocol version ${version}, but this server needs ${OLDEST_SUPPORTED_PROTOCOL_VERSION} or newer: update the plugin`,
        };
      }
      if (version > PROTOCOL_VERSION) {
        return invalid(`The plugin speaks protocol version ${version}, newer than this server's ${PROTOCOL_VERSION}: update the server`);
      }
      return check<Hello>(object, "hello", (fields) => {
        fields.string("token", { nonEmpty: true });
        fields.string("pluginVersion");
        fields.optionalString("decaidVersion");
        fields.optionalString("connectionId");
        fields.optionalObject("machine", (machine) => {
          machine.string("model");
          machine.string("serial");
          machine.optionalString("firmware");
        });
      });
    }
    case "heartbeat":
      return check<Heartbeat>(object, "heartbeat", () => {});
    default:
      return invalid(unknownType(object.type));
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
    case "error":
      return check<ErrorMessage>(object, "error", (fields) => {
        fields.string("code");
        fields.string("message");
      });
    default:
      return invalid(unknownType(object.type));
  }
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

  integer(key: string, options: { positive?: boolean } = {}): void {
    const value = this.object[key];
    if (typeof value !== "number" || !Number.isInteger(value)) this.problem(key, "must be a whole number");
    else if (options.positive && value <= 0) this.problem(key, "must be positive");
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

function unknownType(type: string): string {
  // Bounded, since the type comes from the other end.
  return `Unknown message type ${JSON.stringify(type.slice(0, 40))}`;
}

function invalid(problem: string): { ok: false; error: "protocol_error"; problem: string } {
  return { ok: false, error: "protocol_error", problem };
}
