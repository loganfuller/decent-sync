import { BadRequestException, Body, Controller, Get, Param, Patch, Put } from "@nestjs/common";
import { AllowStaff, CurrentSession } from "../accounts/guards.js";
import type { SignedIn } from "../accounts/sessions.service.js";
import { readLocationId } from "../locations/input.js";
import { readMachineId } from "../machines/input.js";
import { type ConflictView, HistoryService, type VersionView } from "./history.service.js";
import { type LocationSettingsView, LocationSettingsService, readSettingsEdit, readSettingsId } from "./location-settings.service.js";

/**
 * Each Location's steam, hot water and rinse settings, shared by its
 * Machines whatever their model (ADR-0014), and whether each Machine shares
 * them. Staff read them as Admins do, and change those of their own
 * Locations, and their Machines' sharing.
 */
@AllowStaff()
@Controller("api")
export class LocationSettingsController {
  constructor(
    private readonly settings: LocationSettingsService,
    private readonly history: HistoryService,
  ) {}

  /** The Location's settings, and its Machines, each sharing them or not. */
  @Get("locations/:id/settings")
  async view(@Param("id") id: string, @CurrentSession() session: SignedIn): Promise<{ settings: LocationSettingsView }> {
    return { settings: await this.settings.view(readLocationId(id), session.scope) };
  }

  /** Changes settings: `{ values }`, each by its name, such as `steamSettings.flow`. */
  @Patch("location-settings/:id")
  async edit(@Param("id") id: string, @Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ settings: LocationSettingsView }> {
    const settingsId = readSettingsId(id);
    return { settings: await this.settings.edit(settingsId, readSettingsEdit(body), session.account.id, session.scope) };
  }

  /** Switches whether the Machine's tablet shares its Location's settings: `{ sharesSettings }`. */
  @Put("machines/:id/settings-sharing")
  async setSharing(@Param("id") id: string, @Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ sharesSettings: boolean }> {
    const sharesSettings = typeof body === "object" && body !== null ? (body as { sharesSettings?: unknown }).sharesSettings : undefined;
    if (typeof sharesSettings !== "boolean") throw new BadRequestException("Send sharesSettings: true or false");
    return this.settings.setSharing(readMachineId(id), sharesSettings, session.scope);
  }

  /** Their versions, the latest taken in first; the first is the first Machine there setting them. */
  @Get("location-settings/:id/history")
  async versions(@Param("id") id: string, @CurrentSession() session: SignedIn): Promise<{ versions: VersionView[] }> {
    return { versions: await this.history.versions({ kind: "settings", id: readSettingsId(id) }, session.scope) };
  }

  /** Their open Conflicts, the latest first. */
  @Get("location-settings/:id/conflicts")
  async conflicts(@Param("id") id: string, @CurrentSession() session: SignedIn): Promise<{ conflicts: ConflictView[] }> {
    return { conflicts: await this.history.openConflicts(session.scope, { kind: "settings", id: readSettingsId(id) }) };
  }
}
