import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import type { Response } from "express";
import { type LiveFrame, type LiveStart, type LiveStop, MAX_NOTIFICATION_BYTES, relayedLiveFrame, utf8Length } from "@decent-sync/protocol";
import { CONFIG } from "../config.module.js";
import type { Config } from "../config.js";
import { machineNotFound } from "../machines/input.js";
import { Notifications, notify } from "../notifications.js";
import { PrismaService } from "../prisma.service.js";

/** How often a stream's instance renews its lease. */
const RENEW_MS = 10_000;
/** How long after its last renewal a lease expires, by PostgreSQL's clock. */
const LEASE_SECONDS = 30;
/** How soon the browser's `EventSource` reconnects after a stream ends, as the stream tells it. */
const RECONNECT_MS = 1_000;
/** A stream whose viewer has this many bytes still unsent drops live frames until it catches up: the next replaces them. */
const MAX_UNSENT_BYTES = 64 * 1024;
/** How long after a lease's expiry the instance holding its Machine's connection checks the leases again, so PostgreSQL's clock has passed it. */
const EXPIRY_MARGIN_MS = 50;
/** How long after a failed check of the leases it is tried again. */
const CHECK_RETRY_MS = 5_000;

/** A plugin connection this instance welcomed, which may stream for the Live View: not mismatched, and at its wire revision. */
export interface LiveViewConnection {
  sessionId: string;
  machineId: string;
  /** For log lines, such as "Machine Bar 1 (203.0.113.7)". */
  description: string;
  /** Sends the plugin a message, unless its connection is closing. */
  send(message: LiveStart | LiveStop): void;
}

interface Holder {
  connection: LiveViewConnection;
  /** Whether the plugin was last sent `liveStart`, rather than `liveStop` or nothing. */
  started: boolean;
  /** Its decisions, made one at a time. */
  deciding: Promise<void>;
  /** Checks the leases again once the earliest has expired. */
  expiry?: NodeJS.Timeout;
  closed: boolean;
  /** Whether one of its frames is being relayed. */
  relaying: boolean;
  /** The latest frame of each source, awaiting its turn while another is relayed. */
  waiting: Map<string, string>;
  /** Set once a relay failed, until one succeeds, so a database outage is logged once. */
  failing: boolean;
  /** Set once a frame too large to relay was dropped, so that is logged once. */
  droppedLarge: boolean;
}

interface Stream {
  /** Its Machine's id, as PostgreSQL writes it once the Machine is found. */
  machineId: string;
  response: Response;
  /** Its lease, once inserted. */
  leaseId?: string;
  renewal?: NodeJS.Timeout;
  keepAlive?: NodeJS.Timeout;
  ended: boolean;
}

/**
 * The Live View (ADR-0024): what a Machine reports as it happens, streamed
 * from its plugin through the server to each page showing it, nothing of it
 * stored.
 *
 * - **Streams.** Each Live View open on this instance is a Server-Sent
 *   Events stream, holding a lease on its Machine in `live_view_leases`,
 *   announced on `live_views` as it is inserted. The instance renews it
 *   every RENEW_MS, to expire LEASE_SECONDS after, by PostgreSQL's clock; a
 *   renewal that finds it expired or gone ends the stream, which the browser
 *   then opens again. Closing a stream deletes its lease and announces that.
 *   Its headers wait for its lease, so a viewer that has them is counted.
 *   Each relayed live frame is one event; a comment follows
 *   `LIVE_VIEW_KEEP_ALIVE_SECONDS` with nothing to send, so proxies don't
 *   close it as idle.
 * - **Starting the plugin.** Each connection this instance holds that may
 *   stream is sent `liveStart` while it holds its Machine and any of the
 *   Machine's leases is unexpired, and `liveStop` once not, only as that
 *   changes. Its decisions are made one at a time, when a lease of its
 *   Machine is announced, after its welcome, at the earliest lease's expiry,
 *   and for every connection once listening again. A mismatched connection,
 *   or a plugin below LIVE_VIEW_WIRE_REVISION, is never started: the gateway
 *   never hands one over.
 * - **Relaying.** A live frame from a connection that was started, and still
 *   holds its Machine as it is relayed, goes to every instance by NOTIFY on
 *   `live_frames`, outside any transaction, one at a time for each connection,
 *   the latest frame of each source waiting its turn. One too large for a
 *   notification, or unrequested, is dropped, and a failed relay is logged
 *   and dropped; none closes the connection. Every instance forwards each to
 *   its own streams of that Machine.
 *
 * Its memory holds only this instance's own streams and connections
 * (ADR-0016).
 */
@Injectable()
export class LiveViews implements OnModuleDestroy {
  private readonly logger = new Logger("LiveView");
  /** This instance's streams, by their Machine's id. */
  private readonly streams = new Map<string, Set<Stream>>();
  /** This instance's connections that may stream, by their session id. */
  private readonly holders = new Map<string, Holder>();
  /** Work that writes to the database, which shutdown waits for. */
  private readonly inFlight = new Set<Promise<void>>();
  private ending = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: Config,
    notifications: Notifications,
  ) {
    // After listening anew, every connection is checked, as an announcement may have been missed.
    notifications.subscribe("live_views", (machineId) => {
      for (const holder of this.holders.values()) if (machineId === null || holder.connection.machineId === machineId) this.check(holder);
    });
    notifications.subscribe("live_frames", (payload) => {
      if (payload !== null) this.forward(payload);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.end();
  }

  /**
   * Ends every stream, as the instance stops: the browser opens it again,
   * through another instance once the proxy has noticed. Streams opened from
   * now on end at once too. Resolves once their leases are deleted.
   */
  async end(): Promise<void> {
    this.ending = true;
    for (const streams of [...this.streams.values()]) for (const stream of [...streams]) this.endStream(stream);
    while (this.inFlight.size > 0) await Promise.all(this.inFlight);
  }

  /**
   * Opens a Live View of the Machine for the viewer's session on the
   * response, which stays open until the viewer closes it, or the lease can't
   * be kept. Throws for an unknown Machine, before anything is sent. Its
   * headers are sent once its lease is held, or at once with its end if it
   * ends without one. One opened offline receives frames once its Machine
   * connects.
   */
  async open(machineId: string, viewerSessionId: string, response: Response): Promise<void> {
    const stream: Stream = { machineId, response, ended: false };
    // Before anything is awaited, so a viewer gone meanwhile is never kept, nor its lease renewed. One gone already, as
    // while its session was checked, closed before this could hear it.
    response.once("close", () => this.streamClosed(stream));
    if (response.destroyed) return;
    // The Machine's id as PostgreSQL writes it, as relayed frames and announcements name it, whatever case the path used.
    const [machine] = await this.prisma.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM machines WHERE id = ${machineId}::uuid`;
    if (!machine) throw machineNotFound();
    if (stream.ended) return;
    stream.machineId = machine.id;
    // Sent once the lease is held: until then the stream is sent nothing, a frame relayed for another viewer included.
    response.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
    if (this.ending) return void this.endStream(stream);
    const streams = this.streams.get(machine.id) ?? new Set();
    streams.add(stream);
    this.streams.set(machine.id, streams);
    let leaseId: string | undefined;
    try {
      leaseId = await this.prisma.$transaction(async (tx) => {
        // In a statement of its own, skipping leases locked by another's deletion or renewal: no one waits on it.
        await tx.$executeRaw`
          DELETE FROM live_view_leases WHERE id IN (SELECT id FROM live_view_leases WHERE expires_at <= now() FOR UPDATE SKIP LOCKED)`;
        const id = randomUUID();
        // Inserted only while the viewer's session lasts, as its end deletes its leases.
        const inserted = await tx.$executeRaw`
          INSERT INTO live_view_leases (id, machine_id, session_id, expires_at)
          SELECT ${id}::uuid, ${machine.id}::uuid, id, now() + make_interval(secs => ${LEASE_SECONDS}) FROM sessions WHERE id = ${viewerSessionId}::uuid`;
        if (inserted === 0) return undefined;
        await notify(tx, "live_views", machine.id);
        return id;
      });
    } catch (error) {
      this.logger.error(`Could not open a Live View: ${String(error)}`);
    }
    if (leaseId === undefined) return void this.endStream(stream);
    stream.leaseId = leaseId;
    // Closed while its lease was being inserted.
    if (stream.ended) return void this.release(leaseId, machine.id);
    response.flushHeaders();
    response.write(`retry: ${RECONNECT_MS}\n\n`);
    this.keepAlive(stream);
    stream.renewal = setInterval(() => void this.track(this.renew(stream)), RENEW_MS);
  }

  /** A connection this instance welcomed that may stream: whether it is to stream is decided now. */
  welcomed(connection: LiveViewConnection): void {
    const holder: Holder = { connection, started: false, deciding: Promise.resolve(), closed: false, relaying: false, waiting: new Map(), failing: false, droppedLarge: false };
    this.holders.set(connection.sessionId, holder);
    this.check(holder);
  }

  /** A connection's close: it streams no more. */
  closed(sessionId: string): void {
    const holder = this.holders.get(sessionId);
    if (!holder) return;
    holder.closed = true;
    clearTimeout(holder.expiry);
    holder.waiting.clear();
    this.holders.delete(sessionId);
  }

  /** A live frame the connection sent, handled as it arrives. */
  frame(sessionId: string, live: LiveFrame): void {
    const holder = this.holders.get(sessionId);
    // Unrequested: from a connection never started, or stopped since, or one that never streams.
    if (!holder?.started || holder.closed) return;
    const payload = relayedLiveFrame(holder.connection.machineId, live);
    if (utf8Length(payload) > MAX_NOTIFICATION_BYTES) {
      if (!holder.droppedLarge) this.logger.warn(`Dropped a live frame from ${holder.connection.description} too large to relay; any more are dropped too`);
      holder.droppedLarge = true;
      return;
    }
    if (!holder.relaying) return void this.track(this.relay(holder, payload));
    const source = live.source === "sensor" ? `sensor ${live.sensorId}` : live.source;
    holder.waiting.delete(source);
    holder.waiting.set(source, payload);
  }

  /** Decides whether the connection is to stream, in turn. */
  private check(holder: Holder): void {
    holder.deciding = this.track(holder.deciding.then(() => this.decide(holder)));
  }

  private async decide(holder: Holder): Promise<void> {
    if (holder.closed) return;
    clearTimeout(holder.expiry);
    const { machineId, sessionId } = holder.connection;
    let leases: { holds: boolean; expiresInMs: number | null };
    try {
      [leases] = await this.prisma.$queryRaw<[{ holds: boolean; expiresInMs: number | null }]>`
        SELECT EXISTS (SELECT 1 FROM machines WHERE id = ${machineId}::uuid AND connected_session_id = ${sessionId}::uuid) AS holds,
          (SELECT (extract(epoch FROM min(expires_at) - now()) * 1000)::float8 FROM live_view_leases
           WHERE machine_id = ${machineId}::uuid AND expires_at > now()) AS "expiresInMs"`;
    } catch (error) {
      this.logger.error(`Could not check the Live Views of ${holder.connection.description}: ${String(error)}`);
      if (!holder.closed) holder.expiry = setTimeout(() => this.check(holder), CHECK_RETRY_MS);
      return;
    }
    if (holder.closed) return;
    const wanted = leases.holds && leases.expiresInMs !== null;
    if (wanted !== holder.started) {
      holder.started = wanted;
      if (!wanted) holder.waiting.clear();
      holder.connection.send({ type: wanted ? "liveStart" : "liveStop" });
    }
    if (leases.expiresInMs !== null) holder.expiry = setTimeout(() => this.check(holder), Math.max(0, leases.expiresInMs) + EXPIRY_MARGIN_MS);
  }

  /** Relays the frame, then each waiting, one at a time, while the connection still holds its Machine. */
  private async relay(holder: Holder, first: string): Promise<void> {
    holder.relaying = true;
    const { machineId, sessionId } = holder.connection;
    try {
      for (let payload: string | undefined = first; payload !== undefined && !holder.closed; payload = this.nextWaiting(holder)) {
        try {
          await this.prisma.$executeRaw`
            SELECT pg_notify('live_frames', ${payload}) FROM machines WHERE id = ${machineId}::uuid AND connected_session_id = ${sessionId}::uuid`;
          holder.failing = false;
        } catch (error) {
          if (!holder.failing) this.logger.warn(`Could not relay a live frame from ${holder.connection.description}; dropping it, and any more until one is relayed: ${String(error)}`);
          holder.failing = true;
        }
      }
    } finally {
      holder.relaying = false;
    }
  }

  private nextWaiting(holder: Holder): string | undefined {
    const next = holder.waiting.entries().next();
    if (next.done) return undefined;
    holder.waiting.delete(next.value[0]);
    return next.value[1];
  }

  /** Sends a relayed frame to this instance's streams of its Machine. */
  private forward(payload: string): void {
    if (this.streams.size === 0) return;
    let machineId: unknown;
    try {
      machineId = (JSON.parse(payload) as { machineId?: unknown }).machineId;
    } catch {
      return;
    }
    // An event's data ends at a line break, which JSON.stringify never writes.
    if (typeof machineId !== "string" || /[\r\n]/.test(payload)) return;
    for (const stream of this.streams.get(machineId) ?? []) {
      // One whose lease isn't held yet misses it, as its headers wait for the lease: the next frame replaces it.
      if (stream.ended || stream.leaseId === undefined || stream.response.writableLength > MAX_UNSENT_BYTES) continue;
      stream.response.write(`data: ${payload}\n\n`);
      this.keepAlive(stream);
    }
  }

  /** Sends a comment once the stream has had nothing to send for `LIVE_VIEW_KEEP_ALIVE_SECONDS`. */
  private keepAlive(stream: Stream): void {
    clearTimeout(stream.keepAlive);
    stream.keepAlive = setTimeout(() => {
      if (stream.ended) return;
      stream.response.write(": keep-alive\n\n");
      this.keepAlive(stream);
    }, this.config.liveViewKeepAliveMs);
  }

  /** Renews the stream's lease, or ends the stream if it expired or is gone, as after a stall or with its session. */
  private async renew(stream: Stream): Promise<void> {
    if (stream.ended || stream.leaseId === undefined) return;
    try {
      const renewed = await this.prisma.$executeRaw`
        UPDATE live_view_leases SET expires_at = now() + make_interval(secs => ${LEASE_SECONDS}) WHERE id = ${stream.leaseId}::uuid AND expires_at > now()`;
      if (renewed === 0) this.endStream(stream);
    } catch (error) {
      this.logger.warn(`Could not renew a Live View's lease: ${String(error)}`);
    }
  }

  /** Ends a stream on this side, which the browser then opens again after RECONNECT_MS. */
  private endStream(stream: Stream): void {
    this.streamClosed(stream);
    stream.response.end(`retry: ${RECONNECT_MS}\n\n`);
  }

  private streamClosed(stream: Stream): void {
    if (stream.ended) return;
    stream.ended = true;
    clearInterval(stream.renewal);
    clearTimeout(stream.keepAlive);
    const streams = this.streams.get(stream.machineId);
    streams?.delete(stream);
    if (streams?.size === 0) this.streams.delete(stream.machineId);
    if (stream.leaseId !== undefined) this.release(stream.leaseId, stream.machineId);
  }

  /** Deletes a closed stream's lease, and announces it, so the plugin stops once no other is left. */
  private release(leaseId: string, machineId: string): void {
    void this.track(
      this.prisma
        .$transaction(async (tx) => {
          await tx.$executeRaw`DELETE FROM live_view_leases WHERE id = ${leaseId}::uuid`;
          await notify(tx, "live_views", machineId);
        })
        .catch((error: unknown) => this.logger.warn(`Could not delete a closed Live View's lease, which expires by itself: ${String(error)}`)),
    );
  }

  /** Keeps work in `inFlight` until it settles. The work must not reject. */
  private track(work: Promise<void>): Promise<void> {
    this.inFlight.add(work);
    void work.then(() => this.inFlight.delete(work));
    return work;
  }
}
