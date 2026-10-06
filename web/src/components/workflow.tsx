// Reading the parts of Decaid records the management interface shows. Any part
// may be missing, or sent differently by another supported Decaid version.

/**
 * The parts of a Workflow shown, as Decaid names them in its Workflow, each
 * only if present: another Decaid version may send others or fewer.
 */
export function workflowFields(workflow: Record<string, unknown>): [string, string][] {
  const profile = record(workflow.profile);
  const context = record(workflow.context);
  const steam = record(workflow.steamSettings);
  const hotWater = record(workflow.hotWaterData);
  const rinse = record(workflow.rinseData);
  const fields: [string, string | undefined][] = [
    ["Profile", text(profile?.title)],
    ["Dose", amount(context?.targetDoseWeight, "g")],
    ["Yield", amount(context?.targetYield, "g")],
    ["Bean", text(context?.coffeeName)],
    ["Roaster", text(context?.coffeeRoaster)],
    ["Grinder", text(context?.grinderModel)],
    ["Grind setting", text(context?.grinderSetting)],
    ["Barista", text(context?.baristaName)],
    ["Steam", list(amount(steam?.targetTemperature, "°C"), amount(steam?.duration, "s"), amount(steam?.flow, "ml/s"))],
    ["Hot water", list(amount(hotWater?.targetTemperature, "°C"), amount(hotWater?.volume, "ml"))],
    ["Rinse", list(amount(rinse?.targetTemperature, "°C"), amount(rinse?.duration, "s"))],
  ];
  return present(fields);
}

/** The fields that have a value. */
export function present(fields: [string, string | undefined][]): [string, string][] {
  return fields.filter((field): field is [string, string] => field[1] !== undefined);
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function text(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** A number with its unit, to two decimal places at most: Decaid sends 2.500000000000001 for 2.5. */
export function amount(value: unknown, unit: string): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? `${Number(value.toFixed(2))} ${unit}` : undefined;
}

export function list(...parts: (string | undefined)[]): string | undefined {
  const present = parts.filter((part) => part !== undefined);
  return present.length > 0 ? present.join(", ") : undefined;
}
