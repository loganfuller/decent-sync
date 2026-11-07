import { Injectable } from "@nestjs/common";
import { Tool } from "@nestjs/mcp";
import * as z from "zod";
import { READ } from "../connected-apps/oauth.js";
import { LocationsService } from "../locations/locations.service.js";
import { MachinesService } from "../machines/machines.service.js";

const locationsOutput = z.object({
  locations: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      timeZone: z.string().describe("Its IANA time zone, such as America/Chicago. A day at the Location is a day in this zone."),
      machines: z.array(z.object({ id: z.string(), name: z.string() })).describe("The Machines at it now, by name."),
    }),
  ),
});

/**
 * Locations, read through an assistant as the REST API reads them, calling
 * the same services (ADR-0026), with the Machines at each; `MachinesTools`
 * reads the Machines themselves. Every account reads every Location, as
 * through the REST API.
 */
@Injectable()
export class LocationsTools {
  constructor(
    private readonly locations: LocationsService,
    private readonly machines: MachinesService,
  ) {}

  @Tool({
    name: "list_locations",
    title: "List Locations",
    description: "Lists every Location, by name, with its time zone and the Machines at it now.",
    outputSchema: locationsOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
  })
  async listLocations(): Promise<z.infer<typeof locationsOutput>> {
    const [locations, machines] = await Promise.all([this.locations.list(), this.machines.list()]);
    return {
      locations: locations.map((location) => ({
        id: location.id,
        name: location.name,
        timeZone: location.timeZone,
        machines: machines.filter((machine) => machine.location?.id === location.id).map((machine) => ({ id: machine.id, name: machine.name })),
      })),
    };
  }
}
