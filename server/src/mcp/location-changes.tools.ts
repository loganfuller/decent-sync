import { Injectable } from "@nestjs/common";
import { type McpContext, Tool } from "@nestjs/mcp";
import * as z from "zod";
import { CHANGE, READ } from "../connected-apps/oauth.js";
import { readLocationEdit, readLocationId, readNewLocation } from "../locations/input.js";
import { LocationsService, viewLocation } from "../locations/locations.service.js";
import { TimeZones } from "../locations/time-zones.js";
import { requireAdmin } from "./token-verifier.js";

// Locations created and edited through an assistant (#413, ADR-0026), by
// Admins only, as through the REST API: each tool calls the service its
// REST route calls, reading its input with the same readers, so what the
// REST API refuses is refused with its message, and Staff with its
// Admin-only one. Each needs the `change` scope besides `read`.

const name = z.string().describe("Its name, which no other Location has, at most 100 characters.");
const timeZone = z.string().describe("Its IANA time zone, such as America/Chicago, in which its days are counted.");

const locationOutput = z.object({ location: z.object({ id: z.string(), name: z.string(), timeZone: z.string() }) });

const newLocationInput = z.strictObject({ name, timeZone });

const locationEditInput = z.strictObject({
  locationId: z.string().describe("The Location's id, as list_locations gives it."),
  name: name.optional(),
  timeZone: timeZone.optional(),
});

const CHANGES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

/** Locations created and edited through an assistant, by Admins, as the REST API does. */
@Injectable()
export class LocationChangesTools {
  constructor(
    private readonly locations: LocationsService,
    private readonly timeZones: TimeZones,
  ) {}

  @Tool({
    name: "create_location",
    title: "Create a Location",
    description: "Creates a Location: a physical site, such as a cafe, with its own time zone. It has no Machines until one is moved to it (move_machine). Admins only.",
    inputSchema: newLocationInput,
    outputSchema: locationOutput,
    annotations: CHANGES,
    scopes: [READ, CHANGE],
  })
  async createLocation(input: z.infer<typeof newLocationInput>, context: McpContext): Promise<z.infer<typeof locationOutput>> {
    requireAdmin(context);
    return { location: viewLocation(await this.locations.create(await readNewLocation(input, this.timeZones))) };
  }

  @Tool({
    name: "edit_location",
    title: "Edit a Location",
    description: "Renames a Location, changes its time zone, or both, given only what changes. Admins only.",
    inputSchema: locationEditInput,
    outputSchema: locationOutput,
    annotations: { ...CHANGES, idempotentHint: true },
    scopes: [READ, CHANGE],
  })
  async editLocation({ locationId, ...fields }: z.infer<typeof locationEditInput>, context: McpContext): Promise<z.infer<typeof locationOutput>> {
    requireAdmin(context);
    const location = await this.locations.update(readLocationId(locationId).toLowerCase(), await readLocationEdit(fields, this.timeZones));
    return { location: viewLocation(location) };
  }
}
