import { Module } from "@nestjs/common";
import { ConnectedAppsController } from "./connected-apps.controller.js";
import { ConnectedAppsService } from "./connected-apps.service.js";

/**
 * The Connected Apps pages' routes: each account's own Connected Apps, every
 * account's for an Admin, and disconnecting one. Always imported, so with
 * MCP_ENABLED off, when `AuthorizationServerModule` is not, people still see
 * and disconnect the Connected Apps they have.
 */
@Module({
  controllers: [ConnectedAppsController],
  providers: [ConnectedAppsService],
})
export class ConnectedAppsModule {}
