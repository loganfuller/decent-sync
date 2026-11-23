import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import {
  DECENT_SYNC_PLUGIN_ID,
  MAX_SOFTWARE_ACTION_MS,
  MISSED_HEARTBEATS,
  OWN_CHANGEABLE_SETTING,
  SOFTWARE_ACTIONS_WIRE_REVISION,
  type SoftwareActed,
  type SoftwareActedRefusal,
  type SoftwareAction,
  type SoftwareActionKind,
  type SoftwareActionResult,
  isSoftwareActionKind,
  peerHasWireRevision,
  sameValue,
  softwareActionMs,
} from "@decent-sync/protocol";
import type { Scope } from "../accounts/scope.js";
import { ADMINS_ONLY } from "../accounts/guards.js";
import { CONFIG } from "../config.module.js";
import type { Config } from "../config.js";
import { AccountRole, Prisma } from "../generated/prisma/client.js";
import { machineNotFound } from "../machines/input.js";
import { lockMachine } from "../machines/machines.service.js";
import { notify } from "../notifications.js";
import { PrismaService } from "../prisma.service.js";
import { type NewSoftwareAction, softwareActionNotFound } from "./input.js";
import { type PluginSettingView, settingViews } from "./tablet-software.js";

/** Why a Software Action was refused, as the REST API gives it. */
export type SoftwareActionRefusalView =
  | { reason: "machineBusy"; state: string | null }
  /** What no longer held on the Tablet, in the plugin's words. */
  | { reason: "changedSince"; message: string | null }
  | { reason: "expired" }
  /** What the plugin would not do to itself, in its words. */
  | { reason: "notAllowed"; message: string | null }
  /** Decaid's status, null where it did not answer or was not asked, and its words. */
  | { reason: "decaid"; status: number | null; message: string | null };

/** Who makes a Software Action: an Admin's account, in the management interface or through a Connected App acting as it. */
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
  repo?: string;
  branch?: string | null;
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
   * it, but for an `expired` refusal, which leaves it not confirmed.
   */
  outcome: "done" | "refused" | "notConfirmed" | null;
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
   * kept: 403 for anyone but an Admin; 400 for one that names what the
   * Tablet does not report, or that Decent Sync's own plugin refuses; 409
   * while the Machine is offline, its connection's Tablet reports another
   * machine's hardware, its plugin is from before Software Actions, or what
   * the page showed is no longer what the Tablet reports.
   */
  async make(machineId: string, action: NewSoftwareAction, maker: SoftwareActionMaker): Promise<SoftwareActionView> {
    if (maker.role !== AccountRole.ADMIN) throw new ForbiddenException(ADMINS_ONLY);
    await this.forgetHeld(machineId);
    const onlineSinceMs = this.config.heartbeatIntervalMs * MISSED_HEARTBEATS;
    const timeMs = softwareActionMs(action.kind);
    const made = await this.prisma.$transaction(async (tx) => {
      if (!(await lockMachine(tx, machineId))) throw machineNotFound();
      // Online as the Machine's status judges it, by PostgreSQL's clock: held by a connection heard from recently.
      const [holder] = await tx.$queryRaw<[{ sessionId: string | null; tabletId: string | null; online: boolean; mismatched: boolean; wireRevision: number | null }]>`
        SELECT connected_session_id AS "sessionId", connected_tablet_id AS "tabletId",
          connected_session_id IS NOT NULL AND last_seen_at >= now() - ${onlineSinceMs}::integer * interval '1 millisecond' AS online,
          identification = 'MISMATCH' AS mismatched, wire_revision AS "wireRevision"
        FROM machines WHERE id = ${machineId}::uuid`;
      if (!holder.online || holder.sessionId === null || holder.tabletId === null) {
        throw new ConflictException("The Machine is offline: a Software Action is made only while its Tablet is connected, and is never kept for later");
      }
      if (holder.mismatched) throw new ConflictException("Its Tablet reports another machine's hardware than this Machine's, so nothing is asked of it");
      if (!takesSoftwareActions(holder.wireRevision)) throw new ConflictException("The Tablet's plugin must update before it takes a Software Action");
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
   * it does not, and none for a plugin from before Software Actions. Each
   * carries the time it has left, by PostgreSQL's clock; one with none left
   * is not sent. The statement that claims an action takes the values held
   * for the plugin out of its row.
   */
  async claim(connection: { sessionId: string; machineId: string; wireRevision: number }): Promise<SoftwareAction[]> {
    if (!takesSoftwareActions(connection.wireRevision)) return [];
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
  async recordAnswer(machineId: string, answer: SoftwareActed): Promise<{ outcome: "done" | "refused"; late: boolean } | null> {
    const reason = answer.outcome === "refused" ? (answer.reason ?? "decaid") : null;
    const [updated] = await this.prisma.$transaction(async (tx) => {
      // Whether it is late is judged with the Machine's row held, as a Settings Edit's answer is.
      await tx.$queryRaw`SELECT 1 FROM machines WHERE id = ${machineId}::uuid FOR SHARE`;
      return tx.$queryRaw<[{ late: boolean }?]>`
        UPDATE software_actions SET
          answered_at = now(),
          late = ${this.noLongerAwaited()},
          held = NULL,
          outcome = ${answer.outcome === "done" ? "DONE" : "REFUSED"},
          refusal = ${reason},
          machine_state = ${reason === "machineBusy" ? (answer.state ?? null) : null},
          decaid_status = ${reason === "decaid" ? (answer.status ?? null) : null}::integer,
          message = ${reason === null ? null : (answer.message ?? null)},
          result = ${answer.outcome === "done" && answer.result ? JSON.stringify(answer.result) : null}::jsonb
        WHERE id = ${answer.id.toLowerCase()}::uuid AND machine_id = ${machineId}::uuid AND answered_at IS NULL
        RETURNING late`;
    });
    return updated ? { outcome: answer.outcome, late: updated.late } : null;
  }
}

/** Whether a plugin at the wire revision takes Software Actions; one whose revision is not known does not yet. */
export function takesSoftwareActions(wireRevision: number | null): boolean {
  return wireRevision !== null && peerHasWireRevision(wireRevision, SOFTWARE_ACTIONS_WIRE_REVISION);
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
    case "approvePluginUpdate":
      return { ...base, kind, pluginId, version: row.params.version ?? "", addedPermissions: row.params.addedPermissions ?? [] };
    case "changePluginSettings":
      // Without its values, as a row another statement emptied, there is nothing to send.
      return row.held === null ? undefined : { ...base, kind, pluginId, values: row.held.values, expected: row.held.expected };
    case "checkPluginUpdates":
    case "checkDecaidUpdate":
      return { ...base, kind };
  }
}

/** The action as the REST API gives it; `notConfirmed` says whether, still unanswered, it is no longer awaited. */
function view(action: StoredAction, scope: Scope, notConfirmed: boolean): SoftwareActionView {
  // A refusal as too late, arriving once the action was no longer awaited, leaves it not confirmed.
  const stillNotConfirmed = notConfirmed || (action.late && action.refusal === "expired");
  const outcome = stillNotConfirmed ? "notConfirmed" : action.outcome === "DONE" ? "done" : action.outcome === "REFUSED" ? "refused" : null;
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
      return { reason, message: action.message };
    case "expired":
      return { reason };
    default:
      return { reason: "decaid", status: action.decaidStatus, message: action.message };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
