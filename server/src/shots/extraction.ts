import { MAX_HARDWARE_LENGTH, realHardware, type Hardware } from "@decent-sync/protocol";

/** Analytics are a projection; missing or unfamiliar Decaid fields never invalidate a record. */
export function extractShot(record: unknown) {
  const shot = object(record);
  const workflow = object(shot.workflow);
  const context = object(workflow.context);
  const profile = object(workflow.profile);
  const annotations = object(shot.annotations);
  return {
    beanBatchId: string(context.beanBatchId),
    grinderId: string(context.grinderId),
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

/**
 * The hardware a Shot recorded, if it names real hardware. A model or serial
 * longer than a `hello` may report (MAX_HARDWARE_LENGTH) names none: no
 * Machine or Pending Machine could hold it.
 */
export function shotHardware(record: unknown): Hardware | null {
  const machine = object(object(object(record).workflow).machine);
  if (machine.provenanceStatus === "unavailable") return null;
  if (typeof machine.model !== "string" || typeof machine.serialNumber !== "string") return null;
  if (machine.model.length > MAX_HARDWARE_LENGTH || machine.serialNumber.length > MAX_HARDWARE_LENGTH) return null;
  return realHardware({ model: machine.model, serial: machine.serialNumber });
}

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Times without an offset are the tablet's local wall-clock times. Read as
 * UTC, their differences are exact, except across a change of the tablet's
 * clock, such as daylight saving's (see `elapsedSeconds`).
 */
export function date(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const normalized = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? `${value}Z` : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

const QUARTER_HOUR = 15 * 60_000;

/**
 * Decaid records a sample with every machine snapshot, a fraction of a second
 * apart, so a longer jump between two samples is the tablet's clock changing.
 */
const CLOCK_CHANGE_MS = 60_000;

/**
 * The time from a record's first sample to its last, in seconds, from their
 * local times in the order Decaid recorded them, or null without any. The
 * gaps between consecutive samples are added up. Across a daylight-saving
 * change the local time jumps by whole quarter hours, usually an hour, which
 * are left out of that gap. A gap that still runs backwards, or that leaves
 * more than a minute, is a correction of the tablet's clock by an unknown
 * amount, and counts for nothing.
 */
export function elapsedSeconds(times: readonly number[]): number | null {
  if (times.length === 0) return null;
  let elapsed = 0;
  for (let n = 1; n < times.length; n++) {
    const gap = times[n]! - times[n - 1]!;
    const real = Math.abs(gap) <= CLOCK_CHANGE_MS ? gap : gap - quarterHours(gap);
    if (real >= 0 && real <= CLOCK_CHANGE_MS) elapsed += real;
  }
  return elapsed / 1000;
}

/** Values that need the Shot's curves: when it was pulled, its duration and its peaks. */
export function extractCurves(record: unknown, measurements: unknown) {
  const samples = Array.isArray(measurements) ? measurements : [];
  const times: number[] = [];
  let first: number | null = null;
  let last: number | null = null;
  let peakPressure: number | null = null;
  let peakFlow: number | null = null;
  for (const sample of samples) {
    const machine = object(object(sample).machine);
    const at = date(machine.timestamp)?.getTime();
    if (at !== undefined) {
      times.push(at);
      first = first === null ? at : Math.min(first, at);
      last = last === null ? at : Math.max(last, at);
    }
    const pressure = number(machine.pressure);
    const flow = number(machine.flow);
    if (pressure !== null) peakPressure = peakPressure === null ? pressure : Math.max(peakPressure, pressure);
    if (flow !== null) peakFlow = peakFlow === null ? flow : Math.max(peakFlow, flow);
  }
  return {
    pulledAt: pulledAt(object(record), first, last),
    duration: elapsedSeconds(times),
    peakPressure,
    peakFlow,
  };
}

/**
 * Decaid writes a Shot's `timestamp` and sample times in the tablet's local
 * time without an offset, and `createdAt` in UTC as it saves the Shot, just
 * after the last sample. That gap, rounded to a quarter hour, is the samples'
 * offset. Decaid reads `timestamp` back in the tablet's current zone, while
 * samples keep the zone they were recorded in, so any whole-quarter-hour gap
 * between `timestamp` and the first sample is a zone change, removed first.
 */
function pulledAt(shot: Record<string, unknown>, firstSample: number | null, lastSample: number | null): Date | null {
  const start = date(shot.timestamp);
  if (!start || typeof shot.timestamp !== "string") return null;
  if (/(?:Z|[+-]\d\d:\d\d)$/.test(shot.timestamp)) return start;
  const created = date(shot.createdAt);
  if (!created || firstSample === null || lastSample === null) return null;
  const zoneChange = quarterHours(start.getTime() - firstSample);
  return new Date(start.getTime() - zoneChange + quarterHours(created.getTime() - lastSample));
}

function quarterHours(ms: number): number {
  return Math.round(ms / QUARTER_HOUR) * QUARTER_HOUR;
}
