import { BadRequestException } from "@nestjs/common";
import { AccountRole } from "../generated/prisma/client.js";
import type { Config } from "../config.js";

// What the authorization server (ADR-0027) and the MCP endpoint it
// authorizes (ADR-0026) agree on: their addresses, the scopes, and how long
// each secret lasts, by PostgreSQL's clock.

/** Every tool needs it. */
export const READ = "read";
/** Every tool that changes something needs it too. */
export const CHANGE = "change";

/** How long an app's request to connect waits for the person to approve or deny it. */
export const REQUEST_SECONDS = 10 * 60;
/** How long an authorization code may be exchanged for tokens. */
export const CODE_SECONDS = 60;
/** How long an access token lasts. */
export const ACCESS_TOKEN_SECONDS = 60 * 60;
/** A Connected App lapses this long after it was last used, as a session does. */
export const LAPSE_DAYS = 30;
/** Its last use is recorded at most this often. */
export const USE_RECORDED_SECONDS = 60 * 60;

/** The authorization server's issuer: the public URL's origin. */
export function issuerOf(config: Config): string {
  return config.publicUrl.origin;
}

/** The MCP endpoint, as clients name it in `resource` and tokens are issued for (RFC 8707). */
export function resourceOf(config: Config): string {
  return `${config.publicUrl.origin}${MCP_PATH}`;
}

export const MCP_PATH = "/api/mcp";
export const AUTHORIZATION_PATH = "/api/oauth/authorize";
export const TOKEN_PATH = "/api/oauth/token";

/** The scopes a Connected App's calls carry: those it was granted, less `change` while its account is a Viewer. */
export function effectiveScopes(granted: readonly string[], role: AccountRole): string[] {
  return granted.filter((scope) => scope !== CHANGE || role !== AccountRole.VIEWER);
}

/** Whether two `resource` values name the same endpoint. */
export function sameResource(a: string, b: string): boolean {
  return URL.canParse(a) && URL.canParse(b) && new URL(a).href === new URL(b).href;
}

/**
 * A refusal from the token endpoint, in OAuth's form (RFC 6749, section 5.2):
 * `{ error, error_description }`, with 400.
 */
export function tokenError(error: "invalid_request" | "invalid_grant" | "unsupported_grant_type" | "invalid_target", description: string): BadRequestException {
  return new BadRequestException({ error, error_description: description });
}
