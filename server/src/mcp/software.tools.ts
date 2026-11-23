import { Injectable } from "@nestjs/common";
import type { McpContext } from "@nestjs/mcp";
import { SOFTWARE_ACTION_KINDS } from "@decent-sync/protocol";
import * as z from "zod";
import { READ } from "../connected-apps/oauth.js";
import { readMachineId } from "../machines/input.js";
import { MachinesService } from "../machines/machines.service.js";
import { type SoftwareActionView, SoftwareActionsService } from "../software-actions/software-actions.service.js";
import { TabletSoftwareService } from "../software-actions/tablet-software.service.js";
import { BudgetedTool } from "./budget.js";
import { type Zone, zoneOf } from "./machines.tools.js";
import { PAGED, page, pageOf, pageOutput } from "./paging.js";
import { callerOf } from "./token-verifier.js";

const machineId = z.string().describe("The Machine's id, as list_machines gives it.");
const time = z.string().describe("ISO 8601, with the offset of the time zone of the Location the Machine was at then, or UTC's while it was at none.");

const updates = z
  .object({
    how: z.enum(["followsReleases", "followsBranch", "pinned", "followsUrl", "comesWithDecaid", "notUpdated"]),
    repo: z.string().nullable().optional().describe("The GitHub repository it comes from, as owner/name."),
    branch: z.string().optional().describe("For followsBranch: the branch whose head it follows."),
    commit: z.string().nullable().optional().describe("For pinned: the commit it is held at."),
    url: z.string().nullable().optional().describe("For followsUrl, or a Skin pinned by a URL: the URL."),
  })
  .describe("How it updates, worked out from where Decaid says it was installed from.");

const softwareInput = z.object({ machineId });

const softwareOutput = z.object({
  decaid: z.object({
    version: z.string().nullable().describe("Decaid's release on the tablet, such as 0.9.3."),
    build: z.string().nullable(),
    update: z
      .object({
        phase: z.string().nullable().describe("idle, checking, available, downloading, installing or error, as Decaid names it."),
        latestVersion: z.string().nullable().describe("The newer release Decaid found, if any."),
        installable: z.boolean().describe("Whether Decaid can install it itself, with someone at the tablet confirming."),
        error: z.string().nullable(),
        reportedAt: time,
      })
      .nullable()
      .describe("Decaid's own update state as its tablet last reported it; null until it has."),
    automaticUpdateCheck: z.boolean().nullable().describe("Whether the tablet checks its plugins and Skins for updates by itself, every 12 hours; while off, nothing on it updates by itself."),
  }),
  plugins: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().nullable(),
        version: z.string().nullable(),
        state: z.enum(["enabled", "disabled", "notLoaded"]).describe("notLoaded: to load as Decaid starts, but not loaded now, as while it updates or where it failed to load."),
        updates,
        lastError: z.string().nullable().describe("What its latest update check said went wrong, in Decaid's words."),
        pendingUpdate: z
          .object({ version: z.string().nullable(), addedPermissions: z.array(z.string()) })
          .nullable()
          .describe("An update that waits for an Admin to approve the permissions it adds, in the management interface or on the tablet."),
        permissions: z.array(z.string()),
        own: z.boolean().describe("Whether it is Decent Sync's own plugin."),
        settings: z
          .array(
            z.object({
              name: z.string(),
              kind: z.enum(["text", "number", "switch", "choice"]),
              label: z.string(),
              description: z.string().nullable(),
              secret: z.boolean().describe("A secret's value is never reported: only whether one is set."),
              choices: z.array(z.string()),
              default: z.unknown(),
              value: z.unknown().optional().describe("What the tablet holds, given to Admins only: a value, null for none, or isSet for a secret."),
              changeable: z.boolean(),
            }),
          )
          .describe("The settings its manifest declares."),
      }),
    )
    .nullable()
    .describe("Every plugin on the tablet; null until its tablet reports them."),
  skins: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().nullable(),
        version: z.string().nullable(),
        default: z.boolean().describe("The Skin Decaid shows as it starts."),
        served: z.boolean().describe("Whether Decaid's Skin server serves it now."),
        updates,
      }),
    )
    .nullable()
    .describe("Every Skin on the tablet; null until its tablet reports them."),
  pluginMustUpdate: z.boolean().describe("Whether the tablet's plugin is from before Software Actions, so none can be made until it updates."),
});

const actionsInput = z.object({ machineId, ...page });

const softwareActionOutput = z.object({
  id: z.string(),
  kind: z.enum(SOFTWARE_ACTION_KINDS).or(z.string()).describe("What it did: installPlugin, enablePlugin, disablePlugin, changePluginSettings, checkPluginUpdates, approvePluginUpdate, removePlugin or checkDecaidUpdate."),
  params: z
    .object({
      plugin: z.object({ id: z.string(), name: z.string().nullable() }).optional().describe("The plugin it acted on."),
      repo: z.string().optional().describe("For an install: the GitHub repository."),
      branch: z.string().nullable().optional().describe("For an install: the branch or commit; null for the latest release."),
      version: z.string().optional().describe("For an approval: the version of the update approved."),
      addedPermissions: z.array(z.string()).optional().describe("For an approval: the permissions it added."),
      settings: z.array(z.string()).optional().describe("For a settings change: the names of the settings changed, never their values."),
    })
    .describe("What it named."),
  account: z.object({ id: z.string(), name: z.string().nullable().describe("Shown to Admins only.") }).nullable().describe("Who made it; null once the account is gone."),
  connectedApp: z
    .object({ id: z.string(), name: z.string(), host: z.string() })
    .nullable()
    .describe("The Connected App the account made it through; null for the management interface."),
  madeAt: time,
  sentAt: time.nullable(),
  answeredAt: time.nullable(),
  outcome: z.enum(["done", "refused", "notConfirmed"]).nullable().describe("What came of it: done; refused; or notConfirmed, no answer came in time, so the tablet's lists say what it holds. Null while awaited."),
  late: z.boolean().describe("Whether its outcome came from an answer after it was marked not confirmed."),
  refusal: z
    .discriminatedUnion("reason", [
      z.object({ reason: z.literal("machineBusy"), state: z.string().nullable() }),
      z.object({ reason: z.literal("changedSince"), message: z.string().nullable() }),
      z.object({ reason: z.literal("expired") }),
      z.object({ reason: z.literal("notAllowed"), message: z.string().nullable() }),
      z.object({ reason: z.literal("decaid"), status: z.number().int().nullable(), message: z.string().nullable() }),
    ])
    .nullable()
    .describe("Why it was refused: the Machine was busy, the tablet's software changed since, it waited too long, the plugin would not do it to itself, or Decaid refused it, in its own words."),
  result: z
    .object({
      pluginId: z.string().optional(),
      name: z.string().optional().describe("The plugin's name, as its tablet listed it."),
      version: z.string().optional().describe("The version installed afterwards."),
      loaded: z.boolean().optional(),
      results: z.array(z.object({ item: z.string(), status: z.string(), error: z.string().optional(), version: z.string().optional() })).optional().describe("An update check's result for each plugin: updated, alreadyCurrent, pendingApproval or failed."),
      decaid: z.record(z.string(), z.unknown()).optional().describe("Decaid's update state after a check for its own update."),
    })
    .nullable()
    .describe("What came of it, once done."),
});

const actionsOutput = z.object({ ...pageOutput, softwareActions: z.array(softwareActionOutput) });

/** A Software Action as list_software_actions gives it, its times with the offset of the Location its Machine was at then. */
export function softwareActionOf(action: SoftwareActionView, zone: Zone): z.infer<typeof softwareActionOutput> {
  const { id, kind, params, account, connectedApp, madeAt, sentAt, answeredAt, outcome, late, refusal, result } = action;
  return { id, kind, params, account, connectedApp, madeAt: zone(madeAt), sentAt: sentAt && zone(sentAt), answeredAt: answeredAt && zone(answeredAt), outcome, late, refusal, result };
}

/**
 * Reads of a Machine's Tablet Software and its Software Actions (ADR-0034).
 * An assistant reads them and makes none: a Software Action can put code on
 * a tablet, which ADR-0026 keeps out of the endpoint with what grants
 * access, as text an assistant reads may try to steer it.
 */
@Injectable()
export class SoftwareTools {
  constructor(
    private readonly machines: MachinesService,
    private readonly software: TabletSoftwareService,
    private readonly actions: SoftwareActionsService,
  ) {}

  @BudgetedTool({
    name: "get_machine_software",
    title: "Get a Machine's Tablet Software",
    description:
      "One Machine's Tablet Software, as its tablet last reported it: Decaid, with its version, the update it offers and whether its automatic update checks are on; every plugin, with its version, whether it is enabled, how it updates, any update that waits for approval with the permissions it adds, and the settings it declares; and every Skin, with its version, how it updates, which is the default and which is served. updates.how says what the tablet's next update check does to an item: followsReleases, a newer release of its repository is installed; followsBranch, the head of its branch is; pinned, it stays at its commit; followsUrl, a Skin is installed again once its URL serves something new; comesWithDecaid, a Skin Decaid may put its latest release back of as it starts; notUpdated, nothing. While automaticUpdateCheck is false nothing updates by itself. A setting's value is given to Admins only, and a secret's never: only whether it is set. Nothing here can be changed through an assistant: an Admin installs, enables, configures, updates and removes plugins on the Machine's Software tab in the management interface, as Software Actions, which list_software_actions lists.",
    inputSchema: softwareInput,
    outputSchema: softwareOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
    budget: { rest: "The management interface shows the Machine's Software tab whole." },
  })
  async getMachineSoftware(input: z.infer<typeof softwareInput>, context: McpContext): Promise<z.infer<typeof softwareOutput>> {
    const machine = await this.machines.get(readMachineId(input.machineId));
    const view = await this.software.get(machine.id, callerOf(context).scope);
    const zone = zoneOf(machine);
    return { ...view, decaid: { ...view.decaid, update: view.decaid.update && { ...view.decaid.update, reportedAt: zone(view.decaid.update.reportedAt) } } };
  }

  @BudgetedTool({
    name: "list_software_actions",
    title: "List a Machine's Software Actions",
    description: `One Machine's Software Actions, newest first: each thing an Admin asked its tablet to do to its plugins or to Decaid, with who asked, when, what it named and what came of it. kind: installPlugin, from a repository's latest release, or a branch or commit (params.repo, params.branch); enablePlugin, disablePlugin and removePlugin (params.plugin); changePluginSettings (params.settings, the names of the settings changed, never their values); checkPluginUpdates; approvePluginUpdate, of an update that waited on new permissions (params.version, params.addedPermissions); checkDecaidUpdate. Each is made once, while the tablet is connected and its Machine idle, and never kept for later. outcome: done, with result (the version installed, a result for each plugin checked, or Decaid's update state); refused, as refusal says why (machineBusy, the Machine was busy; changedSince, the tablet's software changed since; expired, it waited too long; notAllowed, Decent Sync's plugin never disables or removes itself, nor changes its own server address or Token; decaid, Decaid refused it, with its words); notConfirmed, no answer came in time, so get_machine_software says what the tablet holds; null while awaited. None can be made through an assistant. ${PAGED} Times are ISO 8601 with the offset of the time zone of the Location the Machine was at then, or UTC's while it was at none.`,
    inputSchema: actionsInput,
    outputSchema: actionsOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
    budget: { rest: "Asked for fewer at a time, it has more of each." },
  })
  async listSoftwareActions(input: z.infer<typeof actionsInput>, context: McpContext): Promise<z.infer<typeof actionsOutput>> {
    const { limit, offset } = input;
    const machine = await this.machines.get(readMachineId(input.machineId));
    const { softwareActions, total } = await this.actions.list(machine.id, { limit, offset }, callerOf(context).scope);
    const zone = zoneOf(machine);
    return { ...pageOf(total, offset, softwareActions.length), softwareActions: softwareActions.map((action) => softwareActionOf(action, zone)) };
  }
}
