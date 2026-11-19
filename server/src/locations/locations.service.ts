import { ConflictException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma.service.js";
import { type Location, Prisma } from "../generated/prisma/client.js";
import { endStrandedFollowings } from "../library/draft-following.js";
import { type LocationEdit, type LocationFields, locationNotFound } from "./input.js";

/** A Location as the REST API returns it. */
export interface LocationView {
  id: string;
  name: string;
  /** An IANA time zone, such as America/Chicago. */
  timeZone: string;
}

/** A Location with its settings, as the Locations routes return it. */
export interface LocationSettingsView extends LocationView {
  /** Whether Drafts may be tried here (ADR-0032): only its Machines can follow a Draft. Off unless an Admin turned it on. */
  triesDrafts: boolean;
}

export function viewLocation(location: Location): LocationView {
  return { id: location.id, name: location.name, timeZone: location.timeZone };
}

export function viewLocationSettings(location: Location): LocationSettingsView {
  return { ...viewLocation(location), triesDrafts: location.triesDrafts };
}

@Injectable()
export class LocationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every Location, by name. */
  list(): Promise<Location[]> {
    return this.prisma.location.findMany({ orderBy: { name: "asc" } });
  }

  create(fields: LocationFields): Promise<Location> {
    return this.prisma.location.create({ data: fields }).catch(refuseDuplicateName(fields.name));
  }

  /** Edits it. Turning off that Drafts may be tried there ends the following of each of its Machines, which is written its Draft no more. */
  async update(id: string, fields: LocationEdit): Promise<Location> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const location = await tx.location.update({ where: { id }, data: fields });
        if (fields.triesDrafts === false) await endStrandedFollowings(tx);
        return location;
      });
    } catch (error) {
      // P2025: no row matched the id.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") throw locationNotFound();
      return refuseDuplicateName(fields.name)(error);
    }
  }
}

/** Turns a unique-name violation into a message naming the clash. */
function refuseDuplicateName(name: string | undefined): (error: unknown) => never {
  return (error) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ConflictException(`A Location named ${name} already exists`);
    }
    throw error;
  };
}
