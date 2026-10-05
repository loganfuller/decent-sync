import { ConflictException, GoneException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma.service.js";
import { hashSecret, newSecret } from "../secrets.js";
import {
  type AccountWithLocations,
  type ManagedAccountView,
  administer,
  databaseNow,
  viewManagedAccount,
  withStaffLocations,
} from "./accounts.service.js";
import { hashPassword } from "./passwords.js";
import { SessionsService } from "./sessions.service.js";
import { SignInLimiter } from "./sign-in-limiter.js";

const HOUR_MS = 60 * 60 * 1000;
/**
 * A password reset link can be used for this long after it is issued. It
 * signs in an existing account, perhaps an Admin's, so it lasts a day rather
 * than an invite's week.
 */
const LIFETIME_MS = 24 * HOUR_MS;

/** A password reset link, as the person it was sent to opens it: whose password it sets, and until when. */
export interface PasswordResetView {
  name: string;
  /** The email the account signs in with. */
  email: string;
  expiresAt: string;
}

const withAccount = {
  account: { select: { name: true, email: true, deactivatedAt: true } },
} as const satisfies Prisma.PasswordResetInclude;
type OpenedReset = Prisma.PasswordResetGetPayload<{ include: typeof withAccount }>;

/**
 * Password reset links: one-time links an Admin issues and sends someone
 * themselves, so the server needs no email delivery. Whoever opens the link
 * chooses a new password; using it ends the account's other sessions and
 * signs them in.
 *
 * As with invites, the link holds a random secret stored only as its
 * SHA-256 hash, its expiry is set and judged by PostgreSQL's clock, and it
 * is used once: redeeming claims it with a conditional update, so of
 * concurrent redemptions, on any instances, only the first succeeds. An
 * account has at most one link; issuing another replaces it, and
 * deactivating the account withdraws it.
 */
@Injectable()
export class PasswordResetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly limiter: SignInLimiter,
  ) {}

  /**
   * Issues a link for an active account, replacing any it had. Its secret,
   * which the link holds, is returned only here.
   */
  async issue(adminId: string, accountId: string): Promise<{ account: ManagedAccountView; expiresAt: string; secret: string }> {
    const secret = newSecret();
    return administer(this.prisma, adminId, accountId, async (tx, account) => {
      if (account.deactivatedAt) throw new ConflictException(`${account.name}'s account is deactivated. Reactivate it first`);
      const now = await databaseNow(tx);
      const link = { secretHash: hashSecret(secret), createdAt: now, expiresAt: new Date(now.getTime() + LIFETIME_MS), usedAt: null };
      const reset = await tx.passwordReset.upsert({ where: { accountId }, create: { accountId, ...link }, update: link });
      const issuedFor = await tx.account.findUniqueOrThrow({ where: { id: accountId }, include: withStaffLocations });
      return { account: viewManagedAccount(issuedFor), expiresAt: reset.expiresAt.toISOString(), secret };
    });
  }

  /** The account a link sets the password of, if it can still be used; otherwise why it cannot. */
  async open(secret: string): Promise<PasswordResetView> {
    const reset = await usable(this.prisma, secret);
    return { name: reset.account.name, email: reset.account.email, expiresAt: reset.expiresAt.toISOString() };
  }

  /**
   * Uses the link: sets the account's password, ends its sessions and starts
   * one for whoever redeemed it, whose token is returned. Needs no session.
   */
  async redeem(secret: string, password: string): Promise<{ account: AccountWithLocations; token: string }> {
    // Checked first, so a link that cannot be used costs no password hash.
    const { accountId } = await usable(this.prisma, secret);
    const passwordHash = await hashPassword(password);
    const redeemed = await this.prisma.$transaction(async (tx) => {
      // The account's row first, as deactivating takes it before withdrawing
      // the link and sign-ins take it to start a session: whichever runs
      // second sees what the first did.
      const [account] = await tx.$queryRaw<{ deactivated: boolean }[]>`
        SELECT deactivated_at IS NOT NULL AS deactivated FROM accounts WHERE id = ${accountId}::uuid FOR NO KEY UPDATE`;
      if (!account || account.deactivated) throw deactivated();
      // Read after the lock, so a link that expired while this waited is refused.
      const now = await databaseNow(tx);
      // A concurrent redemption, on any instance, waits for this update's row lock, then finds it used.
      const { count } = await tx.passwordReset.updateMany({
        where: { secretHash: hashSecret(secret), accountId, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (count === 0) {
        await usable(tx, secret);
        throw used();
      }
      await tx.account.update({ where: { id: accountId }, data: { passwordHash } });
      await tx.session.deleteMany({ where: { accountId } });
      const token = await this.sessions.create(tx, accountId);
      return { account: await tx.account.findUniqueOrThrow({ where: { id: accountId }, include: withStaffLocations }), token };
    });
    // Earlier failed sign-ins no longer stop the new password.
    await this.limiter.succeeded(redeemed.account.email);
    return redeemed;
  }
}

/** The reset the secret names, if it can still be used. Otherwise refuses, saying why. */
async function usable(db: Prisma.TransactionClient, secret: string): Promise<OpenedReset> {
  const reset = await db.passwordReset.findUnique({ where: { secretHash: hashSecret(secret) }, include: withAccount });
  if (!reset) {
    // Also a link replaced by a newer one, or withdrawn when its account was deactivated.
    throw new NotFoundException("This password reset link is not valid. Check that it was copied whole, or ask an Admin for a new one");
  }
  if (reset.usedAt) throw used();
  if (reset.account.deactivatedAt) throw deactivated();
  if (reset.expiresAt.getTime() <= (await databaseNow(db)).getTime()) {
    throw new GoneException("This password reset link has expired. Ask an Admin for a new one");
  }
  return reset;
}

function used(): GoneException {
  return new GoneException("This password reset link has already been used. Sign in, or ask an Admin for a new link");
}

function deactivated(): GoneException {
  return new GoneException("This account has been deactivated, so its password can no longer be reset. Ask an Admin to reactivate it");
}
