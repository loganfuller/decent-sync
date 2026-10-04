import { Module } from "@nestjs/common";
import { MachinesController } from "./machines.controller.js";
import { MachinesService } from "./machines.service.js";
import { Presence } from "./presence.js";

/** Machine entries, their tokens and whether they are online. */
@Module({
  controllers: [MachinesController],
  providers: [MachinesService, Presence],
  exports: [MachinesService, Presence],
})
export class MachinesModule {}
