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
