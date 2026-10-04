import { Module } from "@nestjs/common";
import { LocationsController, TimeZonesController } from "./locations.controller.js";
import { LocationsService } from "./locations.service.js";
import { TimeZones } from "./time-zones.js";

/** Locations and the time zones they may use. */
@Module({
  controllers: [LocationsController, TimeZonesController],
  providers: [LocationsService, TimeZones],
})
export class LocationsModule {}
