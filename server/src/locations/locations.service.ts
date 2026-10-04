import { ConflictException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma.service.js";
import { type Location, Prisma } from "../generated/prisma/client.js";
import { type LocationFields, locationNotFound } from "./input.js";

/** A Location as the REST API returns it. */
export interface LocationView {
  id: string;
  name: string;
  /** An IANA time zone, such as America/Chicago. */
  timeZone: string;
}

export function viewLocation(location: Location): LocationView {
  return { id: location.id, name: location.name, timeZone: location.timeZone };
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

  async update(id: string, fields: Partial<LocationFields>): Promise<Location> {
    try {
      return await this.prisma.location.update({ where: { id }, data: fields });
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
