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
  type ItemWritten,
  type LibraryWrite,
  MISSED_HEARTBEATS,
  PROTOCOL_VERSION,
  type PluginMessage,
  Reassembly,
  type ReassemblyLimits,
  SYNC_PATH,
  type ServerMessage,
  type ShotDelivery,
  type SteamDelivery,
  type WriteRefused,
  decodePluginFrame,
  decodePluginMessage,
  encode,
  frames,
} from "@decent-sync/protocol";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { CollectionsService } from "../collections/collections.service.js";
import { CONFIG } from "../config.module.js";
import type { Config } from "../config.js";
import { recordBeanWritten } from "../library/beans.js";
import { MachineEventsService } from "../machine-events/machine-events.service.js";
import { type LiveConnection, LiveConnections } from "../machines/connections.js";
import { MachinesService, type Refusal } from "../machines/machines.service.js";
import type { TakeoverConnectionView } from "../machines/takeovers.js";
import { Notifications } from "../notifications.js";
import { PrismaService } from "../prisma.service.js";
import { repeatingFailure } from "../set-aside-deliveries/repeating-failures.js";
import { type CaptureDelivery, SetAsideDeliveriesService } from "../set-aside-deliveries/set-aside-deliveries.service.js";
import { ShotsService } from "../shots/shots.service.js";
import { SteamRecordsService } from "../steam-records/steam-records.service.js";
import { hashSecret } from "../secrets.js";
import { HandledDeliveries, type IndexRequest } from "./handled-deliveries.js";
import type { Hardware, Identity, Reporter } from "./identity.js";
import { TabletWriter } from "./tablet-writer.js";

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
  /** Writes the Library to its tablet, once welcomed, unless it is mismatched. */
  writer?: TabletWriter;
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
 * one: closed as replaced if it comes from another tablet, after which its
 * plugin yields to that tablet, or as superseded if from the same one, which
 * reconnects. Replacing a live connection from another tablet is recorded on
 * the Machine as a takeover, and a `yielding` hello is refused with
 * machine_held instead. Every refusal sends an `error`, then closes with that
 * error's close code. Messages never reach the log: a `hello` carries the token. A message
 * too large for one frame arrives in chunks, which are put back together for
 * that connection alone and confirmed one by one; the whole message is then
 * handled, and acknowledged, like any other.
 *
 * A delivery is acknowledged once stored. One whose storage fails in a way
 * that would repeat is set aside as received and acknowledged as stored
 * (`SetAsideDeliveriesService`); any other failure closes the connection with
 * 1011, leaving the delivery for the plugin to send again. A Shot or Steam
 * Record no supported Decaid sends is acknowledged and ignored, and logged
 * by its id with what it lacks.
 *
 * Once its report of the tablet's beans is taken in, a connection that is
 * not mismatched writes the Library its Machine's Location offers to its
 * tablet (`TabletWriter`), one write at a time, each answered by the plugin,
 * which the server acknowledges once it has recorded the answer. A write too
 * large for one frame goes in chunks.
 *
 * Any number of server instances may run. Which connection holds a Machine is
 * stored on its row; a change that may end a connection (another accepted
 * hello, a reissued token, dismissed hardware) is notified to every
 * instance, which checks its connections to that Machine against the
 * database. Heartbeats check too, in case a notification was missed. A
 * change to the Library is notified too, and every instance then has its
 * connections' writers look for writes due.
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
    private readonly setAside: SetAsideDeliveriesService,
    private readonly prisma: PrismaService,
    notifications: Notifications,
  ) {
    notifications.subscribe("machine_access", (machineId) => void this.check(this.live.of(machineId)));
    // Each writer reads what its tablet is due, so every one looks, whichever Location changed.
    notifications.subscribe("library_changes", () => {
      for (const session of this.connections) session.writer?.wake();
    });
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
      // A write awaiting its answer is abandoned; the tablet's next connection is written what it lacks.
      session.writer?.stop();
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
      const text = isBinary ? undefined : rawToString(data);
      const decoded = text === undefined ? undefined : decodePluginFrame(text);
      const answered = decoded?.ok === true && decoded.message.type === "heartbeat" && this.answerHeartbeat(session);
      session.queue = this.track(
        session.queue
          .then(() => this.receive(session, decoded, text, answered))
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

  /**
   * Handles a frame in turn: `frame` is undefined for a binary frame, `text`
   * is the frame as received, and `answered` says a heartbeat was answered on
   * arrival.
   */
  private async receive(
    session: Session,
    frame: Decoded<PluginMessage | Chunk> | undefined,
    text: string | undefined,
    answered: boolean,
  ): Promise<void> {
    if (session.closing) return;
    if (!frame || text === undefined) return this.refuse(session, "protocol_error", "Messages must be sent as text frames");
    if (!frame.ok) return this.handle(session, frame, text, answered);
    const message = frame.message;
    if (message.type !== "chunk") return this.handle(session, { ok: true, message }, text, answered);
    const whole = this.reassemble(session, message);
    if (whole) return this.handle(session, decodePluginMessage(whole), whole, false);
  }

  /**
   * Adds a chunk to its message and confirms its receipt, so the plugin can
   * send more. Returns the whole message's text once its last chunk is in,
   * and null until then or if the chunks cannot be trusted.
   */
  private reassemble(session: Session, chunk: Chunk): string | null {
    const added = session.chunks.add(chunk, session.machine ? CHUNK_LIMITS : HELLO_CHUNK_LIMITS);
    if (added.status === "invalid") {
      this.refuse(session, "protocol_error", added.problem);
      return null;
    }
    this.send(session, { type: "chunkReceived", id: chunk.id, index: chunk.index });
    return added.status === "complete" ? added.text : null;
  }

  /** Handles a whole message, from one frame or put back together from chunks, whose JSON text is `text`. */
  private async handle(session: Session, decoded: Decoded<PluginMessage>, text: string, answered: boolean): Promise<void> {
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
    const reporter: Reporter = { machineId: session.machine.id, identity: session.identity!, tabletId: session.live!.tabletId };
    switch (message.type) {
      case "hello":
        return this.refuse(session, "protocol_error", "hello was already sent on this connection");
      case "shot":
      case "shotUpdated":
        return this.captureRecord(session, message, text, () => this.shots.store(message, reporter));
      case "steam":
        return this.captureRecord(session, message, text, () => this.steamRecords.store(message, reporter));
      case "workflow":
        return this.capture(session, message, text, () => this.machineEvents.storeWorkflow(message, reporter));
      case "machineState":
        return this.capture(session, message, text, () => this.machineEvents.storeMachineState(message, reporter));
      case "collection":
        return this.capture(session, message, text, async () => {
          const intake = await this.collections.store(message, reporter);
          if (intake) session.writer?.reported(intake.takenInAt);
        });
      case "written":
      case "writeRefused":
        return this.answered(session, message);
      case "shotIndex": {
        const shotIds = await this.shots.requested(message, session.machine.id);
        return this.acknowledge(session, message.id, { type: "requestShots", shotIds });
      }
      case "steamIndex": {
        const steamIds = await this.steamRecords.requested(message, session.machine.id);
        return this.acknowledge(session, message.id, { type: "requestSteams", steamIds });
      }
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
   * Stores a delivery of what the tablet captured, then acknowledges it. If
   * storing fails in a way that would repeat whenever the delivery was sent
   * again, it is set aside, its text kept as received, and acknowledged as
   * stored, so the deliveries queued behind it on the tablet still flow. Any
   * other failure is thrown, which closes the connection with 1011 and leaves
   * the delivery unacknowledged.
   */
  private async capture(session: Session, delivery: CaptureDelivery, text: string, store: () => Promise<void>): Promise<void> {
    try {
      await store();
    } catch (error) {
      const failure = repeatingFailure(error);
      if (!failure) throw error;
      await this.setAside.record(session.machine!.id, delivery, text, failure);
      this.logger.warn(`Set aside a ${delivery.type} delivery from ${this.describe(session)} that cannot be stored: ${failure.message} (${failure.sqlState})`);
    }
    this.acknowledge(session, delivery.id, null);
  }

  /**
   * Captures a Shot or Steam Record as `capture` does. One that is not a
   * record any supported Decaid sends is acknowledged without being stored,
   * and logged by its id, quoted, with what it lacks, but no field's value.
   */
  private captureRecord(session: Session, delivery: ShotDelivery | SteamDelivery, text: string, store: () => Promise<string | null>): Promise<void> {
    return this.capture(session, delivery, text, async () => {
      const lacking = await store();
      if (lacking !== null) this.logger.warn(`Ignored ${describeRecord(delivery)} from ${this.describe(session)}: its ${delivery.type} delivery has ${lacking}`);
    });
  }

  /**
   * Records the plugin's answer to a write, then acknowledges it, and lets
   * the connection's writer go on. A record Decaid returned is the tablet's
   * record of the item from now on. A refusal is logged, escaped, as it
   * repeats what Decaid answered; the writer skips that item. A record that
   * fails to store in a way that would repeat is logged and skipped the same
   * way, so it cannot stop the tablet's other writes. Any other failure
   * closes the connection with 1011, and the tablet's next connection is
   * written the item again, which the plugin then finds it holds. A
   * connection that is never written to, as a mismatched one, has its
   * answers acknowledged and nothing more.
   */
  private async answered(session: Session, answer: ItemWritten | WriteRefused): Promise<void> {
    let outcome: "written" | "refused" = "refused";
    if (!session.writer) {
      // Nothing was asked of it.
    } else if (answer.type === "writeRefused") {
      this.logger.warn(
        `The tablet of ${this.describe(session)} did not write ${quoted(answer.kind)} ${answer.globalId}: ${answer.status === null ? "Decaid did not answer" : `Decaid answered ${answer.status}`}, ${quoted(answer.error.slice(0, 200))}`,
      );
    } else if (answer.kind !== "bean") {
      this.logger.warn(`The tablet of ${this.describe(session)} answered a write of a ${quoted(answer.kind)}, which this server never asks for`);
    } else {
      try {
        if (await recordBeanWritten(this.prisma, session.live!.tabletId, answer.globalId, answer.record, answer.updatedAt)) outcome = "written";
        else this.logger.warn(`The tablet of ${this.describe(session)} answered the write of Bean ${answer.globalId} with a record that is not that Bean's`);
      } catch (error) {
        const failure = repeatingFailure(error);
        if (!failure) throw error;
        this.logger.warn(`Could not record the Bean ${answer.globalId} written to the tablet of ${this.describe(session)}: ${failure.message} (${failure.sqlState})`);
      }
    }
    this.acknowledge(session, answer.id, null);
    session.writer?.answered(answer.id, outcome);
  }

  /** Sends a write on the connection, in chunks if it is too large for one frame. */
  private sendWrite(session: Session, write: LibraryWrite): void {
    if (session.closing) return;
    for (const frame of frames(encode(write), write.id)) session.socket.send(frame.text);
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
    const outcome = await this.machines.acceptHello(hello, { sessionId: session.id, remoteAddress: session.remote });
    if (!outcome.accepted) return this.refuse(session, outcome.code, outcome.reason);

    const { machine, identity, hardware, tookOverFrom } = outcome;
    this.awaitingHello.delete(session);
    session.machine = machine;
    session.identity = identity;
    const live: LiveConnection = {
      sessionId: session.id,
      machineId: machine.id,
      tokenHash: hashSecret(hello.token),
      mismatch: identity.kind === "mismatch" ? identity.hardware : null,
      tabletId: hello.tabletId.toLowerCase(),
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
    // A mismatched connection's tablet is not its token's Machine's, so nothing is written to it (ADR-0004). The
    // writer starts once the connection's report of the tablet's beans, sent on every welcome, is taken in.
    if (identity.kind !== "mismatch") {
      session.writer = new TabletWriter(
        { sessionId: session.id, machineId: machine.id, tabletId: live.tabletId },
        this.prisma,
        (write) => this.sendWrite(session, write),
        this.logger,
        (work) => this.track(work),
      );
    }
    this.logger.log(
      `Machine ${machine.name} connected from ${session.remote}: ${describeVersions(hello)}, ${describeIdentity(identity, hardware)}`,
    );
    if (tookOverFrom) {
      this.logger.warn(
        `Machine ${machine.name} was taken over by tablet ${live.tabletId} from ${session.remote}, from tablet ${describeTakenOver(tookOverFrom)}, which was still connected`,
      );
    }
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
      // Shutting down closes every connection as going away, to be retried at
      // once, not as replaced, after which the plugin would wait.
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
    session.writer?.stop();
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

  /**
   * Tells the plugin why, then closes with the error's close code. The
   * message may name hardware the tablet reported, so it is logged escaped.
   */
  private refuse(session: Session, code: ErrorCode, message: string): void {
    if (session.closing) return;
    const log = `Closing the sync connection of ${this.describe(session)}: ${escaped(message)}`;
    // Routine: a tablet reconnecting, or yielding to another one, which the takeover was logged for.
    if (code === "replaced" || code === "superseded" || code === "machine_held") this.logger.log(log);
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

function describeRecord(delivery: ShotDelivery | SteamDelivery): string {
  return delivery.type === "steam" ? `Steam Record ${quoted(delivery.steamId)}` : `Shot ${quoted(delivery.shotId)}`;
}

/** Control, formatting, surrogate and line or paragraph separator characters. */
const UNSAFE_IN_LOG = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

/**
 * Text that may hold what the tablet chose, as a log line shows it: every
 * character that could end the line or change how it displays is escaped
 * as \uXXXX, so the tablet cannot forge log lines.
 */
function escaped(text: string): string {
  return text.replace(UNSAFE_IN_LOG, (character) =>
    Array.from({ length: character.length }, (_, unit) => `\\u${character.charCodeAt(unit).toString(16).padStart(4, "0")}`).join(""),
  );
}

/** A string the tablet chose, such as a record id or its plugin's version, escaped and quoted, so where it ends is clear. */
function quoted(value: string): string {
  return escaped(JSON.stringify(value));
}

/** Hardware a tablet reported, as a log line shows it. */
function describeReported(hardware: Hardware): string {
  return `${quoted(hardware.model)} serial ${quoted(hardware.serial)}`;
}

/** The versions a hello reported, as a log line shows them. */
function describeVersions({ pluginVersion, decaidVersion }: { pluginVersion: string; decaidVersion: string }): string {
  return `plugin ${quoted(pluginVersion)}, Decaid ${quoted(decaidVersion)}`;
}

function describeTakenOver(connection: TakeoverConnectionView): string {
  return `${connection.tabletId} at ${connection.remoteAddress}: ${describeVersions(connection)}`;
}

function describeIdentity(identity: Identity, hardware: Hardware | null): string {
  switch (identity.kind) {
    case "identified":
      if (identity.recognisedBy === "alias" || !hardware) return "identified by its connection id";
      return `${identity.bind ? "bound to" : "identified as"} ${describeReported(hardware)}`;
    case "hardwareNotReported":
      return "no machine connected to its tablet yet";
    case "unidentified":
      return "the machine reports no serial";
    case "mismatch":
      return `reports ${describeReported(identity.hardware)}, not the hardware its token is bound to`;
    case "rejected":
      return `reports dismissed hardware ${describeReported(identity.hardware)}`;
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
