import { type MachineHardware, isRecordId } from "@decent-sync/protocol";
import type { Reading } from "./change-detection.js";

// Reads from Decaid's local API (assets/api/rest_v1.yml) through the
// plugin-scoped fetch. Any request can fail, as /machine/info does while no
// machine is connected, so each value read may be missing.

const API = "http://localhost:8080/api/v1";

/** What `hello` reports about this tablet and its machine. */
export interface TabletIdentity {
  /** Null only if /info could not be read: every supported Decaid reports it. */
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

/**
 * A bounded page of metadata, newest first, with how many Shots the tablet
 * holds as it answered; /shots/ids would make history one unbounded response.
 */
export async function readShotPage(limit: number, offset: number): Promise<{ items: unknown[]; total: number } | null> {
  const page = await getObject(`/shots?limit=${limit}&offset=${offset}&order=desc`);
  return Array.isArray(page?.items) && typeof page.total === "number" ? { items: page.items, total: page.total } : null;
}

export function readShot(id: string): Promise<Record<string, unknown> | null> {
  return readRecord("shots", id);
}

export function readSteam(id: string): Promise<Record<string, unknown> | null> {
  return readRecord("steams", id);
}

/**
 * Every Steam Record id the server stores (`isRecordId`), or null if they
 * cannot be read now. Ids are all Decaid offers to find new Steam Records
 * by: it has no event for them, and `GET /steams` returns every record,
 * workflow included, in one response that outgrows the fetch limit.
 */
export async function readSteamIds(): Promise<string[] | null> {
  try {
    const response = await fetch(`${API}/steams/ids`);
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return Array.isArray(body) ? body.filter(isRecordId) : null;
  } catch {
    return null;
  }
}

/** One record, or null if the tablet no longer has it. Throws if it cannot be read now. */
async function readRecord(collection: "shots" | "steams", id: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${API}/${collection}/${encodeURIComponent(id)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Record unavailable");
  const body: unknown = await response.json();
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("Record response unavailable");
  return body as Record<string, unknown>;
}

/**
 * Has Decaid's store API read this plugin's storage, for the side effect
 * alone, and says whether it answered. Decaid's backup (`GET
 * /api/v1/data/export`) holds only the stores that API has opened since
 * Decaid started (KvStoreExportSection, in v0.8.7 and v0.8.8), and
 * `host.storage` reaches the same storage without opening it there, so
 * until this read is answered a backup leaves out the tablet's id.
 */
export async function keepStorageInBackups(): Promise<boolean> {
  try {
    return (await fetch(`${API}/store/${encodeURIComponent(__PLUGIN_ID__)}`)).ok;
  } catch {
    return false;
  }
}

/**
 * One read of a collection at `path`, a route under the API with its query.
 * With an ETag, Decaid answers 304 if it is still current. A failed read, a
 * refusal (such as 500 while no machine is connected, or 503 while no scale
 * is) and `null` (a key never written to plugin storage) are unavailable.
 */
export async function readCollection(path: string, etag: string | null): Promise<Reading> {
  try {
    const response = await fetch(API + path, etag === null ? undefined : { headers: { "If-None-Match": etag } });
    if (response.status === 304) return { kind: "notModified" };
    if (!response.ok) return { kind: "unavailable" };
    const value: unknown = await response.json();
    return value === null ? { kind: "unavailable" } : { kind: "value", value, etag: response.headers.get("etag") };
  } catch {
    return { kind: "unavailable" };
  }
}
