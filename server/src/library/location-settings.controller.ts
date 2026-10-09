import { Body, Controller, Get, Param, Patch } from "@nestjs/common";
import { AllowStaff, CurrentSession } from "../accounts/guards.js";
import type { SignedIn } from "../accounts/sessions.service.js";
import { readLocationId } from "../locations/input.js";
import { type ConflictView, HistoryService, type VersionView } from "./history.service.js";
import { type LocationSettingsView, LocationSettingsService, readSettingsEdit, readSettingsId } from "./location-settings.service.js";

/**
 * Each Location's steam, hot water and rinse settings per Machine model
 * (ADR-0014). Staff read them as Admins do, and change those of their own
 * Locations.
 */
@AllowStaff()
@Controller("api")
export class LocationSettingsController {
  constructor(
    private readonly settings: LocationSettingsService,
    private readonly history: HistoryService,
  ) {}

  /** The Location's settings for each model it has settings for or a Machine of now, by model. */
  @Get("locations/:id/settings")
  async list(@Param("id") id: string, @CurrentSession() session: SignedIn): Promise<{ settings: LocationSettingsView[] }> {
    return { settings: await this.settings.list(readLocationId(id), session.scope) };
  }

  /** Changes settings: `{ values }`, each by its name, such as `steamSettings.flow`. */
  @Patch("location-settings/:id")
  async edit(@Param("id") id: string, @Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ settings: LocationSettingsView }> {
    const settingsId = readSettingsId(id);
    return { settings: await this.settings.edit(settingsId, readSettingsEdit(body), session.account.id, session.scope) };
  }

  /** Their versions, the latest taken in first; the first is the first Machine of the model there setting them. */
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
