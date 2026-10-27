import { type DynamicModule, Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { AccountsModule } from "./accounts/accounts.module.js";
import type { Config } from "./config.js";
import { ConfigModule } from "./config.module.js";
import { Drain } from "./drain.js";
import { HealthController } from "./health.controller.js";
import { LibraryModule } from "./library/library.module.js";
import { LocationsModule } from "./locations/locations.module.js";
import { MachinesModule } from "./machines/machines.module.js";
import { ManagementInterface } from "./management-interface.js";
import { NotificationsModule } from "./notifications.module.js";
import { PrismaModule } from "./prisma.module.js";
import { SyncModule } from "./sync/sync.module.js";

@Module({})
export class AppModule {
  static register(config: Config): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.register(config),
        PrismaModule,
        NotificationsModule,
        AccountsModule,
        LocationsModule,
        MachinesModule,
        LibraryModule,
        SyncModule,
      ],
      controllers: [HealthController],
      providers: [ManagementInterface, Drain, { provide: APP_INTERCEPTOR, useExisting: Drain }],
    };
  }
}
