import { type DynamicModule, Global, Module } from "@nestjs/common";
import type { Config } from "./config.js";

export const CONFIG = Symbol("CONFIG");

@Global()
@Module({})
export class ConfigModule {
  static register(config: Config): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: CONFIG, useValue: config }],
      exports: [CONFIG],
    };
  }
}
