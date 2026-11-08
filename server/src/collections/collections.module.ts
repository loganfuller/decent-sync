import { Module } from "@nestjs/common";
import { CollectionsController } from "./collections.controller.js";
import { CollectionsService } from "./collections.service.js";
import { SettingsHistoryBaselines } from "./settings-history.js";
import { SettingsHistoryService } from "./settings-history.service.js";

/** Each Machine's library, settings and paired devices: stored from the plugin's deliveries, with their Settings History, read through the REST API. */
@Module({
  controllers: [CollectionsController],
  providers: [CollectionsService, SettingsHistoryBaselines, SettingsHistoryService],
  exports: [CollectionsService, SettingsHistoryService],
})
export class CollectionsModule {}
