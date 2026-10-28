import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { StartupError, loadConfig } from "./config.js";
import { Drain, stopOnSignals } from "./drain.js";
import { ManagementInterface } from "./management-interface.js";
import { checkIdleInTransactionTimeout, runMigrations } from "./migrations.js";

async function main(): Promise<void> {
  // Locations' time zones are resolved with Temporal (`locations/time-zones.ts`), which some Node 26 builds lack.
  if (typeof Temporal === "undefined") {
    throw new StartupError(
      `Decent Sync needs Node.js 26 or newer with Temporal, as the builds from nodejs.org and the server image have; Node.js ${process.version} here lacks it`,
    );
  }
  const config = loadConfig(process.env);
  await runMigrations(config);
  await checkIdleInTransactionTimeout(config);

  const app = await NestFactory.create(AppModule.register(config));
  // Every response names the build of the management interface. Added before `listen()` initializes the app, this
  // runs before Nest's body parsers, which answer a malformed or oversized body themselves, and every other middleware.
  app.use(app.get(ManagementInterface).nameBuild);
  app.use(app.get(Drain).track);
  await app.listen(config.port, config.host);
  // Not Nest's `enableShutdownHooks()`, which would disconnect from the database before the requests under way finish.
  stopOnSignals(app, config);
  // Test servers are ready once this is logged (`server/test/support/test-server.ts`).
  new Logger("DecentSync").log(
    `Listening on ${config.host}:${config.port}; public URL ${config.publicUrl.origin}`,
  );
}

main().catch((error: unknown) => {
  if (error instanceof StartupError) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});
