import { BadRequestException, ConflictException, GoneException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { type LocationView, viewLocation } from "../locations/locations.service.js";
import { PrismaService } from "../prisma.service.js";
import { hashSecret, newSecret } from "../secrets.js";
import { type AccountWithLocations, withStaffLocations } from "./accounts.service.js";
import { type Acceptance, type NewInvite, UNKNOWN_LOCATIONS } from "./input.js";
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
 * the first succeeds.
 */
@Injectable()
export class InvitesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Creates an invite. Its secret, which its link holds, is returned only here. */
  async create(fields: NewInvite): Promise<{ invite: InviteView; secret: string }> {
    const secret = newSecret();
    const invite = await this.prisma.$transaction(async (tx) => {
      if (await hasAccount(tx, fields.email)) throw new ConflictException(`${fields.email} already has an account`);
      if ((await tx.location.count({ where: { id: { in: fields.locationIds } } })) !== fields.locationIds.length) {
        throw new BadRequestException([UNKNOWN_LOCATIONS]);
      }
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
    const passwordHash = await hashPassword(acceptance.password);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const secretHash = hashSecret(secret);
        const now = await databaseNow(tx);
        // A concurrent acceptance, on any instance, waits for this update's row lock, then
        // finds the invite accepted; if this transaction rolls back instead, it claims it.
        const { count } = await tx.invite.updateMany({
          where: { secretHash, acceptedAt: null, expiresAt: { gt: now } },
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

/** Now, by PostgreSQL's clock rather than this instance's. */
async function databaseNow(db: Prisma.TransactionClient): Promise<Date> {
  const [{ now }] = await db.$queryRaw<[{ now: Date }]>`SELECT now() AS now`;
  return now;
}
