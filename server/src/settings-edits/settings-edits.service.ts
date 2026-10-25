import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import {
  MISSED_HEARTBEATS,
  SETTINGS_EDIT_MS,
  type SettingsEdit,
  type SettingsEdited,
  type SettingsEditedRefusal,
  type SettingsRole,
  isEditableSettingsCollection,
  settingsRefusalText,
  validateSettingsEdit,
} from "@decent-sync/protocol";
import { type Scope, includesLocation } from "../accounts/scope.js";
import type { SignedIn } from "../accounts/sessions.service.js";
import { CONFIG } from "../config.module.js";
import type { Config } from "../config.js";
import { AccountRole, Prisma, SettingsEditOutcome, SettingsEditRefusal } from "../generated/prisma/client.js";
import { machineNotFound } from "../machines/input.js";
import { lockMachine } from "../machines/machines.service.js";
import { notify } from "../notifications.js";
import { PrismaService } from "../prisma.service.js";
import { type NewSettingsEdit, settingsEditNotFound } from "./input.js";
import { type DecidedOutcome, type HeldOtherwise, decideOutcome, heldOtherwise } from "./outcome.js";

/** Why a Settings Edit was refused, as the REST API gives it, with what the plugin said of it. */
export type SettingsEditRefusalView =
  | { reason: "machineBusy"; state: string | null }
  | { reason: "changedSince"; current: Record<string, unknown> | null }
  | { reason: "expired" }
  /** Decaid's status, null where it did not answer or was not asked, and its message; and the fields it changed before refusing. */
  | { reason: "decaid"; status: number | null; message: string | null; changed: string[] };

/** A Settings Edit as the REST API returns it. */
export interface SettingsEditView {
  id: string;
  machineId: string;
  collection: string;
  /** Each field it sets, with its new value, and each field's value in the report it was made over. */
  fields: Record<string, unknown>;
  expected: Record<string, unknown>;
  /** Who made it: named to Admins, and to Staff by its id only, as other accounts' names are personal information they do not see. */
  account: { id: string; name: string | null } | null;
  /** By PostgreSQL's clock: when it was made, sent to the plugin and answered; null until it was. */
  madeAt: string;
  sentAt: string | null;
  answeredAt: string | null;
  /**
   * What came of it; null while it awaits its answer. `notConfirmed` once
   * it is no longer awaited (`SettingsEditsService.get`), until an answer
   * arriving after that replaces it, but for an `expired` refusal, which
   * leaves it not confirmed.
   */
  outcome: "applied" | "adjusted" | "refused" | "notConfirmed" | null;
  /** Whether its outcome came from an answer that arrived after it was marked not confirmed. */
  late: boolean;
  /** For `adjusted`: each field the Machine stored otherwise, with what it holds. */
  adjusted: HeldOtherwise[];
  refusal: SettingsEditRefusalView | null;
  /** The edit's fields as the plugin read them: back after its write, or as the tablet held them when it was refused as changed since. */
  readBack: Record<string, unknown> | null;
}

const OUTCOMES = { applied: SettingsEditOutcome.APPLIED, adjusted: SettingsEditOutcome.ADJUSTED, refused: SettingsEditOutcome.REFUSED } as const;
const REFUSALS: Record<SettingsEditedRefusal, SettingsEditRefusal> = {
  machineBusy: SettingsEditRefusal.MACHINE_BUSY,
  changedSince: SettingsEditRefusal.CHANGED_SINCE,
  expired: SettingsEditRefusal.EXPIRED,
  decaid: SettingsEditRefusal.DECAID,
};
const OUTCOME_VIEWS = { APPLIED: "applied", ADJUSTED: "adjusted", REFUSED: "refused" } as const satisfies Record<SettingsEditOutcome, string>;
const REFUSAL_VIEWS = {
  MACHINE_BUSY: "machineBusy",
  CHANGED_SINCE: "changedSince",
  EXPIRED: "expired",
  DECAID: "decaid",
} as const satisfies Record<SettingsEditRefusal, SettingsEditedRefusal>;

const withAccount = { account: { select: { name: true } } } as const satisfies Prisma.SettingsEditInclude;
type StoredEdit = Prisma.SettingsEditGetPayload<{ include: typeof withAccount }>;

/**
 * Settings Edits (ADR-0023): each a one-off write of a Machine's settings
 * made in the management interface, kept as a row in PostgreSQL. One is
 * made only while the Machine is online, judged under its row lock as it is
 * inserted, for the connection holding it then, and announced to every
 * instance (`settings_edits`). The instance whose connection that is claims
 * it under the row lock again, by setting when it was sent, and sends it
 * (`claim`); a later connection, even from the same tablet, sends nothing
 * made for an earlier one. The plugin's answer is recorded by whichever
 * instance it reaches (`recordAnswer`).
 *
 * An edit is never queued (ADR-0023). One unanswered SETTINGS_EDIT_MS after
 * it was made, by PostgreSQL's clock, or whose connection no longer holds
 * its Machine first, as it closed or was replaced, is not confirmed
 * (`noLongerAwaited`).
 * Nothing needs to mark it so: every instance judges it the same way from
 * the database whenever it is read. An answer arriving after that still
 * counts, marked late, but for an `expired` refusal, which leaves the edit
 * not confirmed.
 *
 * An Admin edits any field of any Machine with an entry, at any Location or
 * none, sharing or not, as Settings Edits are no Library writes. Staff edit
 * only fields marked for Staff, of Machines at a Location they work at.
 */
@Injectable()
export class SettingsEditsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  /**
   * Makes an edit and announces it, or refuses it at once with nothing kept:
   * 400 for one the field definitions refuse, or of a collection not edited
   * yet; 403 for a field only an Admin may change, or for Staff, a Machine at
   * no Location they work at; 409 while the Machine is offline, or its
   * connection's tablet reports another machine's hardware, which nothing is
   * written to (ADR-0004).
   */
  async make(machineId: string, edit: NewSettingsEdit, signedIn: SignedIn): Promise<SettingsEditView> {
    const role: SettingsRole = signedIn.account.role === AccountRole.ADMIN ? "admin" : "staff";
    const refusals = validateSettingsEdit(edit, role);
    const invalid = refusals.filter((refusal) => refusal.reason !== "notAllowed");
    if (invalid.length > 0) throw new BadRequestException(invalid.map((refusal) => settingsRefusalText(edit.collection, refusal)));
    if (refusals.length > 0) throw new ForbiddenException(refusals.map((refusal) => settingsRefusalText(edit.collection, refusal)));
    if (!isEditableSettingsCollection(edit.collection)) throw new BadRequestException(`These settings can't be changed from here yet`);
    const onlineSinceMs = this.config.heartbeatIntervalMs * MISSED_HEARTBEATS;
    const id = await this.prisma.$transaction(async (tx) => {
      if (!(await lockMachine(tx, machineId))) throw machineNotFound();
      const latest = await tx.locationAssignment.findFirst({ where: { machineId }, orderBy: { effectiveFrom: "desc" }, select: { locationId: true } });
      if (!includesLocation(signedIn.scope, latest?.locationId ?? null)) {
        throw new ForbiddenException("You can change the settings only of a Machine at a Location you work at");
      }
      // Online as the Machine's status judges it, by PostgreSQL's clock: held by a connection heard from recently.
      const [holder] = await tx.$queryRaw<[{ sessionId: string | null; tabletId: string | null; online: boolean; mismatched: boolean }]>`
        SELECT connected_session_id AS "sessionId", connected_tablet_id AS "tabletId",
          connected_session_id IS NOT NULL AND last_seen_at >= now() - ${onlineSinceMs}::integer * interval '1 millisecond' AS online,
          identification = 'MISMATCH' AS mismatched
        FROM machines WHERE id = ${machineId}::uuid`;
      if (!holder.online || holder.sessionId === null || holder.tabletId === null) {
        throw new ConflictException("The Machine is offline: an edit is made only while its Tablet is connected, and is never kept for later");
      }
      if (holder.mismatched) throw new ConflictException("Its Tablet reports another machine's hardware than this Machine's, so nothing is written to it");
      const made = await tx.settingsEdit.create({
        data: {
          machineId,
          sessionId: holder.sessionId,
          tabletId: holder.tabletId,
          accountId: signedIn.account.id,
          collection: edit.collection,
          fields: edit.fields as Prisma.InputJsonObject,
          expected: edit.expected as Prisma.InputJsonObject,
        },
        select: { id: true },
      });
      await notify(tx, "settings_edits", machineId);
      return made.id;
    });
    return this.get(machineId, id, signedIn.scope);
  }

  /** One of the Machine's edits. */
  async get(machineId: string, id: string, scope: Scope): Promise<SettingsEditView> {
    const edit = await this.prisma.settingsEdit.findFirst({ where: { id, machineId }, include: withAccount });
    if (!edit) throw settingsEditNotFound();
    return view(edit, scope, edit.answeredAt === null && (await this.notConfirmed([edit.id])).has(edit.id));
  }

  /** Those of these edits still unanswered that are no longer awaited, so not confirmed, by PostgreSQL's clock. */
  private async notConfirmed(ids: string[]): Promise<Set<string>> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM settings_edits
      WHERE id = ANY(${ids}::uuid[]) AND answered_at IS NULL AND ${this.noLongerAwaited()}`;
    return new Set(rows.map((row) => row.id));
  }

  /**
   * Whether a row of `settings_edits` is no longer awaited, as SQL: made
   * SETTINGS_EDIT_MS ago or longer, or its connection no longer holds its
   * Machine, as it closed and was released, or a newer connection replaced
   * it. A session never holds its Machine again once it has stopped, so this
   * only ever turns true. A connection gone unheard, as when its instance
   * crashed, counts only once the 60 s are up: its plugin, still connected
   * while the database is merely slow to record its heartbeats, could still
   * start the write. A plugin hears that its connection closed only after
   * the server releases or replaces it, so a write it starts in that moment
   * is answered late.
   */
  private noLongerAwaited(): Prisma.Sql {
    return Prisma.sql`(
      settings_edits.made_at <= now() - ${SETTINGS_EDIT_MS}::integer * interval '1 millisecond'
      OR NOT EXISTS (
        SELECT 1 FROM machines
        WHERE machines.id = settings_edits.machine_id AND machines.connected_session_id = settings_edits.session_id
      )
    )`;
  }

  /**
   * The edits made for a connection that it has not sent yet, oldest first,
   * claimed by setting when they were sent, while the connection still holds
   * its Machine, judged under the Machine's row lock; none once it does not.
   * Each carries the time it has left, by PostgreSQL's clock; one with none
   * left is not sent, as it is not confirmed. A claim whose transaction
   * began before an edit's, waiting for the lock, sends it as it was made,
   * not before.
   */
  async claim(connection: { sessionId: string; machineId: string }): Promise<SettingsEdit[]> {
    return this.prisma.$transaction(async (tx) => {
      const holds = await tx.$queryRaw<unknown[]>`
        SELECT 1 FROM machines WHERE id = ${connection.machineId}::uuid AND connected_session_id = ${connection.sessionId}::uuid FOR NO KEY UPDATE`;
      if (holds.length === 0) return [];
      const claimed = await tx.$queryRaw<{ id: string; collection: string; fields: Record<string, unknown>; expected: Record<string, unknown>; timeLeftMs: number }[]>`
        WITH claimed AS (
          UPDATE settings_edits SET sent_at = GREATEST(now(), made_at)
          WHERE session_id = ${connection.sessionId}::uuid AND machine_id = ${connection.machineId}::uuid AND sent_at IS NULL
            AND made_at > now() - ${SETTINGS_EDIT_MS}::integer * interval '1 millisecond'
          RETURNING id, collection, fields, expected, made_at, sent_at
        )
        SELECT id, collection, fields, expected,
          GREATEST(0, ${SETTINGS_EDIT_MS}::integer - FLOOR(EXTRACT(EPOCH FROM sent_at - made_at) * 1000))::integer AS "timeLeftMs"
        FROM claimed ORDER BY made_at, id`;
      return claimed.map(({ id, collection, fields, expected, timeLeftMs }): SettingsEdit => ({ type: "settingsEdit", id, collection, fields, expected, timeLeftMs }));
    });
  }

  /**
   * Records the plugin's answer to one of the Machine's edits, through
   * whichever connection and instance it reached, and says what came of it,
   * and whether it came late, after the edit was no longer awaited; null for
   * an edit of another Machine, or none, or one already answered. Only the
   * values of the edit's own fields are kept.
   */
  async recordAnswer(machineId: string, answer: SettingsEdited): Promise<{ outcome: DecidedOutcome["outcome"]; late: boolean } | null> {
    const edit = await this.prisma.settingsEdit.findFirst({
      where: { id: answer.id.toLowerCase(), machineId, answeredAt: null },
      select: { id: true, collection: true, fields: true, expected: true },
    });
    if (!edit) return null;
    const sent = { collection: edit.collection, fields: asRecord(edit.fields), expected: asRecord(edit.expected) };
    const decided = decideOutcome(sent, answer);
    const values = answer.values === undefined ? null : Object.fromEntries(Object.keys(sent.fields).filter((field) => field in answer.values!).map((field) => [field, answer.values![field]]));
    const refusal = decided.outcome === "refused" ? REFUSALS[decided.reason] : null;
    const decaid = decided.outcome === "refused" && decided.reason === "decaid";
    const [updated] = await this.prisma.$queryRaw<[{ late: boolean }?]>`
      UPDATE settings_edits SET
        answered_at = now(),
        late = ${this.noLongerAwaited()},
        outcome = ${OUTCOMES[decided.outcome]}::settings_edit_outcome,
        refusal = ${refusal}::settings_edit_refusal,
        machine_state = ${answer.reason === "machineBusy" ? (answer.state ?? null) : null},
        decaid_status = ${decaid ? (answer.status ?? null) : null}::integer,
        decaid_message = ${decaid ? (answer.message ?? null) : null},
        read_back = ${values === null ? null : JSON.stringify(values)}::jsonb
      WHERE id = ${edit.id}::uuid AND answered_at IS NULL
      RETURNING late`;
    return updated ? { outcome: decided.outcome, late: updated.late } : null;
  }
}

/** The edit as the REST API gives it; `notConfirmed` says whether, still unanswered, it is no longer awaited. */
function view(edit: StoredEdit, scope: Scope, notConfirmed: boolean): SettingsEditView {
  const fields = asRecord(edit.fields);
  const expected = asRecord(edit.expected);
  const readBack = edit.readBack === null ? null : asRecord(edit.readBack);
  // A refusal as too late, arriving once the edit was no longer awaited, leaves it not confirmed.
  const stillNotConfirmed = notConfirmed || (edit.late && edit.refusal === SettingsEditRefusal.EXPIRED);
  const outcome = stillNotConfirmed ? "notConfirmed" : edit.outcome === null ? null : OUTCOME_VIEWS[edit.outcome];
  return {
    id: edit.id,
    machineId: edit.machineId,
    collection: edit.collection,
    fields,
    expected,
    // Other accounts' names are personal information that Staff do not see.
    account: edit.accountId === null ? null : { id: edit.accountId, name: scope.kind === "everything" ? (edit.account?.name ?? null) : null },
    madeAt: edit.madeAt.toISOString(),
    sentAt: edit.sentAt?.toISOString() ?? null,
    answeredAt: edit.answeredAt?.toISOString() ?? null,
    outcome,
    late: edit.late && !stillNotConfirmed,
    adjusted: outcome === "adjusted" ? heldOtherwise({ collection: edit.collection, fields }, readBack) : [],
    refusal: outcome === "refused" ? refusalView(edit, { collection: edit.collection, fields, expected }, readBack) : null,
    readBack,
  };
}

function refusalView(edit: StoredEdit, sent: { collection: string; fields: Record<string, unknown>; expected: Record<string, unknown> }, readBack: Record<string, unknown> | null): SettingsEditRefusalView | null {
  if (edit.refusal === null) return null;
  const reason = REFUSAL_VIEWS[edit.refusal];
  switch (reason) {
    case "machineBusy":
      return { reason, state: edit.machineState };
    case "changedSince":
      return { reason, current: readBack };
    case "expired":
      return { reason };
    case "decaid": {
      const decided = decideOutcome(sent, { outcome: "refused", reason, ...(readBack ? { values: readBack } : {}) });
      return { reason, status: edit.decaidStatus, message: edit.decaidMessage, changed: decided.outcome === "refused" ? decided.changed : [] };
    }
  }
}

function asRecord(value: Prisma.JsonValue): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
