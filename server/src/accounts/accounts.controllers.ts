import { Body, Controller, Delete, Get, HttpCode, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import type { SignedIn } from "./sessions.service.js";
import { SessionsService } from "./sessions.service.js";
import { AccountsService, type AccountView, TooManySignInAttempts, setupClosed, viewAccount } from "./accounts.service.js";
import { CurrentSession, Public } from "./guards.js";
import { readCredentials, readNewAccount } from "./input.js";

/** First-run setup: creating the first Admin on a server with no accounts. */
@Controller("api/setup")
export class SetupController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly sessions: SessionsService,
  ) {}

  @Public()
  @Get()
  async status(): Promise<{ required: boolean }> {
    return { required: await this.accounts.setupRequired() };
  }

  /** Creates the first Admin and signs them in. Refused once any account exists. */
  @Public()
  @Post()
  async setUp(@Body() body: unknown, @Res({ passthrough: true }) response: Response): Promise<{ account: AccountView }> {
    // Checked before validating, so a set-up server refuses every request alike.
    if (!(await this.accounts.setupRequired())) throw setupClosed();
    const account = await this.accounts.setUp(readNewAccount(body));
    await this.sessions.start(account.id, response);
    return { account: viewAccount(account) };
  }
}

/** The caller's session: signing in, finding who is signed in, signing out. */
@Controller("api/session")
export class SessionController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly sessions: SessionsService,
  ) {}

  @Public()
  @Post()
  @HttpCode(200)
  async signIn(@Body() body: unknown, @Res({ passthrough: true }) response: Response): Promise<{ account: AccountView }> {
    const { email, password } = readCredentials(body);
    try {
      const account = await this.accounts.authenticate(email, password);
      await this.sessions.start(account.id, response);
      return { account: viewAccount(account) };
    } catch (error) {
      if (error instanceof TooManySignInAttempts) response.setHeader("Retry-After", String(error.retryAfterSeconds));
      throw error;
    }
  }

  @Get()
  current(@CurrentSession() { account }: SignedIn): { account: AccountView } {
    return { account: viewAccount(account) };
  }

  /** Signs out: ends the session on the server, not only in the browser. */
  @Delete()
  @HttpCode(204)
  async signOut(@CurrentSession() { sessionId }: SignedIn, @Res({ passthrough: true }) response: Response): Promise<void> {
    await this.sessions.end(sessionId, response);
  }
}
