import { ConflictException, HttpException, HttpStatus, Injectable, UnauthorizedException } from "@nestjs/common";
import { PrismaService } from "../prisma.service.js";
import type { Account } from "../generated/prisma/client.js";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "./passwords.js";
import { SignInLimiter } from "./sign-in-limiter.js";

/** An account as the REST API returns it. */
export interface AccountView {
  id: string;
  email: string;
  name: string;
  role: "admin" | "staff";
}

export function viewAccount(account: Account): AccountView {
  return {
    id: account.id,
    email: account.email,
    name: account.name,
    role: account.role === "ADMIN" ? "admin" : "staff",
  };
}

// Serialises first-run setup across concurrent requests. Any constant works;
// it only has to differ from other advisory locks this server takes.
const SETUP_LOCK = 4_000_001;

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly limiter: SignInLimiter,
  ) {}

  /** Whether the server still needs its first Admin. */
  async setupRequired(): Promise<boolean> {
    return (await this.prisma.account.count()) === 0;
  }

  /**
   * Creates the first Admin. Refused once any account exists, including when
   * another setup request is completing at the same time: the transaction
   * holds an advisory lock while it checks for accounts and creates one.
   */
  async setUp(input: { email: string; name: string; password: string }): Promise<Account> {
    const passwordHash = await hashPassword(input.password);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SETUP_LOCK}::bigint)`;
      if ((await tx.account.count()) > 0) throw setupClosed();
      return tx.account.create({
        data: { email: input.email, name: input.name, role: "ADMIN", passwordHash },
      });
    });
  }

  /**
   * The account with this email and password. A wrong email and a wrong
   * password are refused alike, in about the same time.
   */
  async authenticate(email: string, password: string): Promise<Account> {
    const retryAfter = this.limiter.begin(email);
    if (retryAfter !== undefined) throw new TooManySignInAttempts(retryAfter);

    const account = await this.prisma.account.findUnique({ where: { email } });
    const valid = account
      ? await verifyPassword(password, account.passwordHash)
      : await verifyAgainstDummy(password);
    if (!account || !valid) throw new UnauthorizedException("The email or password is incorrect");

    this.limiter.succeeded(email);
    return account;
  }
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
