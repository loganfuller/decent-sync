import { Module } from "@nestjs/common";
import { BeanBatchesController } from "./bean-batches.controller.js";
import { BeanBatchesService } from "./bean-batches.service.js";
import { BeansController } from "./beans.controller.js";
import { BeansService } from "./beans.service.js";
import { BasketsController, ToolsController } from "./equipment.controller.js";
import { EquipmentService } from "./equipment.service.js";
import { ConflictsController } from "./conflicts.controller.js";
import { ConflictsService } from "./conflicts.service.js";
import { GrindersController } from "./grinders.controller.js";
import { GrindersService } from "./grinders.service.js";
import { HistoryService } from "./history.service.js";
import { LibraryEditsService } from "./library-edits.service.js";
import { ProfilesController } from "./profiles.controller.js";
import { ProfilesService } from "./profiles.service.js";
import { RecipeEditsService } from "./recipe-edits.service.js";
import { RecipesController } from "./recipes.controller.js";
import { RecipesService } from "./recipes.service.js";
import { SharingController } from "./sharing.controller.js";
import { SharingService } from "./sharing.service.js";

/**
 * The Library's REST API, and each Machine's capture-only switch. Tablets' reports are taken into the Library as
 * they are stored (`CollectionsService`), and it is written to tablets by
 * the sync gateway's writers (`TabletWriter`).
 */
@Module({
  controllers: [
    BeansController,
    BeanBatchesController,
    GrindersController,
    ProfilesController,
    BasketsController,
    ToolsController,
    RecipesController,
    ConflictsController,
    SharingController,
  ],
  providers: [
    BeansService,
    BeanBatchesService,
    GrindersService,
    ProfilesService,
    EquipmentService,
    RecipesService,
    HistoryService,
    ConflictsService,
    LibraryEditsService,
    RecipeEditsService,
    SharingService,
  ],
})
export class LibraryModule {}
