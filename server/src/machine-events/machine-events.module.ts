import { Module } from "@nestjs/common";
import { MachineEventsController } from "./machine-events.controller.js";
import { MachineEventsService } from "./machine-events.service.js";

/** Workflow changes and machine state transitions: stored from the plugin's deliveries, read through the REST API. */
@Module({ controllers: [MachineEventsController], providers: [MachineEventsService], exports: [MachineEventsService] })
export class MachineEventsModule {}
