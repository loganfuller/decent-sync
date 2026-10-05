import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { PrismaService } from "../prisma.service.js";
import { type Account, AccountRole, type Prisma } from "../generated/prisma/client.js";
import { type LocationView, viewLocation } from "../locations/locations.service.js";
import { type Access, UNKNOWN_LOCATIONS, accountNotFound } from "./input.js";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "./passwords.js";
import { SignInLimiter } from "./sign-in-limiter.js";

/** An account as the REST API returns it. */
export interface AccountView {
  id: string;
  email: string;
  name: string;
  role: "admin" | "staff";
  /** The Locations a Staff member works at, by name; none for an Admin, who may change anything anywhere. */
  locations: LocationView[];
}

/** An account as an Admin managing accounts sees it: also whether it is active. */
export interface ManagedAccountView extends AccountView {
  /** When an Admin deactivated it; null while it is active. */
  deactivatedAt: string | null;
}

/** What an account is read with, so it can be viewed and its Scope known. */
export const withStaffLocations = {
  locations: { include: { location: true }, orderBy: { location: { name: "asc" } } },
} as const satisfies Prisma.AccountInclude;
export type AccountWithLocations = Prisma.AccountGetPayload<{ include: typeof withStaffLocations }>;

export function viewAccount(account: AccountWithLocations): AccountView {
  return {
    id: account.id,
    email: account.email,
    name: account.name,
    role: account.role === "ADMIN" ? "admin" : "staff",
    locations: account.locations.map(({ location }) => viewLocation(location)),
  };
}

export function viewManagedAccount(account: AccountWithLocations): ManagedAccountView {
  return { ...viewAccount(account), deactivatedAt: account.deactivatedAt?.toISOString() ?? null };
}

// Serialises first-run setup across concurrent requests. Any constant works;
// it only has to differ from other advisory locks this server takes.
const SETUP_LOCK = 4_000_001;
// Serialises Admins' changes to accounts, on every instance, so whether one
// would leave no active Admin is decided one change at a time.
const ACCOUNTS_LOCK = 4_000_004;

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly limiter: SignInLimiter,
  ) {}

  /** The account as the REST API returns it, or undefined if there is none. */
  async view(id: string): Promise<AccountView | undefined> {
    const account = await this.prisma.account.findUnique({ where: { id }, include: withStaffLocations });
    return account ? viewAccount(account) : undefined;
  }

  /** Whether the server still needs its first Admin. */
  async setupRequired(): Promise<boolean> {
    return (await this.prisma.account.count()) === 0;
  }

  /**
   * Creates the first Admin. Refused once any account exists, including when
   * another setup request is completing at the same time: the transaction
   * holds an advisory lock while it checks for accounts and creates one.
   */
  async setUp(input: { email: string; name: string; password: string }): Promise<AccountWithLocations> {
    const passwordHash = await hashPassword(input.password);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SETUP_LOCK}::bigint)`;
      if ((await tx.account.count()) > 0) throw setupClosed();
      return tx.account.create({
        data: { email: input.email, name: input.name, role: "ADMIN", passwordHash },
        include: withStaffLocations,
      });
    });
  }

  /**
   * The account with this email and password. A wrong email and a wrong
   * password are refused alike, in about the same time. A deactivated
   * account is refused only after its password is checked, so saying so
   * reveals nothing to someone who does not know it.
   */
  async authenticate(email: string, password: string): Promise<AccountWithLocations> {
    const retryAfter = await this.limiter.begin(email);
    if (retryAfter !== undefined) throw new TooManySignInAttempts(retryAfter);

    const account = await this.prisma.account.findUnique({ where: { email }, include: withStaffLocations });
    const valid = account
      ? await verifyPassword(password, account.passwordHash)
      : await verifyAgainstDummy(password);
    if (!account || !valid) throw new UnauthorizedException("The email or password is incorrect");
    if (account.deactivatedAt) throw accountDeactivated();

    await this.limiter.succeeded(email);
    return account;
  }

  /** Every account, active or not, by name. */
  async list(): Promise<ManagedAccountView[]> {
    const accounts = await this.prisma.account.findMany({
      include: withStaffLocations,
      orderBy: [{ name: "asc" }, { email: "asc" }],
    });
    return accounts.map(viewManagedAccount);
  }

  /**
   * Changes the account's role and, for Staff, the Locations they work at.
   * Its sessions read both on every request, so the change applies to its
   * next request on any instance. The last active Admin stays an Admin.
   */
  async changeAccess(adminId: string, accountId: string, access: Access): Promise<ManagedAccountView> {
    return administer(this.prisma, adminId, accountId, async (tx, account) => {
      if (access.role !== AccountRole.ADMIN) await refuseLastAdmin(tx, account);
      await refuseUnknownLocations(tx, access.locationIds);
      await tx.staffLocation.deleteMany({ where: { accountId } });
      const changed = await tx.account.update({
        where: { id: accountId },
        data: { role: access.role, locations: { create: access.locationIds.map((locationId) => ({ locationId })) } },
        include: withStaffLocations,
      });
      return viewManagedAccount(changed);
    });
  }

  /**
   * Deactivates the account: its sessions end, its password reset link is
   * withdrawn, and it can no longer sign in. Everything else about it is
   * kept. The last active Admin stays active. Deactivating one already
   * deactivated changes nothing.
   */
  async deactivate(adminId: string, accountId: string): Promise<ManagedAccountView> {
    return administer(this.prisma, adminId, accountId, async (tx, account) => {
      if (account.deactivatedAt) return viewManagedAccount(await read(tx, accountId));
      await refuseLastAdmin(tx, account);
      // The account's row first, as redeeming a password reset link locks it, so the two run one at a time.
      const deactivated = await tx.account.update({
        where: { id: accountId },
        data: { deactivatedAt: await databaseNow(tx) },
        include: withStaffLocations,
      });
      await tx.session.deleteMany({ where: { accountId } });
      await tx.passwordReset.deleteMany({ where: { accountId } });
      return viewManagedAccount(deactivated);
    });
  }

  /** Lets a deactivated account sign in again, with the password it had. */
  async reactivate(adminId: string, accountId: string): Promise<ManagedAccountView> {
    return administer(this.prisma, adminId, accountId, async (tx) => {
      const reactivated = await tx.account.update({
        where: { id: accountId },
        data: { deactivatedAt: null },
        include: withStaffLocations,
      });
      return viewManagedAccount(reactivated);
    });
  }
}

/**
 * Runs an Admin's change to an account in a transaction holding the accounts
 * lock, so changes on any instances are decided one at a time. Under the
 * lock, the Admin making it must still be an active Admin: a session whose
 * account another Admin has just demoted or deactivated changes nothing.
 */
export async function administer<T>(
  prisma: PrismaService,
  adminId: string,
  accountId: string,
  change: (tx: Prisma.TransactionClient, account: Account) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ACCOUNTS_LOCK}::bigint)`;
    const admin = await tx.account.findUnique({ where: { id: adminId }, select: { role: true, deactivatedAt: true } });
    if (admin?.role !== AccountRole.ADMIN || admin.deactivatedAt) throw new ForbiddenException("Only an Admin can do this");
    const account = await tx.account.findUnique({ where: { id: accountId } });
    if (!account) throw accountNotFound();
    return change(tx, account);
  });
}

/** Refuses a change that would leave no active Admin, if the account is one. The accounts lock must be held. */
async function refuseLastAdmin(tx: Prisma.TransactionClient, account: Account): Promise<void> {
  if (account.role !== AccountRole.ADMIN || account.deactivatedAt) return;
  const others = await tx.account.count({ where: { role: AccountRole.ADMIN, deactivatedAt: null, id: { not: account.id } } });
  if (others === 0) throw new ConflictException(`${account.name} is the last active Admin. Make another account an Admin first`);
}

/** Refuses Locations that are not all the server's. */
export async function refuseUnknownLocations(tx: Prisma.TransactionClient, locationIds: string[]): Promise<void> {
  if ((await tx.location.count({ where: { id: { in: locationIds } } })) !== locationIds.length) {
    throw new BadRequestException([UNKNOWN_LOCATIONS]);
  }
}

async function read(tx: Prisma.TransactionClient, id: string): Promise<AccountWithLocations> {
  return tx.account.findUniqueOrThrow({ where: { id }, include: withStaffLocations });
}

/**
 * Now, by PostgreSQL's clock rather than this instance's: the moment it is
 * read, not when its transaction began (as `now()` would be), so a time read
 * after waiting for a lock counts the wait.
 */
export async function databaseNow(db: Prisma.TransactionClient): Promise<Date> {
  const [{ now }] = await db.$queryRaw<[{ now: Date }]>`SELECT clock_timestamp() AS now`;
  return now;
}

/** Refuses a deactivated account's sign-in, once its password has been checked. */
export function accountDeactivated(): ForbiddenException {
  return new ForbiddenException("This account has been deactivated. Ask an Admin to reactivate it");
}

export function setupClosed(): ConflictException {
  return new ConflictException("This server is already set up. Sign in instead.");
}

/** Refuses a sign-in while its email is rate-limited. */
export class TooManySignInAttempts extends HttpException {
  constructor(readonly retryAfterSeconds: number) {
    const minutes = Math.ceil(retryAfterSeconds / 60);
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: "Too Many Requests",
        message: `Too many sign-in attempts for this email. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
