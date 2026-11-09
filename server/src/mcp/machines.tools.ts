import { BadRequestException, Injectable } from "@nestjs/common";
import type { McpContext } from "@nestjs/mcp";
import { type CollectionName, PLUGIN_WORKFLOW_WRITES, SETTINGS_HISTORY_COLLECTIONS } from "@decent-sync/protocol";
import * as z from "zod";
import type { CollectionView } from "../collections/collections.service.js";
import { CollectionsService } from "../collections/collections.service.js";
import type { PairedDevicesView } from "../collections/paired-devices.js";
import { SettingsHistoryService } from "../collections/settings-history.service.js";
import { READ } from "../connected-apps/oauth.js";
import type { LocationView } from "../locations/locations.service.js";
import { type ChangeView, sharingStatus } from "../library/sharing-status.js";
import type { TrailEntry } from "../machine-events/dial-in-trail.js";
import type { LoadedRecipeView } from "../machine-events/loaded-recipes.js";
import { type ActivityKind, type ActivityPage, MachineEventsService } from "../machine-events/machine-events.service.js";
import { workflowSummary } from "../machine-events/workflow-summary.js";
import { readMachineId } from "../machines/input.js";
import { type MachineView, MachinesService } from "../machines/machines.service.js";
import { PrismaService } from "../prisma.service.js";
import { type SettingsEditView, SettingsEditsService } from "../settings-edits/settings-edits.service.js";
import { BudgetedTool } from "./budget.js";
import { PAGED, page, pageOf, pageOutput } from "./paging.js";
import { isDay, startOfDay, timeBound, zonedTime } from "./times.js";
import { callerOf } from "./token-verifier.js";
import { WORKFLOW_SUMMARY, workflowSummaryOutput } from "./workflow-summary.js";

const time = z.string().describe("ISO 8601, with the offset of the time zone of the Location the Machine was at then, or UTC's while it was at none.");
const tabletTime = z.string().describe("ISO 8601, with the offset of the time zone of the Location the Machine was at then, or UTC's while it was at none, by the tablet's clock.");

/** How a Machine's times read, for the descriptions of the tools that read Machines. */
const MACHINE_TIMES =
  "Times are ISO 8601 with the offset of the time zone of the Location the Machine was at then, by its Location History, or UTC's while it was at none; a Machine State's and a Loaded Recipe's times, and its Workflow's observedAt, are by its tablet's clock.";

/** What list_machines gives of each Machine, which get_machine gives too. */
const LISTED =
  "where it is now; online, whether its tablet's plugin is connected now, and lastSeenAt, its plugin's latest heartbeat or report; its last Machine State, as Decaid names its state and substate, such as espresso and pouring, or sleeping; its Loaded Recipe, the Recipe a barista last applied on it, with its Recipe Slot, 1 to 5, and unloadedAt null while still loaded; and captureOnly, why it is a Capture-only Machine, whose records are kept but which takes no part in the Library: noLocation, sharingOff, or empty while it takes part.";

/** What a date given for a bound of a Machine's activity means. */
const MACHINE_DAY = "A date, such as 2026-11-06, is that day at the Location the Machine was at, in its time zone, or in UTC while it was at none.";

const location = z.object({
  id: z.string(),
  name: z.string(),
  timeZone: z.string().describe("Its IANA time zone. A day at the Location is a day in this zone."),
});

const machineState = z
  .object({ state: z.string(), substate: z.string(), observedAt: tabletTime })
  .describe("A Machine State as Decaid names it, such as espresso and pouring, or sleeping, and when the plugin observed it.");

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
  lastSeenAt: time
    .nullable()
    .describe("When its plugin was last heard from, by the server's clock: the later of its latest heartbeat and the latest Workflow, Machine State or collection report the server received from it; null if never. online goes by the heartbeats alone."),
  machineState: machineState.nullable().describe("What it is doing: its last Machine State, null before any."),
  loadedRecipe: loadedRecipe.nullable(),
  captureOnly,
});

const machinesOutput = z.object({ machines: z.array(listedMachine) });

const settingsCollection = z
  .object({
    available: z.boolean().describe("Whether the latest report had a value; with at, true."),
    reportedAt: time.describe("When the latest report was received; with at, its value's receivedAt."),
    receivedAt: time.nullable().describe("When the value was received; null if no report has had one. With at, when the value last received by then was."),
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

/** What a Workflow change's cause and pluginWrite mean, for the descriptions of get_machine and get_machine_activity, as clients show the model those rather than the output schema. */
const WORKFLOW_CAUSE =
  "cause says who made a Workflow change: plugin, one of Decent Sync's own writes, which pluginWrite names; other, anyone else, such as a barista on Streamline, Streamline itself or DYE2, which can't be told apart; unknown, for one received before Decent Sync recorded this, or from a tablet whose plugin is older. pluginWrite is load, the Recipe the Workflow came to name loaded; loadedRecipe, an edit of the Loaded Recipe made elsewhere written into it; clear, the Recipe unloaded, or a grinder, batch or Basket the Location doesn't offer cleared; or steamOn, steam turned back on at the Loaded Recipe's steam temperature and time. A plugin change may also hold a change someone else made while Decent Sync's write was under way, as a barista turning steam back on is given as steamOn.";

/** What get_machine_activity's dial-in trail is, and how it folds and merges Workflow changes (dial-in-trail.ts). */
const DIAL_IN_TRAIL =
  "The dial-in trail is one list of its Recipes loaded and unloaded and what changed between them, by kind: inEffect, its last (oldest) entry, the Workflow in effect as the range began, whole (workflow); loaded, a Recipe loaded, with replaced, one unloaded as it loaded; unloaded; recipeUpdated, Decent Sync writing in an edit of the Loaded Recipe made elsewhere, whose own history says who made it; changed, any other. Each gives who made its first change, and loadedRecipe, the Recipe loaded, unloaded or updated, else the one loaded then; each but inEffect gives changes, each field of the summary that changed, before and after, a part's as steam.duration. A load or unload folds in the first change within 5 s after it, which made it, and in those 5 s Decent Sync's load writes, or for an unload changes of that one's cause; one with no change within 5 s, as on a Location join, is of cause unknown, a later change its own entry. Other changes of one cause and pluginWrite within 5 s of each other merge, a group spanning at most 30 s and never a load or unload; unknown ones, from before Decent Sync recorded who made them, fold and merge with each other by time alone. lastObservedAt is the last change an entry took after it began. An entry left with no field changed is dropped, except a load or unload. total counts the entries; cause keeps those of one cause, and inEffect, each before then as the changes left out left it.";

/** Who made a Workflow change, as get_machine and get_machine_activity give it (WORKFLOW_CAUSE). */
const workflowCause = {
  cause: z.enum(["plugin", "other", "unknown"]).describe("Who made it: Decent Sync itself (plugin), anyone else (other), or unknown."),
  pluginWrite: z
    .enum(PLUGIN_WORKFLOW_WRITES)
    .nullable()
    .describe("For a plugin change, Decent Sync's write; null for any other, or for a write this server doesn't name."),
};

const machineOutput = z.object({
  machine: machineDetail,
  workflow: z
    .object({
      observedAt: tabletTime,
      receivedAt: time,
      ...workflowCause,
      workflow: workflowSummaryOutput,
      raw: z.record(z.string(), z.unknown()).optional().describe("With raw, Decaid's Workflow, as sent, its numbers to hundredths."),
    })
    .nullable()
    .describe("Its Workflow: what it is set up to do next, as its tablet last reported it, summarised as get_machine_activity gives the one in effect as a range begins; null before any."),
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
  cause: z.enum(["plugin", "other", "unknown"]).optional().describe("Only the Workflow changes of this cause, with the one in effect as the range began; all if none."),
  ...page,
});

const activityPage = <T extends z.ZodType>(entry: T, what: string) => z.object({ ...pageOutput, entries: z.array(entry) }).optional().describe(what);

const trailRecipe = z.object({ id: z.string(), name: z.string().nullable() });

const trailEntry = z.object({
  kind: z.enum(["inEffect", "loaded", "unloaded", "recipeUpdated", "changed"]),
  observedAt: tabletTime.describe("When it began: the load's or unload's time, or its first change's."),
  lastObservedAt: tabletTime.optional().describe("When it took a change after it began, the last one's time."),
  ...workflowCause,
  loadedRecipe: trailRecipe.nullable().describe("The Recipe loaded, unloaded or updated; for any other, its Loaded Recipe then, null for none."),
  replaced: trailRecipe.optional().describe("For loaded, the Recipe unloaded as it loaded."),
  workflow: workflowSummaryOutput.optional().describe("For inEffect, the Workflow summarised whole."),
  changes: z
    .array(z.object({ field: z.string(), before: z.union([z.string(), z.number(), z.null()]), after: z.union([z.string(), z.number(), z.null()]) }))
    .optional()
    .describe("For any other, each field of the summary that changed, before and after, a part's as steam.duration."),
});

const activityOutput = z.object({
  workflowChanges: activityPage(
    trailEntry,
    "Its dial-in trail, latest first: its Recipes loaded and unloaded and what changed between them, the last (oldest) entry the Workflow in effect as the range began.",
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
  "Each changes one collection: machineSettings, advancedSettings, machineCalibration or sensorCalibration (Machine Settings), or appSettings or presenceSettings (Tablet Settings). fields are the values it sets, by Decaid's names and in its units, sleepTimeoutMinutes and a wake schedule's keepAwakeFor in minutes, expected each field's value as last reported when it was made, and readBack its fields as read back after the write. outcome: applied; adjusted, stored otherwise by the Machine, as adjusted lists; refused, as refusal says why (machineBusy, the Machine was busy; changedSince, its settings changed since; expired, it waited too long; decaid, Decaid refused it); notConfirmed, no answer came in time; null while awaited. late: its outcome came from an answer after it was marked not confirmed.";

/** The parts of a Settings Edit that are settings, which are never cut. */
export const SETTINGS_EDIT_WHOLE = ["/fields", "/expected", "/readBack", "/adjusted", "/refusal/current"] as const;

const settingsEditsOutput = z.object({ ...pageOutput, settingsEdits: z.array(settingsEditOutput) });

const machineInput = z.object({
  machineId,
  at: z.iso
    .datetime({ offset: true, error: "Enter at as a time with its seconds and offset, such as 2026-11-06T14:30:00-05:00" })
    .optional()
    .describe("A moment, with its offset, such as 2026-11-06T14:30:00-05:00, to give its Machine Settings and Tablet Settings as last received at or before; none for as now."),
  raw: z.boolean().default(false).describe("Whether to give its Workflow whole too, as Decaid sent it, its Profile included and its numbers to hundredths, beside the summary."),
});

/** What get_machine gives with a time. */
const AS_OF =
  "With at, its Machine Settings and Tablet Settings are each as last received at or before then, by its Settings History, available true and reportedAt its receivedAt, when that value was received; null for one none was received of by then, or none kept: a Settings History begins with the value held as it was first kept, dated when that value was last reported, so earlier times give null though the Machine had settings. A change is received about 30 to 60 s after it was made, later while the Machine was busy, and within a day for the sensor calibration, and what a Settings History compares none of, such as the tablet's battery, may have changed since without being kept. Everything else, its Workflow included, is as now: get_machine_activity gives its Workflow then.";

/** The collections a Settings History keeps, for the descriptions of the tools that read one. */
const HISTORY_COLLECTIONS =
  "collection: machineSettings, advancedSettings, machineCalibration (its flow calibration) and sensorCalibration are its Machine Settings; appSettings, and presenceSettings, when it sleeps and wakes, its tablet's Tablet Settings; plugins and skins, Decaid's plugins and Skins; pairedDevices, the devices paired with its tablet; scaleInfo, its scale's firmware; sensors, its sensors.";

/** What a Settings History compares none of, which is never a change. */
const LEFT_OUT =
  "Never a change, as left out of what is compared: the Workflow's steam, hot water and flush settings and the tank temperature, whose changes get_machine_activity gives as Workflow changes, the USB charger, the tablet's battery, the wake schedules' keep-awake end, the scale's battery, and the update checks Decaid makes of plugins.";

const historyInput = z.object({
  machineId,
  from: timeBound("The range's start, by when each change was received; none for since the first.", MACHINE_DAY),
  to: timeBound("The range's end, not included, or through the end of a day given as a date; none for until now.", MACHINE_DAY),
  collections: z.array(z.enum(SETTINGS_HISTORY_COLLECTIONS)).min(1).optional().describe("Which collections' changes to list; every one if none."),
  includeBrief: z.boolean().default(false).describe("Whether to list brief changes too, each changed from outside Decent Sync and changed back within about 2 minutes."),
  ...page,
});

/** The collections get_machine_reports gives: what a Machine's tablet reports beside its settings and its Library's lists. */
const REPORTS = ["scaleInfo", "sensors", "pairedDevices", "plugins", "skins"] as const satisfies readonly CollectionName[];

const reportsInput = z.object({
  machineId,
  collections: z
    .array(z.enum(REPORTS, { error: (issue) => `No such collection as ${JSON.stringify(issue.input)}: name scaleInfo, sensors, pairedDevices, plugins or skins` }))
    .min(1)
    .optional()
    .describe("Which collections to give; all five if none."),
});

const report = z
  .object({
    available: z.boolean().describe("Whether the latest report had a value: false while, say, no scale is connected."),
    reportedAt: time.describe("When the latest report, available or not, was received."),
    receivedAt: time.nullable().describe("When its value was received; null if no report has had one."),
    value: z.unknown().describe("The latest value reported, as Decaid sent it, its fields as Decaid names them and its numbers to hundredths, kept while later reports are unavailable; null if none has had one."),
  })
  .nullable();

const pairedDevice = z.object({
  id: z.string().describe("Decaid's id for it, such as a Bluetooth address."),
  type: z.string().nullable().describe("Decaid's kind of device: machine, scale, sensor or grinder."),
  model: z.string().nullable().describe("As Decaid names it, which names its model, such as Bookoo Mini Scale."),
  vendor: z.string().nullable().describe("A sensor's vendor, from its manifest."),
  state: z.string().nullable().describe("Its connection state when last reported, such as connected or disconnected."),
  firmware: z.string().nullable().describe("For the connected scale, its firmware, if it reports it."),
  batteryLevel: z.number().nullable().describe("For the connected scale, its battery level as a percentage, if it reports it."),
});

const pairedDevices = z.object({
  reportedAt: time.nullable().describe("When its tablet last reported them, whether or not it could read them then; null if it never has."),
  available: z.boolean().nullable().describe("Whether it could read them then. If not, the devices given are those it read before, with their state then."),
  receivedAt: time.nullable().describe("When the devices given were read; null if it has never read them."),
  scale: pairedDevice.nullable().describe("The Scale that weighs Shots: the one Decaid has connected as its primary scale, or else the scale it prefers."),
  auxiliaryScale: pairedDevice.nullable().describe("An Auxiliary Scale Decaid has connected, such as for weighing ground coffee."),
  sensors: z.array(pairedDevice),
  others: z.array(pairedDevice).describe("Every other paired device, such as the machine itself or another scale Decaid remembers."),
});

const reportsOutput = z.object({
  scaleInfo: report.optional(),
  sensors: report.optional(),
  pairedDevices: pairedDevices.optional().describe("Its paired devices, as the management interface's Paired devices card shows them."),
  plugins: report.optional(),
  skins: report.optional(),
});

/** What each collection get_machine_reports gives is, and how its report reads (docs/COLLECTIONS.md). */
const REPORTS_NOTE =
  `scaleInfo is the connected scale's own report, such as its firmwareVersion and batteryLevel, which only some scales give, unavailable while none is connected; sensors, the sensors Decaid lists as connected, each by its id with its manifest (info): its name, vendor, data and commands; plugins, Decaid's plugin list, each plugin's manifest, such as its id, name and version, with loaded, autoLoad, source, how it was installed, such as {"kind":"github_branch","branch":"dist"}, or null for a bundled one, and pendingUpdate; skins, Decaid's Skins as {skins, default, server}: those installed, each with its id, name, version and path, the default Skin, null with none installed, and the WebUI server's status, whose path is the Skin it serves, null while it serves nothing. Each of these four is as Decaid sent it, by Decaid's names, its numbers to hundredths: available false when the latest read had nothing, the value read before kept; reportedAt when the latest report was received, receivedAt when its value was; null for one never reported. pairedDevices are the devices paired with its tablet, leaving out those only discovered nearby, as the management interface's Paired devices card shows them: the Scale that weighs Shots, the one Decaid has connected as primary or else the one it prefers; an Auxiliary Scale; its sensors; and others, such as the machine itself; each with its model as Decaid names it, its connection state when last reported and a sensor's vendor, the connected scale with the firmware and battery level scaleInfo gives, if any; reportedAt, available and receivedAt as for the others, null if never reported. Each is the latest reported: list_settings_history gives each change of them, and get_machine the DYE2 and Streamline among them.`;

const historyOutput = z.object({
  ...pageOutput,
  changes: z.array(
    z.object({
      id: z.string().describe("The id of the value that changed; a read-back holding changes of its Settings Edit and from outside it gives two changes of this id."),
      receivedAt: time.describe("When the server received it."),
      collection: z.enum(SETTINGS_HISTORY_COLLECTIONS),
      settingsEdit: z
        .object({
          id: z.string(),
          account: z.object({ id: z.string(), name: z.string().nullable().describe("Shown to Admins only.") }).nullable().describe("Who made it; null once the account is gone."),
          connectedApp: z
            .object({ id: z.string(), name: z.string().describe("The name the app gave itself."), host: z.string().describe("The host of its client id, which the app can't choose.") })
            .nullable()
            .describe("The Connected App the account made it through; null for the management interface."),
        })
        .nullable()
        .describe("The Settings Edit that made these changes; null for changes made outside Decent Sync, tied to no person."),
      fields: z.array(
        z.object({
          field: z.string().describe("A field as Decaid names it; schedules/ and its id for a wake schedule; a target for the sensor calibration; an id for a plugin, paired device or sensor."),
          change: z.enum(["added", "changed", "removed"]),
          before: z.unknown().describe("As compared; null where absent."),
          after: z.unknown().describe("As compared; null where absent."),
          backAt: time.nullable().describe("For a brief change, when it changed back to before; null for any other."),
        }),
      ),
    }),
  ),
});

/**
 * Machines, read through an assistant as the REST API reads them, calling
 * the same services (ADR-0026): which are online and what each is doing, how
 * one is set up, what its tablet reports, what happened on it over a time
 * range, and its Settings Edits. Every account reads every Machine, as
 * through the REST API; who made a Settings Edit is named as the REST API
 * names it to the account.
 */
@Injectable()
export class MachinesTools {
  constructor(
    private readonly machines: MachinesService,
    private readonly events: MachineEventsService,
    private readonly collections: CollectionsService,
    private readonly history: SettingsHistoryService,
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
    description: `One Machine: its Workflow, Machine Settings, its tablet's Tablet Settings, its Location History, its sharing status, and the versions on its tablet, besides what list_machines gives: ${LISTED} Its Workflow, what it is set up to do next, with who made its latest change, is summarised; raw adds it whole, as Decaid sent it. ${WORKFLOW_SUMMARY} ${WORKFLOW_CAUSE} Its Machine Settings (machineSettings, advancedSettings, machineCalibration, its flow calibration, and sensorCalibration) and its tablet's Tablet Settings (appSettings, and presenceSettings, when it sleeps and wakes) are each as Decaid sent it, by Decaid's field names and in its units, as edit_machine_settings lists them, sleepTimeoutMinutes and a wake schedule's keepAwakeFor in minutes, kept while later reports are unavailable (available false), with utcOffsetMinutes, the tablet's offset, for a value whose times have none; null for one never reported. ${AS_OF} Its sharing status gives how many Library changes its tablet is due (waiting, null while it is written nothing), the last it applied, and those it refused, with Decaid's answer. Its Location History is oldest first, each entry from when it arrived there until the next. ${MACHINE_TIMES}`,
    inputSchema: machineInput,
    outputSchema: machineOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
    budget: { whole: ["/machineSettings", "/tabletSettings"], rest: "Its Workflow is far longer asked for whole with raw; the management interface shows the Machine whole." },
  })
  async getMachine({ machineId, at, raw }: z.infer<typeof machineInput>): Promise<z.infer<typeof machineOutput>> {
    const id = readMachineId(machineId);
    const machine = await this.machines.get(id);
    const asOf = at === undefined ? undefined : new Date(at);
    if (asOf && (asOf.getUTCFullYear() < 1 || asOf.getUTCFullYear() > 9999)) throw new BadRequestException("Times must be in the years 1 to 9999, in UTC");
    const [workflow, settings, status, tabletVersions] = await Promise.all([
      this.events.currentLinkedWorkflow(id),
      asOf ? this.history.asOf(id, SETTINGS, asOf).then((views) => SETTINGS.map((name) => views[name])) : Promise.all(SETTINGS.map((name) => this.collections.get(id, name))),
      sharingStatus(this.prisma, id),
      this.collections.tabletVersions(id),
    ]);
    const zone = zoneOf(machine);
    const [machineSettings, advancedSettings, machineCalibration, sensorCalibration, appSettings, presenceSettings] = settings.map((view) => collection(view, zone));
    return {
      machine: detailed(machine),
      workflow: workflow && {
        observedAt: zone(workflow.observedAt),
        receivedAt: zone(workflow.receivedAt),
        cause: workflow.cause,
        pluginWrite: workflow.pluginWrite,
        workflow: workflowSummary(workflow.workflow, workflow.links),
        ...(raw && { raw: workflow.workflow }),
      },
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
    name: "get_machine_reports",
    title: "Get what a Machine's tablet reports",
    description: `What one Machine's tablet last reported besides its settings and its Library: its scale, sensors, paired devices, plugins and Skins, each collection asked for, all five if none. ${REPORTS_NOTE} Times are ISO 8601 with the offset of the time zone of the Location the Machine was at then, or UTC's while it was at none.`,
    inputSchema: reportsInput,
    outputSchema: reportsOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
    budget: { rest: "Asked for one collection at a time, it has more of each." },
  })
  async getMachineReports({ machineId, collections }: z.infer<typeof reportsInput>): Promise<z.infer<typeof reportsOutput>> {
    const machine = await this.machines.get(readMachineId(machineId));
    const zone = zoneOf(machine);
    const asked = REPORTS.filter((name) => collections === undefined || collections.includes(name));
    const reports = await Promise.all(
      asked.map(async (name) =>
        name === "pairedDevices" ? pairedDevicesOf(await this.collections.pairedDevices(machine.id), zone) : reportOf(await this.collections.get(machine.id, name), zone),
      ),
    );
    return Object.fromEntries(asked.map((name, n) => [name, reports[n]]));
  }

  @BudgetedTool({
    name: "get_machine_activity",
    title: "Get a Machine's activity",
    description: `What happened on one Machine over a time range, by its tablet's clock: its Workflow changes as a dial-in trail, its Loaded Recipes and its Machine States, each list latest first. Times are given with the offset of the Location it was at then. Each list counts what was in effect at any time in the range, so its last (oldest) entry, on its last page, may date from the range's start or before: what was in effect as it began. limit and offset page each list, and kinds asks for some of them alone. ${PAGED} ${DIAL_IN_TRAIL} ${WORKFLOW_SUMMARY} ${WORKFLOW_CAUSE} A Machine State lasts until the next one reported.`,
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
    const activity = await this.events.activity(machine.id, range, { limit, offset }, input.kinds ?? ACTIVITY_KINDS, { cause: input.cause });
    const zone = zoneOf(machine);
    const paged = <T, R>(list: ActivityPage<T> | undefined, view: (entry: T) => R) =>
      list && { ...pageOf(list.total, offset, list.entries.length), entries: list.entries.map(view) };
    return {
      workflowChanges: paged(activity.workflowChanges, (entry) => trailEntryOf(entry, zone)),
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

  @BudgetedTool({
    name: "list_settings_history",
    title: "List a Machine's Settings History",
    description: `One Machine's Settings History, newest first: each change of what its tablet reported for its Machine Settings, Tablet Settings, plugins, Skins, paired devices, scale and sensors, whatever made it. ${HISTORY_COLLECTIONS} Each change gives each field changed, before and after, as compared: by Decaid's field names and in its units, as get_machine gives them; a wake schedule as schedules/ and its id, added, changed or removed, with its time, daysOfWeek, enabled and keepAwakeFor in minutes; the sensor calibration by target (flow, pressure, temperature), its measured value; a plugin, paired device or sensor by its id, a paired device without how it is connected now. ${LEFT_OUT} settingsEdit is the Settings Edit that made the change, by its id in list_settings_edits, with who made it, named to Admins only; null for a change made outside Decent Sync, on the tablet, by another app or by the machine itself, which is tied to no person. A read-back of an edit that also holds changes made outside it gives two changes of one id. receivedAt is when the server received the change: about 30 to 60 s after it was made, later while the Machine was busy, and within a day for the sensor calibration. The first value of each collection, where its history begins, is no change: get_machine with at gives it for the Machine Settings and Tablet Settings. Brief changes, a field changed from outside Decent Sync and changed back within about 2 minutes, such as the refill kit Decaid shows on automatic after the machine reconnects, or a scale left out of the paired devices while it connects, are left out unless includeBrief, and then are one change with backAt, when it changed back. ${PAGED} Times are ISO 8601 with the offset of the time zone of the Location the Machine was at then, or UTC's while it was at none.`,
    inputSchema: historyInput,
    outputSchema: historyOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
    budget: {
      whole: ["field", "before", "after"].map((part) => `/changes/*/fields/*/${part}`),
      rest: "Asked for fewer at a time, or for one collection, it has more of each.",
    },
  })
  async listSettingsHistory(input: z.infer<typeof historyInput>, context: McpContext): Promise<z.infer<typeof historyOutput>> {
    const { limit, offset } = input;
    const machine = await this.machines.get(readMachineId(input.machineId));
    const range = { from: boundOf(input.from, machine, false), to: boundOf(input.to, machine, true) };
    if ([range.from, range.to].some((end) => end && (end.getUTCFullYear() < 1 || end.getUTCFullYear() > 9999))) {
      throw new BadRequestException("Times must be in the years 1 to 9999, in UTC");
    }
    if (range.from && range.to && range.from >= range.to) throw new BadRequestException("Choose an end after the start");
    const filters = { collections: input.collections, from: range.from ?? undefined, to: range.to ?? undefined, includeBrief: input.includeBrief };
    const { changes, total } = await this.history.changes(machine.id, filters, { limit, offset }, callerOf(context).scope);
    const zone = zoneOf(machine);
    return {
      ...pageOf(total, offset, changes.length),
      changes: changes.map(({ id, receivedAt, collection, settingsEdit, fields }) => ({
        id,
        receivedAt: zone(receivedAt),
        collection,
        settingsEdit,
        fields: fields.map((field) => ({ ...field, backAt: zoneMaybe(zone, field.backAt) })),
      })),
    };
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

/** An entry of a Machine's dial-in trail as get_machine_activity gives it: what applies to its kind alone, its times with the offset of the Location it was at then. */
function trailEntryOf(entry: TrailEntry, zone: Zone): z.infer<typeof trailEntry> {
  const { kind, observedAt, lastObservedAt, cause, pluginWrite, loadedRecipe, replaced, workflow, changes } = entry;
  return {
    kind,
    observedAt: zone(observedAt),
    ...(lastObservedAt !== null && { lastObservedAt: zone(lastObservedAt) }),
    cause,
    pluginWrite,
    loadedRecipe,
    ...(replaced !== null && { replaced }),
    ...(workflow !== null ? { workflow } : { changes }),
  };
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

/** A collection get_machine_reports gives, with the REST API's available, reportedAt, receivedAt and value, its times with the offset of the Location the Machine was at then; null if never reported. */
function reportOf(view: CollectionView | null, zone: Zone): z.infer<typeof report> {
  return view && { available: view.available, reportedAt: zone(view.reportedAt), receivedAt: zoneMaybe(zone, view.receivedAt), value: view.value };
}

/** A Machine's paired devices as the REST API and the Machine page give them, their times with the offset of the Location the Machine was at then. */
function pairedDevicesOf({ reportedAt, available, receivedAt, scale, auxiliaryScale, sensors, others }: PairedDevicesView, zone: Zone): z.infer<typeof pairedDevices> {
  return { reportedAt: zoneMaybe(zone, reportedAt), available, receivedAt: zoneMaybe(zone, receivedAt), scale, auxiliaryScale, sensors, others };
}

function changeOf({ change, kind, item, localId }: ChangeView) {
  return { change, kind, item: item && { kind: item.kind, id: item.id, name: item.name }, localId };
}
