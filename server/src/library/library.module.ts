import { Module } from "@nestjs/common";
import { BeansController } from "./beans.controller.js";
import { BeansService } from "./beans.service.js";

/**
 * The Library's REST API. Tablets' reports are taken into the Library as
 * they are stored (`CollectionsService`), and it is written to tablets by
 * the sync gateway's writers (`TabletWriter`).
 */
@Module({ controllers: [BeansController], providers: [BeansService] })
export class LibraryModule {}
