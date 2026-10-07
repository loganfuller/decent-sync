import { Module } from "@nestjs/common";
import { LiveConnections } from "./connections.js";
import { DeliveryIdCleanup } from "./delivery-id-cleanup.js";
import { LocationHistoryService } from "./location-history.service.js";
import { MachinesController, PendingMachinesController } from "./machines.controller.js";
import { MachinesService } from "./machines.service.js";
import { PendingMachinesService } from "./pending-machines.service.js";

/** Machine entries, their tokens, identity and Location History, Pending Machines, their connections, and the delivery ids recorded for them. */
@Module({
  controllers: [MachinesController, PendingMachinesController],
  providers: [MachinesService, PendingMachinesService, LocationHistoryService, LiveConnections, DeliveryIdCleanup],
  exports: [MachinesService, LiveConnections],
})
export class MachinesModule {}
