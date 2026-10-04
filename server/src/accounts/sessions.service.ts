import { createHash, randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Request, Response } from "express";
import { CONFIG } from "../config.module.js";
import type { Config } from "../config.js";
import { PrismaService } from "../prisma.service.js";
import type { Account } from "../generated/prisma/client.js";

const COOKIE_NAME = "decent_sync_session";
const DAY_MS = 24 * 60 * 60 * 1000;
/** A session ends after this long unused. */
const LIFETIME_MS = 30 * DAY_MS;
/** Using a session pushes its expiry forward, at most once per this interval. */
const RENEW_AFTER_MS = DAY_MS;

export interface SignedIn {
  account: Account;
  sessionId: string;
}

/**
 * Cookie sessions for the management interface. The cookie holds a random
 * token that lives on the device until it expires, so a browser restart keeps
 * the person signed in. The server stores only the token's hash, and signing
 * out deletes the stored session.
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

  /** Starts a session for the account and sets its cookie on the response. */
  async start(accountId: string, response: Response): Promise<void> {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    await this.prisma.session.deleteMany({ where: { expiresAt: { lte: new Date(now) } } });
    await this.prisma.session.create({
      data: { tokenHash: hashToken(token), accountId, expiresAt: new Date(now + LIFETIME_MS) },
    });
    this.setCookie(response, token, LIFETIME_MS);
  }

  /**
   * The account signed in by the request's cookie, or undefined. Renews the
   * session when it is due, and clears a cookie that no longer names one.
   */
  async resume(request: Request, response: Response): Promise<SignedIn | undefined> {
    const token = readCookie(request.headers.cookie, COOKIE_NAME);
    if (!token) return undefined;

    const now = Date.now();
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { account: true },
    });
    if (!session || session.expiresAt.getTime() <= now) {
      this.clearCookie(response);
      return undefined;
    }

    if (session.expiresAt.getTime() - now < LIFETIME_MS - RENEW_AFTER_MS) {
      await this.prisma.session.update({
        where: { id: session.id },
        data: { expiresAt: new Date(now + LIFETIME_MS) },
      });
      this.setCookie(response, token, LIFETIME_MS);
    }
    return { account: session.account, sessionId: session.id };
  }

  /** Ends the session on the server and removes its cookie. */
  async end(sessionId: string, response: Response): Promise<void> {
    await this.prisma.session.deleteMany({ where: { id: sessionId } });
    this.clearCookie(response);
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

function hashToken(token: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(createHash("sha256").update(token).digest());
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
