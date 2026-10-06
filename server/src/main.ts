import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { StartupError, loadConfig } from "./config.js";
import { checkIdleInTransactionTimeout, runMigrations } from "./migrations.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  await runMigrations(config);
  await checkIdleInTransactionTimeout(config);

  const app = await NestFactory.create(AppModule.register(config));
  app.enableShutdownHooks();
  await app.listen(config.port, config.host);
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
