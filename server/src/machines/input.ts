import { BadRequestException, NotFoundException } from "@nestjs/common";
import { type Hardware, isRealSerial } from "../sync/identity.js";

// Request bodies for the Machine endpoints, checked by hand like the other
// endpoints: each problem gets a message the management interface can show.

const MAX_NAME_LENGTH = 100;
const MAX_SERIAL_LENGTH = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The models an Admin may enter, spelled as Decaid reports them
 * (DecentMachineModel in decaid:lib/src/models/device/impl/de1/de1.models.dart),
 * so an entered identity matches the one recorded in Shots.
 */
export const MACHINE_MODELS = ["DE1", "DE1Plus", "DE1Pro", "DE1XL", "DE1Cafe", "DE1XXL", "DE1XXXL", "Bengle"] as const;

export interface NewMachine {
  name: string;
}

export function readNewMachine(body: unknown): NewMachine {
  const fields = asObject(body);
  const name = typeof fields.name === "string" ? fields.name.trim() : "";
  if (!name) throw new BadRequestException(["Enter a name"]);
  if (name.length > MAX_NAME_LENGTH) throw new BadRequestException([`Use a name of at most ${MAX_NAME_LENGTH} characters`]);
  return { name };
}

/** A model and serial an Admin entered for a Machine. A serial of "0" identifies nothing. */
export function readHardware(body: unknown): Hardware {
  const fields = asObject(body);
  const problems: string[] = [];
  const model = typeof fields.model === "string" ? fields.model.trim() : "";
  if (!(MACHINE_MODELS as readonly string[]).includes(model)) problems.push(`Choose a model: ${MACHINE_MODELS.join(", ")}`);
  const serial = typeof fields.serial === "string" ? fields.serial.trim() : "";
  if (!isRealSerial(serial)) problems.push("Enter the machine's serial number; 0 is what a machine without one reports");
  else if (serial.length > MAX_SERIAL_LENGTH) problems.push(`Use a serial of at most ${MAX_SERIAL_LENGTH} characters`);
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

function readId(id: string, notFound: () => NotFoundException): string {
  if (!UUID.test(id)) throw notFound();
  return id;
}

function asObject(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}
