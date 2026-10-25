import { Module } from "@nestjs/common";
import { SettingsEditsController } from "./settings-edits.controller.js";
import { SettingsEditsService } from "./settings-edits.service.js";

/** Settings Edits: made through the REST API, sent to and answered by the plugin through the sync gateway. */
@Module({ controllers: [SettingsEditsController], providers: [SettingsEditsService], exports: [SettingsEditsService] })
export class SettingsEditsModule {}
