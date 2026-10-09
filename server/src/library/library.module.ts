import { Module } from "@nestjs/common";
import { BeanBatchesController } from "./bean-batches.controller.js";
import { BeanBatchesService } from "./bean-batches.service.js";
import { BeansController } from "./beans.controller.js";
import { BeansService } from "./beans.service.js";
import { ProfilesController } from "./profiles.controller.js";
import { ProfilesService } from "./profiles.service.js";

/**
 * The Library's REST API. Tablets' reports are taken into the Library as
 * they are stored (`CollectionsService`), and it is written to tablets by
 * the sync gateway's writers (`TabletWriter`).
 */
@Module({
  controllers: [BeansController, BeanBatchesController, ProfilesController],
  providers: [BeansService, BeanBatchesService, ProfilesService],
})
export class LibraryModule {}
