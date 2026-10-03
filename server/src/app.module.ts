import { type DynamicModule, Module } from "@nestjs/common";
import { ServeStaticModule } from "@nestjs/serve-static";
import type { Config } from "./config.js";
import { ConfigModule } from "./config.module.js";
import { HealthController } from "./health.controller.js";
import { PrismaService } from "./prisma.service.js";

@Module({})
export class AppModule {
  static register(config: Config): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.register(config),
        // The management interface is a single-page app: unknown paths outside
        // the API fall back to its index.html.
        ServeStaticModule.forRoot({
          rootPath: config.webDistDir,
          exclude: ["/api/{*path}"],
        }),
      ],
      controllers: [HealthController],
      providers: [PrismaService],
    };
  }
}
