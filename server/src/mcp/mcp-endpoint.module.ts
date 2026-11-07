import fs from "node:fs";
import { type DynamicModule, type MiddlewareConsumer, Module, type NestModule, RequestMethod } from "@nestjs/common";
import { McpModule } from "@nestjs/mcp";
import { Public } from "../accounts/guards.js";
import type { Config } from "../config.js";
import { ConnectedAppsModule } from "../connected-apps/connected-apps.module.js";
import { CHANGE, MCP_PATH, READ, issuerOf, resourceOf } from "../connected-apps/oauth.js";
import { LocationsModule } from "../locations/locations.module.js";
import { MachinesModule } from "../machines/machines.module.js";
import { INSTRUCTIONS } from "./instructions.js";
import { McpListenStreams } from "./listen-streams.js";
import { LocationsTools } from "./locations.tools.js";
import { AccessTokenVerifier } from "./token-verifier.js";

/**
 * The MCP endpoint assistants reach the server through, at `/api/mcp`
 * (ADR-0026): `@nestjs/mcp`, serving the 2026-07-28 revision and the 2025
 * revisions, statelessly, so any instance answers any request. Its tools are
 * this module's providers alone, thin and grouped by area, each calling the
 * server's services. Every request, `tools/list` included, carries a
 * Connected App's access token (`AccessTokenVerifier`), so the route is
 * public to `SessionGuard`; global guards and filters run again around each
 * tool call, outside HTTP. Imported only while MCP_ENABLED is on.
 */
@Module({})
export class McpEndpointModule implements NestModule {
  constructor(private readonly listens: McpListenStreams) {}

  static register(config: Config): DynamicModule {
    return {
      module: McpEndpointModule,
      imports: [
        LocationsModule,
        MachinesModule,
        McpModule.forRoot({
          path: MCP_PATH.slice(1),
          decorators: [Public()],
          imports: [ConnectedAppsModule],
          name: "decent-sync",
          title: "Decent Sync",
          version: serverVersion(),
          instructions: INSTRUCTIONS,
          include: [McpEndpointModule],
          auth: {
            verifier: AccessTokenVerifier,
            resource: resourceOf(config),
            authorizationServers: [issuerOf(config)],
            // What a client asks for as it first connects. No scope is required of every request: a refusal would name
            // it in its challenge, and clients ask for what a challenge names alone, never for change. Each tool needs
            // read instead, which every Connected App has.
            scopesSupported: [READ, CHANGE],
            resourceName: "Decent Sync",
          },
        }),
      ],
      providers: [McpListenStreams, LocationsTools],
      exports: [McpListenStreams],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(this.listens.track).forRoutes({ path: MCP_PATH.slice(1), method: RequestMethod.POST });
  }
}

/**
 * The release this server is, from the repository's package.json, which the
 * server image keeps beside the server, as clients are told it. Only shown
 * to them, so a build without it, such as a test's copy, still starts.
 */
function serverVersion(): string {
  try {
    const { version } = JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof version === "string" ? version : "unknown";
  } catch {
    return "unknown";
  }
}
