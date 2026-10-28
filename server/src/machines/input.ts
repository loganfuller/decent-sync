import { BadRequestException, NotFoundException } from "@nestjs/common";
import { MAX_HARDWARE_LENGTH } from "@decent-sync/protocol";
import { type Hardware, isRealSerial } from "../sync/identity.js";

// Request bodies for the Machine endpoints, checked by hand like the other
// endpoints: each problem gets a message the management interface can show.

const MAX_NAME_LENGTH = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_INSTANT = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.\d+)?)?(?:Z|[+-](\d\d):(\d\d))$/i;

/**
 * The models an Admin may enter, spelled as Decaid reports them
 * (DecentMachineModel in decaid:lib/src/models/device/impl/de1/de1.models.dart),
 * so an entered identity matches the one recorded in Shots.
 */
export const MACHINE_MODELS = ["DE1", "DE1Plus", "DE1Pro", "DE1XL", "DE1Cafe", "DE1XXL", "DE1XXXL", "Bengle"] as const;

export interface NewMachine {
  name: string;
  /** The Location it starts at, or null to leave it unassigned. */
  locationId: string | null;
}

export function readNewMachine(body: unknown): NewMachine {
  const fields = asObject(body);
  const problems: string[] = [];
  const name = typeof fields.name === "string" ? fields.name.trim() : "";
  if (!name) problems.push("Enter a name");
  else if (name.length > MAX_NAME_LENGTH) problems.push(`Use a name of at most ${MAX_NAME_LENGTH} characters`);
  // Absent or null leaves the Machine unassigned.
  const locationId = fields.locationId === undefined || fields.locationId === null ? null : readLocationChoice(fields.locationId, problems);
  if (problems.length > 0) throw new BadRequestException(problems);
  return { name, locationId: locationId ?? null };
}

/** A move: the Location a Machine moved to, and when, if not now. */
export interface Move {
  locationId: string;
  effectiveFrom: Date | null;
}

export function readMove(body: unknown): Move {
  const fields = asObject(body);
  const problems: string[] = [];
  const locationId = readLocationChoice(fields.locationId, problems);
  const effectiveFrom = fields.effectiveFrom === undefined || fields.effectiveFrom === null ? null : readTime(fields.effectiveFrom, problems);
  if (problems.length > 0) throw new BadRequestException(problems);
  return { locationId: locationId!, effectiveFrom: effectiveFrom ?? null };
}

/** A correction of one entry of a Machine's Location History: the Location it names, when it arrived there, or both. */
export interface Correction {
  locationId?: string;
  effectiveFrom?: Date;
}

export function readCorrection(body: unknown): Correction {
  const fields = asObject(body);
  if (fields.locationId === undefined && fields.effectiveFrom === undefined) {
    throw new BadRequestException("Send a new Location or time");
  }
  const problems: string[] = [];
  const locationId = fields.locationId === undefined ? undefined : readLocationChoice(fields.locationId, problems);
  const effectiveFrom = fields.effectiveFrom === undefined ? undefined : readTime(fields.effectiveFrom, problems);
  if (problems.length > 0) throw new BadRequestException(problems);
  return { locationId, effectiveFrom };
}

/** Refuses a Location that is not one of the server's. */
export function unknownLocation(): BadRequestException {
  return new BadRequestException(["Choose a Location from the list"]);
}

function readLocationChoice(value: unknown, problems: string[]): string | undefined {
  if (typeof value === "string" && UUID.test(value)) return value;
  problems.push("Choose a Location from the list");
  return undefined;
}

/** A time with its offset, such as 2026-10-04T15:00:00Z, so it names one instant whatever the server's time zone. */
function readTime(value: unknown, problems: string[]): Date | undefined {
  const match = typeof value === "string" ? ISO_INSTANT.exec(value) : null;
  if (match && namesRealTime(match)) {
    const time = new Date(value as string);
    if (Number.isFinite(time.getTime())) return time;
  }
  problems.push("Enter a date and time with its offset, such as 2026-10-04T15:00:00Z");
  return undefined;
}

/** Whether the date and clock time exist, since Date rolls ones that do not over, February 30 into March. */
function namesRealTime(match: RegExpExecArray): boolean {
  const [year, month, day, hour, minute, second, offsetHours, offsetMinutes] = match.slice(1).map((part) => Number(part ?? 0));
  const daysInMonth = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  return month! >= 1 && month! <= 12 && day! >= 1 && day! <= daysInMonth && hour! <= 23 && minute! <= 59 && second! <= 59 && offsetHours! <= 23 && offsetMinutes! <= 59;
}

/** A model and serial an Admin entered for a Machine. A serial of "0" identifies nothing. */
export function readHardware(body: unknown): Hardware {
  const fields = asObject(body);
  const problems: string[] = [];
  const model = typeof fields.model === "string" ? fields.model.trim() : "";
  if (!(MACHINE_MODELS as readonly string[]).includes(model)) problems.push(`Choose a model: ${MACHINE_MODELS.join(", ")}`);
  const serial = typeof fields.serial === "string" ? fields.serial.trim() : "";
  if (!isRealSerial(serial)) problems.push("Enter the machine's serial number; 0 is what a machine without one reports");
  // The longest a tablet may report: no tablet could report a longer one.
  else if (serial.length > MAX_HARDWARE_LENGTH) problems.push(`Use a serial of at most ${MAX_HARDWARE_LENGTH} characters`);
  if (problems.length > 0) throw new BadRequestException(problems);
  return { model, serial };
}

/** A Machine id from a path; anything that is not a UUID names no Machine. */
export function readMachineId(id: string): string {
  return readId(id, machineNotFound);
}

export function machineNotFound(): NotFoundException {
  return new NotFoundException("No such Machine");
}

/** A Pending Machine id from a path. */
export function readPendingMachineId(id: string): string {
  return readId(id, pendingMachineNotFound);
}

export function pendingMachineNotFound(): NotFoundException {
  return new NotFoundException("No such Pending Machine");
}

/** An entry id of a Machine's Location History, from a path. */
export function readLocationHistoryEntryId(id: string): string {
  return readId(id, locationHistoryEntryNotFound);
}

export function locationHistoryEntryNotFound(): NotFoundException {
  return new NotFoundException("No such entry in this Machine's Location History");
}

function readId(id: string, notFound: () => NotFoundException): string {
  if (!UUID.test(id)) throw notFound();
  return id;
}

function asObject(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}
