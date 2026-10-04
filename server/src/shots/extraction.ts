import { realHardware, type Hardware } from "@decent-sync/protocol";

/** Analytics are a projection; missing or unfamiliar Decaid fields never invalidate a record. */
export function extractShot(record: unknown) {
  const shot = object(record);
  const workflow = object(shot.workflow);
  const context = object(workflow.context);
  const dose = object(workflow.doseData);
  const coffee = object(workflow.coffeeData);
  const profile = object(workflow.profile);
  const annotations = object(shot.annotations);
  const metrics = curveMetrics(shot.measurements);
  return {
    pulledAt: date(shot.timestamp),
    beanBatchId: string(context.beanBatchId),
    coffeeName: string(context.coffeeName) ?? string(coffee.name),
    coffeeRoaster: string(context.coffeeRoaster) ?? string(coffee.roaster),
    profileTitle: string(profile.title),
    profileId: string(profile.id) ?? string(object(object(context.extras).workflowSkin).selectedProfileId),
    targetDose: number(context.targetDoseWeight) ?? number(dose.doseIn),
    targetYield: number(context.targetYield) ?? number(dose.doseOut) ?? number(profile.target_weight),
    actualDose: number(annotations.actualDoseWeight),
    actualYield: number(annotations.actualYield),
    enjoyment: number(annotations.enjoyment),
    barista: string(context.baristaName),
    ...metrics,
  };
}

/** Keep sub-millisecond precision when PostgreSQL compares Decaid's edit times. */
export function shotVersion(record: unknown): string {
  const shot = object(record);
  for (const value of [shot.updatedAt, shot.createdAt, shot.timestamp]) {
    const parsed = date(value);
    if (!parsed) continue;
    if (typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?$/.test(value)) {
      return /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`;
    }
    return parsed.toISOString();
  }
  // Undated records still have a stable version, so repeated deliveries keep the first one.
  return "1970-01-01T00:00:00.000Z";
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

function date(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  // Decaid's older local timestamps have no offset. Treat them consistently as UTC, independent of the instance's time zone.
  const normalized = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? `${value}Z` : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function curveMetrics(measurements: unknown) {
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
  return { duration: first !== null && last !== null ? (last - first) / 1000 : null, peakPressure, peakFlow };
}
