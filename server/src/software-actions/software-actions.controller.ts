import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { AllowStaff, CurrentScope, CurrentSession } from "../accounts/guards.js";
import type { Scope } from "../accounts/scope.js";
import type { SignedIn } from "../accounts/sessions.service.js";
import { readMachineId } from "../machines/input.js";
import { readPage } from "../pagination.js";
import { readPinnedItem, readSoftwareAction, readSoftwareActionId } from "./input.js";
import { type SoftwareActionView, SoftwareActionsService } from "./software-actions.service.js";
import { TabletSoftwareService } from "./tablet-software.service.js";
import type { PinnedSourceView, PluginSourceView, SkinSourceView, TabletSoftwareView } from "./tablet-software.js";

/**
 * A Machine's Tablet Software and its Software Actions (ADR-0034). Staff
 * and Viewers read both. Only an Admin makes an action, as most can put
 * code on the Tablet, but that Staff at the Machine's Location may reload
 * its Skin or restart its Skin view: the route that makes them lets Staff
 * in, and the service judges each kind.
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

  /** The sources the other Machines' Skins were installed from, for the Skin install form. */
  @Get(":id/skin-sources")
  async skinSources(@Param("id") id: string): Promise<{ skinSources: SkinSourceView[] }> {
    return { skinSources: await this.software.skinSources(readMachineId(id)) };
  }

  /** Where a plugin (`pluginId`) or a Skin (`skinId`) on the Tablet can be pinned to hold it at the build installed now, found through GitHub, for the form that changes how it updates. */
  @Get(":id/pinned-source")
  async pinnedSource(@Param("id") id: string, @Query("pluginId") pluginId?: string, @Query("skinId") skinId?: string): Promise<{ pinnedSource: PinnedSourceView }> {
    return { pinnedSource: await this.software.pinnedSource(readMachineId(id), readPinnedItem(pluginId, skinId)) };
  }

  /** Makes an action, answered with its outcome pending, or refuses it at once with nothing kept: Staff only reload the Skin or restart the Skin view, at their Locations. */
  @AllowStaff()
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
