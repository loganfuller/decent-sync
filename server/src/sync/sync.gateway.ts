import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import {
  CLOSE_CODES,
  type ErrorCode,
  type Hello,
  PROTOCOL_VERSION,
  SYNC_PATH,
  type ServerMessage,
  decodePluginMessage,
  encode,
} from "@decent-sync/protocol";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { CONFIG } from "../config.module.js";
import type { Config } from "../config.js";
import { AccessChanges } from "../machines/access-changes.js";
import { type LiveConnection, LiveConnections } from "../machines/connections.js";
import { MISSED_HEARTBEATS, MachinesService, describeHardware } from "../machines/machines.service.js";
import { hashSecret } from "../secrets.js";
import type { Hardware, Identity } from "./identity.js";

/** Decaid never has more than 1 MiB pending on a transport, so no single frame is larger. */
const MAX_FRAME_BYTES = 1 << 20;
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
   * Machine that has it, otherwise to `pendingMachineId`.
   */
  identity?: Identity;
  pendingMachineId?: string | null;
  /** Set once its hello is accepted and the session holds its Machine. */
  live?: LiveConnection;
  /** Frames are handled one at a time, in the order they arrived. */
  queue: Promise<void>;
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
 * code. Messages never reach the log: a `hello` carries the token.
 *
 * Any number of server instances may run. Which connection holds a Machine is
 * stored on its row; a change that may end a connection (another accepted
 * hello, a reissued token, dismissed hardware) is notified to every
 * instance, which checks its connections to that Machine against the
 * database. Heartbeats check too, in case a notification was missed.
 */
@Injectable()
export class SyncGateway implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("Sync");
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  /** Every open connection, welcomed or not. */
  private readonly connections = new Set<Session>();
  private shuttingDown = false;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject(CONFIG) private readonly config: Config,
    private readonly machines: MachinesService,
    private readonly live: LiveConnections,
    accessChanges: AccessChanges,
  ) {
    accessChanges.subscribe((machineId) => {
      for (const connection of this.live.of(machineId)) this.check(connection);
    });
  }

  onApplicationBootstrap(): void {
    const httpServer = this.adapterHost.httpAdapter.getHttpServer() as Server;
    httpServer.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => this.upgrade(request, socket, head));
  }

  /** Runs before the database disconnects: releases this instance's Machines, then closes every connection. */
  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    const held = [...this.connections].flatMap((session) => (session.live ? [session.id] : []));
    await this.machines.releaseAll(held).catch((error: unknown) => {
      this.logger.error(`Could not record this instance's Machines as offline: ${String(error)}`);
    });
    const closed = [...this.connections].map((session) => new Promise((resolve) => session.socket.once("close", resolve)));
    for (const session of this.connections) {
      this.clearTimers(session);
      session.closing = true;
      session.socket.close(GOING_AWAY, "Server shutting down");
    }
    const grace = setTimeout(() => {
      for (const session of this.connections) session.socket.terminate();
    }, 1_000);
    await Promise.all(closed);
    clearTimeout(grace);
    await new Promise((resolve) => this.server.close(resolve));
  }

  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = (request.url ?? "").split("?")[0];
    if (path !== SYNC_PATH || this.shuttingDown) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    this.server.handleUpgrade(request, socket, head, (ws) => this.open(ws, request));
  }

  private open(socket: WebSocket, request: IncomingMessage): void {
    const session: Session = {
      id: randomUUID(),
      socket,
      remote: request.socket.remoteAddress ?? "an unknown address",
      queue: Promise.resolve(),
      closing: false,
    };
    this.connections.add(session);
    session.helloTimer = setTimeout(
      () => this.refuse(session, "protocol_error", `No hello within ${this.config.helloTimeoutMs / 1000} seconds`),
      this.config.helloTimeoutMs,
    );

    socket.on("message", (data, isBinary) => {
      session.queue = session.queue
        .then(() => this.receive(session, data, isBinary))
        .catch((error: unknown) => {
          this.logger.error(`Failed handling a message from ${this.describe(session)}: ${String(error)}`);
          this.end(session, INTERNAL_ERROR, "Server error");
        });
    });
    socket.on("close", (code) => this.closed(session, code));
    // Failures such as an oversized frame; ws closes the connection after them.
    socket.on("error", (error) => this.logger.warn(`Sync connection from ${this.describe(session)} failed: ${error.message}`));
  }

  private async receive(session: Session, data: RawData, isBinary: boolean): Promise<void> {
    if (session.closing) return;
    if (isBinary) return this.refuse(session, "protocol_error", "Messages must be sent as text frames");

    const decoded = decodePluginMessage(rawToString(data));
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
    switch (message.type) {
      case "hello":
        return this.refuse(session, "protocol_error", "hello was already sent on this connection");
      case "heartbeat":
        this.resetIdleTimer(session);
        if (session.live) {
          await this.machines.heard(session.live);
          await this.check(session.live);
        }
        return;
    }
  }

  private async hello(session: Session, hello: Hello): Promise<void> {
    clearTimeout(session.helloTimer);
    const outcome = await this.machines.acceptHello(hello, session.id, new Date());
    if (!outcome.accepted) return this.refuse(session, outcome.code, outcome.reason);

    const { machine, identity, hardware } = outcome;
    session.machine = machine;
    session.identity = identity;
    session.pendingMachineId = outcome.pendingMachineId;
    const live: LiveConnection = {
      sessionId: session.id,
      machineId: machine.id,
      tokenHash: hashSecret(hello.token),
      mismatch: identity.kind === "mismatch" ? identity.hardware : null,
      end: (code, message) => this.refuse(session, code, message),
    };
    session.live = live;
    // Closed while being accepted: the Machine it was just given is released again.
    if (session.closing) return void this.release(session);
    this.live.add(live);

    // A change committed while this hello was being accepted was notified
    // before the session could be found; checked once it can be, it is seen
    // here or by the notification.
    if (await this.check(live)) return;
    if (session.closing) return;

    this.send(session, { type: "welcome", protocolVersion: PROTOCOL_VERSION, heartbeatIntervalMs: this.config.heartbeatIntervalMs });
    this.resetIdleTimer(session);
    this.logger.log(
      `Machine ${machine.name} connected from ${session.remote}: plugin ${hello.pluginVersion}, Decaid ${hello.decaidVersion ?? "unknown"}, ${describeIdentity(identity, hardware)}`,
    );
  }

  /** Ends the connection if it may no longer stay, and says whether it did. */
  private async check(connection: LiveConnection): Promise<boolean> {
    try {
      const refusal = await this.machines.standing(connection);
      // Shutting down releases this instance's Machines before closing their
      // connections, which must then close as going away, to be retried, not
      // as replaced, after which the plugin stops.
      if (!refusal || this.shuttingDown) return false;
      connection.end(refusal.code, refusal.reason);
      return true;
    } catch (error) {
      this.logger.error(`Could not check a sync connection: ${String(error)}`);
      return false;
    }
  }

  /** Shows why a plugin of an unsupported protocol version was refused on its token's Machine, if the token is valid. */
  private async recordVersionRefusal(token: string, reason: string): Promise<void> {
    const machine = await this.machines.findByToken(token);
    if (machine) await this.machines.recordRefusal(machine.id, reason);
  }

  private closed(session: Session, code: number): void {
    this.connections.delete(session);
    this.clearTimers(session);
    session.closing = true;
    if (!session.live) return;
    this.live.delete(session.live);
    // Released together on shutdown.
    if (this.shuttingDown) return;
    void this.release(session, code !== ABNORMAL_CLOSURE);
  }

  /** Releases the Machine the session held, unless a newer connection holds it now. */
  private async release(session: Session, closeFrameHeard = false): Promise<void> {
    const name = session.machine?.name ?? "unknown";
    try {
      if (await this.machines.released(session.id, closeFrameHeard)) this.logger.log(`Machine ${name} disconnected`);
    } catch (error) {
      this.logger.error(`Could not record Machine ${name} as offline: ${String(error)}`);
    }
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

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}
