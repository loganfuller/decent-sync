import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { AllowStaff, CurrentScope, CurrentSession } from "../accounts/guards.js";
import type { Scope } from "../accounts/scope.js";
import type { SignedIn } from "../accounts/sessions.service.js";
import { readMachineId } from "../machines/input.js";
import { readPage } from "../pagination.js";
import { readSoftwareAction, readSoftwareActionId } from "./input.js";
import { type SoftwareActionView, SoftwareActionsService } from "./software-actions.service.js";
import { TabletSoftwareService } from "./tablet-software.service.js";
import type { PluginSourceView, TabletSoftwareView } from "./tablet-software.js";

/**
 * A Machine's Tablet Software and its Software Actions (ADR-0034). Staff
 * and Viewers read both; only an Admin makes an action, as each can put
 * code on the Tablet, so the routes that do carry no `@AllowStaff()`.
 */
@Controller("api/machines")
export class SoftwareActionsController {
  constructor(
    private readonly actions: SoftwareActionsService,
    private readonly software: TabletSoftwareService,
  ) {}

  /** Decaid, the plugins and the Skins on the Machine's Tablet, each with its version and how it updates; the plugins' settings with their values to Admins only. */
  @AllowStaff()
  @Get(":id/tablet-software")
  async tabletSoftware(@Param("id") id: string, @CurrentScope() scope: Scope): Promise<{ tabletSoftware: TabletSoftwareView }> {
    return { tabletSoftware: await this.software.get(readMachineId(id), scope) };
  }

  /** The sources the other Machines' plugins were installed from, for the install form. */
  @Get(":id/plugin-sources")
  async sources(@Param("id") id: string): Promise<{ pluginSources: PluginSourceView[] }> {
    return { pluginSources: await this.software.sources(readMachineId(id)) };
  }

  /** Makes an action, answered with its outcome pending, or refuses it at once with nothing kept. */
  @Post(":id/software-actions")
  async make(@Param("id") id: string, @Body() body: unknown, @CurrentSession() signedIn: SignedIn): Promise<{ softwareAction: SoftwareActionView }> {
    const maker = { accountId: signedIn.account.id, role: signedIn.account.role, scope: signedIn.scope, connectedAppId: null };
    return { softwareAction: await this.actions.make(readMachineId(id), readSoftwareAction(body), maker) };
  }

  /** The Machine's actions, newest first, a page at a time: who made each, what it named, and what came of it. */
  @AllowStaff()
  @Get(":id/software-actions")
  list(@Param("id") id: string, @CurrentScope() scope: Scope, @Query("limit") limit?: string, @Query("offset") offset?: string) {
    return this.actions.list(readMachineId(id), readPage(limit, offset), scope);
  }

  /** One action, which the management interface reads until it has an outcome. */
  @AllowStaff()
  @Get(":id/software-actions/:actionId")
  async get(@Param("id") id: string, @Param("actionId") actionId: string, @CurrentScope() scope: Scope): Promise<{ softwareAction: SoftwareActionView }> {
    return { softwareAction: await this.actions.get(readMachineId(id), readSoftwareActionId(actionId), scope) };
  }
}
