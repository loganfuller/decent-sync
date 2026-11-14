import { type AddressInfo } from "node:net";
import { CHUNK_LIMITS, PROTOCOL_VERSION, Reassembly, SYNC_PATH, type ServerMessage, WIRE_REVISION } from "@decent-sync/protocol";
import { WebSocket, WebSocketServer } from "ws";

// A stand-in for the Decent Sync server on its sync endpoint, for the
// plugin's side of cases the real server reaches only in a race, such as a
// tablet's record changing between the server's plan and its write: a test
// sends the plugin the requests a server sends (`write`, `remove`, `delete`,
// `leaveOut`) as it chooses, and reads the plugin's answers. It welcomes any
// `hello`, answers each heartbeat, puts chunked messages back together,
// telling the plugin of each chunk, and acknowledges every delivery, as the
// server does once it has stored one. A `request` the plugin makes for a
// Skin is no delivery: it is neither acknowledged nor answered, so a test
// answers it with `send`, late, or never. It checks nothing the plugin
// sends: the real server's tests do that.

/** A message the plugin sent, read as JSON. */
type Received = Record<string, unknown> & { type: string };

export class StandInServer {
  /** Every whole message the plugin sent, in order. */
  readonly received: Received[] = [];
  private socket: WebSocket | undefined;
  private waiters: (() => void)[] = [];
  /** The acknowledgments held back (`holdAcks`), or undefined while each is sent as its delivery arrives. */
  private heldAcks: (() => void)[] | undefined;

  private constructor(
    private readonly server: WebSocketServer,
    /** Its public http:// URL, which a tablet's `ServerUrl` names. */
    readonly url: string,
    /** The wire revision its welcome gives. */
    private readonly wireRevision: number,
  ) {
    server.on("connection", (socket) => {
      this.socket?.terminate();
      this.socket = socket;
      const chunks = new Reassembly();
      socket.on("message", (data) => {
        const frame = JSON.parse((Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)).toString("utf8")) as Received;
        if (frame.type !== "chunk") return this.take(socket, frame);
        this.reply(socket, { type: "chunkReceived", id: String(frame.id), index: Number(frame.index) });
        const added = chunks.add(frame as never, CHUNK_LIMITS);
        if (added.status === "complete") this.take(socket, JSON.parse(added.text) as Received);
      });
    });
  }

  /** Starts one, which welcomes at this build's wire revision, or at `wireRevision`, as a server of another release would. */
  static async start(options: { wireRevision?: number } = {}): Promise<StandInServer> {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: SYNC_PATH });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    return new StandInServer(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`, options.wireRevision ?? WIRE_REVISION);
  }

  /** Resolves once the plugin has been welcomed. */
  async welcomed(): Promise<void> {
    await this.until(() => this.received.some((message) => message.type === "hello"), 15_000, "a hello");
  }

  /** Sends the plugin a message, as the server does. */
  send(message: ServerMessage): void {
    if (!this.socket) throw new Error("No plugin is connected");
    this.reply(this.socket, message);
  }

  /** Sends the plugin a request and resolves with its answer, the plugin's message repeating the request's id. */
  async ask(request: ServerMessage & { id: string }): Promise<Received> {
    this.send(request);
    const answer = () => this.received.find((message) => message.id === request.id);
    await this.until(() => answer() !== undefined, 15_000, `the answer to ${request.type} ${request.id}`);
    return answer()!;
  }

  /** Resolves with the first message of that type the plugin has sent, from the `from`th received on, once it has. */
  async next(type: string, from = 0): Promise<Received> {
    const found = () => this.received.slice(from).find((message) => message.type === type);
    await this.until(() => found() !== undefined, 15_000, `a ${type}`);
    return found()!;
  }

  /**
   * Holds the acknowledgment of each delivery from now on, as a server slow
   * to store one does, until the function returned is called, which sends
   * those held, in order.
   */
  holdAcks(): () => void {
    const held: (() => void)[] = (this.heldAcks = []);
    return () => {
      if (this.heldAcks === held) this.heldAcks = undefined;
      for (const acknowledge of held.splice(0)) acknowledge();
    };
  }

  /** Ends the plugin's connection, as a server that went away does. */
  drop(): void {
    this.socket?.terminate();
  }

  async stop(): Promise<void> {
    this.socket?.terminate();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private take(socket: WebSocket, message: Received): void {
    this.received.push(message);
    if (message.type === "hello") this.reply(socket, { type: "welcome", protocolVersion: PROTOCOL_VERSION, wireRevision: this.wireRevision, heartbeatIntervalMs: 30_000 });
    else if (message.type === "heartbeat") this.reply(socket, { type: "heartbeat" });
    else if (typeof message.id === "string" && message.type !== "request") {
      const acknowledge = () => this.reply(socket, { type: "ack", id: String(message.id) });
      if (this.heldAcks) this.heldAcks.push(acknowledge);
      else acknowledge();
    }
    for (const wake of this.waiters.splice(0)) wake();
  }

  private reply(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  private async until(done: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!done()) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`The stand-in server did not receive ${what} within ${timeoutMs} ms`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}
