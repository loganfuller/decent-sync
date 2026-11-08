import { Injectable, NotFoundException } from "@nestjs/common";
import { AccountRole, Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma.service.js";
import { STANDING } from "./authorization-server.js";
import { effectiveScopes } from "./oauth.js";

/** A Connected App as the REST API lists it to its account. */
export interface ConnectedAppView {
  id: string;
  /** The name its Client ID Metadata Document gave as it was approved. */
  name: string;
  /** The host its client id is published at, which, unlike the name, no other app can give. */
  host: string;
  /** What it may do now: `read`, and `change` if it was allowed to and its account is not a Viewer. */
  scopes: string[];
  approvedAt: string;
  /** Recorded at most once an hour, by PostgreSQL's clock. */
  lastUsedAt: string;
}

/** A Connected App as an Admin sees every account's: also whose it is. */
export interface AccountConnectedAppView extends ConnectedAppView {
  account: { id: string; name: string; email: string };
}

interface ConnectedAppRow {
  id: string;
  name: string;
  host: string;
  granted: string[];
  role: AccountRole;
  approvedAt: Date;
  lastUsedAt: Date;
  accountId: string;
  accountName: string;
  accountEmail: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a Connected App `c` is listed with, and its account `a`. */
const COLUMNS = Prisma.raw(
  `c.id::text AS id, c.name, c.client_host AS host, c.scopes AS granted, a.role, c.approved_at AS "approvedAt",
  c.last_used_at AS "lastUsedAt", a.id::text AS "accountId", a.name AS "accountName", a.email AS "accountEmail"`,
);

/**
 * The Connected Apps pages (ADR-0027): each account's own Connected Apps,
 * every account's for an Admin, and disconnecting one. Only those that still
 * stand are listed: one disconnected, lapsed, or whose account is
 * deactivated is refused already. These are routes of the management
 * interface only, never tools (ADR-0026), and work whether or not
 * MCP_ENABLED is on.
 */
@Injectable()
export class ConnectedAppsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The account's Connected Apps, the latest approved first. */
  async list(accountId: string): Promise<ConnectedAppView[]> {
    const rows = await this.prisma.$queryRaw<ConnectedAppRow[]>`
      SELECT ${COLUMNS} FROM connected_apps c JOIN accounts a ON a.id = c.account_id
      WHERE c.account_id = ${accountId}::uuid AND ${STANDING}
      ORDER BY c.approved_at DESC, c.id DESC`;
    return rows.map(viewConnectedApp);
  }

  /** Every account's Connected Apps, by the account's name, then the latest approved first. */
  async listAll(): Promise<AccountConnectedAppView[]> {
    const rows = await this.prisma.$queryRaw<ConnectedAppRow[]>`
      SELECT ${COLUMNS} FROM connected_apps c JOIN accounts a ON a.id = c.account_id
      WHERE ${STANDING}
      ORDER BY a.name, a.email, c.approved_at DESC, c.id DESC`;
    return rows.map((row) => ({ ...viewConnectedApp(row), account: { id: row.accountId, name: row.accountName, email: row.accountEmail } }));
  }

  /**
   * Disconnects one of the account's Connected Apps, or any account's for an
   * Admin: its tokens are refused from its next request, on every instance,
   * as each request reads it. It is kept, refused, until it lapses.
   * Disconnecting one already disconnected changes nothing. Another
   * account's is not found for Staff and Viewers, as if it were not there.
   */
  async disconnect(id: string, by: { id: string; role: AccountRole }): Promise<void> {
    if (!UUID.test(id)) throw connectedAppNotFound();
    const count = await this.prisma.$executeRaw`
      UPDATE connected_apps SET disconnected_at = coalesce(disconnected_at, now())
      WHERE id = ${id}::uuid AND (account_id = ${by.id}::uuid OR ${by.role === AccountRole.ADMIN})`;
    if (count === 0) throw connectedAppNotFound();
  }
}

/**
 * Disconnects every Connected App of the account, as deactivating it does,
 * in its transaction: they stay disconnected if it is reactivated.
 */
export async function disconnectEvery(tx: Prisma.TransactionClient, accountId: string): Promise<void> {
  await tx.$executeRaw`UPDATE connected_apps SET disconnected_at = now() WHERE account_id = ${accountId}::uuid AND disconnected_at IS NULL`;
}

function viewConnectedApp(row: ConnectedAppRow): ConnectedAppView {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    scopes: effectiveScopes(row.granted, row.role),
    approvedAt: row.approvedAt.toISOString(),
    lastUsedAt: row.lastUsedAt.toISOString(),
  };
}

function connectedAppNotFound(): NotFoundException {
  return new NotFoundException("No such Connected App");
}
