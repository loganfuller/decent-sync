import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import pg from "pg";
import { CONFIG } from "../config.module.js";
import type { Config } from "../config.js";
import type { Prisma } from "../generated/prisma/client.js";

const CHANNEL = "machine_access";
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

/**
 * Tells every server instance that who may stay connected for a Machine has
 * changed: a hello was accepted (replacing the previous connection), its
 * token was reissued, or hardware was dismissed for it. Sent with PostgreSQL
 * NOTIFY inside the transaction making the change, so it is delivered only
 * once that commits (ADR-0011's route to more than one instance).
 */
export async function notifyAccessChanged(tx: Prisma.TransactionClient, machineId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_notify(${CHANNEL}, ${machineId})`;
}

/**
 * Listens for those notifications on a connection of its own. A listener is
 * called with a Machine's id, or with null after (re)connecting, when
 * notifications may have been missed and every connection should be checked.
 */
@Injectable()
export class AccessChanges implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("AccessChanges");
  private readonly listeners = new Set<(machineId: string | null) => void>();
  private client: pg.Client | undefined;
  private retryMs = MIN_RETRY_MS;
  private retryTimer: NodeJS.Timeout | undefined;
  private closing = false;

  constructor(@Inject(CONFIG) private readonly config: Config) {}

  subscribe(listener: (machineId: string | null) => void): void {
    this.listeners.add(listener);
  }

  async onModuleInit(): Promise<void> {
    await this.listen();
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    clearTimeout(this.retryTimer);
    await this.client?.end().catch(() => {});
  }

  private async listen(): Promise<void> {
    const client = new pg.Client({ connectionString: this.config.databaseUrl });
    client.on("notification", (message) => {
      if (message.channel === CHANNEL && message.payload) this.emit(message.payload);
    });
    client.on("error", (error) => this.lost(client, error.message));
    client.on("end", () => this.lost(client, "the connection ended"));
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
    } catch (error) {
      this.lost(client, error instanceof Error ? error.message : String(error));
      return;
    }
    this.client = client;
    this.retryMs = MIN_RETRY_MS;
    // Anything sent while not listening was missed.
    this.emit(null);
  }

  private lost(client: pg.Client, reason: string): void {
    if (this.closing || (this.client !== undefined && this.client !== client)) return;
    this.client = undefined;
    client.end().catch(() => {});
    if (this.retryTimer) return;
    this.logger.warn(`Not listening for access changes (${reason}); retrying in ${this.retryMs / 1000} s. Heartbeats still check every connection.`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.listen();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
  }

  private emit(machineId: string | null): void {
    for (const listener of this.listeners) listener(machineId);
  }
}
