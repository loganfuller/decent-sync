import type { MachineHardware } from "@decent-sync/protocol";

// Reads from Decaid's local API (assets/api/rest_v1.yml) through the
// plugin-scoped fetch. Every field is optional: tablets run different Decaid
// versions, and an endpoint can fail, as /machine/info does while no machine
// is connected.

const API = "http://localhost:8080/api/v1";

/** What `hello` reports about this tablet and its machine. */
export interface TabletIdentity {
  decaidVersion: string | null;
  connectionId: string | null;
  machine: MachineHardware | null;
}

export async function readTabletIdentity(): Promise<TabletIdentity> {
  const [info, settings, machine] = await Promise.all([getObject("/info"), getObject("/settings"), readMachineHardware()]);
  return {
    decaidVersion: stringField(info, "fullVersion"),
    // Decaid keeps the preferred machine's id, so it is known before the machine connects.
    connectionId: stringField(settings, "preferredMachineId"),
    machine,
  };
}

/** The connected machine's hardware, or null while no machine is connected. */
export async function readMachineHardware(): Promise<MachineHardware | null> {
  return readHardware(await getObject("/machine/info"));
}

/** Whether two reports name the same hardware: model and serial, whatever the firmware. */
export function sameHardware(a: MachineHardware | null, b: MachineHardware | null): boolean {
  if (a === null || b === null) return a === b;
  return a.model.trim() === b.model.trim() && a.serial.trim() === b.serial.trim();
}

/** The machine's hardware as reported, including an empty or "0" serial: the server decides what identifies it. */
function readHardware(info: Record<string, unknown> | null): MachineHardware | null {
  const model = info?.model;
  const serial = info?.serialNumber;
  if (typeof model !== "string" || typeof serial !== "string") return null;
  return { model, serial, firmware: stringField(info, "version") };
}

async function getObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(API + path);
    if (!response.ok) return null;
    const body = await response.json();
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringField(object: Record<string, unknown> | null, key: string): string | null {
  const value = object?.[key];
  return typeof value === "string" && value !== "" ? value : null;
}
