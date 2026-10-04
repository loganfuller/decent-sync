import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { TimeZones } from "./time-zones.js";

// Request bodies for the Location endpoints, checked by hand like the account
// endpoints: each problem gets a message the management interface can show.

const MAX_NAME_LENGTH = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LocationFields {
  name: string;
  timeZone: string;
}

export async function readNewLocation(body: unknown, timeZones: TimeZones): Promise<LocationFields> {
  const fields = asObject(body);
  const problems: string[] = [];
  const name = readName(fields.name, problems);
  const timeZone = await readTimeZone(fields.timeZone, timeZones, problems);
  if (problems.length > 0) throw new BadRequestException(problems);
  return { name: name!, timeZone: timeZone! };
}

/** An edit: the fields present are changed, and at least one must be. */
export async function readLocationEdit(body: unknown, timeZones: TimeZones): Promise<Partial<LocationFields>> {
  const fields = asObject(body);
  if (fields.name === undefined && fields.timeZone === undefined) {
    throw new BadRequestException("Send a new name or time zone");
  }
  const problems: string[] = [];
  const name = fields.name === undefined ? undefined : readName(fields.name, problems);
  const timeZone = fields.timeZone === undefined ? undefined : await readTimeZone(fields.timeZone, timeZones, problems);
  if (problems.length > 0) throw new BadRequestException(problems);
  return { name, timeZone };
}

/** A Location id from a path; anything that is not a UUID names no Location. */
export function readLocationId(id: string): string {
  if (!UUID.test(id)) throw locationNotFound();
  return id;
}

export function locationNotFound(): NotFoundException {
  return new NotFoundException("No such Location");
}

function readName(value: unknown, problems: string[]): string | undefined {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) problems.push("Enter a name");
  else if (name.length > MAX_NAME_LENGTH) problems.push(`Use a name of at most ${MAX_NAME_LENGTH} characters`);
  else return name;
  return undefined;
}

async function readTimeZone(value: unknown, timeZones: TimeZones, problems: string[]): Promise<string | undefined> {
  const timeZone = typeof value === "string" ? await timeZones.normalise(value) : undefined;
  if (timeZone === undefined) problems.push("Choose a time zone from the list, such as Europe/London");
  return timeZone;
}

function asObject(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}
