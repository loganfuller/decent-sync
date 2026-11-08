import { Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { AllowStaff, AllowViewer, CurrentSession } from "../accounts/guards.js";
import type { SignedIn } from "../accounts/sessions.service.js";
import { type AccountConnectedAppView, type ConnectedAppView, ConnectedAppsService } from "./connected-apps.service.js";

/**
 * The Connected Apps pages' routes (ADR-0027). Every account, a Viewer's
 * included, lists and disconnects its own, as each approved them to act as
 * itself; an Admin also lists every account's, and disconnects any.
 */
@Controller("api")
export class ConnectedAppsController {
  constructor(private readonly apps: ConnectedAppsService) {}

  /** The signed-in account's Connected Apps. */
  @AllowStaff()
  @Get("connected-apps")
  async list(@CurrentSession() { account }: SignedIn): Promise<{ connectedApps: ConnectedAppView[] }> {
    return { connectedApps: await this.apps.list(account.id) };
  }

  /** Every account's Connected Apps, for Admins only, as the Accounts page shows them. */
  @Get("accounts/connected-apps")
  async listAll(): Promise<{ connectedApps: AccountConnectedAppView[] }> {
    return { connectedApps: await this.apps.listAll() };
  }

  /** Disconnects one of the account's Connected Apps, or any account's for an Admin: its tokens are refused from its next request. */
  @AllowStaff()
  @AllowViewer()
  @Post("connected-apps/:id/disconnect")
  @HttpCode(204)
  async disconnect(@Param("id") id: string, @CurrentSession() { account }: SignedIn): Promise<void> {
    await this.apps.disconnect(id, account);
  }
}
