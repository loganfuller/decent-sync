import { Module } from "@nestjs/common";
import { AccessChanges } from "./access-changes.js";
import { LiveConnections } from "./connections.js";
import { LocationHistoryService } from "./location-history.service.js";
import { MachinesController, PendingMachinesController } from "./machines.controller.js";
import { MachinesService } from "./machines.service.js";
import { PendingMachinesService } from "./pending-machines.service.js";

/** Machine entries, their tokens, identity and Location History, Pending Machines, and their connections. */
@Module({
  controllers: [MachinesController, PendingMachinesController],
  providers: [MachinesService, PendingMachinesService, LocationHistoryService, LiveConnections, AccessChanges],
  exports: [MachinesService, LiveConnections, AccessChanges],
})
export class MachinesModule {}
