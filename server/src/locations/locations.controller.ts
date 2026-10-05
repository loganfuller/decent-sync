import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { AllowStaff, CurrentScope } from "../accounts/guards.js";
import type { Scope } from "../accounts/scope.js";
import { readLocationEdit, readLocationId, readNewLocation } from "./input.js";
import { LocationsService, type LocationView, viewLocation } from "./locations.service.js";
import { TimeZones } from "./time-zones.js";

/** Locations: physical sites, each with its own time zone. */
@Controller("api/locations")
export class LocationsController {
  constructor(
    private readonly locations: LocationsService,
    private readonly timeZones: TimeZones,
  ) {}

  /** Every Location for an Admin; for Staff, the Locations they work at. */
  @AllowStaff()
  @Get()
  async list(@CurrentScope() scope: Scope): Promise<{ locations: LocationView[] }> {
    return { locations: (await this.locations.list(scope)).map(viewLocation) };
  }

  /** The time zone defaults to the creating browser's; the server's (usually UTC) is never assumed. */
  @Post()
  async create(@Body() body: unknown): Promise<{ location: LocationView }> {
    const location = await this.locations.create(await readNewLocation(body, this.timeZones));
    return { location: viewLocation(location) };
  }

  /** Renames a Location or changes its time zone. */
  @Patch(":id")
  async update(@Param("id") id: string, @Body() body: unknown): Promise<{ location: LocationView }> {
    const locationId = readLocationId(id);
    const location = await this.locations.update(locationId, await readLocationEdit(body, this.timeZones));
    return { location: viewLocation(location) };
  }
}

/** The time zones a Location may use, for choosers. */
@Controller("api/time-zones")
export class TimeZonesController {
  constructor(private readonly timeZones: TimeZones) {}

  @Get()
  async list(): Promise<{ timeZones: string[] }> {
    return { timeZones: await this.timeZones.list() };
  }
}
