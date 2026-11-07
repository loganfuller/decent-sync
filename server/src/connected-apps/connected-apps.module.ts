import { Module } from "@nestjs/common";
import { ConnectedAppTokens } from "./access.js";
import { AuthorizationController, AuthorizationServerMetadata } from "./authorization.controller.js";
import { AuthorizationServer } from "./authorization-server.js";
import { ClientMetadataDocuments } from "./client-metadata.js";
import { ConnectedAppsCleanup } from "./cleanup.js";

/**
 * The authorization server assistants connect through (ADR-0027): its
 * metadata, the authorization endpoint, the consent page's routes and the
 * token endpoint, and the check of a Connected App's access token, which the
 * MCP endpoint makes on each request. Imported only while MCP_ENABLED is on.
 */
@Module({
  controllers: [AuthorizationController],
  providers: [AuthorizationServer, AuthorizationServerMetadata, ClientMetadataDocuments, ConnectedAppTokens, ConnectedAppsCleanup],
  exports: [ConnectedAppTokens],
})
export class ConnectedAppsModule {}
