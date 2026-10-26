import { Module } from "@nestjs/common";
import { CurvesRefresh } from "./curves-refresh.js";
import { ShotsController } from "./shots.controller.js";
import { ShotsService } from "./shots.service.js";

@Module({ controllers: [ShotsController], providers: [ShotsService, CurvesRefresh], exports: [ShotsService] })
export class ShotsModule {}
