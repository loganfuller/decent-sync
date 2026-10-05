import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { CONFIG } from "../config.module.js";
import type { Config } from "../config.js";
import type { SignedIn } from "./sessions.service.js";
import { SessionsService } from "./sessions.service.js";
import { AccountsService, type AccountView, TooManySignInAttempts, setupClosed, viewAccount } from "./accounts.service.js";
import { AllowStaff, CurrentSession, Public } from "./guards.js";
import { readAcceptance, readCredentials, readNewAccount, readNewInvite } from "./input.js";
import { type InviteView, InvitesService } from "./invites.service.js";
import { MIN_PASSWORD_LENGTH } from "./passwords.js";

/** First-run setup: creating the first Admin on a server with no accounts. */
@Controller("api/setup")
export class SetupController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly sessions: SessionsService,
  ) {}

  /** Whether setup is needed, and the password rule the setup form shows. */
  @Public()
  @Get()
  async status(): Promise<{ required: boolean; passwordMinLength: number }> {
    return { required: await this.accounts.setupRequired(), passwordMinLength: MIN_PASSWORD_LENGTH };
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

  @AllowStaff()
  @Get()
  current(@CurrentSession() { account }: SignedIn): { account: AccountView } {
    return { account: viewAccount(account) };
  }

  /** Signs out: ends the session on the server, not only in the browser. */
  @AllowStaff()
  @Delete()
  @HttpCode(204)
  async signOut(@CurrentSession() { sessionId }: SignedIn, @Res({ passthrough: true }) response: Response): Promise<void> {
    await this.sessions.end(sessionId, response);
  }
}

/** Invites: one-time links an Admin creates and sends someone themselves, which create their account. */
@Controller("api/invites")
export class InvitesController {
  constructor(
    private readonly invites: InvitesService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  /**
   * Creates an invite for an email, as an Admin or as Staff at chosen
   * Locations. The response is the only time its link is shown.
   */
  @Post()
  async create(@Body() body: unknown): Promise<{ invite: InviteView; link: string }> {
    const { invite, secret } = await this.invites.create(readNewInvite(body));
    return { invite, link: new URL(`/invite/${secret}`, this.config.publicUrl).href };
  }
}

/**
 * An invite link, as the person it was sent to opens it, with no session.
 * One that was used or has expired is refused as gone, saying why.
 */
@Controller("api/invite-links")
export class InviteLinksController {
  constructor(
    private readonly invites: InvitesService,
    private readonly sessions: SessionsService,
  ) {}

  /** What the invite offers: the email, role and Locations of the account it creates, and the password rule. */
  @Public()
  @Get(":secret")
  async open(@Param("secret") secret: string): Promise<{ invite: InviteView; passwordMinLength: number }> {
    return { invite: await this.invites.open(secret), passwordMinLength: MIN_PASSWORD_LENGTH };
  }

  /** Creates the invite's account with the name and password chosen, and signs it in. */
  @Public()
  @Post(":secret/accept")
  async accept(
    @Param("secret") secret: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ account: AccountView }> {
    const account = await this.invites.accept(secret, readAcceptance(body));
    await this.sessions.start(account.id, response);
    return { account: viewAccount(account) };
  }
}
