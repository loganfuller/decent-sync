import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Res, UnauthorizedException } from "@nestjs/common";
import type { Response } from "express";
import { CONFIG } from "../config.module.js";
import type { Config } from "../config.js";
import type { SignedIn } from "./sessions.service.js";
import { SessionsService } from "./sessions.service.js";
import {
  AccountsService,
  type AccountView,
  type ManagedAccountView,
  setupClosed,
  viewAccount,
} from "./accounts.service.js";
import { AllowStaff, CurrentSession, Public } from "./guards.js";
import {
  readAcceptance,
  readAccess,
  readAccountId,
  readCredentials,
  readInviteId,
  readNewAccount,
  readNewInvite,
  readNewPassword,
} from "./input.js";
import { type InviteView, InvitesService } from "./invites.service.js";
import { MIN_PASSWORD_LENGTH } from "./passwords.js";
import { type PasswordResetView, PasswordResetsService } from "./password-resets.service.js";

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
    await this.sessions.start(account, response);
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
    const account = await this.accounts.authenticate(email, password);
    await this.sessions.start(account, response);
    return { account: viewAccount(account) };
  }

  @AllowStaff()
  @Get()
  async current(@CurrentSession() { account }: SignedIn): Promise<{ account: AccountView }> {
    // Its Locations' names are read only here: every request needs only their ids.
    const view = await this.accounts.view(account.id);
    if (!view) throw new UnauthorizedException("Sign in to continue");
    return { account: view };
  }

  /** Signs out: ends the session on the server, not only in the browser. */
  @AllowStaff()
  @Delete()
  @HttpCode(204)
  async signOut(@CurrentSession() { sessionId }: SignedIn, @Res({ passthrough: true }) response: Response): Promise<void> {
    await this.sessions.end(sessionId, response);
  }
}

/**
 * The people who can sign in, for Admins only: each account's name and email
 * are personal information that Staff do not see. An Admin changes an
 * account's role and Locations, deactivates and reactivates it, and issues
 * a password reset link. The last active Admin cannot be demoted or
 * deactivated.
 */
@Controller("api/accounts")
export class AccountsController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly resets: PasswordResetsService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Get()
  async list(): Promise<{ accounts: ManagedAccountView[] }> {
    return { accounts: await this.accounts.list() };
  }

  /** Sets the account's role and, for Staff, the Locations they work at; both apply from its next request. */
  @Put(":id/access")
  async changeAccess(
    @Param("id") id: string,
    @Body() body: unknown,
    @CurrentSession() { account: admin }: SignedIn,
  ): Promise<{ account: ManagedAccountView }> {
    const accountId = readAccountId(id);
    return { account: await this.accounts.changeAccess(admin.id, accountId, readAccess(body)) };
  }

  /** Ends the account's sessions and refuses its sign-ins, keeping everything else about it. */
  @Post(":id/deactivate")
  @HttpCode(200)
  async deactivate(@Param("id") id: string, @CurrentSession() { account: admin }: SignedIn): Promise<{ account: ManagedAccountView }> {
    return { account: await this.accounts.deactivate(admin.id, readAccountId(id)) };
  }

  /** Lets a deactivated account sign in again. */
  @Post(":id/reactivate")
  @HttpCode(200)
  async reactivate(@Param("id") id: string, @CurrentSession() { account: admin }: SignedIn): Promise<{ account: ManagedAccountView }> {
    return { account: await this.accounts.reactivate(admin.id, readAccountId(id)) };
  }

  /**
   * Issues a one-time link that sets a new password, replacing any earlier
   * one. The response is the only time its link is shown.
   */
  @Post(":id/password-reset")
  async issuePasswordReset(
    @Param("id") id: string,
    @CurrentSession() { account: admin }: SignedIn,
  ): Promise<{ account: ManagedAccountView; link: string; expiresAt: string }> {
    const { account, expiresAt, secret } = await this.resets.issue(admin.id, readAccountId(id));
    return { account, link: new URL(`/reset-password/${secret}`, this.config.publicUrl).href, expiresAt };
  }
}

/** Invites: one-time links an Admin creates and sends someone themselves, which create their account. */
@Controller("api/invites")
export class InvitesController {
  constructor(
    private readonly invites: InvitesService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  /** The invites that can still be used. */
  @Get()
  async list(): Promise<{ invites: InviteView[] }> {
    return { invites: await this.invites.list() };
  }

  /**
   * Creates an invite for an email, as an Admin or as Staff at chosen
   * Locations. The response is the only time its link is shown.
   */
  @Post()
  async create(@Body() body: unknown): Promise<{ invite: InviteView; link: string }> {
    const { invite, secret } = await this.invites.create(readNewInvite(body));
    return { invite, link: new URL(`/invite/${secret}`, this.config.publicUrl).href };
  }

  /** Revokes an unused invite: its link then says it was revoked. */
  @Post(":id/revoke")
  @HttpCode(204)
  async revoke(@Param("id") id: string): Promise<void> {
    await this.invites.revoke(readInviteId(id));
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
    await this.sessions.start(account, response);
    return { account: viewAccount(account) };
  }
}

/**
 * A password reset link, as the person it was sent to opens it, with no
 * session. One that was used or has expired is refused as gone, saying why.
 */
@Controller("api/password-reset-links")
export class PasswordResetLinksController {
  constructor(
    private readonly resets: PasswordResetsService,
    private readonly sessions: SessionsService,
  ) {}

  /** Whose password the link sets, until when, and the password rule. */
  @Public()
  @Get(":secret")
  async open(@Param("secret") secret: string): Promise<{ passwordReset: PasswordResetView; passwordMinLength: number }> {
    return { passwordReset: await this.resets.open(secret), passwordMinLength: MIN_PASSWORD_LENGTH };
  }

  /** Sets the new password, ends the account's other sessions, and signs this browser in. */
  @Public()
  @Post(":secret/redeem")
  @HttpCode(200)
  async redeem(
    @Param("secret") secret: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ account: AccountView }> {
    const { account, token } = await this.resets.redeem(secret, readNewPassword(body));
    this.sessions.setSessionCookie(response, token);
    return { account: viewAccount(account) };
  }
}
