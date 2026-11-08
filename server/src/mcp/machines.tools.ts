import { BadRequestException, Injectable } from "@nestjs/common";
import type { McpContext } from "@nestjs/mcp";
import * as z from "zod";
import type { CollectionView } from "../collections/collections.service.js";
import { CollectionsService } from "../collections/collections.service.js";
import { READ } from "../connected-apps/oauth.js";
import type { LocationView } from "../locations/locations.service.js";
import { type ChangeView, sharingStatus } from "../library/sharing-status.js";
import type { LoadedRecipeView } from "../machine-events/loaded-recipes.js";
import { type ActivityKind, type ActivityPage, MachineEventsService } from "../machine-events/machine-events.service.js";
import { readMachineId } from "../machines/input.js";
import { type MachineView, MachinesService } from "../machines/machines.service.js";
import { PrismaService } from "../prisma.service.js";
import { type SettingsEditView, SettingsEditsService } from "../settings-edits/settings-edits.service.js";
import { BudgetedTool } from "./budget.js";
import { PAGED, page, pageOf, pageOutput } from "./paging.js";
import { isDay, startOfDay, timeBound, zonedTime } from "./times.js";
import { callerOf } from "./token-verifier.js";
import { workflowSummary, workflowSummaryOutput } from "./workflow-summary.js";

const time = z.string().describe("ISO 8601, with the offset of the time zone of the Location the Machine was at then, or UTC's while it was at none.");
const tabletTime = z.string().describe("ISO 8601, with the offset of the time zone of the Location the Machine was at then, or UTC's while it was at none, by the tablet's clock.");

/** How a Machine's times read, for the descriptions of the tools that read Machines. */
const MACHINE_TIMES =
  "Times are ISO 8601 with the offset of the time zone of the Location the Machine was at then, by its Location History, or UTC's while it was at none; a Machine State's and a Loaded Recipe's times, and its Workflow's observedAt, are by its tablet's clock.";

/** What list_machines gives of each Machine, which get_machine gives too. */
const LISTED =
  "where it is now; online, whether its tablet's plugin is connected now, and lastSeenAt, when it was last heard from; its last Machine State, as Decaid names its state and substate, such as espresso and pouring, or sleep; its Loaded Recipe, the Recipe a barista last applied on it, with its Recipe Slot, 1 to 5, and unloadedAt null while still loaded; and captureOnly, why it is a Capture-only Machine, whose records are kept but which takes no part in the Library: noLocation, sharingOff, or empty while it takes part.";

/** What a date given for a bound of a Machine's activity means. */
const MACHINE_DAY = "A date, such as 2026-11-06, is that day at the Location the Machine was at, in its time zone, or in UTC while it was at none.";

const location = z.object({
  id: z.string(),
  name: z.string(),
  timeZone: z.string().describe("Its IANA time zone. A day at the Location is a day in this zone."),
});

const machineState = z
  .object({ state: z.string(), substate: z.string(), observedAt: tabletTime })
  .describe("A Machine State as Decaid names it, such as espresso and pouring, or sleep, and when the plugin observed it.");

const loadedRecipe = z
  .object({
    recipe: z.object({
      id: z.string(),
      name: z.string().nullable(),
      slot: z.number().int().nullable().describe("Its Recipe Slot at its Location now, 1 to 5, or null for none."),
      locationId: z.string().nullable(),
      archived: z.boolean(),
    }),
    loadedAt: tabletTime,
    unloadedAt: tabletTime.nullable().describe("Null while it is still loaded."),
  })
  .describe("A Loaded Recipe: the Recipe a barista last applied on the Machine, from when until when.");

const captureOnly = z
  .array(z.enum(["noLocation", "sharingOff"]))
  .describe("Why it is a Capture-only Machine, whose records are kept but which takes no part in the Library: it has no Location, or an Admin turned its sharing off. Empty while it takes part.");

const listedMachine = z.object({
  id: z.string(),
  name: z.string(),
  model: z.string().nullable().describe("Such as DE1PRO or Bengle; null until its tablet reports it."),
  location: location.nullable().describe("Where it is now; null if nowhere known."),
  online: z.boolean().describe("Whether its tablet's plugin is connected now."),
  lastSeenAt: time.nullable().describe("When its plugin was last heard from; null if never."),
  machineState: machineState.nullable().describe("What it is doing: its last Machine State, null before any."),
  loadedRecipe: loadedRecipe.nullable(),
  captureOnly,
});

const machinesOutput = z.object({ machines: z.array(listedMachine) });

const settingsCollection = z
  .object({
    available: z.boolean().describe("Whether the latest report had a value."),
    reportedAt: time,
    receivedAt: time.nullable().describe("When the value was received; null if no report has had one."),
    value: z.unknown().describe("As Decaid sent it, its fields as Decaid names them; kept while later reports are unavailable."),
    utcOffsetMinutes: z.number().int().nullable().describe("For a value whose times have no offset, the tablet's UTC offset in minutes as it was read; else null."),
  })
  .nullable();

const changedItem = z.object({ kind: z.string(), id: z.string(), name: z.string().nullable() }).nullable();
const changeFields = { change: z.enum(["write", "delete", "remove", "leaveOut"]), kind: z.string(), item: changedItem, localId: z.string().nullable() };

/** A Machine as get_machine gives it, apart from its Workflow, settings, sharing status and its tablet's versions. */
export const machineDetail = listedMachine.extend({
  serial: z.string().nullable(),
  firmware: z.string().nullable().describe("The firmware its latest connection reported."),
  pluginVersion: z.string().nullable().describe("The Decent Sync plugin's version on its tablet, as its latest connection reported it."),
  decaidVersion: z.string().nullable(),
  locationHistory: z
    .array(z.object({ location, effectiveFrom: z.string().describe("When it arrived there, ISO 8601 with the offset of that Location's time zone then. It stayed until the next entry's time.") }))
    .describe("Where it has been, oldest first."),
  sharing: z.boolean().describe("Whether it shares the Library at its Location: on unless an Admin turned it off."),
  lastShot: z.object({ id: z.string(), pulledAt: tabletTime.nullable() }).nullable(),
});

const machineOutput = z.object({
  machine: machineDetail,
  workflow: z
    .object({ observedAt: tabletTime, receivedAt: time, workflow: z.record(z.string(), z.unknown()).describe("Decaid's Workflow, as sent.") })
    .nullable()
    .describe("Its Workflow: what it is set up to do next, as its tablet last reported it; null before any."),
  machineSettings: z
    .object({
      machineSettings: settingsCollection,
      advancedSettings: settingsCollection,
      machineCalibration: settingsCollection.describe("Its flow calibration."),
      sensorCalibration: settingsCollection,
    })
    .describe("Its Machine Settings, as its tablet last reported each; null for one never reported."),
  tabletSettings: z
    .object({ appSettings: settingsCollection, presenceSettings: settingsCollection.describe("When it sleeps and wakes, with its wake schedules.") })
    .describe("Its tablet's Tablet Settings, Decaid's own, as last reported; null for one never reported."),
  sharingStatus: z.object({
    waiting: z.number().int().nullable().describe("How many changes of the Library its tablet is due and has not refused; null while it is written nothing."),
    lastApplied: z.object({ ...changeFields, appliedAt: time }).nullable().describe("The last change its tablet applied."),
    refused: z
      .array(z.object({ ...changeFields, status: z.number().int().nullable(), error: z.string(), refusedAt: time }))
      .describe("The changes its tablet refused that are still due, latest first, with Decaid's answer."),
    unrecognisedLists: z.array(z.object({ list: z.string(), since: time })).describe("DYE2's lists its tablet holds in a shape not recognised, which nothing is written to."),
  }),
  tabletVersions: z.object({
    dye2: z.discriminatedUnion("status", [
      z.object({ status: z.literal("notReported") }),
      z.object({ status: z.literal("notInstalled") }),
      z.object({ status: z.literal("installed"), version: z.string().nullable(), loaded: z.boolean(), branch: z.string().nullable() }),
    ]),
    streamline: z.discriminatedUnion("status", [
      z.object({ status: z.literal("notReported") }),
      z.object({ status: z.literal("notInstalled") }),
      z.object({ status: z.literal("notActive"), activeSkin: z.object({ name: z.string().nullable(), version: z.string().nullable() }).nullable() }),
      z.object({ status: z.literal("active"), version: z.string().nullable(), build: z.enum(["release", "main"]) }),
    ]),
  }),
});

export const machineId = z.string().describe("The Machine's id, as list_machines gives it.");

const ACTIVITY_KINDS = ["workflowChanges", "loadedRecipes", "machineStates"] as const satisfies readonly ActivityKind[];

const activityInput = z.object({
  machineId,
  from: timeBound("The range's start; none for since the first.", MACHINE_DAY),
  to: timeBound("The range's end, not included, or through the end of a day given as a date; none for until now.", MACHINE_DAY),
  kinds: z.array(z.enum(ACTIVITY_KINDS)).min(1).optional().describe("Which lists to give; all three if none."),
  ...page,
});

const activityPage = <T extends z.ZodType>(entry: T, what: string) => z.object({ ...pageOutput, entries: z.array(entry) }).optional().describe(what);

const activityOutput = z.object({
  workflowChanges: activityPage(
    z.object({ observedAt: tabletTime, receivedAt: time, workflow: workflowSummaryOutput }),
    "Its Workflow each time it changed, latest first, each what it was set up to do next from then. One observed at or before the range's start, last, is the one in effect as it began.",
  ),
  loadedRecipes: activityPage(loadedRecipe, "Each Recipe loaded at any time in the range, latest loaded first."),
  machineStates: activityPage(
    z.object({ state: z.string(), substate: z.string(), observedAt: tabletTime, receivedAt: time }),
    "Each Machine State it went into, latest first, each until the next one reported. One observed at or before the range's start, last, is the one it was in as the range began. Nothing is reported while the machine isn't connected to its tablet or Decaid isn't running; changes while its tablet is offline arrive as it reconnects, with when they were observed, though a long outage may lose the oldest.",
  ),
});

const settingsEditsInput = z.object({ machineId, ...page });

/** A Settings Edit, as list_settings_edits gives it. */
export const settingsEditOutput = z.object({
  id: z.string(),
  collection: z.string().describe("The settings it changes: machineSettings, advancedSettings, machineCalibration or sensorCalibration (Machine Settings), or appSettings or presenceSettings (Tablet Settings)."),
  schedule: z.object({ action: z.enum(["add", "change", "delete"]), id: z.string().nullable() }).nullable().describe("The wake schedule it adds, changes or deletes, if it does."),
  fields: z.record(z.string(), z.unknown()).describe("Each field it sets, as Decaid names it, with its new value."),
  expected: z.record(z.string(), z.unknown()).describe("Each field's value as last reported when it was made."),
  account: z
    .object({ id: z.string(), name: z.string().nullable().describe("Shown to Admins only.") })
    .nullable()
    .describe("Who made it; null once the account is gone."),
  connectedApp: z
    .object({ id: z.string(), name: z.string().describe("The name the app gave itself."), host: z.string().describe("The host of its client id, which the app can't choose.") })
    .nullable()
    .describe("The Connected App, such as an assistant, the account made it through; null for the management interface."),
  madeAt: time,
  sentAt: time.nullable(),
  answeredAt: time.nullable(),
  outcome: z
    .enum(["applied", "adjusted", "refused", "notConfirmed"])
    .nullable()
    .describe("What came of it: applied; adjusted, stored otherwise by the Machine; refused; or notConfirmed, no answer came in time. Null while awaited."),
  late: z.boolean().describe("Whether its outcome came from an answer after it was marked not confirmed."),
  adjusted: z.array(z.object({ field: z.string(), holds: z.unknown().optional() })).describe("For adjusted: each field the Machine stored otherwise, with what it holds."),
  refusal: z
    .discriminatedUnion("reason", [
      z.object({ reason: z.literal("machineBusy"), state: z.string().nullable() }),
      z.object({ reason: z.literal("changedSince"), current: z.record(z.string(), z.unknown()).nullable() }),
      z.object({ reason: z.literal("expired") }),
      z.object({ reason: z.literal("decaid"), status: z.number().int().nullable(), message: z.string().nullable(), changed: z.array(z.string()) }),
    ])
    .nullable()
    .describe("Why it was refused: the Machine was busy, its settings changed since, it waited too long, or Decaid refused it."),
  readBack: z.record(z.string(), z.unknown()).nullable().describe("Its fields as read back after the write, or as held when refused as changed since."),
});

/** What a Settings Edit's parts mean, for the descriptions of the tools that give one. */
const SETTINGS_EDIT_NOTE =
  "Each changes one collection: machineSettings, advancedSettings, machineCalibration or sensorCalibration (Machine Settings), or appSettings or presenceSettings (Tablet Settings). fields are the values it sets, by Decaid's names, expected each field's value as last reported when it was made, and readBack its fields as read back after the write. outcome: applied; adjusted, stored otherwise by the Machine, as adjusted lists; refused, as refusal says why (machineBusy, the Machine was busy; changedSince, its settings changed since; expired, it waited too long; decaid, Decaid refused it); notConfirmed, no answer came in time; null while awaited. late: its outcome came from an answer after it was marked not confirmed.";

/** The parts of a Settings Edit that are settings, which are never cut. */
export const SETTINGS_EDIT_WHOLE = ["/fields", "/expected", "/readBack", "/adjusted", "/refusal/current"] as const;

const settingsEditsOutput = z.object({ ...pageOutput, settingsEdits: z.array(settingsEditOutput) });

/**
 * Machines, read through an assistant as the REST API reads them, calling
 * the same services (ADR-0026): which are online and what each is doing, how
 * one is set up, what happened on it over a time range, and its Settings
 * Edits. Every account reads every Machine, as through the REST API; who made
 * a Settings Edit is named as the REST API names it to the account.
 */
@Injectable()
export class MachinesTools {
  constructor(
    private readonly machines: MachinesService,
    private readonly events: MachineEventsService,
    private readonly collections: CollectionsService,
    private readonly settingsEdits: SettingsEditsService,
    private readonly prisma: PrismaService,
  ) {}

  @BudgetedTool({
    name: "list_machines",
    title: "List Machines",
    description: `Lists every Machine, by name, with its model, such as DE1PRO or Bengle: ${LISTED} ${MACHINE_TIMES}`,
    outputSchema: machinesOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
    budget: { rest: "get_machine reads one Machine with more of it." },
  })
  async listMachines(): Promise<z.infer<typeof machinesOutput>> {
    return { machines: (await this.machines.list()).map((machine) => listed(machine, zoneOf(machine))) };
  }

  @BudgetedTool({
    name: "get_machine",
    title: "Get a Machine",
    description: `One Machine: its Workflow, Machine Settings, its tablet's Tablet Settings, its Location History, its sharing status, and the versions on its tablet, besides what list_machines gives: ${LISTED} Its Workflow, what it is set up to do next, is Decaid's as its tablet last reported it, its Profile included. Its Machine Settings (machineSettings, advancedSettings, machineCalibration, its flow calibration, and sensorCalibration) and its tablet's Tablet Settings (appSettings, and presenceSettings, when it sleeps and wakes) are each as Decaid sent it, by Decaid's field names, kept while later reports are unavailable (available false), with utcOffsetMinutes, the tablet's offset, for a value whose times have none; null for one never reported. Its sharing status gives how many Library changes its tablet is due (waiting, null while it is written nothing), the last it applied, and those it refused, with Decaid's answer. Its Location History is oldest first, each entry from when it arrived there until the next. ${MACHINE_TIMES}`,
    inputSchema: z.object({ machineId }),
    outputSchema: machineOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
    budget: { whole: ["/machineSettings", "/tabletSettings"], rest: "The management interface shows the Machine whole." },
  })
  async getMachine({ machineId }: { machineId: string }): Promise<z.infer<typeof machineOutput>> {
    const id = readMachineId(machineId);
    const machine = await this.machines.get(id);
    const [workflow, settings, status, tabletVersions] = await Promise.all([
      this.events.currentWorkflow(id),
      Promise.all(SETTINGS.map((name) => this.collections.get(id, name))),
      sharingStatus(this.prisma, id),
      this.collections.tabletVersions(id),
    ]);
    const zone = zoneOf(machine);
    const [machineSettings, advancedSettings, machineCalibration, sensorCalibration, appSettings, presenceSettings] = settings.map((view) => collection(view, zone));
    return {
      machine: detailed(machine),
      workflow: workflow && { observedAt: zone(workflow.observedAt), receivedAt: zone(workflow.receivedAt), workflow: workflow.workflow },
      machineSettings: { machineSettings: machineSettings!, advancedSettings: advancedSettings!, machineCalibration: machineCalibration!, sensorCalibration: sensorCalibration! },
      tabletSettings: { appSettings: appSettings!, presenceSettings: presenceSettings! },
      sharingStatus: {
        waiting: status.waiting,
        lastApplied: status.lastApplied && { ...changeOf(status.lastApplied), appliedAt: zone(status.lastApplied.appliedAt) },
        refused: status.refused.map((refusal) => ({ ...changeOf(refusal), status: refusal.status, error: refusal.error, refusedAt: zone(refusal.refusedAt) })),
        unrecognisedLists: status.unrecognisedLists.map(({ list, since }) => ({ list, since: zone(since) })),
      },
      tabletVersions,
    };
  }

  @BudgetedTool({
    name: "get_machine_activity",
    title: "Get a Machine's activity",
    description: `What happened on one Machine over a time range, by its tablet's clock: its Workflow changes, its Loaded Recipes and its Machine States, each list latest first. Times are given with the offset of the Location it was at then. Each list counts what was in effect at any time in the range, so its last (oldest) entry, on its last page, may date from the range's start or before: what was in effect as it began. limit and offset page each list, and kinds asks for some of them alone. ${PAGED} Each Workflow change gives the parts of the Workflow the management interface shows: dose and yield in grams, brewTemperature in °C (its Profile's first step's), and steam, hot water and flush settings in °C, seconds, ml/s and ml. A Machine State lasts until the next one reported.`,
    inputSchema: activityInput,
    outputSchema: activityOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
    budget: { rest: "Asked for fewer at a time, or one kind of activity alone, it has more of each." },
  })
  async getMachineActivity(input: z.infer<typeof activityInput>): Promise<z.infer<typeof activityOutput>> {
    const machine = await this.machines.get(readMachineId(input.machineId));
    const range = { from: boundOf(input.from, machine, false), to: boundOf(input.to, machine, true) };
    // PostgreSQL has no year 0, and doesn't parse the six-digit year toISOString writes past 9999 or before 1.
    if ([range.from, range.to].some((end) => end && (end.getUTCFullYear() < 1 || end.getUTCFullYear() > 9999))) {
      throw new BadRequestException("Times must be in the years 1 to 9999, in UTC");
    }
    if (range.from && range.to && range.from >= range.to) throw new BadRequestException("Choose an end after the start");
    const { limit, offset } = input;
    const activity = await this.events.activity(machine.id, range, { limit, offset }, input.kinds ?? ACTIVITY_KINDS);
    const zone = zoneOf(machine);
    const paged = <T, R>(list: ActivityPage<T> | undefined, view: (entry: T) => R) =>
      list && { ...pageOf(list.total, offset, list.entries.length), entries: list.entries.map(view) };
    return {
      workflowChanges: paged(activity.workflowChanges, (event) => ({ observedAt: zone(event.observedAt), receivedAt: zone(event.receivedAt), workflow: workflowSummary(event.workflow) })),
      loadedRecipes: paged(activity.loadedRecipes, (entry) => loaded(entry, zone)),
      machineStates: paged(activity.machineStates, ({ state, substate, observedAt, receivedAt }) => ({ state, substate, observedAt: zone(observedAt), receivedAt: zone(receivedAt) })),
    };
  }

  @BudgetedTool({
    name: "list_settings_edits",
    title: "List a Machine's Settings Edits",
    description: `One Machine's Settings Edits, newest first: who made each and when, its fields' values before and after, and what came of it. ${SETTINGS_EDIT_NOTE} ${PAGED} ${MACHINE_TIMES}`,
    inputSchema: settingsEditsInput,
    outputSchema: settingsEditsOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
    budget: { whole: SETTINGS_EDIT_WHOLE.map((part) => `/settingsEdits/*${part}`), rest: "Asked for fewer at a time, it has more of each." },
  })
  async listSettingsEdits(input: z.infer<typeof settingsEditsInput>, context: McpContext): Promise<z.infer<typeof settingsEditsOutput>> {
    const { limit, offset } = input;
    const machine = await this.machines.get(readMachineId(input.machineId));
    const { settingsEdits, total } = await this.settingsEdits.list(machine.id, { limit, offset }, callerOf(context).scope);
    const zone = zoneOf(machine);
    return { ...pageOf(total, offset, settingsEdits.length), settingsEdits: settingsEdits.map((edit) => settingsEditOf(edit, zone)) };
  }
}

/** A Machine as get_machine gives it, apart from its Workflow, settings, sharing status and its tablet's versions. */
export function detailed(machine: MachineView): z.infer<typeof machineDetail> {
  const zone = zoneOf(machine);
  return {
    ...listed(machine, zone),
    serial: machine.serial,
    firmware: machine.reported?.firmware ?? null,
    pluginVersion: machine.pluginVersion,
    decaidVersion: machine.decaidVersion,
    locationHistory: machine.locationHistory.map((entry) => ({ location: locationOf(entry.location), effectiveFrom: zone(entry.effectiveFrom) })),
    sharing: machine.sharing,
    lastShot: machine.lastShot && { id: machine.lastShot.id, pulledAt: zoneMaybe(zone, machine.lastShot.pulledAt) },
  };
}

/** A Settings Edit as list_settings_edits gives it, its times with the offset of the Location its Machine was at then. */
export function settingsEditOf(edit: SettingsEditView, zone: Zone): z.infer<typeof settingsEditOutput> {
  const { id, collection, schedule, fields, expected, account, connectedApp, madeAt, sentAt, answeredAt, outcome, late, adjusted, refusal, readBack } = edit;
  return {
    id,
    collection,
    schedule,
    fields,
    expected,
    account,
    connectedApp,
    madeAt: zone(madeAt),
    sentAt: zoneMaybe(zone, sentAt),
    answeredAt: zoneMaybe(zone, answeredAt),
    outcome,
    late,
    adjusted,
    refusal,
    readBack,
  };
}

/** The collections holding a Machine's Machine Settings, then its tablet's Tablet Settings. */
const SETTINGS = ["machineSettings", "advancedSettings", "machineCalibration", "sensorCalibration", "appSettings", "presenceSettings"] as const;

/** A time the REST API gives, given again with the offset of the Location the Machine was at then. */
export type Zone = (at: string) => string;

/**
 * A Machine's times, each given with the offset of the time zone of the
 * Location it was at then, by its Location History, as a Shot's are with its
 * Location's (`zonedTime`), and UTC's while it was at none.
 */
export function zoneOf(machine: MachineView): Zone {
  return (at) => zonedTime(new Date(at), locationAt(machine, Date.parse(at))?.timeZone);
}

function zoneMaybe(zone: Zone, at: string | null): string | null {
  return at === null ? null : zone(at);
}

/** The Location the Machine was at, at a moment, by its Location History, oldest first; null before its first entry. */
function locationAt(machine: MachineView, at: number): LocationView | null {
  let found: LocationView | null = null;
  for (const entry of machine.locationHistory) {
    if (Date.parse(entry.effectiveFrom) > at) break;
    found = entry.location;
  }
  return found;
}

/**
 * A bound of a range of the Machine's activity as a moment: one given with
 * its offset as itself, and a date as when that day began at the Location
 * the Machine was at, or for an end the day after it, through its end, in
 * UTC while it was at none. The day's Location is the one it was at at noon
 * UTC that day, within the day nearly everywhere, which differs only on a
 * day it moved between time zones.
 */
function boundOf(bound: string | undefined, machine: MachineView, end: boolean): Date | null {
  if (bound === undefined) return null;
  if (!isDay(bound)) return new Date(bound);
  return startOfDay(bound, locationAt(machine, Date.parse(`${bound}T12:00:00Z`))?.timeZone, end ? 1 : 0);
}

function listed(machine: MachineView, zone: Zone): z.infer<typeof listedMachine> {
  return {
    id: machine.id,
    name: machine.name,
    model: machine.model,
    location: machine.location && locationOf(machine.location),
    online: machine.online,
    lastSeenAt: zoneMaybe(zone, machine.lastSeenAt),
    machineState: machine.machineState && { state: machine.machineState.state, substate: machine.machineState.substate, observedAt: zone(machine.machineState.observedAt) },
    loadedRecipe: machine.loadedRecipe && loaded(machine.loadedRecipe, zone),
    captureOnly: machine.captureOnly,
  };
}

function locationOf({ id, name, timeZone }: z.infer<typeof location>): z.infer<typeof location> {
  return { id, name, timeZone };
}

function loaded({ recipe, loadedAt, unloadedAt }: LoadedRecipeView, zone: Zone): z.infer<typeof loadedRecipe> {
  return {
    recipe: { id: recipe.id, name: recipe.name, slot: recipe.slot, locationId: recipe.locationId, archived: recipe.archived },
    loadedAt: zone(loadedAt),
    unloadedAt: zoneMaybe(zone, unloadedAt),
  };
}

function collection(view: CollectionView | null, zone: Zone): z.infer<typeof settingsCollection> {
  return (
    view && { available: view.available, reportedAt: zone(view.reportedAt), receivedAt: zoneMaybe(zone, view.receivedAt), value: view.value, utcOffsetMinutes: view.utcOffsetMinutes }
  );
}

function changeOf({ change, kind, item, localId }: ChangeView) {
  return { change, kind, item: item && { kind: item.kind, id: item.id, name: item.name }, localId };
}
