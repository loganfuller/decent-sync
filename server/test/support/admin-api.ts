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
  online: boolean;
  lastSeenAt: string | null;
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

  async createMachine(name: string): Promise<CreatedMachine> {
    const response = await this.call("POST", "/machines", { name });
    expect(response.status).toBe(201);
    return this.issued(response);
  }

  async pendingMachines(): Promise<PendingMachineView[]> {
    return ((await (await this.call("GET", "/pending-machines")).json()) as { pendingMachines: PendingMachineView[] }).pendingMachines;
  }

  /** Reads a response that issues a token, remembering the token. */
  async issued(response: Response): Promise<CreatedMachine> {
    const created = (await response.json()) as CreatedMachine;
    this.tokens.push(created.token);
    return created;
  }
}
