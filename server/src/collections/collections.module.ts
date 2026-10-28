import { Module } from "@nestjs/common";
import { CollectionsController } from "./collections.controller.js";
import { CollectionsService } from "./collections.service.js";

/** Each Machine's library, settings and paired devices: stored from the plugin's deliveries, read through the REST API. */
@Module({ controllers: [CollectionsController], providers: [CollectionsService], exports: [CollectionsService] })
export class CollectionsModule {}
