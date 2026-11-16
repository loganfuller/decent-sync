// Reading the parts of Decaid records the management interface shows. Any part
// may be missing, or sent differently by another supported Decaid version.

/** The parts of a Workflow the management interface shows, each only if present: another Decaid version may send others or fewer. */
export interface WorkflowParts {
  profile?: string;
  brewTemperature?: string;
  dose?: string;
  yield?: string;
  bean?: string;
  roaster?: string;
  grinder?: string;
  burrs?: string;
  grindSetting?: string;
  barista?: string;
  steam?: string;
  hotWater?: string;
  /** The flush settings, which Decaid's Workflow calls its rinse data. */
  flush?: string;
}

/** A Workflow's parts, read from it as Decaid sends it. */
export function workflowParts(workflow: Record<string, unknown>): WorkflowParts {
  const profile = record(workflow.profile);
  const context = record(workflow.context);
  const steam = record(workflow.steamSettings);
  const hotWater = record(workflow.hotWaterData);
  const rinse = record(workflow.rinseData);
  // Decaid's Workflow has no brew temperature: Streamline's Brew tile shows
  // and sets the profile's first step's, moving every other step with it.
  const firstStep = Array.isArray(profile?.steps) ? record(profile.steps[0]) : undefined;
  return {
    profile: text(profile?.title),
    brewTemperature: amount(firstStep?.temperature, "°C"),
    dose: amount(context?.targetDoseWeight, "g"),
    yield: amount(context?.targetYield, "g"),
    bean: text(context?.coffeeName),
    roaster: text(context?.coffeeRoaster),
    grinder: text(context?.grinderModel),
    burrs: text(context?.grinderBurrs),
    grindSetting: text(context?.grinderSetting),
    barista: text(context?.baristaName),
    steam: list(amount(steam?.targetTemperature, "°C"), amount(steam?.duration, "s"), amount(steam?.flow, "ml/s")),
    hotWater: list(amount(hotWater?.targetTemperature, "°C"), amount(hotWater?.volume, "ml")),
    flush: list(amount(rinse?.targetTemperature, "°C"), amount(rinse?.duration, "s")),
  };
}

/** A Workflow's parts as a Machine's page lists them, named as Decaid names them in its Workflow. */
export function workflowFields(workflow: Record<string, unknown>): [string, string][] {
  const parts = workflowParts(workflow);
  return present([
    ["Profile", parts.profile],
    ["Brew temperature", parts.brewTemperature],
    ["Dose", parts.dose],
    ["Yield", parts.yield],
    ["Bean", parts.bean],
    ["Roaster", parts.roaster],
    ["Grinder", parts.grinder],
    ["Burrs", parts.burrs],
    ["Grind setting", parts.grindSetting],
    ["Barista", parts.barista],
    ["Steam", parts.steam],
    ["Hot water", parts.hotWater],
    ["Rinse", parts.flush],
  ]);
}

/**
 * What a Shot's page reads of its record beside its Workflow's parts and
 * what the server gives of it: who it was for, the Tools DYE2 named, and the
 * machine as the Shot recorded it (Decaid v0.7.6 and later), in one line,
 * such as "DE1Pro, serial 10021, firmware 1333, flow calibration 1.1".
 */
export function shotRecordParts(shot: Record<string, unknown>): { drinker?: string; tools?: string; machine?: string } {
  const workflow = record(shot.workflow);
  const context = record(workflow?.context);
  const extras = record(context?.extras);
  // DYE2's Edit Shot page records the Tools in the annotations' extras, over the Workflow's (`shotBasketRpm` in DYE2).
  const edited = record(record(shot.annotations)?.extras);
  const toolNames = (from: Record<string, unknown> | undefined) =>
    Array.isArray(from?.equipmentNames) ? from.equipmentNames : from?.equipmentName != null ? [from.equipmentName] : [];
  const tools = [...toolNames(edited), ...toolNames(extras)].filter((name): name is string => typeof name === "string" && name !== "");
  const machine = record(workflow?.machine);
  const labelled = (label: string, value: string | undefined) => (value === undefined ? undefined : `${label} ${value}`);
  return {
    drinker: text(context?.drinkerName),
    tools: tools.length > 0 ? [...new Set(tools)].join(", ") : undefined,
    machine: list(
      text(machine?.model),
      labelled("serial", text(machine?.serialNumber)),
      labelled("firmware", text(machine?.firmwareVersion)),
      labelled("flow calibration", text(machine?.flowCalibration)),
    ),
  };
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

function list(...parts: (string | undefined)[]): string | undefined {
  const present = parts.filter((part) => part !== undefined);
  return present.length > 0 ? present.join(", ") : undefined;
}
