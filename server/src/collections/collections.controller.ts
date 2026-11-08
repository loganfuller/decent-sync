import { BadRequestException, Controller, Get, Param, Query } from "@nestjs/common";
import { isCollectionName, isSettingsHistoryCollection } from "@decent-sync/protocol";
import { AllowStaff, CurrentScope } from "../accounts/guards.js";
import type { Scope } from "../accounts/scope.js";
import { readMachineId } from "../machines/input.js";
import { readQueryPage } from "../pagination.js";
import { type CollectionSummary, type CollectionView, CollectionsService } from "./collections.service.js";
import type { PairedDevicesView } from "./paired-devices.js";
import { type SettingsHistoryPage, SettingsHistoryService, readAsOf, readSettingsHistoryFilters } from "./settings-history.service.js";
import type { TabletVersionsView } from "./tablet-versions.js";

/**
 * Each Machine's library, settings, paired devices, DYE2 and Streamline, as
 * its tablet last reported them, and its Settings History. Staff and Viewers
 * read them too.
 */
@AllowStaff()
@Controller("api/machines")
export class CollectionsController {
  constructor(
    private readonly collections: CollectionsService,
    private readonly history: SettingsHistoryService,
  ) {}

  /** The collections the Machine's tablet has reported, without their values. */
  @Get(":id/collections")
  async list(@Param("id") id: string): Promise<{ collections: CollectionSummary[] }> {
    return { collections: await this.collections.list(readMachineId(id)) };
  }

  /**
   * One collection with its latest value, or null until the Machine's tablet
   * reports it. With `at`, a moment with its offset, a collection other than
   * the Library's lists as last received at or before then, by its Settings
   * History, or null if none was received by then.
   */
  @Get(":id/collections/:name")
  async get(@Param("id") id: string, @Param("name") name: string, @Query("at") at?: unknown): Promise<{ collection: CollectionView | null }> {
    const machineId = readMachineId(id);
    const asOf = readAsOf(at);
    // An unknown name is refused as it is without a time.
    if (asOf === undefined || !isCollectionName(name)) return { collection: await this.collections.get(machineId, name) };
    if (!isSettingsHistoryCollection(name)) throw new BadRequestException("The Library's lists are kept in the Library's own history, not the Settings History, so they can't be read as of a time");
    return { collection: (await this.history.asOf(machineId, [name], asOf))[name] };
  }

  /**
   * The Machine's Settings History's changes, newest first, a page at a
   * time: each with when it was received, its collection, each field's value
   * before and after, and the Settings Edit that made it, or none for a
   * change made outside Decent Sync. Narrowed by `collection` (once or more),
   * `from` and `to` (moments with their offsets), and with brief changes
   * only with `includeBrief=true`.
   */
  @Get(":id/settings-history")
  async settingsHistory(@Param("id") id: string, @Query() query: Record<string, unknown>, @CurrentScope() scope: Scope): Promise<SettingsHistoryPage> {
    return this.history.changes(readMachineId(id), readSettingsHistoryFilters(query), readQueryPage(query), scope);
  }

  /** The Machine's paired scale, auxiliary scale and sensors, with their model, firmware and battery level. */
  @Get(":id/paired-devices")
  async pairedDevices(@Param("id") id: string): Promise<{ pairedDevices: PairedDevicesView }> {
    return { pairedDevices: await this.collections.pairedDevices(readMachineId(id)) };
  }

  /** The DYE2 and Streamline on the Machine's tablet, as its tablet last reported them. */
  @Get(":id/tablet-versions")
  async tabletVersions(@Param("id") id: string): Promise<{ tabletVersions: TabletVersionsView }> {
    return { tabletVersions: await this.collections.tabletVersions(readMachineId(id)) };
  }
}
