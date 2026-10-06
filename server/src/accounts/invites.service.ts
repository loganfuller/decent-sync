import { ConflictException, GoneException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { type LocationView, viewLocation } from "../locations/locations.service.js";
import { PrismaService } from "../prisma.service.js";
import { hashSecret, newSecret } from "../secrets.js";
import { type AccountWithLocations, databaseNow, refuseUnknownLocations, withStaffLocations } from "./accounts.service.js";
import { type Acceptance, type NewInvite, inviteNotFound } from "./input.js";
import { PasswordChecks } from "./password-checks.js";
import { hashPassword } from "./passwords.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** An invite can be accepted for this long after it is created. */
const LIFETIME_MS = 7 * DAY_MS;

/** An invite as the REST API returns it, to the Admin who created it and to whoever opens its link. */
export interface InviteView {
  id: string;
  /** The email its account will sign in with. */
  email: string;
  role: "admin" | "staff";
  /** The Locations a Staff member will work at, by name; none for an Admin, who sees every Location. */
  locations: LocationView[];
  createdAt: string;
  expiresAt: string;
}

const withLocations = {
  locations: { include: { location: true }, orderBy: { location: { name: "asc" } } },
} as const satisfies Prisma.InviteInclude;
type ListedInvite = Prisma.InviteGetPayload<{ include: typeof withLocations }>;

function viewInvite(invite: ListedInvite): InviteView {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role === "ADMIN" ? "admin" : "staff",
    locations: invite.locations.map(({ location }) => viewLocation(location)),
    createdAt: invite.createdAt.toISOString(),
    expiresAt: invite.expiresAt.toISOString(),
  };
}

/**
 * Invites: one-time links an Admin creates and sends someone themselves, so
 * the server needs no email delivery. Whoever opens the link chooses a name
 * and password, and gets the account the Admin chose: its email, its role
 * and, for Staff, the Locations they work at.
 *
 * The link holds a random secret, stored only as its SHA-256 hash, as session
 * cookies are. Its expiry is set and judged by PostgreSQL's clock, never an
 * instance's (ADR-0016). It is used once: accepting claims it with a
 * conditional update, so of concurrent acceptances, on any instances, only
 * the first succeeds. An Admin may revoke it until then, by the same kind of
 * conditional update, so an invite is either accepted or revoked.
 */
@Injectable()
export class InvitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordChecks: PasswordChecks,
  ) {}

  /** Creates an invite. Its secret, which its link holds, is returned only here. */
  async create(fields: NewInvite): Promise<{ invite: InviteView; secret: string }> {
    const secret = newSecret();
    const invite = await this.prisma.$transaction(async (tx) => {
      if (await hasAccount(tx, fields.email)) throw new ConflictException(`${fields.email} already has an account`);
      await refuseUnknownLocations(tx, fields.locationIds);
      return tx.invite.create({
        data: {
          secretHash: hashSecret(secret),
          email: fields.email,
          role: fields.role,
          expiresAt: new Date((await databaseNow(tx)).getTime() + LIFETIME_MS),
          locations: { create: fields.locationIds.map((locationId) => ({ locationId })) },
        },
        include: withLocations,
      });
    });
    return { invite: viewInvite(invite), secret };
  }

  /**
   * The invites that can still be used, newest first: not accepted, revoked
   * or expired, for an email that has no account yet.
   */
  async list(): Promise<InviteView[]> {
    const invites = await this.prisma.invite.findMany({
      where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: await databaseNow(this.prisma) } },
      include: withLocations,
      orderBy: { createdAt: "desc" },
    });
    const emails = invites.map((invite) => invite.email);
    const taken = new Set(
      (await this.prisma.account.findMany({ where: { email: { in: emails } }, select: { email: true } })).map(({ email }) => email),
    );
    return invites.filter((invite) => !taken.has(invite.email)).map(viewInvite);
  }

  /**
   * Revokes an unused invite, so its link can no longer be used. Revoking one
   * already revoked changes nothing; one already accepted is refused, since
   * its account exists.
   */
  async revoke(id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // A concurrent acceptance, on any instance, waits for this update's row lock, then finds it revoked.
      const { count } = await tx.invite.updateMany({
        where: { id, acceptedAt: null, revokedAt: null },
        data: { revokedAt: await databaseNow(tx) },
      });
      if (count > 0) return;
      const invite = await tx.invite.findUnique({ where: { id } });
      if (!invite) throw inviteNotFound();
      if (invite.acceptedAt) {
        throw new ConflictException(`This invite has already been used, so ${invite.email} has an account. Deactivate it instead`);
      }
    });
  }

  /** The invite a link holds, if it can still be used; otherwise why it cannot. */
  async open(secret: string): Promise<InviteView> {
    return viewInvite(await usable(this.prisma, secret));
  }

  /**
   * Uses the invite: creates its account, with the name and password chosen
   * and what the Admin chose. Needs no session.
   */
  async accept(secret: string, acceptance: Acceptance): Promise<AccountWithLocations> {
    // Checked first, so a link that cannot be used costs no password hash.
    const { email } = await usable(this.prisma, secret);
    const passwordHash = await this.passwordChecks.run(() => hashPassword(acceptance.password));
    try {
      return await this.prisma.$transaction(async (tx) => {
        const secretHash = hashSecret(secret);
        // The invite's row first, which a concurrent acceptance or revocation, on any instance,
        // holds until it commits or rolls back; then the time, so an invite that expired while
        // this waited is refused.
        await tx.$executeRaw`SELECT 1 FROM invites WHERE secret_hash = ${secretHash} FOR NO KEY UPDATE`;
        const now = await databaseNow(tx);
        const { count } = await tx.invite.updateMany({
          where: { secretHash, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
          data: { acceptedAt: now },
        });
        if (count === 0) {
          await usable(tx, secret);
          throw used();
        }
        const invite = (await tx.invite.findUnique({ where: { secretHash }, include: { locations: true } }))!;
        return tx.account.create({
          data: {
            email: invite.email,
            name: acceptance.name,
            role: invite.role,
            passwordHash,
            locations: { create: invite.locations.map(({ locationId }) => ({ locationId })) },
          },
          include: withStaffLocations,
        });
      });
    } catch (error) {
      // An account with its email was created meanwhile, perhaps from another invite; this one stays unused.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw accountExists(email);
      throw error;
    }
  }
}

/** The invite the secret names, if it can still be used. Otherwise refuses, saying why. */
async function usable(db: Prisma.TransactionClient, secret: string): Promise<ListedInvite> {
  const invite = await db.invite.findUnique({ where: { secretHash: hashSecret(secret) }, include: withLocations });
  if (!invite) {
    throw new NotFoundException("This invite link is not valid. Check that it was copied whole, or ask an Admin for a new one");
  }
  if (invite.acceptedAt) throw used();
  if (invite.revokedAt) throw new GoneException("This invite was revoked. Ask an Admin for a new one");
  if (invite.expiresAt.getTime() <= (await databaseNow(db)).getTime()) {
    throw new GoneException("This invite has expired. Ask an Admin for a new one");
  }
  if (await hasAccount(db, invite.email)) throw accountExists(invite.email);
  return invite;
}

function used(): GoneException {
  return new GoneException("This invite has already been used. Sign in, or ask an Admin for a new invite");
}

function accountExists(email: string): GoneException {
  return new GoneException(`${email} already has an account, so this invite can no longer be used. Sign in instead`);
}

async function hasAccount(db: Prisma.TransactionClient, email: string): Promise<boolean> {
  return (await db.account.count({ where: { email } })) > 0;
}
