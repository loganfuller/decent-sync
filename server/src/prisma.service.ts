import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { CONFIG } from "./config.module.js";
import type { Config } from "./config.js";
import { PrismaClient } from "./generated/prisma/client.js";

/**
 * How long PostgreSQL lets one of our connections sit in an open transaction
 * without a statement before ending it. If an instance's host vanishes
 * mid-transaction, PostgreSQL may not notice the lost connection for hours,
 * and the transaction would keep its row locks (such as a Machine's) until
 * then. Ours run statements back to back and are timed out by Prisma after
 * 5 s, so only an abandoned one waits this long.
 */
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(CONFIG) config: Config) {
    super({
      adapter: new PrismaPg({
        connectionString: config.databaseUrl,
        idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
      }),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
