import { Module } from "@nestjs/common";
import { SoftwareActionsController } from "./software-actions.controller.js";
import { SoftwareActionsService } from "./software-actions.service.js";
import { TabletSoftwareService } from "./tablet-software.service.js";

/** A Machine's Tablet Software, read through the REST API, and its Software Actions: made through it, sent to and answered by the plugin through the sync gateway. */
@Module({ controllers: [SoftwareActionsController], providers: [SoftwareActionsService, TabletSoftwareService], exports: [SoftwareActionsService, TabletSoftwareService] })
export class SoftwareActionsModule {}
