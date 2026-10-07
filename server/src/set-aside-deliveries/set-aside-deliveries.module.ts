import { Module } from "@nestjs/common";
import { SetAsideDeliveriesController } from "./set-aside-deliveries.controller.js";
import { SetAsideDeliveriesService } from "./set-aside-deliveries.service.js";

/** Deliveries that could not be stored, set aside by the sync gateway and read through the REST API. */
@Module({ controllers: [SetAsideDeliveriesController], providers: [SetAsideDeliveriesService], exports: [SetAsideDeliveriesService] })
export class SetAsideDeliveriesModule {}
