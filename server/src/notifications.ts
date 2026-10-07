import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import pg from "pg";
import { CONFIG } from "./config.module.js";
import type { Config } from "./config.js";
import type { Prisma } from "./generated/prisma/client.js";

/**
 * The channels on which a server instance tells every instance of a change
 * they may have to act on (ADR-0016), each with its payload:
 *
 * - `machine_access`, a Machine's id: who may stay connected for it has
 *   changed, as when a hello was accepted, replacing the previous
 *   connection, its token was reissued, or hardware was dismissed for it;
 * - `library_changes`, a Location's id: what the Library offers there, or
 *   what its tablets must be written, has changed.
 */
export type Channel = "machine_access" | "library_changes";

const CHANNELS: readonly Channel[] = ["machine_access", "library_changes"];
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

/**
 * Tells every instance of a change, with PostgreSQL NOTIFY inside the
 * transaction making it, so it is delivered only once that commits.
 */
export async function notify(tx: Prisma.TransactionClient, channel: Channel, payload: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_notify(${channel}, ${payload})`;
}

/**
 * Listens for those notifications on one connection of its own, which an
 * instance needs whatever the number of channels. A listener is called with
 * a notification's payload, or with null after (re)connecting, when
 * notifications may have been missed and everything they would have said
 * should be checked again.
 */
@Injectable()
export class Notifications implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("Notifications");
  private readonly listeners = new Map<Channel, Set<(payload: string | null) => void>>(CHANNELS.map((channel) => [channel, new Set()]));
  private client: pg.Client | undefined;
  /** A client still connecting or starting to listen, ended on shutdown so it cannot outlive it. */
  private connecting: pg.Client | undefined;
  private retryMs = MIN_RETRY_MS;
  private retryTimer: NodeJS.Timeout | undefined;
  private closing = false;

  constructor(@Inject(CONFIG) private readonly config: Config) {}

  subscribe(channel: Channel, listener: (payload: string | null) => void): void {
    this.listeners.get(channel)!.add(listener);
  }

  async onModuleInit(): Promise<void> {
    await this.listen();
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    clearTimeout(this.retryTimer);
    await Promise.all([this.client?.end().catch(() => {}), this.connecting?.end().catch(() => {})]);
  }

  private async listen(): Promise<void> {
    const client = new pg.Client({ connectionString: this.config.databaseUrl });
    client.on("notification", (message) => {
      const listeners = this.listeners.get(message.channel as Channel);
      if (listeners && message.payload) for (const listener of listeners) listener(message.payload);
    });
    client.on("error", (error) => this.lost(client, error.message));
    client.on("end", () => this.lost(client, "the connection ended"));
    this.connecting = client;
    try {
      await client.connect();
      for (const channel of CHANNELS) await client.query(`LISTEN ${channel}`);
    } catch (error) {
      this.lost(client, error instanceof Error ? error.message : String(error));
      return;
    } finally {
      this.connecting = undefined;
    }
    // Shut down between connecting and here: shutdown saw neither field set, so this ends it.
    if (this.closing) return void (await client.end().catch(() => {}));
    this.client = client;
    this.retryMs = MIN_RETRY_MS;
    // Anything sent while not listening was missed.
    for (const listeners of this.listeners.values()) for (const listener of listeners) listener(null);
  }

  private lost(client: pg.Client, reason: string): void {
    // Shutdown ends the clients itself.
    if (this.closing || (this.client !== undefined && this.client !== client)) return;
    this.client = undefined;
    client.end().catch(() => {});
    if (this.retryTimer) return;
    this.logger.warn(
      `Not listening for access changes or Library changes (${reason}); retrying in ${this.retryMs / 1000} s. Heartbeats still check every connection, and a tablet that reconnects is written what it lacks.`,
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.listen();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
  }
}
