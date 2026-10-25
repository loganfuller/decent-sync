import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { AllowStaff, CurrentScope, CurrentSession } from "../accounts/guards.js";
import type { Scope } from "../accounts/scope.js";
import type { SignedIn } from "../accounts/sessions.service.js";
import { readMachineId } from "../machines/input.js";
import { readSettingsEdit, readSettingsEditId } from "./input.js";
import { type SettingsEditView, SettingsEditsService } from "./settings-edits.service.js";

/**
 * Settings Edits of a Machine's settings (ADR-0023), made while it is
 * online and sent to its Tablet at once. Staff make them too, of the fields
 * marked for Staff, on Machines at Locations they work at.
 */
@AllowStaff()
@Controller("api/machines")
export class SettingsEditsController {
  constructor(private readonly edits: SettingsEditsService) {}

  /** Makes an edit, answered with its outcome pending, or refuses it at once with nothing kept. */
  @Post(":id/settings-edits")
  async make(@Param("id") id: string, @Body() body: unknown, @CurrentSession() signedIn: SignedIn): Promise<{ settingsEdit: SettingsEditView }> {
    return { settingsEdit: await this.edits.make(readMachineId(id), readSettingsEdit(body), signedIn) };
  }

  /** One edit, which the management interface reads until it has an outcome. */
  @Get(":id/settings-edits/:editId")
  async get(@Param("id") id: string, @Param("editId") editId: string, @CurrentScope() scope: Scope): Promise<{ settingsEdit: SettingsEditView }> {
    return { settingsEdit: await this.edits.get(readMachineId(id), readSettingsEditId(editId), scope) };
  }
}
