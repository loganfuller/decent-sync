import { type DynamicModule, type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { AccountsModule } from "./accounts/accounts.module.js";
import type { Config } from "./config.js";
import { ConfigModule } from "./config.module.js";
import { HealthController } from "./health.controller.js";
import { LibraryModule } from "./library/library.module.js";
import { LocationsModule } from "./locations/locations.module.js";
import { MachinesModule } from "./machines/machines.module.js";
import { ManagementInterface } from "./management-interface.js";
import { NotificationsModule } from "./notifications.module.js";
import { PrismaModule } from "./prisma.module.js";
import { SyncModule } from "./sync/sync.module.js";

@Module({})
export class AppModule implements NestModule {
  constructor(private readonly managementInterface: ManagementInterface) {}

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
      providers: [ManagementInterface],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    // Every response, an error or a file of the build included, names the build of the management interface.
    consumer.apply(this.managementInterface.nameBuild).forRoutes("*");
  }
}
