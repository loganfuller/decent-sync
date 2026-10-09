// Decaid's Workflow writes, as v0.8.7 carries them out
// (`WorkflowHandler._updateWorkflow` in
// decaid:lib/src/services/webserver/workflow_handler.dart), learned from
// fixtures/decaid/workflow-writes-v0.8.7/: the body is deep-merged into the
// Workflow, which is rebuilt from the result, dropping fields Decaid does not
// know, and fields of its `context` merged in as null, and its steam, hot
// water and rinse settings, where they changed, are written to the machine,
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
  const changed = (part: string, fields: readonly string[]) => fields.some((field) => partOf(previous, part)[field] !== partOf(updated, part)[field]);
  return (
    changed("steamSettings", STEAM_WRITTEN) ||
    changed("hotWaterData", Object.keys(PARTS.hotWaterData!)) ||
    changed("rinseData", Object.keys(PARTS.rinseData!))
  );
}

function partOf(workflow: Json, part: string): Json {
  const value = workflow[part];
  return isObject(value) ? value : {};
}

/** The Workflow Decaid rebuilds from a merged one: its known fields, and each settings part's fields read as it reads them. */
function rebuilt(merged: Json): Json {
  const workflow: Json = {};
  for (const field of WORKFLOW_FIELDS) if (field in merged) workflow[field] = merged[field];
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
