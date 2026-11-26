import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import {
  DECENT_SYNC_PLUGIN_ID,
  DECENT_SYNC_REPO,
  MAX_SOFTWARE_ACTION_MS,
  MISSED_HEARTBEATS,
  OWN_CHANGEABLE_SETTING,
  type SoftwareActed,
  type SoftwareActedRefusal,
  type SoftwareAction,
  type SoftwareActionKind,
  type SoftwareActionResult,
  type SourceSeen,
  isSkinViewKind,
  isSoftwareActionKind,
  namesCommit,
  pluginSourceSeen,
  sameSourceSeen,
  sameValue,
  softwareActionMs,
} from "@decent-sync/protocol";
import { type Scope, includesLocation } from "../accounts/scope.js";
import { ADMINS_ONLY } from "../accounts/guards.js";
import { CONFIG } from "../config.module.js";
import type { Config } from "../config.js";
import { AccountRole, Prisma } from "../generated/prisma/client.js";
import { machineNotFound } from "../machines/input.js";
import { lockMachine } from "../machines/machines.service.js";
import { notify } from "../notifications.js";
import { PrismaService } from "../prisma.service.js";
import { type NewSoftwareAction, softwareActionNotFound } from "./input.js";
import { type PluginSettingView, settingViews, skinViews } from "./tablet-software.js";

/** Why a Software Action was refused, as the REST API gives it. */
export type SoftwareActionRefusalView =
  | { reason: "machineBusy"; state: string | null }
  /** What no longer held on the Tablet, in the plugin's words. */
  | { reason: "changedSince"; message: string | null }
  | { reason: "expired" }
  /** What the plugin would not do to itself or the default Skin, in its words. */
  | { reason: "notAllowed"; message: string | null }
  /** The source a change of how an item updates named held another plugin or Skin, in the plugin's words: which, and what became of it. */
  | { reason: "differentItem"; message: string | null }
  /** Android's permission for Decaid to install apps is not granted at the Tablet, with Decaid's words. */
  | { reason: "installNotPermitted"; message: string | null }
  /** The Skin view was stopped and did not start again, with Decaid's words. */
  | { reason: "noSkinServed"; message: string | null }
  /** Decaid's status, null where it did not answer or was not asked, and its words. */
  | { reason: "decaid"; status: number | null; message: string | null };

/** Who makes a Software Action: an Admin's account, or for Reload and the restart a Staff member's, in the management interface or through a Connected App acting as it. */
export interface SoftwareActionMaker {
  accountId: string;
  role: AccountRole;
  scope: Scope;
  /** The Connected App it is made through; null for the management interface. */
  connectedAppId: string | null;
}

/**
 * What a Software Action names, kept and shown: never a setting's value.
 * `plugin` is the plugin it acts on, with its name as the Tablet reported
 * it then; `settings` the names of the settings a change sets.
 */
export interface SoftwareActionParams {
  plugin?: { id: string; name: string | null };
  /** The Skin it acts on, with its name as the Tablet reported it then. */
  skin?: { id: string; name: string | null };
  repo?: string;
  branch?: string | null;
  /** The URL a Skin is installed from. */
  url?: string;
  /** For a change of how an item updates: its source and build as its Tablet reported them when it was made, which the plugin installs over only while they still hold. */
  expected?: SourceSeen;
  version?: string;
  addedPermissions?: string[];
  settings?: string[];
}

/** A Software Action as the REST API returns it. */
export interface SoftwareActionView {
  id: string;
  machineId: string;
  kind: string;
  params: SoftwareActionParams;
  /** Who made it: named to Admins, and to anyone else by its id only, as other accounts' names are personal information. */
  account: { id: string; name: string | null } | null;
  /** The Connected App the account made it through; null for the management interface. */
  connectedApp: { id: string; name: string; host: string } | null;
  /** By PostgreSQL's clock: when it was made, sent to the plugin and answered; null until it was. */
  madeAt: string;
  sentAt: string | null;
  answeredAt: string | null;
  /**
   * What came of it; null while it awaits its answer. `notConfirmed` once
   * it is no longer awaited, until an answer arriving after that replaces
   * it, but for an `expired` refusal, which leaves it not confirmed; and
   * where the plugin answered that what came of it never showed.
   */
  outcome: "done" | "refused" | "notConfirmed" | null;
  /** For one the plugin answered as not confirmed: what did not show, in its words. */
  note: string | null;
  /** Whether its outcome came from an answer that arrived after it was marked not confirmed. */
  late: boolean;
  refusal: SoftwareActionRefusalView | null;
  /** What came of it, once done: the version installed, a result for each plugin checked, Decaid's update state. */
  result: SoftwareActionResult | null;
}

type Page = { limit: number; offset: number };

const withAccount = {
  account: { select: { name: true } },
  connectedApp: { select: { id: true, name: true, clientHost: true } },
} as const satisfies Prisma.SoftwareActionInclude;
type StoredAction = Prisma.SoftwareActionGetPayload<{ include: typeof withAccount }>;

/** What is held for the plugin and shown to nobody: a settings change's values. */
interface Held {
  values: Record<string, unknown>;
  expected: Record<string, unknown>;
}

/**
 * Software Actions (ADR-0034): each one thing an Admin asked a Machine's
 * Tablet to do to its plugins or to Decaid, kept as a row in PostgreSQL and
 * made as a Settings Edit is (ADR-0023): only while the Machine is online,
 * judged under its row lock as it is inserted, for the connection holding it
 * then, and announced to every instance (`software_actions`). The instance
 * whose connection that is claims it under the row lock again, by setting
 * when it was sent, and sends it (`claim`); a later connection, even from
 * the same Tablet, sends nothing made for an earlier one. The plugin's
 * answer is recorded by whichever instance it reaches (`recordAnswer`).
 *
 * An action is never queued. One unanswered once its time is up
 * (`softwareActionMs`), by PostgreSQL's clock, or never sent and its
 * connection no longer holding its Machine, is not confirmed
 * (`noLongerAwaited`), judged from the database whenever it is read. One
 * that was sent stays awaited for its time though its connection closed:
 * an action that has Decaid load the plugin again, as approving the
 * plugin's own update does, is answered on the next. An answer arriving
 * after its time still counts, marked late, but for an `expired` refusal.
 *
 * A change of a plugin's settings carries values, a secret's among them.
 * They are held in the row apart from what is shown (`held`), given to the
 * plugin as the action is claimed and removed by that same statement; one
 * never claimed loses them once it is no longer awaited (`forgetHeld`),
 * by a timer of every instance that hears it was made, the one that made
 * it included, and by every instance as it starts, again once any action
 * made before it started is past its time, and before it reads or makes an
 * action, so that none outlives its action whatever instance stops. No
 * response, log line or notification ever holds one. A removed value is
 * gone from the row, not from PostgreSQL's own history of it until that is
 * cleared: its dead row versions until a vacuum, its write-ahead log and
 * any backup taken meanwhile.
 */
@Injectable()
export class SoftwareActionsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("SoftwareActions");
  /** The timers of this instance's actions that hold values, each until its action's time is up. */
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  /** Removes what an instance that stopped left held past its time, now and once any action made before now is past its time. */
  onModuleInit(): void {
    void this.forgetHeld().catch((error: unknown) => this.logger.warn(`Could not remove the values of Software Actions past their time: ${describe(error)}`));
    this.forgetHeldLater(undefined);
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  /**
   * Makes an action and announces it, or refuses it at once with nothing
   * kept: 403 for anyone but an Admin, but that Staff may reload the Skin
   * or restart the Skin view of a Machine at a Location they work at
   * (`SKIN_VIEW_KINDS`); 400 for one that names what the
   * Tablet does not report, or that Decent Sync's own plugin refuses; 409
   * while the Machine is offline, its connection's Tablet reports another
   * machine's hardware, its plugin is from before a change of how an item
   * updates and is asked for one, or what the page showed is no longer what
   * the Tablet reports.
   */
  async make(machineId: string, action: NewSoftwareAction, maker: SoftwareActionMaker): Promise<SoftwareActionView> {
    const admin = maker.role === AccountRole.ADMIN;
    if (!admin && !(maker.role === AccountRole.STAFF && isSkinViewKind(action.kind))) throw new ForbiddenException(ADMINS_ONLY);
    await this.forgetHeld(machineId);
    const onlineSinceMs = this.config.heartbeatIntervalMs * MISSED_HEARTBEATS;
    const timeMs = softwareActionMs(action.kind);
    const made = await this.prisma.$transaction(async (tx) => {
      if (!(await lockMachine(tx, machineId))) throw machineNotFound();
      if (!admin) {
        const latest = await tx.locationAssignment.findFirst({ where: { machineId }, orderBy: { effectiveFrom: "desc" }, select: { locationId: true } });
        if (!includesLocation(maker.scope, latest?.locationId ?? null)) {
          throw new ForbiddenException("You can reload or restart the Skin only of a Machine at a Location you work at");
        }
      }
      // Online as the Machine's status judges it, by PostgreSQL's clock: held by a connection heard from recently.
      const [holder] = await tx.$queryRaw<[{ sessionId: string | null; tabletId: string | null; online: boolean; mismatched: boolean }]>`
        SELECT connected_session_id AS "sessionId", connected_tablet_id AS "tabletId",
          connected_session_id IS NOT NULL AND last_seen_at >= now() - ${onlineSinceMs}::integer * interval '1 millisecond' AS online,
          identification = 'MISMATCH' AS mismatched
        FROM machines WHERE id = ${machineId}::uuid`;
      if (!holder.online || holder.sessionId === null || holder.tabletId === null) {
        throw new ConflictException("The Machine is offline: a Software Action is made only while its Tablet is connected, and is never kept for later");
      }
      if (holder.mismatched) throw new ConflictException("Its Tablet reports another machine's hardware than this Machine's, so nothing is asked of it");
      const { params, held } = await this.checked(tx, machineId, action);
      const row = await tx.softwareAction.create({
        data: {
          machineId,
          sessionId: holder.sessionId,
          tabletId: holder.tabletId,
          accountId: maker.accountId,
          connectedAppId: maker.connectedAppId,
          kind: action.kind,
          params: params as Prisma.InputJsonObject,
          ...(held === null ? {} : { held: held as unknown as Prisma.InputJsonObject }),
          timeMs,
        },
        select: { id: true },
      });
      await notify(tx, "software_actions", machineId);
      return { id: row.id, holds: held !== null };
    });
    if (made.holds) this.forgetHeldLater(machineId, timeMs);
    return this.get(machineId, made.id, maker.scope);
  }

  /**
   * What an action names, checked against what the Machine's Tablet last
   * reported, in the transaction that makes it: the plugin it acts on, the
   * update that waits, the settings it changes, each by what the plugin's
   * manifest declares. Gives what is kept and shown (`params`) and what is
   * only held for the plugin (`held`).
   */
  private async checked(tx: Prisma.TransactionClient, machineId: string, action: NewSoftwareAction): Promise<{ params: SoftwareActionParams; held: Held | null }> {
    if (action.kind === "installPlugin") return { params: { repo: action.repo, branch: action.branch }, held: null };
    if (action.kind === "installSkin") return { params: "url" in action ? { url: action.url } : { repo: action.repo, branch: action.branch }, held: null };
    if (action.kind === "chooseDefaultSkin" || action.kind === "removeSkin" || action.kind === "reloadSkin" || action.kind === "changeSkinSource") {
      return { params: await this.checkedOnSkins(tx, machineId, action), held: null };
    }
    if (action.kind === "startDecaidUpdate") {
      const report = await tx.reportedCollection.findUnique({ where: { machineId_name: { machineId, name: "decaidUpdate" } }, select: { value: true, receivedAt: true } });
      const state = report?.receivedAt && isRecord(report.value) ? report.value : {};
      if (typeof state.latestVersion !== "string" || state.latestVersion === "" || state.installable !== true) {
        throw new ConflictException("Decaid offers no update it can install on this Tablet: check for its update first");
      }
      return { params: { version: state.latestVersion }, held: null };
    }
    if (!("pluginId" in action)) return { params: {}, held: null };
    const report = await tx.reportedCollection.findUnique({ where: { machineId_name: { machineId, name: "plugins" } }, select: { value: true, receivedAt: true } });
    const list = report?.receivedAt && Array.isArray(report.value) ? (report.value as unknown[]) : [];
    const plugin = list.find((entry): entry is Record<string, unknown> => isRecord(entry) && entry.id === action.pluginId);
    if (!plugin) throw new ConflictException("The Tablet reports no such plugin: it may have been removed since the page was loaded");
    const named = { id: action.pluginId, name: typeof plugin.name === "string" && plugin.name !== "" ? plugin.name : null };
    const own = action.pluginId === DECENT_SYNC_PLUGIN_ID;
    switch (action.kind) {
      case "enablePlugin":
        return { params: { plugin: named }, held: null };
      case "disablePlugin":
      case "removePlugin":
        // The plugin refuses these itself, whatever it is sent: said here first, with nothing kept.
        if (own) throw new BadRequestException(`Decent Sync's own plugin can't be ${action.kind === "disablePlugin" ? "disabled" : "removed"} from here: that would cut the Tablet off from the server`);
        return { params: { plugin: named }, held: null };
      case "changePluginSource": {
        const expected = pluginSourceSeen(plugin);
        // Its build too, not only how it updates: one a check moved since, at the same version, is not the one a pin from the page holds.
        if (!sameSourceSeen(action.seen, expected)) {
          throw new ConflictException(`${named.name ?? named.id} is at another version or source now than the page showed: load the page again`);
        }
        // The plugin refuses this itself, whatever it is sent: said here first, with nothing kept.
        if (own && (action.repo.toLowerCase() !== DECENT_SYNC_REPO || (action.branch !== null && !namesCommit(action.branch)))) {
          throw new BadRequestException(`Decent Sync's own plugin follows the releases of ${DECENT_SYNC_REPO} or is pinned to one of its commits: a build from anywhere else could cut the Tablet off from the server`);
        }
        return { params: { plugin: named, repo: action.repo, branch: action.branch, expected }, held: null };
      }
      case "approvePluginUpdate": {
        const waiting = isRecord(plugin.pendingUpdate) ? plugin.pendingUpdate : null;
        if (waiting === null) throw new ConflictException("No update of this plugin waits for approval any more");
        const added = Array.isArray(waiting.addedPermissions) ? [...waiting.addedPermissions].sort() : [];
        if (waiting.version !== action.version || !sameValue(added, [...action.addedPermissions].sort())) {
          throw new ConflictException("Another update of this plugin waits now than the one shown: load the page again");
        }
        return { params: { plugin: named, version: action.version, addedPermissions: action.addedPermissions }, held: null };
      }
      case "changePluginSettings": {
        const declared = settingViews(plugin.settings, own);
        const problems = Object.entries(action.values).flatMap(([name, value]) => {
          const setting = declared.find((candidate) => candidate.name === name);
          if (!setting) return [`${named.name ?? named.id} declares no setting ${name}`];
          if (!setting.changeable) return [`${setting.label} of Decent Sync's own plugin can't be changed from here: it is set on the Tablet`];
          const problem = settingProblem(setting, value);
          return problem === null ? [] : [`${setting.label}: ${problem}`];
        });
        if (problems.length > 0) throw new BadRequestException(problems);
        return { params: { plugin: named, settings: Object.keys(action.values) }, held: { values: action.values, expected: action.expected } };
      }
    }
  }

  /**
   * What an action on a Skin names, checked against the Skins the Tablet
   * last reported: the Skin is there; one removed is neither the default, nor
   * the one served, nor one that comes with Decaid, which keeps it; for Reload, the Skin
   * served now has reported its page; and one whose source changes does not
   * come with Decaid, and is at the version and source the page showed.
   */
  private async checkedOnSkins(
    tx: Prisma.TransactionClient,
    machineId: string,
    action: Extract<NewSoftwareAction, { kind: "chooseDefaultSkin" | "removeSkin" | "reloadSkin" | "changeSkinSource" }>,
  ): Promise<SoftwareActionParams> {
    const reports = await tx.reportedCollection.findMany({ where: { machineId, name: { in: ["skins", "skinPage"] }, receivedAt: { not: null } }, select: { name: true, value: true } });
    const reported = reports.find((report) => report.name === "skins")?.value;
    const skins = skinViews(reported, reports.find((report) => report.name === "skinPage")?.value) ?? [];
    if (action.kind === "reloadSkin") {
      const served = skins.find((skin) => skin.served);
      if (!served) throw new ConflictException("Decaid serves no Skin on this Tablet now: restart the Skin view instead");
      if (!served.pageReported) throw new ConflictException(`${served.name ?? served.id} has not reported its page, so it can't be asked to reload: restart the Skin view instead`);
      return { skin: { id: served.id, name: served.name } };
    }
    const skin = skins.find((candidate) => candidate.id === action.skinId);
    if (!skin) throw new ConflictException("The Tablet reports no such Skin: it may have been removed since the page was loaded");
    if (action.kind === "removeSkin") {
      // The plugin refuses the first two itself, and Decaid the third, whatever they are sent: said here first, with nothing kept.
      if (skin.default) throw new BadRequestException(`${skin.name ?? skin.id} is the default Skin, which can't be removed: choose another default first`);
      // Decaid would go on serving its deleted folder, which answers 404 once the page loads again (`defaultRemoved`).
      if (skin.served) throw new BadRequestException(`${skin.name ?? skin.id} is on screen now, so it can't be removed: restart the Skin view onto the default first`);
      if (skin.updates.how === "comesWithDecaid") throw new BadRequestException(`${skin.name ?? skin.id} comes with Decaid, which keeps it: it can't be removed`);
    }
    if (action.kind === "changeSkinSource") {
      // Decaid installs its own repository's latest release again as it starts and at each update check, whatever it was installed from since.
      if (skin.updates.how === "comesWithDecaid") {
        throw new BadRequestException(`${skin.name ?? skin.id} comes with Decaid, which restores it from its own repository each time it starts: how it updates can't be changed`);
      }
      if (!sameSourceSeen(action.seen, skin.build)) {
        throw new ConflictException(`${skin.name ?? skin.id} is at another version or source now than the page showed: load the page again`);
      }
      // From the branch a Skin was installed from Decaid installs nothing while it serves the same build, answering that it is current; from the same URL it installs the same build again, which changes nothing.
      const source = "url" in action ? action.url : action.branch === null ? null : `github_branch:${action.repo}@${action.branch}`;
      if (source !== null && source === skin.build.sourceUrl) {
        throw new BadRequestException(`${skin.name ?? skin.id} already updates from there: choose another source, or check the Skins for updates to install its newest build`);
      }
      const to = "url" in action ? { url: action.url } : { repo: action.repo, branch: action.branch };
      return { skin: { id: skin.id, name: skin.name }, ...to, expected: skin.build };
    }
    return { skin: { id: skin.id, name: skin.name } };
  }

  /** One of the Machine's actions, it and whether it is not confirmed read from one snapshot. */
  async get(machineId: string, id: string, scope: Scope): Promise<SoftwareActionView> {
    const [action, notConfirmed] = await this.prisma.$transaction(
      [
        this.prisma.softwareAction.findFirst({ where: { id, machineId }, include: withAccount }),
        this.prisma.$queryRaw<unknown[]>`
          SELECT 1 FROM software_actions WHERE id = ${id}::uuid AND answered_at IS NULL AND ${this.noLongerAwaited()}`,
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    if (!action) throw softwareActionNotFound();
    return view(action, scope, notConfirmed.length > 0);
  }

  /** A page of the Machine's actions, newest first, with how many it has, read from one snapshot as `get` reads one. */
  async list(machineId: string, page: Page, scope: Scope): Promise<{ softwareActions: SoftwareActionView[]; total: number } & Page> {
    await this.forgetHeld(machineId);
    const [actions, total] = await this.prisma.$transaction(
      async (tx) => {
        if ((await tx.machine.count({ where: { id: machineId } })) === 0) throw machineNotFound();
        const actions = await tx.softwareAction.findMany({
          where: { machineId },
          include: withAccount,
          orderBy: [{ madeAt: "desc" }, { id: "desc" }],
          take: page.limit,
          skip: page.offset,
        });
        return [await this.views(tx, actions, scope), await tx.softwareAction.count({ where: { machineId } })] as const;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return { softwareActions: actions, total, ...page };
  }

  /** The actions of these ids, each as the REST API gives it, by its id, read in the caller's transaction: what a Settings History names its changes' actions with. */
  async viewsOf(tx: Prisma.TransactionClient, ids: readonly string[], scope: Scope): Promise<Map<string, SoftwareActionView>> {
    if (ids.length === 0) return new Map();
    const actions = await tx.softwareAction.findMany({ where: { id: { in: [...ids] } }, include: withAccount });
    return new Map((await this.views(tx, actions, scope)).map((action) => [action.id, action]));
  }

  private async views(tx: Prisma.TransactionClient, actions: StoredAction[], scope: Scope): Promise<SoftwareActionView[]> {
    const unanswered = actions.filter((action) => action.answeredAt === null).map((action) => action.id);
    const notConfirmed =
      unanswered.length === 0
        ? []
        : await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM software_actions WHERE id = ANY(${unanswered}::uuid[]) AND answered_at IS NULL AND ${this.noLongerAwaited()}`;
    const ids = new Set(notConfirmed.map((action) => action.id));
    return actions.map((action) => view(action, scope, ids.has(action.id)));
  }

  /**
   * Whether a row of `software_actions` is no longer awaited, as SQL: its
   * time has passed since it was made, or it was never sent and its
   * connection no longer holds its Machine, so that it never will be. This
   * only ever turns true.
   */
  private noLongerAwaited(): Prisma.Sql {
    // The time as the statement runs, after any lock it waited for, not as its transaction began.
    return Prisma.sql`(
      software_actions.made_at <= clock_timestamp() - software_actions.time_ms * interval '1 millisecond'
      OR (
        software_actions.sent_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM machines
          WHERE machines.id = software_actions.machine_id AND machines.connected_session_id = software_actions.session_id
        )
      )
    )`;
  }

  /**
   * Removes the values held for the plugin from every action no longer
   * awaited and never sent, of one Machine or of all. Says how many it
   * removed them from.
   */
  async forgetHeld(machineId?: string): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE software_actions SET held = NULL
      WHERE held IS NOT NULL AND ${machineId === undefined ? Prisma.sql`true` : Prisma.sql`machine_id = ${machineId}::uuid`} AND ${this.noLongerAwaited()}`;
  }

  /**
   * Removes a Machine's held values, or every Machine's, once an action
   * made now is past its time, with a moment's room for the clocks to
   * differ: on the instance that made it, and on each that hears it was
   * made (`SyncGateway`), so that it is removed though the one that made it
   * stops first.
   */
  forgetHeldLater(machineId: string | undefined, timeMs = MAX_SOFTWARE_ACTION_MS): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.forgetHeld(machineId).catch((error: unknown) => this.logger.warn(`Could not remove the values of a Software Action past its time: ${describe(error)}`));
    }, timeMs + 1_000);
    timer.unref();
    this.timers.add(timer);
  }

  /**
   * The actions made for a connection that it has not sent yet, oldest
   * first, claimed by setting when they were sent, while the connection
   * still holds its Machine, judged under the Machine's row lock; none once
   * it does not. Each carries the time it has left, by PostgreSQL's clock;
   * one with none left is not sent. The statement that claims an action
   * takes the values held for the plugin out of its row.
   */
  async claim(connection: { sessionId: string; machineId: string }): Promise<SoftwareAction[]> {
    return this.prisma.$transaction(async (tx) => {
      const holds = await tx.$queryRaw<unknown[]>`
        SELECT 1 FROM machines WHERE id = ${connection.machineId}::uuid AND connected_session_id = ${connection.sessionId}::uuid FOR NO KEY UPDATE`;
      if (holds.length === 0) return [];
      const claimed = await tx.$queryRaw<{ id: string; kind: string; params: SoftwareActionParams; held: Held | null; timeLeftMs: number }[]>`
        WITH due AS (
          SELECT id, held FROM software_actions
          WHERE session_id = ${connection.sessionId}::uuid AND machine_id = ${connection.machineId}::uuid AND sent_at IS NULL
            AND made_at > clock_timestamp() - time_ms * interval '1 millisecond'
          FOR UPDATE
        ), claimed AS (
          UPDATE software_actions SET sent_at = clock_timestamp(), held = NULL
          FROM due WHERE software_actions.id = due.id
          RETURNING software_actions.id, software_actions.kind, software_actions.params, software_actions.time_ms, software_actions.made_at, software_actions.sent_at
        )
        SELECT claimed.id, claimed.kind, claimed.params, due.held,
          GREATEST(0, claimed.time_ms - FLOOR(EXTRACT(EPOCH FROM claimed.sent_at - claimed.made_at) * 1000))::integer AS "timeLeftMs"
        FROM claimed JOIN due ON due.id = claimed.id ORDER BY claimed.made_at, claimed.id`;
      return claimed.flatMap((row) => messageOf(row) ?? []);
    });
  }

  /**
   * Records the plugin's answer to one of the Machine's actions, through
   * whichever connection and instance it reached, and says what came of it
   * and whether it came late; null for an action of another Machine, or
   * none, or one already answered.
   */
  async recordAnswer(machineId: string, answer: SoftwareActed): Promise<{ outcome: SoftwareActed["outcome"]; late: boolean } | null> {
    const reason = answer.outcome === "refused" ? (answer.reason ?? "decaid") : null;
    const [updated] = await this.prisma.$transaction(async (tx) => {
      // Whether it is late is judged with the Machine's row held, as a Settings Edit's answer is.
      await tx.$queryRaw`SELECT 1 FROM machines WHERE id = ${machineId}::uuid FOR SHARE`;
      return tx.$queryRaw<[{ late: boolean }?]>`
        UPDATE software_actions SET
          answered_at = now(),
          late = ${this.noLongerAwaited()},
          held = NULL,
          outcome = ${answer.outcome === "done" ? "DONE" : answer.outcome === "notConfirmed" ? "NOT_CONFIRMED" : "REFUSED"},
          refusal = ${reason},
          machine_state = ${reason === "machineBusy" ? (answer.state ?? null) : null},
          decaid_status = ${reason === "decaid" ? (answer.status ?? null) : null}::integer,
          message = ${answer.outcome === "done" ? null : (answer.message ?? null)},
          result = ${answer.outcome === "done" && answer.result ? JSON.stringify(answer.result) : null}::jsonb
        WHERE id = ${answer.id.toLowerCase()}::uuid AND machine_id = ${machineId}::uuid AND answered_at IS NULL
        RETURNING late`;
    });
    return updated ? { outcome: answer.outcome, late: updated.late } : null;
  }
}

/** What is wrong with a value for a setting, by what its manifest declares, or null: never the value itself. */
function settingProblem(setting: PluginSettingView, value: unknown): string | null {
  // Null clears a setting, whatever its kind.
  if (value === null) return null;
  switch (setting.kind) {
    case "number":
      return typeof value === "number" ? null : "give a number";
    case "switch":
      return typeof value === "boolean" ? null : "give on or off";
    case "choice":
      return typeof value === "string" && setting.choices.includes(value) ? null : `choose one of ${setting.choices.join(", ")}`;
    default:
      return typeof value === "string" ? null : "give text";
  }
}

/** The message that asks the plugin for a claimed action, or undefined for a row no message can be made of. */
function messageOf(row: { id: string; kind: string; params: SoftwareActionParams; held: Held | null; timeLeftMs: number }): SoftwareAction | undefined {
  if (!isSoftwareActionKind(row.kind)) return undefined;
  const base = { type: "softwareAction" as const, id: row.id, timeLeftMs: row.timeLeftMs };
  const kind: SoftwareActionKind = row.kind;
  const pluginId = row.params.plugin?.id ?? "";
  switch (kind) {
    case "installPlugin":
      return { ...base, kind, repo: row.params.repo ?? "", ...(row.params.branch ? { branch: row.params.branch } : {}) };
    case "enablePlugin":
    case "disablePlugin":
    case "removePlugin":
      return { ...base, kind, pluginId };
    case "changePluginSource":
      return { ...base, kind, pluginId, expected: row.params.expected ?? {}, repo: row.params.repo ?? "", ...(row.params.branch ? { branch: row.params.branch } : {}) };
    case "approvePluginUpdate":
      return { ...base, kind, pluginId, version: row.params.version ?? "", addedPermissions: row.params.addedPermissions ?? [] };
    case "changePluginSettings":
      // Without its values, as a row another statement emptied, there is nothing to send.
      return row.held === null ? undefined : { ...base, kind, pluginId, values: row.held.values, expected: row.held.expected };
    case "installSkin":
      return row.params.url ? { ...base, kind, url: row.params.url } : { ...base, kind, repo: row.params.repo ?? "", ...(row.params.branch ? { branch: row.params.branch } : {}) };
    case "chooseDefaultSkin":
    case "removeSkin":
      return { ...base, kind, skinId: row.params.skin?.id ?? "" };
    case "changeSkinSource": {
      const changed = { ...base, kind, skinId: row.params.skin?.id ?? "", expected: row.params.expected ?? {} };
      return row.params.url ? { ...changed, url: row.params.url } : { ...changed, repo: row.params.repo ?? "", ...(row.params.branch ? { branch: row.params.branch } : {}) };
    }
    case "checkSkinUpdates":
    case "reloadSkin":
    case "restartSkinView":
      return { ...base, kind };
    case "checkPluginUpdates":
    case "checkDecaidUpdate":
    case "startDecaidUpdate":
      return { ...base, kind };
  }
}

/** The action as the REST API gives it; `notConfirmed` says whether, still unanswered, it is no longer awaited. */
function view(action: StoredAction, scope: Scope, notConfirmed: boolean): SoftwareActionView {
  // A refusal as too late, arriving once the action was no longer awaited, leaves it not confirmed.
  const stillNotConfirmed = notConfirmed || (action.late && action.refusal === "expired");
  const outcome = stillNotConfirmed || action.outcome === "NOT_CONFIRMED" ? "notConfirmed" : action.outcome === "DONE" ? "done" : action.outcome === "REFUSED" ? "refused" : null;
  return {
    id: action.id,
    machineId: action.machineId,
    kind: action.kind,
    params: isRecord(action.params) ? (action.params as SoftwareActionParams) : {},
    // Other accounts' names are personal information that only Admins see.
    account: action.accountId === null ? null : { id: action.accountId, name: scope.kind === "everything" ? (action.account?.name ?? null) : null },
    connectedApp: action.connectedApp && { id: action.connectedApp.id, name: action.connectedApp.name, host: action.connectedApp.clientHost },
    madeAt: action.madeAt.toISOString(),
    sentAt: action.sentAt?.toISOString() ?? null,
    answeredAt: action.answeredAt?.toISOString() ?? null,
    outcome,
    note: action.outcome === "NOT_CONFIRMED" && !stillNotConfirmed ? action.message : null,
    late: action.late && !stillNotConfirmed,
    refusal: outcome === "refused" ? refusalView(action) : null,
    result: outcome === "done" && isRecord(action.result) ? (action.result as SoftwareActionResult) : null,
  };
}

function refusalView(action: StoredAction): SoftwareActionRefusalView {
  const reason = action.refusal as SoftwareActedRefusal | null;
  switch (reason) {
    case "machineBusy":
      return { reason, state: action.machineState };
    case "changedSince":
    case "notAllowed":
    case "differentItem":
    case "installNotPermitted":
    case "noSkinServed":
      return { reason, message: action.message };
    case "expired":
      return { reason };
    default:
      return { reason: "decaid", status: action.decaidStatus, message: action.message };
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
