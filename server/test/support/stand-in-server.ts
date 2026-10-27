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
// server does once it has stored one. It checks nothing the plugin sends:
// the real server's tests do that.

/** A message the plugin sent, read as JSON. */
type Received = Record<string, unknown> & { type: string };

export class StandInServer {
  /** Every whole message the plugin sent, in order. */
  readonly received: Received[] = [];
  private socket: WebSocket | undefined;
  private waiters: (() => void)[] = [];

  private constructor(
    private readonly server: WebSocketServer,
    /** Its public http:// URL, which a tablet's `ServerUrl` names. */
    readonly url: string,
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

  static async start(): Promise<StandInServer> {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: SYNC_PATH });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    return new StandInServer(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
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

  async stop(): Promise<void> {
    this.socket?.terminate();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private take(socket: WebSocket, message: Received): void {
    this.received.push(message);
    if (message.type === "hello") this.reply(socket, { type: "welcome", protocolVersion: PROTOCOL_VERSION, wireRevision: WIRE_REVISION, heartbeatIntervalMs: 30_000 });
    else if (message.type === "heartbeat") this.reply(socket, { type: "heartbeat" });
    else if (typeof message.id === "string") this.reply(socket, { type: "ack", id: message.id });
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
