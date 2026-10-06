import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { CONFIG } from "./config.module.js";
import type { Config } from "./config.js";
import { PrismaClient } from "./generated/prisma/client.js";

/**
 * The server's database client. Its connections send no settings at startup,
 * since a pooler may refuse them; a migration sets the idle-in-transaction
 * timeout on the database instead.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(CONFIG) config: Config) {
    super({ adapter: new PrismaPg({ connectionString: config.databaseUrl }) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
