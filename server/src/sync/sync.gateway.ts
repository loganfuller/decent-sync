import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import {
  CHUNK_LIMITS,
  CLOSE_CODES,
  type Chunk,
  type Decoded,
  type ErrorCode,
  type Hello,
  MISSED_HEARTBEATS,
  PROTOCOL_VERSION,
  type PluginMessage,
  Reassembly,
  type ReassemblyLimits,
  SYNC_PATH,
  type ServerMessage,
  decodePluginFrame,
  decodePluginMessage,
  encode,
} from "@decent-sync/protocol";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { CollectionsService } from "../collections/collections.service.js";
import { CONFIG } from "../config.module.js";
import type { Config } from "../config.js";
import { MachineEventsService } from "../machine-events/machine-events.service.js";
import { AccessChanges } from "../machines/access-changes.js";
import { type LiveConnection, LiveConnections } from "../machines/connections.js";
import { MachinesService, type Refusal, describeHardware } from "../machines/machines.service.js";
import { ShotsService } from "../shots/shots.service.js";
import { SteamRecordsService } from "../steam-records/steam-records.service.js";
import { hashSecret } from "../secrets.js";
import { HandledDeliveries, type IndexRequest } from "./handled-deliveries.js";
import type { Hardware, Identity, Reporter } from "./identity.js";

/** Decaid never has more than 1 MiB pending on a transport, so no single frame is larger. */
const MAX_PAYLOAD_BYTES = 1 << 20;
/**
 * Before its hello is accepted, a connection may hold no more for chunked
 * messages, ids included, than one frame could carry: 1 Mi characters. A
 * hello goes through the same chunking as any other message, but is far
 * smaller.
 */
const HELLO_CHUNK_LIMITS: ReassemblyLimits = { ...CHUNK_LIMITS, maxLength: MAX_PAYLOAD_BYTES };
/**
 * Connections whose hello has not been accepted that one instance holds at
 * once. Each may hold a frame and chunks of up to 1 MiB until its hello
 * timeout, and needs no token to open, so upgrades beyond these are refused.
 */
const MAX_AWAITING_HELLO = 64;
/** Refusing upgrades over that cap is logged at most this often. */
const REFUSAL_WARNING_INTERVAL_MS = 60_000;
/** Received when the connection ended without a close frame. */
const ABNORMAL_CLOSURE = 1006;
const INTERNAL_ERROR = 1011;
const GOING_AWAY = 1001;

interface Session {
  /** Written to its Machine's row once its hello is accepted, marking the connection that holds the Machine. */
  id: string;
  socket: WebSocket;
  remote: string;
  /** The token's Machine, once its `hello` is accepted. */
  machine?: { id: string; name: string };
  /**
   * Who the tablet is, decided at `hello` and never changed for the session.
   * What a mismatched session sends belongs to the reported hardware: to the
   * Machine that has it, otherwise to the Pending Machine for it. Which is
   * looked up when it is stored, as an Admin may create a machine entry for
   * the hardware meanwhile.
   */
  identity?: Identity;
  /** Set once its hello is accepted and the session holds its Machine. */
  live?: LiveConnection;
  /** Frames are handled one at a time, in the order they arrived. */
  queue: Promise<void>;
  /**
   * Chunked messages still arriving. They belong to this connection alone: a
   * plugin that reconnects sends a message again from its first chunk.
   */
  chunks: Reassembly;
  /** The deliveries handled most recently on this connection, with the request each index was answered with. */
  handled: HandledDeliveries;
  /** Set once `welcome` is sent. */
  welcomed: boolean;
  closing: boolean;
  helloTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
}

/**
 * The plugin's WebSocket endpoint at /sync (ADR-0009). A connection must send
 * `hello` within the hello timeout; its token decides the Machine, and its
 * reported hardware and connection id the session's identity (ADR-0004,
 * ADR-0015), once. A newer connection with the same token replaces an older
 * one. Every refusal sends an `error`, then closes with that error's close
 * code. Messages never reach the log: a `hello` carries the token. A message
 * too large for one frame arrives in chunks, which are put back together for
 * that connection alone and confirmed one by one; the whole message is then
 * handled, and acknowledged, like any other.
 *
 * Any number of server instances may run. Which connection holds a Machine is
 * stored on its row; a change that may end a connection (another accepted
 * hello, a reissued token, dismissed hardware) is notified to every
 * instance, which checks its connections to that Machine against the
 * database. Heartbeats check too, in case a notification was missed.
 *
 * Each instance holds at most `MAX_AWAITING_HELLO` connections whose hello
 * has not been accepted, and refuses further upgrades with 503 until one is
 * accepted or closes. Connections that hold a Machine are not counted. The
 * count is this instance's own: it protects its memory and decides nothing
 * shared (ADR-0016).
 */
@Injectable()
export class SyncGateway implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("Sync");
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  /** Every open connection, welcomed or not. */
  private readonly connections = new Set<Session>();
  /** Open connections whose hello has not been accepted. */
  private readonly awaitingHello = new Set<Session>();
  /** Upgrades refused over that cap since it was last logged, and when that was (`performance.now()`). */
  private refusedUpgrades = 0;
  private refusalLoggedAt: number | undefined;
  /** Message handling and releases still running, which shutdown waits for before the database disconnects. */
  private readonly inFlight = new Set<Promise<void>>();
  private shuttingDown = false;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject(CONFIG) private readonly config: Config,
    private readonly machines: MachinesService,
    private readonly live: LiveConnections,
    private readonly shots: ShotsService,
    private readonly steamRecords: SteamRecordsService,
    private readonly machineEvents: MachineEventsService,
    private readonly collections: CollectionsService,
    accessChanges: AccessChanges,
  ) {
    accessChanges.subscribe((machineId) => void this.check(this.live.of(machineId)));
  }

  onApplicationBootstrap(): void {
    const httpServer = this.adapterHost.httpAdapter.getHttpServer() as Server;
    httpServer.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => this.upgrade(request, socket, head));
  }

  /**
   * Runs before the database disconnects: closes every connection, waits for
   * hellos still being accepted, then releases this instance's Machines.
   */
  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    const sessions = [...this.connections];
    const closed = sessions.map((session) => new Promise((resolve) => session.socket.once("close", resolve)));
    for (const session of sessions) {
      this.clearTimers(session);
      session.closing = true;
      session.socket.close(GOING_AWAY, "Server shutting down");
    }
    const grace = setTimeout(() => {
      for (const session of sessions) session.socket.terminate();
    }, 1_000);
    // A hello still being accepted may yet give its session a Machine, so the
    // Machines held are known only once every hello has finished.
    while (this.inFlight.size > 0) await Promise.all(this.inFlight);
    const held = sessions.flatMap((session) => (session.live ? [session.id] : []));
    await this.machines.releaseAll(held).catch((error: unknown) => {
      this.logger.error(`Could not record this instance's Machines as offline: ${String(error)}`);
    });
    await Promise.all(closed);
    clearTimeout(grace);
    await new Promise((resolve) => this.server.close(resolve));
  }

  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = (request.url ?? "").split("?")[0];
    if (path !== SYNC_PATH || this.shuttingDown) return rejectUpgrade(socket, "404 Not Found");
    if (this.awaitingHello.size >= MAX_AWAITING_HELLO) return this.refuseUpgrade(socket);
    // Without verifyClient, ws upgrades and calls back synchronously, so the
    // connection is counted before the next upgrade is judged.
    this.server.handleUpgrade(request, socket, head, (ws) => this.open(ws, request));
  }

  /** Refuses an upgrade over the cap on connections awaiting hello, saying so at most once a minute. */
  private refuseUpgrade(socket: Duplex): void {
    rejectUpgrade(socket, "503 Service Unavailable");
    this.refusedUpgrades++;
    const now = performance.now();
    if (this.refusalLoggedAt !== undefined && now - this.refusalLoggedAt < REFUSAL_WARNING_INTERVAL_MS) return;
    const since = this.refusalLoggedAt === undefined ? "" : ` (${this.refusedUpgrades} refused since this was last logged)`;
    this.logger.warn(`Refusing sync connections while ${MAX_AWAITING_HELLO} have not had a hello accepted${since}`);
    this.refusalLoggedAt = now;
    this.refusedUpgrades = 0;
  }

  private open(socket: WebSocket, request: IncomingMessage): void {
    if (this.shuttingDown) return void socket.close(GOING_AWAY, "Server shutting down");
    const session: Session = {
      id: randomUUID(),
      socket,
      remote: request.socket.remoteAddress ?? "an unknown address",
      queue: Promise.resolve(),
      chunks: new Reassembly(),
      handled: new HandledDeliveries(),
      welcomed: false,
      closing: false,
    };
    this.connections.add(session);
    this.awaitingHello.add(session);
    session.helloTimer = setTimeout(
      () => this.refuse(session, "protocol_error", `No hello within ${this.config.helloTimeoutMs / 1000} seconds`),
      this.config.helloTimeoutMs,
    );

    socket.on("message", (data, isBinary) => {
      const decoded = isBinary ? undefined : decodePluginFrame(rawToString(data));
      const answered = decoded?.ok === true && decoded.message.type === "heartbeat" && this.answerHeartbeat(session);
      session.queue = this.track(
        session.queue
          .then(() => this.receive(session, decoded, answered))
          .catch((error: unknown) => {
            this.logger.error(`Failed handling a message from ${this.describe(session)}: ${String(error)}`);
            this.end(session, INTERNAL_ERROR, "Server error");
          }),
      );
    });
    socket.on("close", (code) => this.closed(session, code));
    // Failures such as an oversized frame; ws closes the connection after them.
    socket.on("error", (error) => this.logger.warn(`Sync connection from ${this.describe(session)} failed: ${error.message}`));
  }

  /**
   * Answers a welcomed connection's heartbeat as it arrives, rather than after
   * earlier messages and the database work they wait on, so a slow database
   * does not make either end give up on a working connection. Says whether
   * it did.
   */
  private answerHeartbeat(session: Session): boolean {
    if (!session.welcomed || session.closing) return false;
    this.resetIdleTimer(session);
    this.send(session, { type: "heartbeat" });
    return true;
  }

  /** Handles a frame in turn: `frame` is undefined for a binary frame, and `answered` says a heartbeat was answered on arrival. */
  private async receive(session: Session, frame: Decoded<PluginMessage | Chunk> | undefined, answered: boolean): Promise<void> {
    if (session.closing) return;
    if (!frame) return this.refuse(session, "protocol_error", "Messages must be sent as text frames");
    if (!frame.ok) return this.handle(session, frame, answered);
    const message = frame.message;
    if (message.type !== "chunk") return this.handle(session, { ok: true, message }, answered);
    const whole = this.reassemble(session, message);
    if (whole) return this.handle(session, whole, false);
  }

  /**
   * Adds a chunk to its message and confirms its receipt, so the plugin can
   * send more. Returns the whole message once its last chunk is in, and
   * null until then or if the chunks cannot be trusted.
   */
  private reassemble(session: Session, chunk: Chunk): Decoded<PluginMessage> | null {
    const added = session.chunks.add(chunk, session.machine ? CHUNK_LIMITS : HELLO_CHUNK_LIMITS);
    if (added.status === "invalid") {
      this.refuse(session, "protocol_error", added.problem);
      return null;
    }
    this.send(session, { type: "chunkReceived", id: chunk.id, index: chunk.index });
    return added.status === "complete" ? decodePluginMessage(added.text) : null;
  }

  /** Handles a whole message, from one frame or put back together from chunks. */
  private async handle(session: Session, decoded: Decoded<PluginMessage>, answered: boolean): Promise<void> {
    if (!decoded.ok) {
      // A hello of an unsupported version: its Machine, if the token is valid, shows why.
      if (!session.machine && decoded.token !== undefined) await this.recordVersionRefusal(decoded.token, decoded.problem);
      return this.refuse(session, decoded.error, decoded.problem);
    }
    const message = decoded.message;

    if (!session.machine) {
      if (message.type !== "hello") return this.refuse(session, "protocol_error", "The first message must be hello");
      return this.hello(session, message);
    }
    if (message.type !== "hello" && message.type !== "heartbeat" && session.handled.has(message.id)) {
      const request = session.handled.get(message.id);
      if (request) this.send(session, request);
      this.send(session, { type: "ack", id: message.id });
      return;
    }
    const reporter: Reporter = { machineId: session.machine.id, identity: session.identity! };
    switch (message.type) {
      case "hello":
        return this.refuse(session, "protocol_error", "hello was already sent on this connection");
      case "shot":
      case "shotUpdated":
        await this.shots.store(message, reporter);
        return this.acknowledge(session, message.id, null);
      case "steam":
        await this.steamRecords.store(message, reporter);
        return this.acknowledge(session, message.id, null);
      case "workflow":
        await this.machineEvents.storeWorkflow(message, reporter);
        return this.acknowledge(session, message.id, null);
      case "machineState":
        await this.machineEvents.storeMachineState(message, reporter);
        return this.acknowledge(session, message.id, null);
      case "collection":
        await this.collections.store(message, reporter);
        return this.acknowledge(session, message.id, null);
      case "shotIndex":
        return this.acknowledge(session, message.id, { type: "requestShots", shotIds: await this.shots.requested(message) });
      case "steamIndex":
        return this.acknowledge(session, message.id, { type: "requestSteams", steamIds: await this.steamRecords.requested(message) });
      case "heartbeat":
        // One sent before its connection was welcomed is answered now.
        if (!answered) {
          this.resetIdleTimer(session);
          this.send(session, { type: "heartbeat" });
        }
        if (session.live) {
          const live = session.live;
          await this.enforce([live], async () => [await this.machines.heard(live)]);
        }
        return;
    }
  }

  /**
   * Acknowledges a delivery once stored, after the request answering it if it
   * is an index. Both are remembered with the connection's recent deliveries:
   * replaying an index after losing its request must still let the tablet
   * continue backfill.
   */
  private acknowledge(session: Session, id: string, request: IndexRequest | null): void {
    session.handled.add(id, request);
    if (session.closing) return;
    if (request) this.send(session, request);
    this.send(session, { type: "ack", id });
  }

  private async hello(session: Session, hello: Hello): Promise<void> {
    clearTimeout(session.helloTimer);
    const outcome = await this.machines.acceptHello(hello, session.id, new Date());
    if (!outcome.accepted) return this.refuse(session, outcome.code, outcome.reason);

    const { machine, identity, hardware, machineTabletId } = outcome;
    this.awaitingHello.delete(session);
    session.machine = machine;
    session.identity = identity;
    const live: LiveConnection = {
      sessionId: session.id,
      machineId: machine.id,
      tokenHash: hashSecret(hello.token),
      mismatch: identity.kind === "mismatch" ? identity.hardware : null,
      machineTabletId,
      end: (code, message) => this.refuse(session, code, message),
    };
    session.live = live;
    // Closed while being accepted: the Machine it was just given is released again.
    if (session.closing) return void this.release(session);
    this.live.add(live);

    // A change committed while this hello was being accepted was notified
    // before the session could be found; checked once it can be, it is seen
    // here or by the notification.
    await this.check([live]);
    if (session.closing) return;

    this.send(session, { type: "welcome", protocolVersion: PROTOCOL_VERSION, heartbeatIntervalMs: this.config.heartbeatIntervalMs });
    session.welcomed = true;
    this.resetIdleTimer(session);
    this.logger.log(
      `Machine ${machine.name} connected from ${session.remote}: plugin ${hello.pluginVersion}, Decaid ${hello.decaidVersion}, ${describeIdentity(identity, hardware)}`,
    );
  }

  /** Ends those of the connections that may no longer stay, read together. */
  private check(connections: LiveConnection[]): Promise<void> {
    if (connections.length === 0) return Promise.resolve();
    return this.enforce(connections, () => this.machines.standings(connections));
  }

  /** Ends each connection whose refusal, read in the same order, says it may no longer stay. */
  private async enforce(connections: LiveConnection[], read: () => Promise<(Refusal | null)[]>): Promise<void> {
    try {
      const refusals = await read();
      // Shutting down closes every connection as going away, to be retried,
      // not as replaced, after which the plugin stops.
      if (this.shuttingDown) return;
      connections.forEach((connection, index) => {
        const refusal = refusals[index];
        if (refusal) connection.end(refusal.code, refusal.reason);
      });
    } catch (error) {
      this.logger.error(`Could not check ${connections.length === 1 ? "a sync connection" : "sync connections"}: ${String(error)}`);
    }
  }

  /**
   * Shows why a hello of an unsupported protocol or Decaid version was refused
   * on its token's Machine, if the token is valid. Failing to only logs: the
   * plugin must still be told why, or it would retry instead of stopping.
   */
  private async recordVersionRefusal(token: string, reason: string): Promise<void> {
    try {
      const machine = await this.machines.findByToken(token);
      if (machine) await this.machines.recordRefusal(machine.id, reason);
    } catch (error) {
      this.logger.error(`Could not record why a plugin was refused: ${String(error)}`);
    }
  }

  private closed(session: Session, code: number): void {
    this.connections.delete(session);
    this.awaitingHello.delete(session);
    this.clearTimers(session);
    session.closing = true;
    if (!session.live) return;
    this.live.delete(session.live);
    // Released together on shutdown.
    if (this.shuttingDown) return;
    void this.release(session, code !== ABNORMAL_CLOSURE);
  }

  /** Releases the Machine the session held, unless a newer connection holds it now. */
  private release(session: Session, closeFrameHeard = false): Promise<void> {
    const name = session.machine?.name ?? "unknown";
    return this.track(
      this.machines.released(session.id, closeFrameHeard).then(
        (released) => {
          if (released) this.logger.log(`Machine ${name} disconnected`);
        },
        (error: unknown) => this.logger.error(`Could not record Machine ${name} as offline: ${String(error)}`),
      ),
    );
  }

  /** Keeps work that writes to the database in `inFlight` until it settles. The work must not reject. */
  private track(work: Promise<void>): Promise<void> {
    this.inFlight.add(work);
    void work.then(() => this.inFlight.delete(work));
    return work;
  }

  /** Tells the plugin why, then closes with the error's close code. */
  private refuse(session: Session, code: ErrorCode, message: string): void {
    if (session.closing) return;
    const log = `Closing the sync connection of ${this.describe(session)}: ${message}`;
    if (code === "replaced") this.logger.log(log);
    else this.logger.warn(log);
    this.send(session, { type: "error", code, message });
    this.end(session, CLOSE_CODES[code], code);
  }

  private end(session: Session, closeCode: number, reason: string): void {
    if (session.closing) return;
    session.closing = true;
    this.clearTimers(session);
    session.socket.close(closeCode, reason);
  }

  private send(session: Session, message: ServerMessage): void {
    session.socket.send(encode(message));
  }

  private resetIdleTimer(session: Session): void {
    clearTimeout(session.idleTimer);
    const silenceMs = this.config.heartbeatIntervalMs * MISSED_HEARTBEATS;
    session.idleTimer = setTimeout(
      () => this.refuse(session, "protocol_error", `No heartbeat for ${silenceMs / 1000} seconds`),
      silenceMs,
    );
  }

  private clearTimers(session: Session): void {
    clearTimeout(session.helloTimer);
    clearTimeout(session.idleTimer);
  }

  private describe(session: Session): string {
    return session.machine ? `Machine ${session.machine.name} (${session.remote})` : session.remote;
  }
}

function describeIdentity(identity: Identity, hardware: Hardware | null): string {
  switch (identity.kind) {
    case "identified":
      if (identity.recognisedBy === "alias" || !hardware) return "identified by its connection id";
      return `${identity.bind ? "bound to" : "identified as"} ${describeHardware(hardware)}`;
    case "hardwareNotReported":
      return "no machine connected to its tablet yet";
    case "unidentified":
      return "the machine reports no serial";
    case "mismatch":
      return `reports ${describeHardware(identity.hardware)}, not the hardware its token is bound to`;
    case "rejected":
      return `reports dismissed hardware ${describeHardware(identity.hardware)}`;
  }
}

/**
 * Answers an upgrade with an HTTP error instead of a WebSocket, then destroys
 * the socket once that is sent, as ws does: a client that keeps its end open
 * would otherwise hold it. The HTTP server stops handling a socket's errors
 * once it is upgraded, so a client resetting the connection would otherwise
 * crash the process.
 */
function rejectUpgrade(socket: Duplex, status: string): void {
  socket.on("error", () => socket.destroy());
  socket.once("finish", () => socket.destroy());
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}
