// Decaid's Workflow writes, as v0.9.0 carries them out
// (`WorkflowHandler._updateWorkflow` in
// decaid:lib/src/services/webserver/workflow_handler.dart), learned from
// fixtures/decaid/workflow-writes-v0.8.7/, unchanged since, and
// workflow-writes-v0.9.0/, for the grinder's burrs v0.9.0 added: the body is deep-merged into the
// Workflow, which is rebuilt from the result, dropping fields Decaid does not
// know, its profile's included, and fields of its `context` merged in as
// null, and its steam, hot water and rinse settings, where they changed, are
// written to the machine,
// which refuses them while none is connected.

/** What Decaid answers a request: its status and its body, as JSON. */
export interface WorkflowAnswer {
  status: number;
  body: unknown;
}

type Json = Record<string, unknown>;

/** Each part's fields, whole numbers (`int`) or doubles, as `Workflow.toJson` writes them. */
const PARTS: Readonly<Record<string, Readonly<Record<string, "int" | "double">>>> = {
  steamSettings: { targetTemperature: "int", duration: "int", flow: "double", stopAtTemperature: "double" },
  hotWaterData: { targetTemperature: "int", duration: "int", volume: "int", flow: "double" },
  rinseData: { targetTemperature: "int", duration: "int", flow: "double" },
};

/** A part merged in as null is rebuilt as Decaid's defaults; steamSettings refuses null. */
const DEFAULTS: Readonly<Record<string, Json>> = {
  hotWaterData: { targetTemperature: 75, duration: 30, volume: 50, flow: 10 },
  rinseData: { targetTemperature: 90, duration: 10, flow: 6 },
};

/**
 * The fields of a Workflow's `context` Decaid knows, as `WorkflowContext`
 * reads them: numbers (`parseOptionalDouble`), strings
 * (`parseOptionalString`), and its `extras`. It drops any other, and any
 * that reads as null.
 */
const CONTEXT: Readonly<Record<string, "double" | "string" | "object">> = {
  targetDoseWeight: "double",
  targetYield: "double",
  targetWaterVolume: "double",
  grinderId: "string",
  grinderModel: "string",
  grinderBurrs: "string",
  grinderSetting: "string",
  beanBatchId: "string",
  coffeeName: "string",
  coffeeRoaster: "string",
  finalBeverageType: "string",
  baristaName: "string",
  drinkerName: "string",
  extras: "object",
};

/** The Workflow's fields Decaid knows; it drops any other top-level key. */
const WORKFLOW_FIELDS = ["id", "name", "description", "profile", "context", "steamSettings", "hotWaterData", "rinseData"];

/** The profile's fields as `Profile.toJson` writes them, in its order (decaid:lib/src/models/data/profile.dart); it drops any other, such as an `id`. */
const PROFILE_FIELDS = ["version", "title", "notes", "author", "beverage_type", "steps", "target_volume", "target_weight", "target_volume_count_start", "tank_temperature"];

/**
 * A step's fields as `ProfileStepPressure.toJson` and `ProfileStepFlow.toJson`
 * write them, in their order, its pressure or flow by its pump; its weight,
 * exit and limiter as theirs do, or null for none (decaid:lib/src/models/data/profile.dart).
 * So a profile reads back in the same order whatever order it was sent in.
 */
function rebuiltStep(step: unknown): unknown {
  if (!isObject(step)) return step;
  const fields = ["name", "pump", "transition", "exit", "volume", "seconds", "weight", "temperature", "sensor", step.pump === "flow" ? "flow" : "pressure", "limiter"];
  const ordered = (value: unknown, keys: readonly string[]) => (isObject(value) ? Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]])) : null);
  return Object.fromEntries(
    fields
      .filter((field) => field in step || field === "exit" || field === "weight" || field === "limiter")
      .map((field) => [field, field === "exit" ? ordered(step.exit, ["type", "condition", "value"]) : field === "limiter" ? ordered(step.limiter, ["value", "range"]) : field === "weight" ? (step.weight ?? null) : step[field]]),
  );
}

/** The steam settings Decaid writes to the machine, so a change of which needs one: not `stopAtTemperature`. */
const STEAM_WRITTEN = ["targetTemperature", "duration", "flow"];

class FormatError extends Error {}

/**
 * Carries out `PUT /workflow` on `current` as Decaid does, with a machine
 * connected or not: the answer, and the Workflow from then on if it took.
 */
export function updateWorkflow(current: Json, body: unknown, machineConnected: boolean): { answer: WorkflowAnswer; workflow?: Json } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { answer: { status: 400, body: { error: "Request body must be a JSON object" } } };
  }
  const merge = body as Json;
  let updated: Json;
  try {
    rejectNulls(merge, ["steamSettings", "context"]);
    if (isObject(merge.steamSettings)) rejectNulls(merge.steamSettings, ["targetTemperature", "duration", "flow", "stopAtTemperature"]);
    else if ("steamSettings" in merge) throw new FormatError('Field "steamSettings" must be an object');
    if (isObject(merge.context)) rejectNulls(merge.context, ["targetYield"]);
    else if ("context" in merge) throw new FormatError('Field "context" must be an object');
    updated = rebuilt(deepMerge(current, merge));
  } catch (error) {
    if (!(error instanceof FormatError)) throw error;
    return { answer: { status: 400, body: { error: "Invalid request", message: `FormatException: ${error.message}` } } };
  }
  if (needsMachine(current, updated) && !machineConnected) {
    return { answer: { status: 500, body: { error: "Internal server error", message: "DeviceNotConnectedException: machine not connected" } } };
  }
  return { answer: { status: 200, body: updated }, workflow: updated };
}

/** Whether Decaid writes the change to the machine (`De1Controller.updateWorkflowSettings`). */
function needsMachine(previous: Json, updated: Json): boolean {
  return Object.values(changedParts(previous, updated)).some(Boolean);
}

/** Which of the parts Decaid writes to the machine the change changed (`De1Controller.updateWorkflowSettings`). */
function changedParts(previous: Json, updated: Json): Record<"steamSettings" | "hotWaterData" | "rinseData", boolean> {
  const changed = (part: string, fields: readonly string[]) => fields.some((field) => partOf(previous, part)[field] !== partOf(updated, part)[field]);
  return {
    steamSettings: changed("steamSettings", STEAM_WRITTEN),
    hotWaterData: changed("hotWaterData", Object.keys(PARTS.hotWaterData!)),
    rinseData: changed("rinseData", Object.keys(PARTS.rinseData!)),
  };
}

/**
 * The machine's settings, by their `GET /machine/settings` names, that
 * Decaid sets as it writes each changed part to the machine
 * (`De1Controller.updateWorkflowSettings`): the steam flow, hot water flow
 * and flush flow, and, on a machine that keeps them (`keepsFlush`), as a
 * DE1 does in its MMR (`UnifiedDe1.setFlushTemperature`), the flush time and
 * temperature. Decaid's simulated machine keeps neither
 * (`MockDe1.setFlushTimeout` and `setFlushTemperature` do nothing), and
 * answers 10 and 25 whatever was written, as recorded
 * (dye2-2cf631c/machine-settings.json).
 */
export function machineSettingsWritten(previous: Json, updated: Json, keepsFlush: boolean): Json {
  const parts = changedParts(previous, updated);
  const written: Json = {};
  if (parts.steamSettings) written.steamFlow = partOf(updated, "steamSettings").flow;
  if (parts.hotWaterData) written.hotWaterFlow = partOf(updated, "hotWaterData").flow;
  if (parts.rinseData) {
    const rinse = partOf(updated, "rinseData");
    written.flushFlow = rinse.flow;
    if (keepsFlush) Object.assign(written, { flushTemp: rinse.targetTemperature, flushTimeout: rinse.duration });
  }
  return written;
}

function partOf(workflow: Json, part: string): Json {
  const value = workflow[part];
  return isObject(value) ? value : {};
}

/** The Workflow Decaid rebuilds from a merged one: its known fields, and each settings part's fields read as it reads them. */
function rebuilt(merged: Json): Json {
  const workflow: Json = {};
  for (const field of WORKFLOW_FIELDS) if (field in merged) workflow[field] = merged[field];
  if (isObject(merged.profile)) {
    const profile = merged.profile;
    const kept: Json = Object.fromEntries(PROFILE_FIELDS.filter((field) => field in profile).map((field) => [field, profile[field]]));
    if (Array.isArray(profile.steps)) kept.steps = profile.steps.map(rebuiltStep);
    workflow.profile = kept;
  }
  if (isObject(merged.context)) workflow.context = rebuiltContext(merged.context);
  else delete workflow.context;
  for (const [part, fields] of Object.entries(PARTS)) {
    const value = merged[part];
    const source = value === null || value === undefined ? DEFAULTS[part] : value;
    if (!isObject(source)) throw new FormatError(`Field "${part}" must be an object`);
    workflow[part] = Object.fromEntries(Object.entries(fields).map(([field, type]) => [field, read(source[field], type)]));
  }
  return workflow;
}

/** A Workflow's `context` as `WorkflowContext.fromJson` reads it and `toJson` writes it back. */
function rebuiltContext(merged: Json): Json {
  const context: Json = {};
  for (const [field, type] of Object.entries(CONTEXT)) {
    const value = merged[field];
    const read =
      type === "double" ? optionalDouble(value) : type === "string" ? optionalString(value) : isObject(value) ? value : null;
    if (read !== null) context[field] = read;
  }
  return context;
}

/** `parseOptionalDouble` in utils.dart: a number, or a string that reads as one; otherwise null. */
function optionalDouble(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^[+-]?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return null;
}

/** `parseOptionalString` in utils.dart: a string, a number or a boolean as text; otherwise null. */
function optionalString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/** A number as Dart's `parseInt` or `parseDouble` in json_utils.dart reads one: a fraction for an int is cut toward zero. */
function read(value: unknown, type: "int" | "double"): number {
  let number: number;
  if (typeof value === "number") number = value;
  else if (typeof value === "string" && /^[+-]?\d+(\.\d+)?$/.test(value.trim())) number = Number(value);
  else if (typeof value === "string") throw new FormatError(`Invalid radix-10 number (at character 1)\n${value}\n^\n`);
  else number = 0;
  return type === "int" ? Math.trunc(number) : number;
}

function rejectNulls(patch: Json, fields: readonly string[]): void {
  for (const field of fields) if (field in patch && patch[field] === null) throw new FormatError(`Field "${field}" cannot be null`);
}

/** `deepMergeJson` in json_utils.dart: objects merged key by key, anything else replaced. */
function deepMerge(base: Json, updates: Json): Json {
  const result: Json = { ...base };
  for (const [key, value] of Object.entries(updates)) {
    const known = result[key];
    result[key] = isObject(known) && isObject(value) ? deepMerge(known, value) : value;
  }
  return result;
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
