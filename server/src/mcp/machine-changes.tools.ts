import { Injectable } from "@nestjs/common";
import type { McpContext } from "@nestjs/mcp";
import * as z from "zod";
import {
  EDITABLE_SETTINGS_COLLECTIONS,
  type EditableSettingsField,
  SETTINGS_FIELDS,
  WAKE_SCHEDULE_ACTIONS,
  WAKE_SCHEDULE_FIELDS,
  isEditable,
} from "@decent-sync/protocol";
import { CHANGE, READ } from "../connected-apps/oauth.js";
import { SharingService } from "../library/sharing.service.js";
import { readMachineId, readMove } from "../machines/input.js";
import { LocationHistoryService } from "../machines/location-history.service.js";
import { MachinesService } from "../machines/machines.service.js";
import { readSettingsEdit } from "../settings-edits/input.js";
import { SettingsEditsService } from "../settings-edits/settings-edits.service.js";
import { BudgetedTool } from "./budget.js";
import { SETTINGS_EDIT_WHOLE, detailed, machineDetail, machineId, settingsEditOf, settingsEditOutput, zoneOf } from "./machines.tools.js";
import { callerOf, requireAdmin } from "./token-verifier.js";

// Machines changed through an assistant (#413, ADR-0026): moved to another
// Location, their sharing turned on or off, and their Machine Settings or
// Tablet Settings changed by a Settings Edit, each by the service its REST
// route calls, so it is refused, with the same message, wherever the REST
// API would refuse it, Staff's limits included. A Settings Edit is recorded
// as the account's, through its Connected App. Every tool needs the `change`
// scope besides `read`, so a Connected App granted only `read`, or a
// Viewer's, is refused with 403 `insufficient_scope`. Correcting a Location
// History stays in the management interface (#405).

const machineOutput = z.object({ machine: machineDetail });

const moveInput = z.strictObject({
  machineId,
  locationId: z.string().describe("The id of the Location it moves to, as list_locations gives it."),
});

const sharingInput = z.strictObject({
  machineId,
  sharing: z.boolean().describe("true to turn its sharing on, false to turn it off."),
});

const settingsEditInput = z.strictObject({
  machineId,
  collection: z
    .enum(EDITABLE_SETTINGS_COLLECTIONS)
    .describe("The settings to change, as get_machine names them: machineSettings, advancedSettings, machineCalibration or sensorCalibration (Machine Settings), or appSettings or presenceSettings (Tablet Settings)."),
  fields: z
    .record(z.string(), z.unknown())
    .describe("Each setting to change, by its name in get_machine's value of the collection, with its new value. A sensorCalibration edit sets one sensor, such as { \"pressure\": 1.02 }. For a wake schedule, the fields of it to set; none to delete it."),
  expected: z
    .record(z.string(), z.unknown())
    .describe(
      "Each of those settings' value as get_machine gave it, exactly, null where it gave none: the tablet refuses the edit, changing nothing, if it holds another by then. For sensorCalibration, the sensor's measuredValue. For a wake schedule's change or delete, the whole schedule as get_machine gave it, its id included; for an add, {}.",
    ),
  schedule: z
    .strictObject({
      action: z.enum(WAKE_SCHEDULE_ACTIONS),
      id: z.string().optional().describe("The schedule's id, as get_machine gives it, to change or delete it; none to add one."),
    })
    .optional()
    .describe("Only for presenceSettings' wake schedules, each added, changed or deleted on its own."),
});

const CHANGES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

/** What a field takes, in words, from its definition. */
function valueGuide(field: EditableSettingsField): string {
  const range = field.min !== undefined && field.max !== undefined ? `, ${field.min} to ${field.max}` : field.min !== undefined ? `, ${field.min} or more` : "";
  switch (field.kind) {
    case "onOff":
      return "true or false";
    case "choice":
      return `one of ${(field.choices ?? []).map(({ value, label }) => (String(value) === label ? JSON.stringify(value) : `${JSON.stringify(value)} for ${label}`)).join(", ")}`;
    case "number":
      return `a number${range}${field.step === undefined ? "" : `, a multiple of ${field.step}`}`;
    case "wholeNumber":
      return `a whole number${range}${field.orNone ? ", or null for none" : ""}`;
    case "timeOfDay":
      return "minutes after midnight in the tablet's own time, 0 to 1439";
    case "hoursMinutes":
      return "HH:MM in the tablet's own time";
    case "weekdays":
      return "days of the week, 1 (Monday) to 7 (Sunday), each once and in order, none for every day";
    default:
      return field.kind;
  }
}

/** A field as the description names it: its name, label and unit, what it takes, and who may change it. */
function fieldGuide(field: EditableSettingsField): string {
  const notes = [valueGuide(field), field.notes?.includes("restartAfterChange") ? "taken once the Machine restarts" : undefined, field.editableBy === "admin" ? "Admins only" : undefined];
  return `${field.path} (${field.label}${field.unit ? `, ${field.unit}` : ""}: ${notes.filter((note) => note !== undefined).join("; ")})`;
}

/**
 * The settings each collection's edit sets, from the definitions the server
 * and plugin check an edit against, with the wake schedules' fields, so the
 * description stays in step with them.
 */
const SETTINGS_GUIDE = [
  ...EDITABLE_SETTINGS_COLLECTIONS.map((name) => {
    const fields = SETTINGS_FIELDS[name].filter(isEditable).filter((field) => field.kind !== "wakeSchedules");
    return `${name}: ${fields.map(fieldGuide).join(", ")}.`;
  }),
  `A wake schedule of presenceSettings: ${WAKE_SCHEDULE_FIELDS.map(fieldGuide).join(", ")}; an added one sets all four.`,
].join(" ");

/**
 * Machines changed through an assistant: each tool calls the service its
 * REST route calls, as the account, and returns the Machine as get_machine
 * gives it, or the Settings Edit as list_settings_edits gives it.
 */
@Injectable()
export class MachineChangesTools {
  constructor(
    private readonly machines: MachinesService,
    private readonly locationHistory: LocationHistoryService,
    private readonly sharing: SharingService,
    private readonly settingsEdits: SettingsEditsService,
  ) {}

  @BudgetedTool({
    name: "move_machine",
    title: "Move a Machine",
    description:
      "Moves a Machine to another Location, from now: its Location History gains an entry, its Shots and Steam Records from then on are credited to that Location, and its tablet takes part in that Location's Library from then, as when moved in the management interface. Staff move a Machine only from a Location they work at to another they work at. Earlier entries of its Location History are corrected only in the management interface.",
    inputSchema: moveInput,
    outputSchema: machineOutput,
    annotations: { ...CHANGES, idempotentHint: true },
    scopes: [READ, CHANGE],
  })
  async moveMachine(input: z.infer<typeof moveInput>, context: McpContext): Promise<z.infer<typeof machineOutput>> {
    // In lower case, as Staff's Locations and the Machine's Location History hold them.
    const move = readMove({ locationId: input.locationId.toLowerCase() });
    const machine = await this.locationHistory.move(readMachineId(input.machineId).toLowerCase(), move, callerOf(context).scope);
    return { machine: detailed(machine) };
  }

  @BudgetedTool({
    name: "set_machine_sharing",
    title: "Turn a Machine's sharing on or off",
    description:
      "Turns a Machine's sharing on or off. Off, it is a Capture-only Machine: its Shots and Steam Records are kept, but its tablet's items don't join the Library, and nothing of the Library is written to it; Settings Edits still reach it. Turned on again, it joins its Location's Library afresh. Admins only.",
    inputSchema: sharingInput,
    outputSchema: machineOutput,
    annotations: { ...CHANGES, idempotentHint: true },
    scopes: [READ, CHANGE],
  })
  async setMachineSharing(input: z.infer<typeof sharingInput>, context: McpContext): Promise<z.infer<typeof machineOutput>> {
    requireAdmin(context);
    const id = readMachineId(input.machineId).toLowerCase();
    await this.sharing.setSharing(id, input.sharing);
    return { machine: detailed(await this.machines.get(id)) };
  }

  @BudgetedTool({
    name: "edit_machine_settings",
    title: "Change a Machine's settings",
    description: `Makes a Settings Edit: changes some of a Machine's Machine Settings or its tablet's Tablet Settings, from the values get_machine gives. It is sent to the tablet at once, only while the Machine is online, and never kept for later; the tablet answers within a minute, refusing it while the Machine is busy, such as pulling a Shot. This returns it as made, usually before that answer: read what came of it with list_settings_edits, newest first. Staff change only a Machine at a Location they work at, and only the settings not marked for Admins. The settings, by collection: ${SETTINGS_GUIDE}`,
    inputSchema: settingsEditInput,
    outputSchema: z.object({ settingsEdit: settingsEditOutput }),
    annotations: { ...CHANGES, destructiveHint: true },
    scopes: [READ, CHANGE],
    budget: { whole: SETTINGS_EDIT_WHOLE.map((part) => `/settingsEdit${part}`) },
  })
  async editMachineSettings(input: z.infer<typeof settingsEditInput>, context: McpContext): Promise<{ settingsEdit: z.infer<typeof settingsEditOutput> }> {
    const { machineId: given, ...body } = input;
    const id = readMachineId(given).toLowerCase();
    const { accountId, role, scope, connectedAppId } = callerOf(context);
    const made = await this.settingsEdits.make(id, readSettingsEdit(body), { accountId, role, scope, connectedAppId });
    return { settingsEdit: settingsEditOf(made, zoneOf(await this.machines.get(id))) };
  }
}
