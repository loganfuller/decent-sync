import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request, Response } from "express";
import { CONFIG } from "../config.module.js";
import type { Config } from "../config.js";
import { PrismaService } from "../prisma.service.js";
import { hashSecret, newSecret } from "../secrets.js";
import { type Account, AccountRole, type Prisma } from "../generated/prisma/client.js";
import { accountDeactivated } from "./accounts.service.js";
import { EVERYTHING, type Scope } from "./scope.js";

const COOKIE_NAME = "decent_sync_session";
const DAY_MS = 24 * 60 * 60 * 1000;
/** A session ends after this long unused. */
const LIFETIME_MS = 30 * DAY_MS;
/** Using a session pushes its expiry forward, at most once per this interval. */
const RENEW_AFTER_MS = DAY_MS;

export interface SignedIn {
  account: Account;
  sessionId: string;
  /** What the account sees, as its role and Locations stand at this request. */
  scope: Scope;
}

/**
 * Cookie sessions for the management interface. The cookie holds a random
 * token that lives on the device until it expires, so a browser restart keeps
 * the person signed in. The server stores only the token's hash, and signing
 * out deletes the stored session.
 *
 * Expiry is set, renewed and judged by the database's clock, never an
 * instance's (ADR-0016): one instance may start a session that another
 * renews, judges or deletes, and their clocks drift apart. The cookie's
 * Max-Age is only a hint to the browser; the stored expiry decides.
 *
 * The account is read with the session on every request, never kept, so a
 * change to its role or Locations applies to its next request on any
 * instance. A session starts under the account's row lock, which a password
 * reset or a deactivation holds while it ends the account's sessions: one
 * started first is ended by it, and one started after finds the password
 * changed or the account deactivated and is refused.
 */
@Injectable()
export class SessionsService {
  private readonly secureCookie: boolean;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CONFIG) config: Config,
  ) {
    this.secureCookie = config.publicUrl.protocol === "https:";
  }

  /**
   * Starts a session for the account, as it was just read with the password
   * checked against it, and sets its cookie on the response. Refused if,
   * under the account's row lock, its password has changed since or it has
   * been deactivated.
   */
  async start(account: Pick<Account, "id" | "passwordHash">, response: Response): Promise<void> {
    await this.deleteExpired();
    const token = await this.prisma.$transaction(async (tx) => {
      // FOR SHARE: sign-ins wait only for a reset or deactivation in progress, not for each other.
      const [current] = await tx.$queryRaw<{ passwordHash: string; deactivated: boolean }[]>`
        SELECT password_hash AS "passwordHash", deactivated_at IS NOT NULL AS deactivated
        FROM accounts WHERE id = ${account.id}::uuid FOR SHARE`;
      if (!current || current.passwordHash !== account.passwordHash) {
        throw new UnauthorizedException("The email or password is incorrect");
      }
      if (current.deactivated) throw accountDeactivated();
      return this.create(tx, account.id);
    });
    this.setSessionCookie(response, token);
  }

  /**
   * Creates a session for the account in the caller's transaction, which
   * must hold the account's row lock, and returns its token. Set its cookie
   * with `setSessionCookie` only once that transaction has committed.
   */
  async create(tx: Prisma.TransactionClient, accountId: string): Promise<string> {
    const token = newSecret();
    const now = await databaseNow(tx);
    await tx.session.create({
      data: { tokenHash: hashSecret(token), accountId, expiresAt: new Date(now + LIFETIME_MS) },
    });
    return token;
  }

  /** Sets the cookie of a session `create` started. */
  setSessionCookie(response: Response, token: string): void {
    this.setCookie(response, token, LIFETIME_MS);
  }

  /**
   * The account signed in by the request's cookie, or undefined. Renews the
   * session when it is due, and clears a cookie that no longer names one.
   */
  async resume(request: Request, response: Response): Promise<SignedIn | undefined> {
    const token = readCookie(request.headers.cookie, COOKIE_NAME);
    if (!token) return undefined;

    const now = await databaseNow(this.prisma);
    // The account is read with it every time, so a change to its role, Locations or standing reaches the next request.
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashSecret(token) },
      include: { account: { include: { locations: { select: { locationId: true } } } } },
    });
    if (!session || session.expiresAt.getTime() <= now || session.account.deactivatedAt) {
      this.clearCookie(response);
      return undefined;
    }

    if (session.expiresAt.getTime() - now < LIFETIME_MS - RENEW_AFTER_MS) {
      const { count } = await this.prisma.session.updateMany({
        where: { id: session.id },
        data: { expiresAt: new Date(now + LIFETIME_MS) },
      });
      // Signed out meanwhile, perhaps on another instance.
      if (count === 0) {
        this.clearCookie(response);
        return undefined;
      }
      this.setCookie(response, token, LIFETIME_MS);
    }
    const { locations, ...account } = session.account;
    const scope: Scope =
      account.role === AccountRole.ADMIN
        ? EVERYTHING
        : { kind: "locations", locationIds: locations.map((location) => location.locationId) };
    return { account, sessionId: session.id, scope };
  }

  /** Ends the session on the server and removes its cookie. */
  async end(sessionId: string, response: Response): Promise<void> {
    await this.prisma.session.deleteMany({ where: { id: sessionId } });
    this.clearCookie(response);
  }

  /**
   * Deletes expired sessions, in a statement of its own. It skips sessions
   * another transaction has locked, such as a password reset ending its
   * account's sessions, so it waits for no one and no one waits for it.
   */
  private async deleteExpired(): Promise<void> {
    await this.prisma.$executeRaw`
      DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE expires_at <= now() FOR UPDATE SKIP LOCKED)`;
  }

  private setCookie(response: Response, token: string, maxAgeMs: number): void {
    const attributes = [
      `${COOKIE_NAME}=${token}`,
      "Path=/",
      `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
      "HttpOnly",
      "SameSite=Lax",
    ];
    if (this.secureCookie) attributes.push("Secure");
    response.setHeader("Set-Cookie", attributes.join("; "));
  }

  private clearCookie(response: Response): void {
    this.setCookie(response, "", 0);
  }
}

/** Now, by PostgreSQL's clock, in milliseconds. */
async function databaseNow(db: Prisma.TransactionClient): Promise<number> {
  const [{ now }] = await db.$queryRaw<[{ now: Date }]>`SELECT now() AS now`;
  return now.getTime();
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const pair of header?.split(";") ?? []) {
    const separator = pair.indexOf("=");
    if (separator > 0 && pair.slice(0, separator).trim() === name) {
      return pair.slice(separator + 1).trim() || undefined;
    }
  }
  return undefined;
}
