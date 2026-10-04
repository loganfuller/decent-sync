import { Module } from "@nestjs/common";
import { MachinesController, PendingMachinesController } from "./machines.controller.js";
import { MachinesService } from "./machines.service.js";
import { PendingMachinesService } from "./pending-machines.service.js";
import { Presence } from "./presence.js";

/** Machine entries, their tokens and identity, Pending Machines, and which Machines are online. */
@Module({
  controllers: [MachinesController, PendingMachinesController],
  providers: [MachinesService, PendingMachinesService, Presence],
  exports: [MachinesService, Presence],
})
export class MachinesModule {}
