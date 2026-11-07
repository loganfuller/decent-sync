import { Injectable } from "@nestjs/common";
import { type Scope, scopeOf } from "../accounts/scope.js";
import type { AccountRole } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma.service.js";
import { hashSecret } from "../secrets.js";
import { STANDING, recordUse } from "./authorization-server.js";
import { USE_RECORDED_SECONDS, effectiveScopes } from "./oauth.js";

/** Who an MCP request acts as: its access token's Connected App and account, as they stand at this request. */
export interface ConnectedAppAccess {
  connectedAppId: string;
  clientId: string;
  accountId: string;
  role: AccountRole;
  /** What the account sees, as its role and Locations stand at this request. */
  scope: Scope;
  /** `read`, and `change` if it was granted and the account is not a Viewer. */
  scopes: string[];
  /** The endpoint the token was issued for. */
  resource: string;
  /** How long the token has left, by PostgreSQL's clock. */
  secondsLeft: number;
}

/**
 * Checks a Connected App's access token, as each MCP request does: refused
 * once expired, once its Connected App is disconnected or lapsed, or once its
 * account is deactivated, all by PostgreSQL's clock. The account's role and
 * Locations are read with it every time and never kept, so a change to them
 * applies to the next request on any instance, as for a session.
 */
@Injectable()
export class ConnectedAppTokens {
  constructor(private readonly prisma: PrismaService) {}

  async verify(token: string): Promise<ConnectedAppAccess | undefined> {
    const [found] = await this.prisma.$queryRaw<
      {
        connectedAppId: string;
        clientId: string;
        accountId: string;
        role: AccountRole;
        locationIds: string[];
        granted: string[];
        resource: string;
        secondsLeft: number;
        useDue: boolean;
      }[]
    >`
      SELECT c.id::text AS "connectedAppId", c.client_id AS "clientId", a.id::text AS "accountId", a.role,
        ARRAY(SELECT location_id::text FROM staff_locations WHERE account_id = a.id) AS "locationIds",
        c.scopes AS granted, t.resource, extract(epoch FROM t.expires_at - now())::float8 AS "secondsLeft",
        c.last_used_at < now() - make_interval(secs => ${USE_RECORDED_SECONDS}) AS "useDue"
      FROM access_tokens t JOIN connected_apps c ON c.id = t.connected_app_id JOIN accounts a ON a.id = c.account_id
      WHERE t.token_hash = ${hashSecret(token)} AND t.expires_at > now() AND ${STANDING}`;
    if (!found) return undefined;
    // Only when due, so a call writes nothing most of the time.
    if (found.useDue) await recordUse(this.prisma, found.connectedAppId);
    const { locationIds, granted, useDue: _, ...access } = found;
    return { ...access, scope: scopeOf(found.role, locationIds), scopes: effectiveScopes(granted, found.role) };
  }
}
