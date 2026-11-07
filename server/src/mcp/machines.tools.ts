import { BadRequestException, Injectable } from "@nestjs/common";
import { type McpContext, Tool } from "@nestjs/mcp";
import * as z from "zod";
import type { CollectionView } from "../collections/collections.service.js";
import { CollectionsService } from "../collections/collections.service.js";
import { READ } from "../connected-apps/oauth.js";
import { type ChangeView, sharingStatus } from "../library/sharing-status.js";
import type { LoadedRecipeView } from "../machine-events/loaded-recipes.js";
import { type ActivityKind, MachineEventsService } from "../machine-events/machine-events.service.js";
import { readMachineId } from "../machines/input.js";
import { type MachineView, MachinesService } from "../machines/machines.service.js";
import { PrismaService } from "../prisma.service.js";
import { SettingsEditsService } from "../settings-edits/settings-edits.service.js";
import { pageInput, pageOf } from "./paging.js";
import { callerOf } from "./token-verifier.js";
import { workflowSummary, workflowSummaryOutput } from "./workflow-summary.js";

const time = z.string().describe("ISO 8601, in UTC.");
const tabletTime = z.string().describe("ISO 8601, in UTC, by the tablet's clock.");

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

const machineOutput = z.object({
  machine: listedMachine.extend({
    serial: z.string().nullable(),
    firmware: z.string().nullable().describe("The firmware its latest connection reported."),
    pluginVersion: z.string().nullable().describe("The Decent Sync plugin's version on its tablet, as its latest connection reported it."),
    decaidVersion: z.string().nullable(),
    locationHistory: z
      .array(z.object({ location, effectiveFrom: time.describe("When it arrived there. It stayed until the next entry's time.") }))
      .describe("Where it has been, oldest first."),
    sharing: z.boolean().describe("Whether it shares the Library at its Location: on unless an Admin turned it off."),
    lastShot: z.object({ id: z.string(), pulledAt: tabletTime.nullable() }).nullable(),
  }),
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

const machineId = z.string().describe("The Machine's id, as list_machines gives it.");

const ACTIVITY_KINDS = ["workflowChanges", "loadedRecipes", "machineStates"] as const satisfies readonly ActivityKind[];

const activityInput = z.object({
  machineId,
  from: z.iso.datetime({ offset: true }).optional().describe("The range's start, ISO 8601 with an offset, such as 2026-11-07T06:00:00-05:00. None for since the first."),
  to: z.iso.datetime({ offset: true }).optional().describe("The range's end, not included. None for until now."),
  kinds: z.array(z.enum(ACTIVITY_KINDS)).min(1).optional().describe("Which lists to give; all three if none."),
  ...pageInput,
});

const activityPage = <T extends z.ZodType>(entry: T, what: string) =>
  z.object({ entries: z.array(entry), more: z.boolean().describe("Whether more follow, at a higher offset.") }).optional().describe(what);

const activityOutput = z.object({
  workflowChanges: activityPage(
    z.object({ observedAt: tabletTime, receivedAt: time, workflow: workflowSummaryOutput }),
    "Its Workflow each time it changed, latest first, each what it was set up to do next from then; the last, the oldest, is the one in effect as the range began.",
  ),
  loadedRecipes: activityPage(loadedRecipe, "Each Recipe loaded at any time in the range, latest loaded first."),
  machineStates: activityPage(
    z.object({ state: z.string(), substate: z.string(), observedAt: tabletTime, receivedAt: time }),
    "Each Machine State it went into, latest first, each until the next one reported; the last, the oldest, is the one it was in as the range began. Nothing is reported while its tablet is offline.",
  ),
});

const settingsEditsInput = z.object({ machineId, ...pageInput });

const settingsEditsOutput = z.object({
  settingsEdits: z.array(
    z.object({
      id: z.string(),
      collection: z.string().describe("The settings it changes: machineSettings, advancedSettings, machineCalibration or sensorCalibration (Machine Settings), or appSettings or presenceSettings (Tablet Settings)."),
      schedule: z.object({ action: z.enum(["add", "change", "delete"]), id: z.string().nullable() }).nullable().describe("The wake schedule it adds, changes or deletes, if it does."),
      fields: z.record(z.string(), z.unknown()).describe("Each field it sets, as Decaid names it, with its new value."),
      expected: z.record(z.string(), z.unknown()).describe("Each field's value as last reported when it was made."),
      account: z
        .object({ id: z.string(), name: z.string().nullable().describe("Shown to Admins only.") })
        .nullable()
        .describe("Who made it; null once the account is gone."),
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
    }),
  ),
  more: z.boolean().describe("Whether more follow, at a higher offset."),
});

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

  @Tool({
    name: "list_machines",
    title: "List Machines",
    description: "Lists every Machine, by name: where it is, whether it is online, its last Machine State, its Loaded Recipe, and whether it is capture-only.",
    outputSchema: machinesOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
  })
  async listMachines(): Promise<z.infer<typeof machinesOutput>> {
    return { machines: (await this.machines.list()).map(listed) };
  }

  @Tool({
    name: "get_machine",
    title: "Get a Machine",
    description:
      "One Machine: its Workflow, Machine Settings, its tablet's Tablet Settings, its Location History, its sharing status, and the versions on its tablet, besides what list_machines gives.",
    inputSchema: z.object({ machineId }),
    outputSchema: machineOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
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
    const [machineSettings, advancedSettings, machineCalibration, sensorCalibration, appSettings, presenceSettings] = settings.map(collection);
    return {
      machine: {
        ...listed(machine),
        serial: machine.serial,
        firmware: machine.reported?.firmware ?? null,
        pluginVersion: machine.pluginVersion,
        decaidVersion: machine.decaidVersion,
        locationHistory: machine.locationHistory.map((entry) => ({ location: locationOf(entry.location), effectiveFrom: entry.effectiveFrom })),
        sharing: machine.sharing,
        lastShot: machine.lastShot,
      },
      workflow: workflow && { observedAt: workflow.observedAt, receivedAt: workflow.receivedAt, workflow: workflow.workflow },
      machineSettings: { machineSettings: machineSettings!, advancedSettings: advancedSettings!, machineCalibration: machineCalibration!, sensorCalibration: sensorCalibration! },
      tabletSettings: { appSettings: appSettings!, presenceSettings: presenceSettings! },
      sharingStatus: {
        waiting: status.waiting,
        lastApplied: status.lastApplied && { ...changeOf(status.lastApplied), appliedAt: status.lastApplied.appliedAt },
        refused: status.refused.map((refusal) => ({ ...changeOf(refusal), status: refusal.status, error: refusal.error, refusedAt: refusal.refusedAt })),
        unrecognisedLists: status.unrecognisedLists,
      },
      tabletVersions,
    };
  }

  @Tool({
    name: "get_machine_activity",
    title: "Get a Machine's activity",
    description:
      "What happened on one Machine over a time range, by its tablet's clock: its Workflow changes, its Loaded Recipes and its Machine States, each list latest first. Each list counts what was in effect at any time in the range, so its last (oldest) entry, on its last page, is what was in effect as the range began. limit and offset page each list.",
    inputSchema: activityInput,
    outputSchema: activityOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
  })
  async getMachineActivity(input: z.infer<typeof activityInput>): Promise<z.infer<typeof activityOutput>> {
    const id = readMachineId(input.machineId);
    const range = { from: input.from === undefined ? null : new Date(input.from), to: input.to === undefined ? null : new Date(input.to) };
    // PostgreSQL has no year 0, which an ISO 8601 time may name.
    if ([range.from, range.to].some((end) => end && end.getUTCFullYear() < 1)) throw new BadRequestException("Times must be in the year 1 or later");
    if (range.from && range.to && range.from >= range.to) throw new BadRequestException("The range's start must be before its end");
    const activity = await this.events.activity(id, range, pageOf(input), input.kinds ?? ACTIVITY_KINDS);
    return {
      workflowChanges: activity.workflowChanges && {
        entries: activity.workflowChanges.entries.map((event) => ({ observedAt: event.observedAt, receivedAt: event.receivedAt, workflow: workflowSummary(event.workflow) })),
        more: activity.workflowChanges.more,
      },
      loadedRecipes: activity.loadedRecipes && { entries: activity.loadedRecipes.entries.map(loaded), more: activity.loadedRecipes.more },
      machineStates: activity.machineStates && {
        entries: activity.machineStates.entries.map(({ state, substate, observedAt, receivedAt }) => ({ state, substate, observedAt, receivedAt })),
        more: activity.machineStates.more,
      },
    };
  }

  @Tool({
    name: "list_settings_edits",
    title: "List a Machine's Settings Edits",
    description: "One Machine's Settings Edits, newest first: who made each and when, its fields' values before and after, and what came of it.",
    inputSchema: settingsEditsInput,
    outputSchema: settingsEditsOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
  })
  async listSettingsEdits(input: z.infer<typeof settingsEditsInput>, context: McpContext): Promise<z.infer<typeof settingsEditsOutput>> {
    const page = pageOf(input);
    const { settingsEdits, total } = await this.settingsEdits.list(readMachineId(input.machineId), page, callerOf(context).scope);
    return {
      settingsEdits: settingsEdits.map(({ id, collection, schedule, fields, expected, account, madeAt, sentAt, answeredAt, outcome, late, adjusted, refusal, readBack }) => ({
        id,
        collection,
        schedule,
        fields,
        expected,
        account,
        madeAt,
        sentAt,
        answeredAt,
        outcome,
        late,
        adjusted,
        refusal,
        readBack,
      })),
      more: page.offset + settingsEdits.length < total,
    };
  }
}

/** The collections holding a Machine's Machine Settings, then its tablet's Tablet Settings. */
const SETTINGS = ["machineSettings", "advancedSettings", "machineCalibration", "sensorCalibration", "appSettings", "presenceSettings"] as const;

function listed(machine: MachineView): z.infer<typeof listedMachine> {
  return {
    id: machine.id,
    name: machine.name,
    model: machine.model,
    location: machine.location && locationOf(machine.location),
    online: machine.online,
    lastSeenAt: machine.lastSeenAt,
    machineState: machine.machineState && { state: machine.machineState.state, substate: machine.machineState.substate, observedAt: machine.machineState.observedAt },
    loadedRecipe: machine.loadedRecipe && loaded(machine.loadedRecipe),
    captureOnly: machine.captureOnly,
  };
}

function locationOf({ id, name, timeZone }: z.infer<typeof location>): z.infer<typeof location> {
  return { id, name, timeZone };
}

function loaded({ recipe, loadedAt, unloadedAt }: LoadedRecipeView): z.infer<typeof loadedRecipe> {
  return { recipe: { id: recipe.id, name: recipe.name, slot: recipe.slot, locationId: recipe.locationId, archived: recipe.archived }, loadedAt, unloadedAt };
}

function collection(view: CollectionView | null): z.infer<typeof settingsCollection> {
  return view && { available: view.available, reportedAt: view.reportedAt, receivedAt: view.receivedAt, value: view.value, utcOffsetMinutes: view.utcOffsetMinutes };
}

function changeOf({ change, kind, item, localId }: ChangeView) {
  return { change, kind, item: item && { kind: item.kind, id: item.id, name: item.name }, localId };
}
