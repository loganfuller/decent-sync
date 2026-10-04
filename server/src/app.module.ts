import { type DynamicModule, Module } from "@nestjs/common";
import { ServeStaticModule } from "@nestjs/serve-static";
import { AccountsModule } from "./accounts/accounts.module.js";
import type { Config } from "./config.js";
import { ConfigModule } from "./config.module.js";
import { HealthController } from "./health.controller.js";
import { PrismaModule } from "./prisma.module.js";

@Module({})
export class AppModule {
  static register(config: Config): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.register(config),
        PrismaModule,
        AccountsModule,
        // The management interface is a single-page app: unknown paths outside
        // the API fall back to its index.html.
        ServeStaticModule.forRoot({
          rootPath: config.webDistDir,
          exclude: ["/api/{*path}"],
        }),
      ],
      controllers: [HealthController],
    };
  }
}
