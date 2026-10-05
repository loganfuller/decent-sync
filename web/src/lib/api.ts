// The management interface uses only the server's REST API, the same one any
// other client uses. The session cookie travels with every same-origin request.

export class ApiError extends Error {
  override name = "ApiError";

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) throw new ApiError(response.status, errorMessage(data) ?? response.statusText);
  return data as T;
}

// Nest reports problems as { message: string | string[] }.
function errorMessage(data: unknown): string | undefined {
  const message = (data as { message?: unknown } | undefined)?.message;
  if (Array.isArray(message)) return message.join(". ");
  return typeof message === "string" ? message : undefined;
}

export interface Account {
  id: string;
  email: string;
  name: string;
  role: "admin" | "staff";
}

export interface Location {
  id: string;
  name: string;
  /** An IANA time zone, such as America/Chicago. */
  timeZone: string;
}

/** How a Machine's identity stands: decided at each connection, or by an Admin entering its hardware. */
export type Identification = "identified" | "hardwareNotReported" | "unidentified" | "mismatch";

export interface Machine {
  id: string;
  name: string;
  /** The hardware its token is bound to, or null until a connection reports it or an Admin enters it. */
  model: string | null;
  serial: string | null;
  identification: Identification;
  /**
   * The hardware the latest connection that reported any did: the Machine's
   * own, the other hardware of a mismatch, or an Unidentified Machine's "0".
   */
  reported: { model: string; serial: string; firmware: string | null } | null;
  /** The connection id and versions of the latest accepted connection. */
  connectionId: string | null;
  pluginVersion: string | null;
  decaidVersion: string | null;
  /** Connection ids known to be this Machine's, oldest first. */
  aliases: string[];
  /** While a mismatch: the hardware reported, and the Pending Machine or Machine that has it. */
  mismatch: {
    model: string;
    serial: string;
    pendingMachineId: string | null;
    machine: { id: string; name: string } | null;
  } | null;
  /** Why a connection with its token was last refused, until one is accepted. */
  lastRefusal: { reason: string; at: string } | null;
  online: boolean;
  lastSeenAt: string | null;
  lastShot: { id: string; pulledAt: string | null } | null;
  /** What it is doing: the latest machine state its tablet reported, or null before any. */
  machineState: MachineState | null;
  /** Where it is now: the Location of its Location History's latest entry, or null if it has none. */
  location: Location | null;
  /** Where it has been, oldest first. Each entry lasts until the next one's time. */
  locationHistory: LocationHistoryEntry[];
}

/** A machine state as Decaid names it, such as espresso and preinfusion, and when the plugin observed it. */
export interface MachineState {
  state: string;
  substate: string;
  observedAt: string;
}

/** A Workflow a Machine's tablet reported: what it is set up to do next. */
export interface WorkflowEvent {
  id: string;
  /** When the plugin observed it, by the tablet's clock. */
  observedAt: string;
  receivedAt: string;
  /** Decaid's Workflow, as sent; any part may be missing. */
  workflow: Record<string, unknown>;
}

/** One entry of a Machine's Location History. */
export interface LocationHistoryEntry {
  id: string;
  location: Location;
  /** When the Machine arrived there. */
  effectiveFrom: string;
}

/** Hardware the server has seen that no Machine has, for an Admin to adopt or dismiss. */
export interface PendingMachine {
  id: string;
  model: string;
  serial: string;
  firstSeenAt: string;
  lastSeenAt: string | null;
  dismissed: boolean;
  /** Machines whose token's connection reports this hardware as a mismatch. */
  mismatchedMachines: { id: string; name: string }[];
}

/** A newly issued Machine token, returned only once, with the server URL to enter beside it. */
export interface IssuedToken {
  machine: Machine;
  token: string;
  serverUrl: string;
}

/** A collection a Machine's tablet reports (its library, settings or paired devices), as last reported, without its value. */
export interface CollectionSummary {
  name: string;
  /** Whether the latest report had a value: false while, say, no scale is connected. */
  available: boolean;
  /** When the latest report, available or not, arrived. */
  reportedAt: string;
  /** When the value arrived; null if no report has had one. */
  receivedAt: string | null;
  /** How many entries the value lists, if it is a list. */
  items: number | null;
}

/** A collection with the latest value reported, as Decaid sent it, which later unavailable reports keep. */
export interface Collection extends CollectionSummary {
  value: unknown;
}

/** A device paired with a Machine's tablet. */
export interface PairedDevice {
  /** Decaid's id for it, such as a Bluetooth address. */
  id: string;
  /** Decaid's kind of device: machine, scale or sensor. */
  type: string | null;
  /** As Decaid names it, which names its model. */
  model: string | null;
  vendor: string | null;
  /** Decaid's connection state when last reported, such as connected. */
  state: string | null;
  firmware: string | null;
  /** A percentage. */
  batteryLevel: number | null;
}

/** A Machine's paired devices, as its tablet last reported them. */
export interface PairedDevices {
  /** Null until its tablet reports them. */
  reportedAt: string | null;
  scale: PairedDevice | null;
  auxiliaryScale: PairedDevice | null;
  sensors: PairedDevice[];
  others: PairedDevice[];
}
