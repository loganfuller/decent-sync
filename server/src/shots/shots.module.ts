import { Module } from "@nestjs/common";
import { CurvesRefresh } from "./curves-refresh.js";
import { ShotEditsService } from "./shot-edits.service.js";
import { ShotsController } from "./shots.controller.js";
import { ShotsService } from "./shots.service.js";

@Module({ controllers: [ShotsController], providers: [ShotsService, ShotEditsService, CurvesRefresh], exports: [ShotsService, ShotEditsService] })
export class ShotsModule {}
