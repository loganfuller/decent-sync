import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { AllowStaff } from "../accounts/guards.js";
import { readLocationEdit, readLocationId, readNewLocation } from "./input.js";
import { LocationsService, type LocationSettingsView, viewLocationSettings } from "./locations.service.js";
import { TimeZones } from "./time-zones.js";

/** Locations: physical sites, each with its own time zone. */
@Controller("api/locations")
export class LocationsController {
  constructor(
    private readonly locations: LocationsService,
    private readonly timeZones: TimeZones,
  ) {}

  @AllowStaff()
  @Get()
  async list(): Promise<{ locations: LocationSettingsView[] }> {
    return { locations: (await this.locations.list()).map(viewLocationSettings) };
  }

  /** The time zone defaults to the creating browser's; the server's (usually UTC) is never assumed. */
  @Post()
  async create(@Body() body: unknown): Promise<{ location: LocationSettingsView }> {
    const location = await this.locations.create(await readNewLocation(body, this.timeZones));
    return { location: viewLocationSettings(location) };
  }

  /** Renames a Location, changes its time zone, or turns on or off that Drafts may be tried there (`triesDrafts`, ADR-0032). */
  @Patch(":id")
  async update(@Param("id") id: string, @Body() body: unknown): Promise<{ location: LocationSettingsView }> {
    const locationId = readLocationId(id);
    const location = await this.locations.update(locationId, await readLocationEdit(body, this.timeZones));
    return { location: viewLocationSettings(location) };
  }
}

/** The time zones a Location may use, for choosers. */
@Controller("api/time-zones")
export class TimeZonesController {
  constructor(private readonly timeZones: TimeZones) {}

  @AllowStaff()
  @Get()
  async list(): Promise<{ timeZones: string[] }> {
    return { timeZones: await this.timeZones.list() };
  }
}
