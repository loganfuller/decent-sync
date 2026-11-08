import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma.service.js";
import { LAPSE_DAYS } from "./oauth.js";

/** How often each server instance deletes what the authorization server no longer keeps. */
const CLEANUP_INTERVAL_MS = 60 * 60_000;
/** The most rows one statement deletes, so a large backlog never holds one long statement. */
const CLEANUP_BATCH = 1_000;

/**
 * What expires, by PostgreSQL's clock: requests to connect that were never
 * answered, codes never exchanged, access tokens, and Connected Apps that
 * lapsed, with their tokens. A disconnected Connected App is kept, refused,
 * until it lapses. A lapsed one that the Library's history or a Conflict
 * names is kept, refused, without its refresh tokens, so they go on showing
 * the change as made through it.
 */
const EXPIRED: { what: string; table: string; condition: string }[] = [
  { what: "expired requests to connect", table: "authorization_requests", condition: "expires_at <= now()" },
  { what: "expired authorization codes", table: "authorization_codes", condition: "expires_at <= now()" },
  { what: "expired access tokens", table: "access_tokens", condition: "expires_at <= now()" },
  {
    what: "lapsed Connected Apps' refresh tokens",
    table: "refresh_tokens",
    condition: `connected_app_id IN (SELECT id FROM connected_apps WHERE last_used_at <= now() - make_interval(days => ${LAPSE_DAYS}))`,
  },
  {
    what: "lapsed Connected Apps",
    table: "connected_apps",
    condition: `last_used_at <= now() - make_interval(days => ${LAPSE_DAYS})
      AND NOT EXISTS (SELECT 1 FROM item_versions WHERE item_versions.connected_app_id = connected_apps.id)
      AND NOT EXISTS (SELECT 1 FROM conflicts WHERE conflicts.connected_app_id = connected_apps.id)`,
  },
];

/**
 * Deletes what the authorization server no longer keeps (EXPIRED): as the
 * server starts, then every hour, on every instance, as the delivery id
 * cleanup does (`DeliveryIdCleanup`). Each batch is a statement of its own
 * that skips locked rows, so it waits for no one. A run that fails is
 * logged, and the next tries again.
 */
@Injectable()
export class ConnectedAppsCleanup implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("ConnectedAppsCleanup");
  private timer: NodeJS.Timeout | undefined;
  /** The run in progress, which shutdown waits for. */
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    this.schedule(0);
  }

  /** Runs before the database disconnects: stops the timer, and lets a run in progress finish its statement. */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.running = this.run().finally(() => {
        this.running = undefined;
        if (!this.stopped) this.schedule(CLEANUP_INTERVAL_MS);
      });
    }, delayMs);
  }

  private async run(): Promise<void> {
    for (const { what, table, condition } of EXPIRED) {
      let deleted = 0;
      try {
        while (!this.stopped) {
          const count = await this.prisma.$executeRaw`
            DELETE FROM ${Prisma.raw(table)} WHERE ctid = ANY(ARRAY(
              SELECT ctid FROM ${Prisma.raw(table)} WHERE ${Prisma.raw(condition)} LIMIT ${CLEANUP_BATCH}::integer FOR UPDATE SKIP LOCKED
            ))`;
          deleted += count;
          if (count < CLEANUP_BATCH) break;
        }
      } catch (error) {
        this.logger.error(`Could not delete ${what}; trying again in an hour: ${String(error)}`);
      }
      if (deleted > 0) this.logger.log(`Deleted ${deleted} ${what}`);
    }
  }
}
