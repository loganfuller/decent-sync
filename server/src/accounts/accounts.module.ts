import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { InviteLinksController, InvitesController, SessionController, SetupController } from "./accounts.controllers.js";
import { AccountsService } from "./accounts.service.js";
import { SameOriginGuard, SessionGuard } from "./guards.js";
import { InvitesService } from "./invites.service.js";
import { SessionsService } from "./sessions.service.js";
import { SignInLimiter } from "./sign-in-limiter.js";

/**
 * Accounts, sessions and invites for the management interface and other REST
 * clients. Its guards apply to every route: cross-site state changes are
 * refused first, then routes not marked `@Public()` require a signed-in
 * account, and an Admin unless marked `@AllowStaff()`. The plugin's WebSocket
 * authenticates with a Machine token instead.
 */
@Module({
  controllers: [SetupController, SessionController, InvitesController, InviteLinksController],
  providers: [
    AccountsService,
    SessionsService,
    InvitesService,
    SignInLimiter,
    { provide: APP_GUARD, useClass: SameOriginGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
})
export class AccountsModule {}
