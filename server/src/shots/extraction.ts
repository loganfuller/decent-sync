import { realHardware, type Hardware } from "@decent-sync/protocol";

/** Analytics are a projection; missing or unfamiliar Decaid fields never invalidate a record. */
export function extractShot(record: unknown) {
  const shot = object(record);
  const workflow = object(shot.workflow);
  const context = object(workflow.context);
  const profile = object(workflow.profile);
  const annotations = object(shot.annotations);
  return {
    beanBatchId: string(context.beanBatchId),
    coffeeName: string(context.coffeeName),
    coffeeRoaster: string(context.coffeeRoaster),
    profileTitle: string(profile.title),
    profileId: string(object(object(context.extras).workflowSkin).selectedProfileId),
    targetDose: number(context.targetDoseWeight),
    targetYield: number(context.targetYield) ?? number(profile.target_weight),
    actualDose: number(annotations.actualDoseWeight),
    actualYield: number(annotations.actualYield),
    enjoyment: number(annotations.enjoyment),
    barista: string(context.baristaName),
  };
}

/**
 * A Shot's edit time, as sent, so PostgreSQL compares Decaid's microseconds.
 * Decaid v0.8.7 and later write it on every Shot, in UTC with a Z; null marks
 * a record without one, which is ignored.
 */
export function shotVersion(record: unknown): string | null {
  const updatedAt = object(record).updatedAt;
  return typeof updatedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(updatedAt) && date(updatedAt)
    ? updatedAt
    : null;
}

export function shotHardware(record: unknown): Hardware | null {
  const machine = object(object(object(record).workflow).machine);
  if (machine.provenanceStatus === "unavailable") return null;
  if (typeof machine.model !== "string" || typeof machine.serialNumber !== "string") return null;
  return realHardware({ model: machine.model, serial: machine.serialNumber });
}

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Times without an offset are the tablet's local wall-clock times; reading them as UTC keeps their differences exact. */
function date(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const normalized = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? `${value}Z` : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

const QUARTER_HOUR = 15 * 60_000;

/** Values that need the Shot's curves: when it was pulled, its duration and its peaks. */
export function extractCurves(record: unknown, measurements: unknown) {
  const samples = Array.isArray(measurements) ? measurements : [];
  let first: number | null = null;
  let last: number | null = null;
  let peakPressure: number | null = null;
  let peakFlow: number | null = null;
  for (const sample of samples) {
    const machine = object(object(sample).machine);
    const at = date(machine.timestamp)?.getTime();
    if (at !== undefined) {
      first = first === null ? at : Math.min(first, at);
      last = last === null ? at : Math.max(last, at);
    }
    const pressure = number(machine.pressure);
    const flow = number(machine.flow);
    if (pressure !== null) peakPressure = peakPressure === null ? pressure : Math.max(peakPressure, pressure);
    if (flow !== null) peakFlow = peakFlow === null ? flow : Math.max(peakFlow, flow);
  }
  return {
    pulledAt: pulledAt(object(record), last),
    duration: first !== null && last !== null ? (last - first) / 1000 : null,
    peakPressure,
    peakFlow,
  };
}

/**
 * Decaid writes a Shot's `timestamp` and sample times in the tablet's local
 * time without an offset, and `createdAt` in UTC as it saves the Shot, just
 * after the last sample. That gap, rounded to a quarter hour, is the offset.
 */
function pulledAt(shot: Record<string, unknown>, lastSample: number | null): Date | null {
  const start = date(shot.timestamp);
  if (!start || typeof shot.timestamp !== "string") return null;
  if (/(?:Z|[+-]\d\d:\d\d)$/.test(shot.timestamp)) return start;
  const created = date(shot.createdAt);
  if (!created || lastSample === null) return null;
  return new Date(start.getTime() + Math.round((created.getTime() - lastSample) / QUARTER_HOUR) * QUARTER_HOUR);
}
