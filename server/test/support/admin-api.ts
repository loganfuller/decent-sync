import { randomUUID } from "node:crypto";
import type pg from "pg";
import { expect } from "vitest";

// The REST API as a signed-in Admin uses it, for Seam 1 tests. Requests carry
// no Origin, as a non-browser client's do.

export interface MachineView {
  id: string;
  name: string;
  model: string | null;
  serial: string | null;
  identification: "identified" | "hardwareNotReported" | "unidentified" | "mismatch";
  reported: { model: string; serial: string; firmware: string | null } | null;
  connectionId: string | null;
  pluginVersion: string | null;
  decaidVersion: string | null;
  aliases: string[];
  mismatch: { model: string; serial: string; pendingMachineId: string | null; machine: { id: string; name: string } | null } | null;
  lastRefusal: { reason: string; at: string } | null;
  takeover: TakeoverView | null;
  online: boolean;
  lastSeenAt: string | null;
  lastShot: { id: string; pulledAt: string | null } | null;
  machineState: { state: string; substate: string; observedAt: string } | null;
  location: LocationView | null;
  locationHistory: { id: string; location: LocationView; effectiveFrom: string }[];
  tablet: TabletView | null;
  earlierTablets: TabletView[];
}

/** A Machine's latest takeover: a connection from one tablet replacing a live one from another. */
export interface TakeoverView {
  at: string;
  replaced: TakeoverConnectionView;
  replacement: TakeoverConnectionView;
}

export interface TakeoverConnectionView {
  tabletId: string;
  remoteAddress: string;
  connectionId: string | null;
  pluginVersion: string;
  decaidVersion: string;
}

/** A tablet a Machine's connections came from. */
export interface TabletView {
  id: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface LocationView {
  id: string;
  name: string;
  timeZone: string;
}

export interface PendingMachineView {
  id: string;
  model: string;
  serial: string;
  firstSeenAt: string;
  lastSeenAt: string | null;
  dismissed: boolean;
  mismatchedMachines: { id: string; name: string }[];
}

export interface InviteView {
  id: string;
  email: string;
  role: "admin" | "staff";
  locations: LocationView[];
  createdAt: string;
  expiresAt: string;
}

/** An account as an Admin managing accounts sees it. */
export interface ManagedAccountView {
  id: string;
  email: string;
  name: string;
  role: "admin" | "staff";
  locations: LocationView[];
  deactivatedAt: string | null;
}

/** An invite as created: its link is shown only now. */
export interface CreatedInvite {
  invite: InviteView;
  link: string;
}

/** A machine entry as created: its token is shown only now. */
export interface CreatedMachine {
  machine: MachineView;
  token: string;
  serverUrl: string;
}

export const admin = { name: "Ada Admin", email: "ada@example.com", password: "correct horse battery" };

export class AdminApi {
  /** Every token issued through this client, to check none reaches a log. */
  readonly tokens: string[] = [];

  private constructor(
    readonly serverUrl: string,
    private readonly cookie: string,
  ) {}

  /** Creates the first Admin on a fresh server and signs in as them. */
  static async setUp(serverUrl: string): Promise<AdminApi> {
    const setup = await fetch(`${serverUrl}/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(admin),
    });
    expect(setup.status).toBe(201);
    return new AdminApi(serverUrl, setup.headers.getSetCookie()[0]!.split(";")[0]!);
  }

  /** The same signed-in Admin, using another server instance on the same database. */
  at(serverUrl: string): AdminApi {
    return new AdminApi(serverUrl, this.cookie);
  }

  /** Another signed-in account, such as a Staff member, making the same calls with its session cookie. */
  static signedInAs(serverUrl: string, cookie: string): AdminApi {
    return new AdminApi(serverUrl, cookie);
  }

  call(method: string, path: string, body?: unknown, headers: Record<string, string> = { Cookie: this.cookie }): Promise<Response> {
    return fetch(`${this.serverUrl}/api${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async machines(): Promise<MachineView[]> {
    return ((await (await this.call("GET", "/machines")).json()) as { machines: MachineView[] }).machines;
  }

  async machineNamed(name: string): Promise<MachineView | undefined> {
    return (await this.machines()).find((machine) => machine.name === name);
  }

  /** Polls the REST API until the Machine matches. */
  async waitForMachine(name: string, matches: (machine: MachineView) => boolean, timeoutMs = 10_000): Promise<MachineView> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const machine = await this.machineNamed(name);
      if (machine && matches(machine)) return machine;
      if (Date.now() > deadline) throw new Error(`Machine ${name} did not match within ${timeoutMs} ms: ${JSON.stringify(machine)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Creates a machine entry, at a Location from now if one is given. */
  async createMachine(name: string, locationId?: string): Promise<CreatedMachine> {
    const response = await this.call("POST", "/machines", { name, locationId });
    expect(response.status).toBe(201);
    return this.issued(response);
  }

  async createLocation(name: string, timeZone: string): Promise<LocationView> {
    const response = await this.call("POST", "/locations", { name, timeZone });
    expect(response.status).toBe(201);
    return ((await response.json()) as { location: LocationView }).location;
  }

  /** Creates an invite, for Staff at the Locations given. */
  async invite(email: string, role: "admin" | "staff", locationIds: string[] = []): Promise<CreatedInvite> {
    const response = await this.call("POST", "/invites", { email, role, locationIds });
    expect(response.status).toBe(201);
    return (await response.json()) as CreatedInvite;
  }

  async accounts(): Promise<ManagedAccountView[]> {
    const response = await this.call("GET", "/accounts");
    expect(response.status).toBe(200);
    return ((await response.json()) as { accounts: ManagedAccountView[] }).accounts;
  }

  async invites(): Promise<InviteView[]> {
    const response = await this.call("GET", "/invites");
    expect(response.status).toBe(200);
    return ((await response.json()) as { invites: InviteView[] }).invites;
  }

  async pendingMachines(): Promise<PendingMachineView[]> {
    return ((await (await this.call("GET", "/pending-machines")).json()) as { pendingMachines: PendingMachineView[] }).pendingMachines;
  }

  /**
   * How far the instance's clock runs ahead of the database's (behind if
   * negative), as its code sees it, to check `clockOffsetMs` took effect.
   * Prisma's `@updatedAt` fills in a new machine entry's `updated_at` by the
   * instance's clock, unlike every time the server stores. Leaves a machine
   * entry behind.
   */
  async instanceClockOffsetMs(database: pg.Client): Promise<number> {
    const { machine } = await this.createMachine(`Clock check ${randomUUID()}`);
    const { rows } = await database.query<{ ms: string }>(
      "SELECT extract(epoch FROM updated_at - now()) * 1000 AS ms FROM machines WHERE id = $1",
      [machine.id],
    );
    return Number(rows[0]!.ms);
  }

  /** Reads a response that issues a token, remembering the token. */
  async issued(response: Response): Promise<CreatedMachine> {
    const created = (await response.json()) as CreatedMachine;
    this.tokens.push(created.token);
    return created;
  }
}

/** The secret an invite or password reset link holds. */
export function secretOf(link: string): string {
  return new URL(link).pathname.split("/").at(-1)!;
}

/**
 * Accepts an invite as the person it was sent to, with no session, and
 * returns the Cookie header their browser would then send.
 */
export async function acceptInvite(serverUrl: string, link: string, person: { name: string; password: string }): Promise<string> {
  const response = await fetch(`${serverUrl}/api/invite-links/${secretOf(link)}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(person),
  });
  expect(response.status).toBe(201);
  return response.headers.getSetCookie()[0]!.split(";")[0]!;
}

/** Signs in with the email and password, and returns the Cookie header the browser would then send. */
export async function signIn(serverUrl: string, credentials: { email: string; password: string }): Promise<string> {
  const response = await fetch(`${serverUrl}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(credentials),
  });
  expect(response.status).toBe(200);
  return response.headers.getSetCookie()[0]!.split(";")[0]!;
}
